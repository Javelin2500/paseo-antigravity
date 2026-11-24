import test from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../server/transport.ts";
import { ToolResultMapper } from "../server/tool-results.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

async function sequence(updates: Record<string, unknown>[]) {
  const frames = updates.map(update => ({
    jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: {
      sessionUpdate: "tool_call_update", toolCallId: "t", ...update,
    } },
  }));
  const t = createTransport(
    { command: process.execPath, args: ["-e", `console.log(${JSON.stringify(frames.map(f => JSON.stringify(f)).join("\n"))})`], env: {} },
    { cwd: process.cwd(), env: {} }, () => {},
  );
  try {
    const reader = t.stream.readable.getReader();
    const output: Record<string, unknown>[] = [];
    for (const _ of frames) {
      const { value } = await reader.read();
      output.push((value as typeof frames[number]).params.update);
    }
    return output;
  } finally { await t.close(); }
}
test("mapper provenance is session-scoped and cleared on transport close", () => {
  const mapper = new ToolResultMapper();
  const frame = (sessionId: string, update: Record<string, unknown>) => ({
    jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "same", ...update,
    } },
  } as AcpStreamMessage);
  const get = (sessionId: string) => mapper.map(frame(sessionId, { content: text("new") })) as {
    params: { update: { rawOutput?: unknown } };
  };
  mapper.map(frame("a", { rawOutput: null, status: "completed" }));
  assert.equal(get("b").params.update.rawOutput, "new");
  assert.equal(get("a").params.update.rawOutput, undefined);
  mapper.clear();
  assert.equal(get("a").params.update.rawOutput, "new");
});
const text = (s: string) => [{ type: "content", content: { type: "text", text: s } }];
for (const content of [[], null, [{ type: "content", content: { type: "image", mimeType: "image/png", data: "x" } }], [{ type: "diff", path: "/tmp/f", oldText: "a", newText: "b" }]]) {
  test(`replacement content clears prior synthetic output: ${JSON.stringify(content)}`, async () => {
    const result = await sequence([{ content: text("partial") }, { content }]);
    assert.equal(result[1].rawOutput, null);
    assert.deepEqual(result[1].content, content);
  });
}
for (const rawOutput of [null, "", { output: "native", exit_code: 0 }]) {
  test(`native output remains authoritative across frames: ${JSON.stringify(rawOutput)}`, async () => {
    const result = await sequence([{ rawOutput }, { content: text("summary") }, { content: [] }]);
    assert.deepEqual(result[0].rawOutput, rawOutput);
    assert.equal(result[1].rawOutput, undefined);
    assert.equal(result[2].rawOutput, undefined);
  });
}
test("status-only update preserves synthetic text, and later native output takes precedence", async () => {
  const result = await sequence([
    { content: text("partial") }, { status: "in_progress" },
    { rawOutput: { output: "native", exit_code: 0 } }, { content: text("summary") },
  ]);
  assert.equal(result[1].rawOutput, undefined);
  assert.equal(result[3].rawOutput, undefined);
});
