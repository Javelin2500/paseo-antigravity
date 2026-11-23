// Explicit opt-in: this uses the existing official CLI subscription for small test prompts.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { provider } from "../server/provider";
import type {
  ProviderEvent,
  ProviderConnection,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
if (!process.argv.includes("--confirm-live"))
  throw new Error("Pass --confirm-live to use the existing CLI subscription.");
const cwd = await mkdtemp(join(tmpdir(), "agy-live-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (v): v is [string, string] => v[1] !== undefined,
  ),
);
let c: ProviderConnection | undefined;
const events: ProviderEvent[] = [];
const watchers = new Set<() => void>();
function wait<T extends ProviderEvent>(
  pred: (e: ProviderEvent) => e is T,
  from = 0,
  timeout = 120000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.slice(from).find(pred);
      if (found) {
        clearTimeout(timer);
        watchers.delete(check);
        resolve(found);
      } else {
        const failed = events
          .slice(from)
          .find(
            (e) =>
              e.type === "request.failed" ||
              e.type === "session.runtime_failed",
          );
        if (failed) {
          clearTimeout(timer);
          watchers.delete(check);
          reject(new Error(JSON.stringify(failed)));
        }
      }
    };
    const timer = setTimeout(() => {
      watchers.delete(check);
      reject(new Error("Live operation timed out"));
    }, timeout);
    watchers.add(check);
    check();
  });
}
const started = Date.now();
try {
  c = await provider().connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "session.persistence",
      "session.configure",
      "permission",
    ],
    launch: {
      command: process.env.AGY_BINARY ?? "agy",
      args: ["acp", "--disable-telemetry"],
      env,
    },
  });
  c.onEvent((e) => {
    events.push(e);
    for (const w of [...watchers]) w();
  });
  await c.send({ type: "catalog", requestId: "cat", cwd });
  const catalog = await wait(
    (e): e is Extract<ProviderEvent, { type: "catalog" }> =>
      e.type === "catalog",
  );
  console.log(
    "catalog",
    catalog.catalog.models.map((m) => m.id),
  );
  const model =
    process.env.AGY_TEST_MODEL ??
    catalog.catalog.models.find((m) => /gemini.*neon/.test(m.id))?.id ??
    catalog.catalog.defaultModel;
  console.log("selected", model, "catalog_ms", Date.now() - started);
  const config: ProviderSessionConfig = {
    cwd,
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
    model,
  };
  await c.send({
    type: "session.open",
    requestId: "open",
    sessionId: "live",
    config,
    history: "skip",
  });
  const opened = await wait(
    (e): e is Extract<ProviderEvent, { type: "session.opened" }> =>
      e.type === "session.opened",
  );
  await wait(
    (e): e is Extract<ProviderEvent, { type: "session.ready" }> =>
      e.type === "session.ready",
  );
  async function prompt(sid: string, text: string) {
    const from = events.length;
    await c!.send({
      type: "session.prompt",
      sessionId: sid,
      prompt: {
        clientMessageId: crypto.randomUUID(),
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    const turn = await wait(
      (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
        e.type === "session.turn" && e.state !== "started",
      from,
    );
    const replies = events
      .slice(from)
      .filter(
        (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
          e.type === "timeline.item",
      )
      .filter((e) => e.item.type === "assistant_message")
      .map((e) => (e.item.type === "assistant_message" ? e.item.text : ""));
    return { turn, text: replies.at(-1) ?? "" };
  }
  const first = await prompt(
    "live",
    "Remember this test marker: ACP_TEST_731. Reply exactly ACP_OK. Do not call tools or inspect files.",
  );
  console.log(
    "first",
    first.turn.state,
    "expected_reply",
    first.text.includes("ACP_OK"),
    "elapsed_ms",
    Date.now() - started,
  );
  if (first.turn.state !== "completed" || !first.text.includes("ACP_OK"))
    throw new Error("First real prompt failed.");
  await c.send({
    type: "session.close",
    requestId: "close",
    sessionId: "live",
  });
  await wait(
    (e): e is Extract<ProviderEvent, { type: "session.closed" }> =>
      e.type === "session.closed" && e.sessionId === "live",
  );
  await c.send({
    type: "session.open",
    requestId: "resume",
    sessionId: "resumed",
    config,
    persistence: opened.persistence,
    history: "replay",
  });
  await wait(
    (e): e is Extract<ProviderEvent, { type: "session.ready" }> =>
      e.type === "session.ready" && e.sessionId === "resumed",
  );
  const second = await prompt(
    "resumed",
    "What was the test marker I gave you? Reply only the marker. Do not use tools.",
  );
  console.log(
    "resume",
    second.turn.state,
    "remembered_marker",
    second.text.includes("ACP_TEST_731"),
  );
  if (
    second.turn.state !== "completed" ||
    !second.text.includes("ACP_TEST_731")
  )
    throw new Error("Native persistence failed.");
  const from = events.length;
  await c.send({
    type: "session.prompt",
    sessionId: "resumed",
    prompt: {
      clientMessageId: crypto.randomUUID(),
      delivery: "auto",
      input: {
        type: "message",
        content: [
          {
            type: "text",
            text: "Without using tools, list integers from 1 to 10000, one per line.",
          },
        ],
      },
    },
  });
  await wait(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" &&
      e.item.type === "assistant_message" &&
      e.item.text.length > 0,
    from,
  );
  const stopAt = Date.now();
  await c.send({
    type: "session.interrupt",
    requestId: "stop",
    sessionId: "resumed",
  });
  const stopped = await wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" && e.state !== "started",
    from,
    15000,
  );
  console.log("stop", stopped.state, "latency_ms", Date.now() - stopAt);
  if (stopped.state !== "canceled")
    throw new Error("Live cancellation did not reach canceled.");
  const afterStop = await prompt(
    "resumed",
    "Reply exactly AFTER_STOP_OK. Do not use tools.",
  );
  if (
    afterStop.turn.state !== "completed" ||
    !afterStop.text.includes("AFTER_STOP_OK")
  )
    throw new Error("Prompt immediately after cancellation failed.");
  await c.send({
    type: "session.interrupt",
    requestId: "idle-stop",
    sessionId: "resumed",
  });
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const afterIdle = await prompt(
    "resumed",
    "Reply exactly AFTER_IDLE_STOP_OK. Do not use tools.",
  );
  if (
    afterIdle.turn.state !== "completed" ||
    !afterIdle.text.includes("AFTER_IDLE_STOP_OK")
  )
    throw new Error("Idle cancellation poisoned next prompt.");
  console.log(
    "after_stop",
    afterStop.turn.state,
    "after_idle_stop",
    afterIdle.turn.state,
  );
} finally {
  await c?.close();
  await rm(cwd, { recursive: true, force: true });
}
