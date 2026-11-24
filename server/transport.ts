import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { Watch, defaults, type Limits } from "./watch";
import { stopProcessGroup } from "./process-group";

export interface Context {
  cwd: string;
  env: Readonly<Record<string, string>>;
  sessionId?: string;
}
export interface OwnedTransport {
  stream: AcpStream;
  close(): Promise<void>;
  finished: Promise<void>;
  pid: number | undefined;
  finishTool(id: string): void;
}
const MAX_FRAME = 16 * 1024 * 1024;
const REPLAY_QUIET_MS = 200;
function parse(line: string): AcpStreamMessage {
  if (
    line.startsWith("Open the following link to authenticate") ||
    line.startsWith("https://accounts.google.com/")
  )
    throw new Error(
      "官方 CLI 要求登录。请在该主机终端使用现有 agy 登录；插件不会收集授权码。",
    );
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new Error(
      "Antigravity stdout 返回了非 ACP 数据。请检查 CLI 版本和登录状态。",
    );
  }
  if (!v || typeof v !== "object" || !("jsonrpc" in v) || v.jsonrpc !== "2.0")
    throw new Error("无效的 ACP 消息。");
  if (
    "method" in v &&
    v.method === "session/request_permission" &&
    "params" in v
  ) {
    const params = v.params as { toolCall?: Record<string, unknown> };
    if (params?.toolCall && params.toolCall.rawInput === undefined)
      params.toolCall.rawInput = {};
  }
  return v as AcpStreamMessage;
}

/** Own the official CLI and its process group. No credentials or raw stderr are logged. */
export function createTransport(
  launch: ProviderLaunch,
  context: Context,
  hint: (message: string) => void,
  limits: Limits = defaults,
  onFailure: (message: string) => void = () => {},
): OwnedTransport {
  if (process.platform === "win32")
    throw new Error("当前进程管理实现仅支持 macOS / Linux。");
  for (const value of Object.values(limits))
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("Watch 时间限制必须是正数。");
  const child = spawn(launch.command, launch.args, {
    cwd: context.cwd,
    env: { ...launch.env, ...context.env },
    shell: false,
    detached: true,
    stdio: "pipe",
  });
  const watch = new Watch(limits);
  let finish!: () => void;
  const finished = new Promise<void>((r) => {
    finish = r;
  });
  let controller: ReadableStreamDefaultController<AcpStreamMessage>;
  let closed = false,
    closing: Promise<void> | undefined,
    failure: string | undefined;
  let groupClosing: Promise<string | undefined> | undefined;
  const stopOwned = () => (groupClosing ??= stopProcessGroup(child.pid));
  let exitTimer: ReturnType<typeof setTimeout> | undefined,
    replayTimer: ReturnType<typeof setTimeout> | undefined;
  let exitInfo:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  let exited!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    exited = resolve;
  });
  let ending: Promise<void> | undefined;
  const decoder = new StringDecoder("utf8");
  let buffer = "",
    lastRead = Date.now();
  let loadId: string | number | undefined,
    loadResponse: AcpStreamMessage | undefined;
  const recordFailure = (message: string) => {
    if (!failure) {
      failure = message;
      onFailure(message);
    }
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* consumer already cancelled */
        }
      }
      clearInterval(timer);
      clearTimeout(exitTimer);
      clearTimeout(replayTimer);
      child.stdin.end();
      try {
        const error = await stopOwned();
        if (error) {
          recordFailure(error);
          hint(error);
        }
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    })().finally(finish));
  const fail = (message: string) => {
    if (closed) return;
    recordFailure(message);
    closed = true;
    controller.error(new Error(message));
    void close();
  };
  const deliver = (frame: AcpStreamMessage) => {
    watch.observe("in", frame, Date.now());
    controller.enqueue(frame);
  };
  // In connector mode the SDK cannot see partial byte reads. Hold the native load response
  // until the same 200ms replay boundary is reached AND no incomplete frame remains.
  // History itself is streamed immediately, inside SDK's still-open replay window.
  const armReplay = () => {
    clearTimeout(replayTimer);
    if (!loadResponse || closed) return;
    replayTimer = setTimeout(() => {
      if (closed || !loadResponse) return;
      if (buffer.length || Date.now() - lastRead < REPLAY_QUIET_MS) {
        armReplay();
        return;
      }
      const response = loadResponse;
      loadResponse = undefined;
      loadId = undefined;
      deliver(response);
    }, REPLAY_QUIET_MS);
    replayTimer.unref();
  };
  const receive = (frame: AcpStreamMessage) => {
    if (loadId !== undefined && !("method" in frame) && frame.id === loadId) {
      if ("error" in frame) {
        loadId = undefined;
        deliver(frame);
      } else {
        loadResponse = frame;
        armReplay();
      }
    } else deliver(frame);
  };
  const consume = () => {
    let pos: number;
    while ((pos = buffer.indexOf("\n")) >= 0) {
      if (pos > MAX_FRAME) throw new Error("Antigravity 消息超过大小限制。");
      const line = buffer.slice(0, pos).trim();
      buffer = buffer.slice(pos + 1);
      if (line) receive(parse(line));
    }
    if (buffer.length > MAX_FRAME)
      throw new Error("Antigravity 消息超过大小限制。");
  };
  const endOutput = (): Promise<void> =>
    (ending ??= (async () => {
      if (closed) return;
      try {
        buffer += decoder.end();
        consume();
        if (buffer.trim()) receive(parse(buffer.trim()));
        buffer = "";
        if (loadResponse) {
          const frame = loadResponse;
          loadResponse = undefined;
          loadId = undefined;
          deliver(frame);
        }
        // stdout EOF can precede Node's exit event. Briefly wait for metadata without
        // delaying delivery of already parsed final replies or inventing a failure code.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exitObserved,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 100);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (closed) return;
        const detail = exitInfo?.signal
          ? `（信号 ${exitInfo.signal}）`
          : typeof exitInfo?.code === "number"
            ? `（退出码 ${exitInfo.code}）`
            : "";
        recordFailure(
          `Antigravity CLI 已关闭输出或退出${detail}。请刷新会话后继续；未重发消息。`,
        );
        // close() preserves queued replies; error() would discard them.
        void close();
      } catch (e) {
        fail(e instanceof Error ? e.message : "ACP 尾帧错误。");
      }
    })());
  const drainThenClose = () => {
    if (!closed && !exitTimer) {
      // Do not manufacture EOF while stdout is paused with unread final frames.
      // Reap pipe-holding descendants; only the real stdout 'end' flushes the decoder.
      exitTimer = setTimeout(() => {
        void stopOwned().then((error) => {
          if (error) {
            recordFailure(error);
            hint(error);
            void close();
          }
        });
      }, 1000);
      exitTimer.unref();
    }
  };
  const interval = Math.max(
    10,
    Math.min(500, limits.startup, limits.silent, limits.cancel),
  );
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > interval + 5000 || now < lastTick)
      watch.resume(now, lastTick);
    lastTick = now;
    const result = watch.check(now);
    if (result.failure) fail(result.failure);
  }, interval);
  timer.unref();
  const source = new ReadableStream<AcpStreamMessage>({
    start(c) {
      controller = c;
    },
    cancel() {
      return close();
    },
  });
  const reader = source.getReader();
  const stream: AcpStream = {
    readable: new ReadableStream<AcpStreamMessage>({
      async pull(c) {
        child.stdout.resume();
        try {
          const next = await reader.read();
          if (next.done) c.close();
          else c.enqueue(next.value);
        } catch (e) {
          c.error(e);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
    writable: new WritableStream<AcpStreamMessage>({
      write(frame) {
        if (closed) throw new Error(failure ?? "Antigravity 连接已关闭。");
        if (
          "method" in frame &&
          frame.method === "session/load" &&
          "id" in frame
        )
          loadId = frame.id ?? undefined;
        watch.observe("out", frame, Date.now());
        return new Promise<void>((resolve, reject) =>
          child.stdin.write(JSON.stringify(frame) + "\n", (error) => {
            if (error) {
              recordFailure("Antigravity 输入管道已关闭。");
              drainThenClose();
              reject(new Error(failure));
            } else resolve();
          }),
        );
      },
      close,
      abort: close,
    }),
  };
  child.once("error", () =>
    fail("无法启动官方 agy，请检查 Paseo 的可执行文件路径。"),
  );
  child.stdin.on("error", () => {
    if (!closed) {
      recordFailure("Antigravity 输入管道已关闭。");
      drainThenClose();
    }
  });
  child.stdout.on("error", () => fail("Antigravity 输出管道读取失败。"));
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    lastRead = Date.now();
    try {
      buffer += decoder.write(chunk);
      consume();
      armReplay();
      if (controller.desiredSize !== null && controller.desiredSize <= 0)
        child.stdout.pause();
    } catch (e) {
      fail(e instanceof Error ? e.message : "ACP 协议错误。");
    }
  });
  child.stdout.once("end", endOutput);
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    exited();
    if (child.stdout.readableEnded) void endOutput();
    else drainThenClose();
  });
  return {
    stream,
    close,
    finished,
    pid: child.pid,
    finishTool: (id) => watch.finishTool(id),
  };
}
