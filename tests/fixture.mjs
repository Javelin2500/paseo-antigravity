import readline from "node:readline";
import { writeFileSync } from "node:fs";
const send = (m) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (u) =>
  send({
    method: "session/update",
    params: { sessionId: "native", update: u },
  });
const ready = () =>
  update({ sessionUpdate: "available_commands_update", availableCommands: [] });
if (process.argv.includes("--version")) {
  console.log("1.5.15");
  process.exit(0);
}
if (process.argv.includes("/usage")) {
  console.log(
    JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini models",
              buckets: [
                {
                  id: "5h",
                  name: "5h Remaining",
                  window: "5h",
                  remaining_fraction: 0.75,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  process.exit(0);
}
let pending;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line),
    r = (result) => send({ id: m.id, result });
  if (m.method === "initialize") {
    if (process.env.SCENARIO === "init-error")
      send({
        id: m.id,
        error: { code: -32603, message: "fixture init failure" },
      });
    else r({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  }
  if (m.method === "session/new") {
    if (process.env.SCENARIO === "new-hang") return;
    if (process.env.SCENARIO === "new-error") {
      console.log("Open the following link to authenticate fixture");
      return;
    }
    r({ sessionId: "native", configOptions: [] });
    setTimeout(ready, 10);
  }
  if (m.method === "session/load") {
    r({});
    ready();
    update({
      sessionUpdate: "tool_call",
      toolCallId: "old-history",
      title: "history",
      kind: "execute",
      status: "in_progress",
      rawInput: {},
    });
    const frame =
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "REPLAY_" + "中".repeat(100000) },
          },
        },
      }) + "\n";
    const bytes = Buffer.from(frame);
    let pos = 0;
    const timer = setInterval(() => {
      const end = Math.min(pos + 50003, bytes.length);
      process.stdout.write(bytes.subarray(pos, end));
      pos = end;
      if (pos === bytes.length) clearInterval(timer);
    }, 60);
  }
  if (m.method === "session/close") {
    if (process.env.CLOSE_FILE) writeFileSync(process.env.CLOSE_FILE, "closed");
    r({});
  }
  if (m.method === "session/prompt") {
    const text = m.params.prompt[0].text;
    pending = m.id;
    if (text === "silent" || text === "ignore-cancel") return;
    if (text === "bad") {
      setTimeout(() => console.log("not ACP"), 20);
      return;
    }
    if (text === "tool" || text === "deferred-bad") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "live-tool",
        title: "live",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      if (text === "deferred-bad") {
        r({ stopReason: "end_turn" });
        setTimeout(() => console.log("not ACP"), 50);
      }
      return;
    }
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OK" },
    });
    r({ stopReason: "end_turn" });
    pending = undefined;
  }
  if (
    m.method === "session/cancel" &&
    process.env.SCENARIO !== "ignore-cancel" &&
    pending !== undefined
  ) {
    send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
  }
});
