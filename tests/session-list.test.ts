import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { provider } from "../server/provider.ts";

const mock = String.raw`
const rows = JSON.parse(process.env.FIXTURE_SESSIONS);
const send = m => console.log(JSON.stringify({jsonrpc:'2.0', ...m}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line), reply = result => send({id:m.id, result});
  if (m.method === 'initialize') reply({protocolVersion:1, agentCapabilities:{loadSession:true, sessionCapabilities:{list:{}}}});
  if (m.method === 'session/list') reply({sessions:rows});
  if (m.method === 'session/load') {
    if (m.params.sessionId !== rows[0].sessionId || m.params.cwd !== process.env.FIXTURE_CWD) {
      send({id:m.id, error:{code:-32602, message:'Session identity or cwd changed'}});
      return;
    }
    send({method:'session/update', params:{sessionId:m.params.sessionId, update:{sessionUpdate:'agent_message_chunk', content:{type:'text', text:rows[0].cwd}}}});
    reply({});
  }
  if (m.method === 'session/close') reply({});
});`;

for (const empty of [false, true]) {
  test(`real SDK normalizes session summaries without changing identity or history (empty=${empty})`, { timeout: 15000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "agy-session-list-"));
    let c: ProviderConnection | undefined;
    try {
      const chinese = join(root, "中文项目");
      const spaces = join(root, "space name");
      const literal = join(root, "literal%20name");
      for (const path of [chinese, spaces, literal, join(root, "literal name")]) mkdirSync(path);
      const encoded = join(root, encodeURIComponent("中文项目"));
      const inputs = [encoded, pathToFileURL(spaces).href, literal, join(root, "%ZZ"), join(root, "missing%20dir"), encoded];
      const expected = [chinese, spaces, literal, inputs[3], inputs[4], chinese];
      const sessions = empty ? [] : inputs.map((cwd, index) => ({
        sessionId: `fixture-${index}`,
        cwd,
        title: `Title %20 中文 ${index}`,
        updatedAt: "2026-01-01T00:00:00Z",
      }));
      c = await provider().connect({
        versions: [1],
        capabilities: ["session.list", "session.persistence"],
        launch: {
          command: process.execPath,
          args: ["-e", mock],
          env: {
            PATH: process.env.PATH!,
            FIXTURE_SESSIONS: JSON.stringify(sessions),
            FIXTURE_CWD: chinese,
          },
        },
      });
      const events: ProviderEvent[] = [];
      c.onEvent((e) => events.push(e));
      const wait = async (predicate: (e: ProviderEvent) => boolean) => {
        const event = events.find(predicate);
        if (event) return event;
        return new Promise<ProviderEvent>((resolve, reject) => {
          const timeout = setTimeout(() => {
            off();
            reject(new Error("Missing SDK event: " + JSON.stringify(events)));
          }, 5000);
          const off = c!.onEvent((e) => {
            if (e.type !== "request.failed" && !predicate(e)) return;
            clearTimeout(timeout);
            off();
            if (e.type === "request.failed") reject(new Error(e.error.message));
            else resolve(e);
          });
        });
      };
      await c.send({ type: "sessions", requestId: "list" });
      const listed = await wait((e) => e.type === "sessions");
      assert.deepEqual(listed, {
        type: "sessions",
        requestId: "list",
        sessions: sessions.map((s, index) => ({
          persistence: { version: 1, data: { sessionId: s.sessionId } },
          cwd: expected[index],
          title: s.title,
          updatedAt: s.updatedAt,
        })),
      });
      if (listed.type !== "sessions" || empty) return;
      // The corrected summary must be usable as a real process cwd and resume
      // the original native session. No production daemon or CLI is involved.
      await c.send({
        type: "session.open",
        requestId: "restore",
        sessionId: "restored",
        persistence: listed.sessions[0].persistence,
        history: "replay",
        config: {
          cwd: listed.sessions[0].cwd,
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await wait((e) => e.type === "session.ready" && e.sessionId === "restored");
      const opened = await wait((e) => e.type === "session.opened" && e.sessionId === "restored");
      assert.equal(opened.type === "session.opened" && opened.cwd, chinese);
      assert.ok(events.some((e) =>
        e.type === "timeline.item" &&
        e.item.type === "assistant_message" &&
        e.item.text === encoded,
      ));
      assert.equal(events.filter((e) => e.type === "sessions").length, 1);
    } finally {
      await c?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
