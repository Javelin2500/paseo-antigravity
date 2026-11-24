import test from "node:test";
import assert from "node:assert/strict";
import { LoadBoundary } from "../server/load-boundary.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

const chunk = (text:string, extra = {}): AcpStreamMessage => ({
  jsonrpc:"2.0",method:"session/update",params:{sessionId:"s",
    update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text},...extra}},
});
const update = (frame:AcpStreamMessage) => {
  assert.ok("params" in frame);
  return (frame.params as {update:Record<string,unknown>}).update;
};
const start = () => {
  const b = new LoadBoundary();
  b.outgoing({jsonrpc:"2.0",id:0,method:"session/load",params:{sessionId:"s"}});
  return b;
};
test("load boundary scopes first anonymous live run without rewriting history or native IDs", () => {
  const b = start(), history = chunk("history");
  assert.equal(b.incoming(history).frame,history);
  assert.equal(b.incoming({jsonrpc:"2.0",id:0,result:{}}).boundary,true);
  const a = update(b.incoming(chunk("A")).frame), z = update(b.incoming(chunk("B")).frame);
  assert.equal(a.messageId,z.messageId);
  assert.ok(a.messageId);
  assert.deepEqual(a.content,{type:"text",text:"A"});
  const native = chunk("C",{messageId:"native"});
  assert.equal(b.incoming(native).frame,native);
  const later = chunk("D");
  assert.equal(b.incoming(later).frame,later);
});
test("prompt and reload retire only their session's synthetic live run", () => {
  for (const method of ["session/prompt", "session/load"]) {
    for (const autonomous of [false, true]) {
      const b = start();
      b.incoming({jsonrpc:"2.0",id:0,result:{}});
      if (autonomous) b.incoming(chunk("autonomous"));
      b.outgoing({jsonrpc:"2.0",id:1,method,params:{sessionId:"other"}});
      assert.ok(update(b.incoming(chunk("still s")).frame).messageId);
      b.outgoing({jsonrpc:"2.0",id:2,method,params:{sessionId:"s"}});
      const reply = chunk("next");
      assert.equal(b.incoming(reply).frame,reply);
      b.outgoing({jsonrpc:"2.0",id:3,method:"session/prompt",params:{sessionId:"s"}});
      assert.equal(b.incoming(reply).frame,reply);
    }
  }
});
test("empty message IDs are anonymous just like the pinned SDK", () => {
  const b = start();
  b.incoming({jsonrpc:"2.0",id:0,result:{}});
  const first = update(b.incoming(chunk("A",{messageId:""})).frame);
  const second = update(b.incoming(chunk("B")).frame);
  assert.ok(first.messageId);
  assert.equal(first.messageId,second.messageId);
});

test("load errors do not create boundaries; tool/user/plan and thought transitions end the first run", () => {
  const b = start();
  assert.equal(b.incoming({jsonrpc:"2.0",id:0,error:{code:-32002,message:"missing"}}).boundary,false);
  const untouched = chunk("x");
  assert.equal(b.incoming(untouched).frame,untouched);
  for (const sessionUpdate of ["tool_call","user_message_chunk","plan","agent_thought_chunk"]) {
    const x = start();
    x.incoming({jsonrpc:"2.0",id:0,result:{}});
    x.incoming(chunk("first"));
    x.incoming(chunk("transition",{sessionUpdate}));
    assert.equal(x.incoming(untouched).frame,untouched);
  }
});
