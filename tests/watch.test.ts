import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
const limits = { startup: 90, silent: 150, cancel: 5, hint: 30 };
const out = (
  w: Watch,
  id: number,
  method = "session/prompt",
  sid = "s",
  at = 0,
) =>
  w.observe(
    "out",
    { jsonrpc: "2.0", id, method, params: { sessionId: sid } },
    at,
  );
const response = (w: Watch, id: number, at = 1) =>
  w.observe(
    "in",
    { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } },
    at,
  );
const update = (
  w: Watch,
  id: string,
  status: string,
  at = 1,
  sid = "s",
  extra = {},
) =>
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status,
          ...extra,
        },
      },
    },
    at,
  );
const cancel = (w: Watch, at = 0) =>
  w.observe(
    "out",
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    at,
  );

test("silent prompt has a hint then a bounded failure", () => {
  const w = new Watch(limits);
  out(w, 1);
  assert.equal(w.check(30).hints.length, 1);
  assert.match(w.check(150).failure!, /无进展/);
});
test("normal long tools are never killed for silence", () => {
  const w = new Watch(limits);
  out(w, 1);
  update(w, "a", "in_progress");
  assert.equal(w.check(10000).failure, undefined);
  assert.equal(w.check(10001).hints.length, 0);
});
test("new post-response tool has its own progress hint", () => {
  const w = new Watch(limits);
  out(w, 1);
  update(w, "a", "in_progress");
  response(w, 1, 2);
  update(w, "a", "completed", 3);
  update(w, "b", "in_progress", 4);
  assert.equal(w.check(34).hints.length, 1);
  cancel(w, 35);
  assert.match(w.check(40).failure!, /取消/);
});
test("cancel stays armed until every overlapping prompt settles", () => {
  const w = new Watch(limits);
  out(w, 1);
  out(w, 2);
  cancel(w, 10);
  response(w, 2, 11);
  assert.match(w.check(15).failure!, /取消/);
});
test("confirmed cancellation disarms deadline", () => {
  const w = new Watch(limits);
  out(w, 1);
  cancel(w, 10);
  response(w, 1, 11);
  assert.equal(w.check(20).failure, undefined);
});
test("permission wait pauses silence but never pauses cancellation", () => {
  const w = new Watch(limits);
  out(w, 1);
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      id: "p",
      method: "session/request_permission",
      params: { sessionId: "s" },
    },
    1,
  );
  assert.equal(w.check(1000).failure, undefined);
  cancel(w, 1001);
  assert.match(w.check(1006).failure!, /取消/);
});
test("permission answer resets inactivity baseline", () => {
  const w = new Watch(limits);
  out(w, 1);
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      id: "p",
      method: "session/request_permission",
      params: { sessionId: "s" },
    },
    1,
  );
  w.observe("out", { jsonrpc: "2.0", id: "p", result: {} }, 1000);
  assert.equal(w.check(1001).failure, undefined);
  assert.ok(w.check(1150).failure);
});
test("other sessions cannot keep silent prompt alive", () => {
  const w = new Watch(limits);
  out(w, 1);
  update(w, "alien", "in_progress", 149, "other");
  assert.ok(w.check(150).failure);
});
test("usage heartbeats do not reset silence", () => {
  const w = new Watch(limits);
  out(w, 1);
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "usage_update" } },
    },
    149,
  );
  assert.ok(w.check(150).failure);
});
test("completed and detached tools do not block silent detection", () => {
  for (const detached of [false, true]) {
    const w = new Watch(limits);
    out(w, 1);
    update(
      w,
      "a",
      detached ? "in_progress" : "completed",
      1,
      "s",
      detached ? { rawInput: { IsDaemon: true } } : {},
    );
    assert.ok(w.check(151).failure);
  }
});
test("initialize and model selection also have deadlines", () => {
  for (const m of ["initialize", "session/set_config_option"]) {
    const w = new Watch(limits);
    out(w, 1, m);
    assert.ok(w.check(90).failure);
    response(w, 1, 91);
    assert.equal(w.check(200).failure, undefined);
  }
});
