import test from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../server/transport.ts";

async function roundTrip(update: Record<string, unknown>, prior: Record<string, unknown>[] = []) {
  const frame = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } };
  const frames = [...prior, update].map(update => ({ ...frame, params: { sessionId: "s", update } }));
  const transport = createTransport(
    { command: process.execPath, args: ["-e", `console.log(${JSON.stringify(frames.map(frame => JSON.stringify(frame)).join("\n"))})`], env: {} },
    { cwd: process.cwd(), env: {} },
    () => {},
  );
  try {
    const reader = transport.stream.readable.getReader();
    for (let i = 0; i < prior.length; i++) await reader.read();
    const next = await reader.read();
    return (next.value as typeof frame).params.update;
  } finally {
    await transport.close();
  }
}
const text = (value: string) => ({ type: "content", content: { type: "text", text: value } });
for (const sessionUpdate of ["tool_call", "tool_call_update"]) {
  test(`${sessionUpdate} content text is exposed without changing original content`, async () => {
    const content = [text("中文\n"), text("second")];
    const got = await roundTrip({ sessionUpdate, toolCallId: "t", content });
    assert.equal(got.rawOutput, "中文\n\nsecond");
    assert.deepEqual(got.content, content);
  });
}
for (const rawOutput of [null, "", { output: "native", exit_code: 0 }]) {
  test(`explicit rawOutput ${JSON.stringify(rawOutput)} is preserved`, async () => {
    const got = await roundTrip({ sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput, content: [text("fallback")] });
    assert.deepEqual(got.rawOutput, rawOutput);
  });
}
test("diff and non-text content are preserved without inventing text", async () => {
  const content = [{ type: "diff", path: "/tmp/a", oldText: "a", newText: "b" }, { type: "content", content: { type: "image", data: "fixture", mimeType: "image/png" } }];
  const got = await roundTrip({ sessionUpdate: "tool_call_update", toolCallId: "t", content });
  assert.deepEqual(got.content, content);
  assert.equal(got.rawOutput, undefined);
});
test("status-only updates do not synthesize an empty output", async () => {
  const got = await roundTrip({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" });
  assert.equal(got.rawOutput, undefined);
});
