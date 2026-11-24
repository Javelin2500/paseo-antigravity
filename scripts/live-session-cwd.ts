// Opt-in: creates one synthetic native session and uses the existing CLI subscription.
// Leaves that synthetic native history entry, but removes its temporary directory.
// Never prints session IDs, historical summaries, transcripts, or raw CLI errors.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { provider } from "../server/provider";
import { createTransport, type OwnedTransport } from "../server/transport";
import { normalizeSessionCwd } from "../server/session-cwd";

if (!process.argv.includes("--confirm-live"))
  throw new Error("Pass --confirm-live to create a test session and use the CLI subscription.");

function observe(c: ProviderConnection) {
  const events: ProviderEvent[] = [];
  const watchers = new Set<() => void>();
  c.onEvent((event) => {
    events.push(event);
    if (event.type === "session.permission")
      void c.send({
        type: "session.permission",
        sessionId: event.sessionId,
        permissionId: event.request.id,
        response: { behavior: "deny" },
      }).catch(() => {});
    for (const watcher of [...watchers]) watcher();
  });
  const wait = <T extends ProviderEvent>(
    predicate: (event: ProviderEvent) => event is T,
    from = 0,
  ) => new Promise<T>((resolve, reject) => {
    const check = () => {
      const rows = events.slice(from);
      const failed = rows.some((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
      const event = rows.find(predicate);
      if (!failed && !event) return;
      clearTimeout(timer);
      watchers.delete(check);
      if (failed) reject(new Error("Live operation failed (details withheld)"));
      else resolve(event!);
    };
    const timer = setTimeout(() => {
      watchers.delete(check);
      reject(new Error("Live operation timed out"));
    }, 120000);
    watchers.add(check);
    check();
  });
  return { events, wait };
}

const root = await mkdtemp(join(tmpdir(), "agy-cwd-live-"));
let patched: ProviderConnection | undefined;
let raw: ProviderConnection | undefined;
const transports = new Set<OwnedTransport>();
let phase = "prepare";
try {
  await mkdir(join(root, "中文 空格"));
  // Avoid /var vs /private/var aliases on macOS obscuring the encoding check.
  const cwd = await realpath(join(root, "中文 空格"));
  const launch: ProviderLaunch = {
    command: process.env.AGY_BINARY ?? "agy",
    args: ["acp", "--disable-telemetry"],
    env: Object.fromEntries(Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    )),
  };
  phase = "connect";
  patched = await provider().connect({
    versions: [1],
    capabilities: ["session.list", "session.persistence", "prompt.message", "permission"],
    launch,
  });
  const { events, wait } = observe(patched);
  const config = {
    cwd, env: {}, mcpServers: {}, settings: {}, persist: true,
    model: process.env.AGY_TEST_MODEL ?? "gemini-4-neon",
    mode: "default",
  };
  phase = "create";
  await patched.send({ type: "session.open", requestId: "new", sessionId: "fixture", config, history: "skip" });
  const opened = await wait((e): e is Extract<ProviderEvent, { type: "session.opened" }> => e.type === "session.opened");
  await wait((e): e is Extract<ProviderEvent, { type: "session.ready" }> => e.type === "session.ready");
  assert.ok(opened.persistence);
  phase = "persist synthetic conversation";
  await patched.send({
    type: "session.prompt", sessionId: "fixture",
    prompt: {
      clientMessageId: crypto.randomUUID(), delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "This is an isolated import test. Reply exactly CWD_IMPORT_OK. Do not call tools or inspect any files." }] },
    },
  });
  const turn = await wait((e): e is Extract<ProviderEvent, { type: "session.turn" }> => e.type === "session.turn" && e.state !== "started");
  assert.equal(turn.state, "completed");
  await patched.send({ type: "session.close", requestId: "close-fixture", sessionId: "fixture" });
  await wait((e): e is Extract<ProviderEvent, { type: "session.closed" }> => e.type === "session.closed");
  const identity = JSON.stringify(opened.persistence);

  // Unmodified SDK provides the actual upstream cwd, not our normalized summary.
  phase = "raw list";
  raw = await runAcpProvider({
    id: "cwd-validation", label: "cwd validation",
    connector: () => {
      const transport = createTransport(launch, { cwd, env: {} }, () => {});
      transports.add(transport);
      return transport.stream;
    },
  }).connect({ versions: [1], capabilities: ["session.list"], launch });
  const baseline = observe(raw);
  await raw.send({ type: "sessions", requestId: "raw" });
  const rawList = await baseline.wait((e): e is Extract<ProviderEvent, { type: "sessions" }> => e.type === "sessions" && e.requestId === "raw");
  const original = rawList.sessions.find((s) => JSON.stringify(s.persistence) === identity);
  assert.ok(original, "Synthetic session not found in raw list");
  assert.equal(normalizeSessionCwd(original.cwd), cwd);
  const encodingObserved = original.cwd !== cwd;
  console.log(JSON.stringify({ phase: "raw-list", syntheticSessionFound: true, encodingObserved }));

  phase = "filtered raw list";
  await raw.send({ type: "sessions", requestId: "filtered", cwd });
  const filtered = await baseline.wait((e): e is Extract<ProviderEvent, { type: "sessions" }> => e.type === "sessions" && e.requestId === "filtered");
  const filterMatched = filtered.sessions.some((s) => JSON.stringify(s.persistence) === identity);
  console.log(JSON.stringify({ phase: "filtered-list", filterMatched }));

  phase = "patched list";
  await patched.send({ type: "sessions", requestId: "patched" });
  const list = await wait((e): e is Extract<ProviderEvent, { type: "sessions" }> => e.type === "sessions" && e.requestId === "patched");
  const summary = list.sessions.find((s) => JSON.stringify(s.persistence) === identity);
  assert.ok(summary, "Synthetic session not found in patched list");
  assert.deepEqual(summary, { ...original, cwd });

  phase = "load with corrected cwd";
  const from = events.length;
  await patched.send({ type: "session.open", requestId: "restore", sessionId: "restored", config: { ...config, cwd: summary.cwd }, persistence: summary.persistence, history: "replay" });
  const restored = await wait((e): e is Extract<ProviderEvent, { type: "session.opened" }> => e.type === "session.opened" && e.sessionId === "restored", from);
  await wait((e): e is Extract<ProviderEvent, { type: "session.ready" }> => e.type === "session.ready" && e.sessionId === "restored", from);
  assert.equal(restored.cwd, cwd);
  assert.deepEqual(restored.persistence, opened.persistence);
  const historyReplayed = events.slice(from).some((e) => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text.includes("CWD_IMPORT_OK"));
  assert.ok(historyReplayed, "Synthetic history was not replayed");
  console.log(JSON.stringify({ phase: "restored", identityPreserved: true, cwdCorrect: true, historyReplayed, encodingObserved, filterMatched }));
  assert.ok(filterMatched, "Native directory filtering did not include the synthetic session");
} catch {
  // Raw SDK errors can contain user paths, session IDs or authorization links.
  console.error(JSON.stringify({ phase, status: "failed", details: "withheld" }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([patched?.close(), raw?.close()]);
  await Promise.allSettled([...transports].map((transport) => transport.close()));
  await rm(root, { recursive: true, force: true });
}
