import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
const limits = { startup: 90, silent: 150, cancel: 5, hint: 30 };
const prompt = (w: Watch, id = 1, at = 0) =>
  w.observe(
    "out",
    {
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId: "s" },
    },
    at,
  );
const response = (w: Watch, id = 1, stopReason = "end_turn", at = 1) =>
  w.observe("in", { jsonrpc: "2.0", id, result: { stopReason } }, at);
const cancel = (w: Watch, at = 2) =>
  w.observe(
    "out",
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    at,
  );
const tool = (w: Watch, status = "in_progress", at = 1) =>
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "tool_call", toolCallId: "old", status },
      },
    },
    at,
  );
test("host sleep rebases old clocks but not new cancellation", () => {
  const w = new Watch(limits);
  prompt(w);
  w.resume(10000, 10);
  assert.equal(w.check(10001).failure, undefined);
  assert.ok(w.check(10150).failure);
  const next = new Watch(limits);
  prompt(next);
  cancel(next, 9999);
  next.resume(10000, 10);
  assert.ok(next.check(10004).failure);
});
test("SDK terminalization clears ghost tools and ignores their late echoes", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  response(w);
  w.settle();
  tool(w, "in_progress", 4);
  assert.equal(w.check(40).hints.length, 0);
  prompt(w, 2, 50);
  assert.ok(w.check(201).failure);
});
test("new steering prompt must not disarm an outstanding cancellation", () => {
  const w = new Watch(limits);
  prompt(w);
  cancel(w);
  prompt(w, 2, 3);
  response(w, 2, "end_turn", 4);
  assert.ok(w.check(7).failure);
});
test("idle cancel never arms deadline or poisons next prompt", () => {
  const w = new Watch(limits);
  prompt(w);
  response(w);
  cancel(w);
  assert.equal(w.check(7).failure, undefined);
  prompt(w, 2, 8);
  assert.equal(w.check(9).failure, undefined);
});
test("cancel deadline clears when post-response tools all finish", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  response(w);
  cancel(w);
  tool(w, "completed", 3);
  assert.equal(w.check(7).failure, undefined);
});
test("load replay tools do not block later inactivity detection", () => {
  const w = new Watch(limits);
  w.observe(
    "out",
    {
      jsonrpc: "2.0",
      id: 10,
      method: "session/load",
      params: { sessionId: "s" },
    },
    0,
  );
  tool(w);
  w.observe("in", { jsonrpc: "2.0", id: 10, result: {} }, 2);
  tool(w, "in_progress", 3);
  assert.equal(w.check(40).hints.length, 0);
  prompt(w, 1, 50);
  assert.ok(w.check(201).failure);
});
test("cancelled prompt clears ghost tools and approvals", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  response(w, 1, "cancelled", 2);
  assert.equal(w.check(40).hints.length, 0);
  prompt(w, 2, 50);
  assert.ok(w.check(201).failure);
});
test("RPC error clears ghost tools", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  w.observe(
    "in",
    { jsonrpc: "2.0", id: 1, error: { code: -1, message: "fixture" } },
    2,
  );
  prompt(w, 2, 50);
  assert.ok(w.check(201).failure);
});
test("one progress notice per turn, not per silence interval", () => {
  const w = new Watch(limits);
  prompt(w);
  assert.equal(w.check(30).hints.length, 1);
  tool(w, "in_progress", 31);
  assert.equal(w.check(62).hints.length, 0);
});
