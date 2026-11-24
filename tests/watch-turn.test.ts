import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
const frame = (w: Watch, direction: "in" | "out", m: object) =>
  w.observe(direction, {jsonrpc:"2.0", ...m} as AcpStreamMessage, 1);
const prompt = (w: Watch, id = 1) => {
  w.startTurn(`turn:${id}`, 0);
  frame(w, "out", {id,method:"session/prompt",params:{sessionId:"s"}});
};
const update = (w: Watch, u: object, sessionId = "s") =>
  frame(w, "in", {method:"session/update",params:{sessionId,update:u}});
const tool = (w: Watch, id: string, status: string, extra = {}) =>
  update(w, {sessionUpdate:"tool_call_update",toolCallId:id,status,...extra});
const text = (w: Watch, value = "text") =>
  update(w, {sessionUpdate:"agent_message_chunk",content:{type:"text",text:value}});

test("ordered live text, parallel terminals, failures and retired echoes", () => {
  const w = new Watch();
  prompt(w);
  text(w); tool(w, "a", "in_progress"); tool(w, "b", "in_progress");
  tool(w, "a", "completed"); text(w); tool(w, "b", "failed");
  assert.equal(w.turn!.trailingText, false);
  text(w, "  ");
  update(w, {sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"thought"}});
  assert.equal(w.turn!.trailingText, false);
  text(w); tool(w, "a", "completed"); tool(w, "b", "failed");
  assert.equal(w.turn!.trailingText, true);
  assert.equal(w.turn!.results, 2);
  assert.equal(w.turn!.completed, 1);
  assert.equal(w.turn!.failed, 1);
});
for (const [name, rawInput, detached] of [
  ["run_command", {IsDaemon:true}, true],
  ["schedule", {CronExpression:" * * * * * "}, true],
  ["other", {CronExpression:"* * * * *"}, false],
  ["schedule", {CronExpression:" "}, false],
] as const) test(`foreground policy: ${name} ${JSON.stringify(rawInput)}`, () => {
  const w = new Watch(); prompt(w);
  tool(w, "a", "in_progress", {name,rawInput}); text(w);
  tool(w, "a", "completed");
  assert.equal(w.turn!.results, 1);
  assert.equal(w.turn!.completed, detached ? 0 : 1);
  assert.equal(w.turn!.trailingText, detached);
});
test("replay echoes, synthetic completion, carry-over and other sessions do not count", () => {
  const w = new Watch();
  frame(w, "out", {id:0,method:"session/load",params:{sessionId:"s"}});
  tool(w, "history", "in_progress"); text(w);
  frame(w, "in", {id:0,result:{}});
  tool(w, "autonomous", "in_progress");
  prompt(w);
  tool(w, "carry", "in_progress");
  prompt(w, 2);
  tool(w, "history", "completed"); tool(w, "carry", "completed"); tool(w, "autonomous", "completed");
  tool(w, "synthetic", "pending"); w.finishTool("synthetic"); tool(w, "synthetic", "completed");
  tool(w, "cancelled", "cancelled");
  update(w, {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"other"}}, "other");
  assert.equal(w.turn!.results, 0);
  assert.equal(w.turn!.text, false);
});
test("wire reply does not end deferred observation; canceled replies retain cancellation", t => {
  t.mock.method(console, "log", () => {});
  const w = new Watch(); prompt(w); tool(w, "a", "in_progress");
  frame(w, "in", {id:1,result:{stopReason:"end_turn"}});
  tool(w, "a", "completed");
  assert.equal(w.turn!.completed, 1);
  assert.equal(w.turn!.trailingText, false);
  text(w);
  assert.equal(w.turn!.trailingText, true);
  prompt(w, 2);
  frame(w, "out", {method:"session/cancel",params:{sessionId:"s"}});
  frame(w, "in", {id:2,result:{stopReason:"end_turn"}});
  assert.equal(w.turn!.canceled, true);
});
test("wire diagnostics allow only metadata, never free-form stop/error content", t => {
  const log = t.mock.method(console, "log", () => {}), w = new Watch();
  prompt(w); text(w, "PRIVATE_TEXT");
  tool(w, "a", "failed", {rawInput:{path:"PRIVATE_PATH"},rawOutput:"PRIVATE_OUTPUT"});
  frame(w, "in", {id:1,result:{stopReason:"PRIVATE_REASON"},error:{code:-32001,message:"PRIVATE_ERROR"}});
  const [label, json] = log.mock.calls[0].arguments as [string, string];
  const data = JSON.parse(json);
  assert.equal(label, "[antigravity:prompt-end]");
  assert.equal(data.stopReason, "unknown");
  assert.equal(data.errorCode, -32001);
  assert.equal(data.responseAt, 1);
  assert.deepEqual(Object.keys(data).sort(), ["turnId", "nativeSessionId", "startedAt",
    "responseAt", "stopReason", "errorCode", "canceled", "replaced", "text", "trailingText",
    "results", "completed", "failed", "openTools"].sort());
  assert.ok(!JSON.stringify(data).includes("PRIVATE_"));
});
