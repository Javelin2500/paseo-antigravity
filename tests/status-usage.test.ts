import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { provider } from "../server/provider.ts";
import { Usage } from "../server/usage.ts";
const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
const launch = (scenario = "") => ({
  command: process.execPath,
  args: [fixture, "acp"],
  env: { SCENARIO: scenario, SSH_TTY: "fixture" },
});
test("status validates ACP handshake, not just executable version", async () => {
  const p = provider();
  const good = await p.status!({ launch: launch() });
  assert.equal(good.available, true);
  assert.match(good.diagnostic!, /SSH_TTY/);
  assert.equal(
    (await p.status!({ launch: launch("init-error") })).available,
    false,
  );
});
test("installation inspect preserves custom prefix without acp", async () => {
  const p = provider();
  const result = await p.installation!.inspect!({
    launch: { ...launch(), args: [fixture], resolved: true },
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "installed");
  if (result.status === "installed") assert.equal(result.version, "1.5.15");
});
test("Plus usage source discovers account and parses official usage format", async () => {
  const s = new Usage().registration();
  assert.equal(s.provider, "antigravity-plus");
  const accounts = await s.discover({ kind: "global", launch: launch() });
  assert.equal(accounts.length, 1);
  const result = await s.fetch(accounts[0]!.input);
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0]?.usedPct, 25);
  }
  assert.deepEqual(
    await s.discover({
      kind: "session",
      provider: "other",
      env: {},
      launch: launch(),
    }),
    [],
  );
});
