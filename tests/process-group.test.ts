import test from "node:test";
import assert from "node:assert/strict";
import { stopGroup } from "../server/process-group.ts";
const err = (code: string) => Object.assign(new Error(code), { code });
test("ESRCH after EPERM retry is success, never signals a vanished group again", async () => {
  let calls = 0,
    now = 0;
  const result = await stopGroup({
    signal() {
      calls++;
      throw err(calls === 1 ? "EPERM" : "ESRCH");
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
  assert.equal(result, undefined);
  assert.equal(calls, 2);
});
test("persistent EPERM is bounded, tries force-stop and reports failure", async () => {
  const calls: Array<string | number> = [];
  let now = 0;
  const result = await stopGroup({
    signal(s) {
      calls.push(s);
      throw err("EPERM");
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
  assert.ok(result);
  assert.ok(calls.includes("SIGKILL"));
  assert.ok(now < 1500);
});
test("graceful failure still attempts SIGKILL; successful termination stops probing", async () => {
  const calls: Array<string | number> = [];
  let now = 0;
  const result = await stopGroup(
    {
      signal(s) {
        calls.push(s);
        if (s === "SIGTERM") throw err("EIO");
        if (s === "SIGKILL") throw err("ESRCH");
      },
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    },
    100,
  );
  assert.equal(result, undefined);
  assert.ok(calls.includes("SIGKILL"));
});
