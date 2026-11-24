import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createTransport } from "../server/transport.ts";

test("slow consumption backpressures a large producer and preserves every frame", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-pressure-"));
  const marker = join(dir, "drained");
  const count = 2000;
  const payload = "中🙂".repeat(1000);
  const t = createTransport(
    { command: process.execPath, args: ["-e", `
      const {once}=require('node:events');
      (async()=>{
        for(let id=0;id<${count};id++){
          const line=JSON.stringify({jsonrpc:'2.0',id,result:{text:${JSON.stringify(payload)}}})+'\\n';
          if(!process.stdout.write(line)) await once(process.stdout,'drain');
        }
        process.stdout.write('',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'done'));
      })();
    `], env: {} },
    { cwd: dir, env: {} }, () => {},
  );
  const reader = t.stream.readable.getReader();
  let received = 0;
  const readOne = async () => {
    const next = await reader.read();
    assert.equal(next.done, false);
    const frame = next.value as { id: number; result: { text: string } };
    assert.equal(frame.id, received++);
    assert.equal(frame.result.text, payload);
  };
  try {
    for (let i = 0; i < 600; i++) {
      await readOne();
      await sleep(1);
    }
    await sleep(50);
    await assert.rejects(access(marker), "producer should still be blocked, not drained into an unbounded queue");
    while (received < count) await readOne();
    assert.equal((await reader.read()).done, true);
  } finally {
    await t.close();
    reader.releaseLock();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fragmented high-frequency text and tool updates keep exact order", { timeout: 10000 }, async () => {
  const count = 10000;
  const t = createTransport(
    { command: process.execPath, args: ["-e", `
      const {once}=require('node:events');
      (async()=>{
        const frames=[];
        for(let i=0;i<${count};i++) frames.push(JSON.stringify({
          jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:
            i%2===0
              ? {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中🙂'+i}}
              : {sessionUpdate:'tool_call_update',toolCallId:'t'+i,status:'completed',
                 content:[{type:'content',content:{type:'text',text:'结果'+i}}]}
          }
        }));
        const bytes=Buffer.from(frames.join('\\n')+'\\n');
        for(let offset=0;offset<bytes.length;offset+=4093){
          if(!process.stdout.write(bytes.subarray(offset,offset+4093)))
            await once(process.stdout,'drain');
        }
      })();
    `], env: {} },
    { cwd: tmpdir(), env: {} }, () => {},
  );
  try {
    const reader = t.stream.readable.getReader();
    for (let i = 0; i < count; i++) {
      const next = await reader.read();
      assert.equal(next.done, false);
      const frame = next.value as {
        params: { update: { content: { text?: string }; toolCallId?: string; rawOutput?: string } };
      };
      const update = frame.params.update;
      if (i % 2 === 0) assert.equal(update.content.text, "中🙂" + i);
      else {
        assert.equal(update.toolCallId, "t" + i);
        assert.equal(update.rawOutput, "结果" + i);
      }
    }
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
  } finally {
    await t.close();
  }
});

test("slow replay consumer preserves history before the native load response", { timeout: 5000 }, async () => {
  const t = createTransport(
    { command: process.execPath, args: ["-e", `
      const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        const history=i=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',
          update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:String(i)}}}});
        process.stdout.write(Array.from({length:20},(_,i)=>JSON.stringify(history(i))).join('\\n')+'\\n');
        setTimeout(()=>{
          for(let i=20;i<400;i++)send(history(i));
          send({jsonrpc:'2.0',id:m.id,result:{}});
        },50);
      });
    `], env: {} },
    { cwd: tmpdir(), env: {} }, () => {},
  );
  try {
    await t.stream.writable.getWriter().write({
      jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s", cwd: tmpdir(), mcpServers: [] },
    });
    const reader = t.stream.readable.getReader();
    let updates = 0;
    while (true) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      if (value && "id" in value && value.id === 1) {
        assert.equal(updates, 400, "load response must follow all replay updates");
        break;
      }
      updates++;
      if (updates === 1) await sleep(350);
    }
  } finally { await t.close(); }
});

test("cancel during output flood releases the transport promptly", { timeout: 5000 }, async () => {
  const t = createTransport(
    { command: process.execPath, args: ["-e", `
      const {once}=require('node:events');
      (async()=>{let id=0;while(true){
        if(!process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:id++,result:{text:'x'.repeat(8000)}})+'\\n'))
          await once(process.stdout,'drain');
      }})();
    `], env: {} },
    { cwd: tmpdir(), env: {} }, () => {},
  );
  try {
    const reader = t.stream.readable.getReader();
    await reader.read();
    const start = Date.now();
    await reader.cancel();
    await t.finished;
    assert.ok(Date.now() - start < 2000);
    reader.releaseLock();
  } finally {
    await t.close();
  }
});
