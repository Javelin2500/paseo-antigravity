import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createTransport } from "../server/transport.ts";
const make = (code: string) =>
  createTransport(
    { command: process.execPath, args: ["-e", code], env: {} },
    { cwd: process.cwd(), env: {} },
    () => {},
  );
test("flushes final UTF8 frame without newline", async () => {
  const t = make(
    `const x=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,result:{text:'中文'}}));process.stdout.write(x.subarray(0,x.length-3));setTimeout(()=>process.stdout.write(x.subarray(x.length-3)),10);`,
  );
  try {
    const r = t.stream.readable.getReader();
    assert.deepEqual((await r.read()).value, {
      jsonrpc: "2.0",
      id: 1,
      result: { text: "中文" },
    });
    assert.equal((await r.read()).done, true);
  } finally {
    await t.close();
  }
});
// Windows: closing the child's fd 0 does not fail parent writes, so the stdin
// reader exits instead while a detached descendant still holds stdout.
const epipe =
  process.platform === "win32"
    ? `require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{final:true}})),300)"],{stdio:['ignore','inherit','ignore'],detached:true}).unref();process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{ready:true}})+'\\n',()=>process.exit(0));`
    : `require('node:fs').closeSync(0);console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{ready:true}}));setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{final:true}})),30);setTimeout(()=>process.exit(0),70);`;
test("stdin EPIPE cannot discard a final stdout reply", async () => {
  const t = make(epipe);
  try {
    const r = t.stream.readable.getReader();
    await r.read();
    if (process.platform === "win32") await sleep(100);
    await assert.rejects(
      t.stream.writable
        .getWriter()
        .write({ jsonrpc: "2.0", id: 5, method: "fixture", params: {} }),
    );
    assert.deepEqual((await r.read()).value, {
      jsonrpc: "2.0",
      id: 2,
      result: { final: true },
    });
    assert.equal((await r.read()).done, true);
  } finally {
    await t.close();
  }
});
test(
  "slow consumer retains queued output beyond exit drain timeout",
  { timeout: 5000 },
  async () => {
    const t = make(
      `for(let i=0;i<4;i++)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:i,result:{text:'x'.repeat(100000)}})+'\\n');`,
    );
    try {
      const r = t.stream.readable.getReader();
      const got = [(await r.read()).value];
      await sleep(1200);
      while (true) {
        const n = await r.read();
        if (n.done) break;
        got.push(n.value);
      }
      assert.equal(got.length, 4);
      assert.deepEqual(
        got.map((m) => (m && "id" in m ? m.id : null)),
        [0, 1, 2, 3],
      );
    } finally {
      await t.close();
    }
  },
);
