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
  if (process.env.SCENARIO === "slow-init")
    await new Promise((resolve) => setTimeout(resolve, 60));
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
    if (process.env.SCENARIO === "login-required") {
      console.log(
        "Open the following link to authenticate https://accounts.google.com/?code=fixture-do-not-show",
      );
      return;
    }
    if (process.env.SCENARIO === "slow-init") {
      setTimeout(
        () =>
          r({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        120,
      );
      return;
    }
    if (process.env.SCENARIO === "init-hang") return;
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
    if (process.env.SCENARIO === "late-history") {
      setTimeout(() => {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "LATE_HISTORY" },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "late-ghost",
          title: "late",
          kind: "execute",
          status: "in_progress",
          rawInput: {},
        });
      }, 260);
      return;
    }
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
    if (text === "pending-only") {
      update({ sessionUpdate: "tool_call", toolCallId: "pending-only", title: "pending", status: "pending", kind: "execute", rawInput: {} });
      r({ stopReason: "max_tokens" });
      pending = undefined;
      return;
    }
    if (["content-shell", "content-mcp", "content-diff", "content-native", "content-cleared"].includes(text)) {
      const shell = ["content-shell", "content-native", "content-cleared"].includes(text), diff = text === "content-diff";
      update({
        sessionUpdate: "tool_call",
        toolCallId: "content-tool",
        name: shell ? "run_command" : diff ? "edit_file" : "mcp_paseo_fixture",
        title: "fixture",
        kind: shell ? "execute" : diff ? "edit" : "other",
        status: "in_progress",
        rawInput: shell ? { CommandLine: "printf fixture" } : {},
        ...(text === "content-native" ? { rawOutput: { output: "native", exit_code: 0 } } : {}),
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "content-tool",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "partial" } }],
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "content-tool",
        status: "completed",
        content: text === "content-cleared" ? [] : diff
          ? [{ type: "diff", path: "/tmp/fixture", oldText: "before", newText: "after" }]
          : [{ type: "content", content: { type: "text", text: "完整结果\n" } }],
      });
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "background-first") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "bg1",
        title: "background",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "background-follow") {
      setTimeout(() => {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "bg1",
          status: "completed",
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "DONE" },
        });
        r({ stopReason: "end_turn" });
        pending = undefined;
      }, 450);
      return;
    }
    if (text === "empty") {
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "silent" || text === "ignore-cancel") return;
    if (text === "exit-17") {
      process.exit(17);
    }
    if (text === "signal-term") {
      process.kill(process.pid, "SIGTERM");
      return;
    }
    if (text === "bad") {
      setTimeout(() => console.log("not ACP"), 20);
      return;
    }
    if (text === "tool" || text === "deferred-bad" || text === "tool-error") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "live-tool",
        title: "live",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      if (text === "tool-error") {
        send({
          id: m.id,
          error: { code: -32001, message: "fixture tool failure" },
        });
        pending = undefined;
        return;
      }
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
