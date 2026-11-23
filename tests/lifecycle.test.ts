import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { provider } from "../server/provider.ts";
import type {
  ProviderEvent,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
const config: ProviderSessionConfig = {
  cwd: tmpdir(),
  env: {},
  mcpServers: {},
  settings: {},
  persist: true,
};
async function setup(scenario = "", extra: Record<string, string> = {}) {
  const c = await provider({
    limits: { startup: 2000, silent: 200, cancel: 80, hint: 50 },
    closeTimeoutMs: 150,
  }).connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "permission"],
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixture.mjs", import.meta.url))],
      env: { PATH: process.env.PATH!, SCENARIO: scenario, ...extra },
    },
  });
  const rows: ProviderEvent[] = [];
  const listeners = new Set<() => void>();
  c.onEvent((e) => {
    rows.push(e);
    for (const f of [...listeners]) f();
  });
  const wait = (p: (e: ProviderEvent) => boolean, from = 0, ms = 3000) =>
    new Promise<ProviderEvent>((resolve, reject) => {
      const done = () => {
        const e = rows.slice(from).find(p);
        if (e) {
          clearTimeout(t);
          listeners.delete(done);
          resolve(e);
        }
      };
      const t = setTimeout(() => {
        listeners.delete(done);
        reject(
          Error(
            "Missing event: " +
              JSON.stringify(rows.slice(from).map((e) => e.type)),
          ),
        );
      }, ms);
      listeners.add(done);
      done();
    });
  const open = async () => {
    await c.send({
      type: "session.open",
      sessionId: "s",
      requestId: "open",
      config,
      history: "skip",
    });
    await wait((e) => e.type === "session.ready");
  };
  const prompt = async (text: string) => {
    const from = rows.length;
    await c.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: crypto.randomUUID(),
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    return from;
  };
  return { c, rows, wait, open, prompt };
}
for (const [text, reason] of [
  ["bad", "非 ACP"],
  ["silent", "连续无进展"],
  ["deferred-bad", "非 ACP"],
  ["exit-17", "退出码 17"],
  ["signal-term", "SIGTERM"],
] as const) {
  test(
    `SDK delivers specific runtime and turn failure: ${text}`,
    { timeout: 5000 },
    async () => {
      const h = await setup();
      try {
        await h.open();
        const from = await h.prompt(text);
        const runtime = await h.wait(
          (e) => e.type === "session.runtime_failed",
          from,
        );
        assert.ok(
          runtime.type === "session.runtime_failed" &&
            runtime.error.message.includes(reason),
        );
        const turn = await h.wait(
          (e) => e.type === "session.turn" && e.state === "failed",
          from,
        );
        assert.ok(
          turn.type === "session.turn" &&
            turn.state === "failed" &&
            turn.error?.message.includes(reason),
          JSON.stringify(turn),
        );
      } finally {
        await h.c.close();
      }
    },
  );
}
test(
  "SDK cancellation clears a tool with no terminal update",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      let from = await h.prompt("tool");
      await h.wait(
        (e) => e.type === "timeline.item" && e.item.type === "tool_call",
        from,
      );
      await h.c.send({
        type: "session.interrupt",
        sessionId: "s",
        requestId: "stop",
      });
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "canceled",
        from,
      );
      from = await h.prompt("silent");
      const e = await h.wait((e) => e.type === "session.runtime_failed", from);
      assert.ok(
        e.type === "session.runtime_failed" &&
          e.error.message.includes("连续无进展"),
      );
    } finally {
      await h.c.close();
    }
  },
);
test(
  "0.2.2 SDK terminalizes failed RPC tools without poisoning the next turn",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      let from = await h.prompt("tool-error");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "failed",
        from,
      );
      assert.ok(
        h.rows
          .slice(from)
          .some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "tool_call" &&
              e.item.status === "failed",
          ),
      );
      from = await h.prompt("silent");
      const e = await h.wait((e) => e.type === "session.runtime_failed", from);
      assert.ok(
        e.type === "session.runtime_failed" &&
          e.error.message.includes("连续无进展"),
      );
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK close callers share the same bounded cleanup",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    await h.open();
    const a = h.c.close(),
      b = h.c.close();
    assert.equal(a, b);
    await Promise.all([a, b]);
  },
);
test(
  "SDK cancel timeout keeps its concrete reason",
  { timeout: 5000 },
  async () => {
    const h = await setup("ignore-cancel");
    try {
      await h.open();
      const from = await h.prompt("ignore-cancel");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "started",
        from,
      );
      await h.c.send({
        type: "session.interrupt",
        sessionId: "s",
        requestId: "stop",
      });
      const e = await h.wait((e) => e.type === "session.runtime_failed", from);
      assert.ok(
        e.type === "session.runtime_failed" &&
          e.error.message.includes("取消请求"),
      );
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK cancel after completed turn does not kill next real turn",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      let from = await h.prompt("hello");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      await h.c.send({
        type: "session.interrupt",
        sessionId: "s",
        requestId: "idle-stop",
      });
      await sleep(120);
      from = await h.prompt("hello again");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      assert.ok(!h.rows.some((e) => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK restored history survives >200ms partial UTF8 frames and ghost tool",
  { timeout: 6000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      const opened = h.rows.find((e) => e.type === "session.opened");
      assert.ok(opened?.type === "session.opened");
      await h.c.send({
        type: "session.close",
        sessionId: "s",
        requestId: "close",
      });
      await h.wait((e) => e.type === "session.closed");
      const from = h.rows.length;
      await h.c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "restore",
        config,
        history: "replay",
        persistence: opened.persistence,
      });
      await h.wait((e) => e.type === "session.ready", from);
      assert.ok(
        h.rows
          .slice(from)
          .some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "assistant_message" &&
              e.item.text === "REPLAY_" + "中".repeat(100000),
          ),
      );
      const p = await h.prompt("silent");
      const error = await h.wait((e) => e.type === "session.runtime_failed", p);
      assert.ok(
        error.type === "session.runtime_failed" &&
          error.error.message.includes("连续无进展"),
      );
    } finally {
      await h.c.close();
    }
  },
);
for (const history of ["skip", "replay"] as const)
  test(
    `0.2.2 late history after ready is skipped until first prompt (${history})`,
    { timeout: 6000 },
    async () => {
      const h = await setup("late-history");
      try {
        await h.open();
        const opened = h.rows.find((e) => e.type === "session.opened");
        assert.ok(opened?.type === "session.opened");
        await h.c.send({
          type: "session.close",
          sessionId: "s",
          requestId: "close",
        });
        await h.wait((e) => e.type === "session.closed");
        const from = h.rows.length;
        await h.c.send({
          type: "session.open",
          sessionId: "s",
          requestId: "restore",
          config,
          history,
          persistence: opened.persistence,
        });
        await h.wait((e) => e.type === "session.ready", from);
        await sleep(350);
        assert.ok(
          !h.rows
            .slice(from)
            .some(
              (e) =>
                e.type === "timeline.item" &&
                ((e.item.type === "assistant_message" &&
                  e.item.text === "LATE_HISTORY") ||
                  (e.item.type === "tool_call" &&
                    e.item.callId === "late-ghost")),
            ),
        );
        const p = await h.prompt("hello");
        await h.wait(
          (e) => e.type === "session.turn" && e.state === "completed",
          p,
        );
      } finally {
        await h.c.close();
      }
    },
  );
test(
  "0.2.2 auto followup retains background tool until its real terminal event",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      await h.prompt("background-first");
      await sleep(80);
      const from = await h.prompt("background-follow");
      await h.wait(
        (e) =>
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          e.item.text === "DONE",
        from,
      );
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      assert.ok(!h.rows.some((e) => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK graceful close sends session/close before terminating CLI",
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-close-"));
    const file = join(dir, "close");
    const h = await setup("", { CLOSE_FILE: file });
    try {
      await h.open();
      await h.c.close();
      assert.equal(await readFile(file, "utf8"), "closed");
    } finally {
      await h.c.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "SDK close stays bounded even with session/new in flight",
  { timeout: 5000 },
  async () => {
    const h = await setup("new-hang");
    try {
      await h.c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "open",
        config,
        history: "skip",
      });
      await sleep(50);
      const at = Date.now();
      await h.c.close();
      assert.ok(Date.now() - at < 1500);
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK session/new failure retains login diagnostic",
  { timeout: 5000 },
  async () => {
    const h = await setup("new-error");
    try {
      await h.c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "open",
        config,
        history: "skip",
      });
      const e = await h.wait((e) => e.type === "request.failed");
      assert.ok(
        e.type === "request.failed" && e.error.message.includes("登录"),
      );
    } finally {
      await h.c.close();
    }
  },
);
