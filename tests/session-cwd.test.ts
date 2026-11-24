import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSessionCwd, normalizeSessionCwds } from "../server/session-cwd.ts";

const filesystem = (probe: (path: string) => { isDirectory(): boolean }) => ({
  lstat: probe,
  stat: probe,
});

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "agy-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { root, dir };
}

for (const name of ["中文项目", "space name", "café 🚀", "a+b #?%&", "中文/嵌套 项目"]) {
  test(`decodes one existing absolute directory: ${name}`, (t) => {
    const { root, dir } = fixture(t);
    const actual = dir(name);
    const encoded = join(root, name.split("/").map(encodeURIComponent).join("/"));
    assert.equal(normalizeSessionCwd(encoded), actual);
    assert.equal(normalizeSessionCwd(encoded.replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase())), actual);
    assert.equal(normalizeSessionCwd(actual), actual);
  });
}

test("existing literal percent directory wins even if decoded directory exists", (t) => {
  const { dir } = fixture(t);
  for (const name of ["literal%20name", "%E4%B8%AD", "%2520", "%ZZ", "percent%", "%2F", "%5C", "%00"]) {
    const actual = dir(name);
    if (!/^(?:%ZZ|percent%|%2F|%5C|%00)$/.test(name)) dir(decodeURIComponent(name));
    assert.equal(normalizeSessionCwd(actual), actual);
  }
});

test("decodes at most once, including file URLs", (t) => {
  const { root, dir } = fixture(t);
  const literal = dir("one%20pass");
  dir("one pass");
  assert.equal(normalizeSessionCwd(join(root, "one%2520pass")), literal);
  assert.equal(normalizeSessionCwd(pathToFileURL(literal).href), literal);
  dir("two passes");
  const missingIntermediate = join(root, "two%2520passes");
  assert.equal(normalizeSessionCwd(missingIntermediate), missingIntermediate);
});

test("keeps missing paths and files instead of claiming they are directories", (t) => {
  const { root, dir } = fixture(t);
  const absent = join(root, "absent%20directory");
  assert.equal(normalizeSessionCwd(absent), absent);
  writeFileSync(join(root, "decoded file"), "fixture");
  const encodedFile = join(root, "decoded%20file");
  assert.equal(normalizeSessionCwd(encodedFile), encodedFile);
  writeFileSync(join(root, "literal%20file"), "fixture");
  dir("literal file");
  const literalFile = join(root, "literal%20file");
  assert.equal(normalizeSessionCwd(literalFile), literalFile);
});

test("does not canonicalize existing symlinks", (t) => {
  const { root, dir } = fixture(t);
  const actual = dir("target");
  const literalLink = join(root, "literal%20link");
  symlinkSync(actual, literalLink);
  dir("literal link");
  assert.equal(normalizeSessionCwd(literalLink), literalLink);
  const decodedLink = join(root, "decoded link");
  symlinkSync(actual, decodedLink);
  assert.equal(normalizeSessionCwd(join(root, "decoded%20link")), decodedLink);
});

test("preserves dangling literal symlinks instead of selecting another directory", (t) => {
  const { root, dir } = fixture(t);
  const original = join(root, "literal%20link");
  symlinkSync(join(root, "missing-target"), original);
  dir("literal link");
  assert.equal(normalizeSessionCwd(original), original);
});

test("preserves pathless file URLs but converts explicit root URLs", () => {
  for (const url of ["file://", "file://localhost", "FILE://", "FILE://LOCALHOST"]) {
    unchangedWithoutStat(url);
  }
  for (const url of ["file:/", "file:///", "file://localhost/", "FILE://LOCALHOST/"]) {
    assert.equal(normalizeSessionCwd(url), "/");
  }
});

test("converts explicit local file URLs with Node URL semantics", (t) => {
  const { root, dir } = fixture(t);
  for (const name of ["中文项目", "space name", "a+b #?%&", "literal%20name"]) {
    const actual = dir(name);
    const url = pathToFileURL(actual).href;
    assert.equal(normalizeSessionCwd(url), actual);
    assert.equal(normalizeSessionCwd(url.replace(/^file:/, "FILE:")), actual);
    assert.equal(normalizeSessionCwd(url.replace("file:///", "file://localhost/")), actual);
  }
  const missing = join(root, "missing directory");
  assert.equal(normalizeSessionCwd(pathToFileURL(missing).href), missing);
});

const noStat = () => { throw new Error("Unexpected filesystem lookup"); };
// Count calls as well: the normalizer intentionally catches filesystem errors.
function unchangedWithoutStat(input: string) {
  let calls = 0;
  assert.equal(normalizeSessionCwd(input, filesystem(() => { calls++; return noStat(); })), input);
  assert.equal(calls, 0);
}

test("leaves relative paths, other schemes and plain paths untouched", () => {
  for (const path of ["", "relative%20dir", "./%E4%B8%AD", "../space%20name", "~/space%20name", "https://example.test/a%20b", "C:\\a%20b", "/plain/中文/./dir", "/plain/a+b"]) {
    unchangedWithoutStat(path);
  }
});

test("leaves malformed encoding and ambiguous file URLs untouched", () => {
  for (const path of ["/tmp/%", "/tmp/%ZZ", "/tmp/%E4%B8", "/tmp/%FF", "file:relative", "file:///tmp/%ZZ", "file://remote.test/tmp/name", "file:///tmp/a?query", "file:///tmp/a#fragment", "file:///tmp/a\\b", "file:///tmp/a\nb", "file:///tmp/space name"]) {
    unchangedWithoutStat(path);
  }
});

test("never decodes separators, NULs or dot-segment traversal", () => {
  for (const name of ["a%2Fb", "a%2fb", "a%5Cb", "a%5cb", "a%00b", "a\0b", "%2e", "%2E%2e", ".%2e", "%2e."]) {
    unchangedWithoutStat(`/tmp/${name}/child`);
    unchangedWithoutStat(`file:///tmp/${name}/child`);
  }
});

for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
  test(`preserves original path on ${code}, without probing decoded path`, () => {
    const calls: string[] = [];
    const input = "/fixture/space%20name";
    assert.equal(normalizeSessionCwd(input, filesystem((path) => {
      calls.push(path);
      throw Object.assign(new Error("fixture"), { code });
    })), input);
    assert.deepEqual(calls, [input]);
  });
}

test("candidate stat errors are contained and explicit ENOENT is required", () => {
  const input = "/fixture/space%20name";
  for (const error of [
    Object.assign(new Error("fixture"), { code: "EACCES" }),
    new Error("unknown"),
    null,
    undefined,
  ]) {
    const calls: string[] = [];
    assert.equal(normalizeSessionCwd(input, filesystem((path) => {
      calls.push(path);
      if (path === input) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    })), input);
    assert.deepEqual(calls, [input, "/fixture/space name"]);
    assert.equal(normalizeSessionCwd(input, filesystem(() => { throw error; })), input);
  }
});

test("probes the literal entry with lstat and the decoded directory with stat", () => {
  const calls: string[] = [];
  const fs = {
    lstat(path: string) {
      calls.push(`lstat:${path}`);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    stat(path: string) {
      calls.push(`stat:${path}`);
      return { isDirectory: () => true };
    },
  };
  assert.equal(normalizeSessionCwd("/fixture/a%20b", fs), "/fixture/a b");
  assert.deepEqual(calls, ["lstat:/fixture/a%20b", "stat:/fixture/a b"]);
});

test("normalizes each distinct cwd once per event without mutating summaries", () => {
  const sessions = Object.freeze(Array.from({ length: 100 }, (_, i) => Object.freeze({
    cwd: i % 2 ? "/fixture/a%20b" : "",
    persistence: Object.freeze({ version: 1, data: { sessionId: `session-${i}` } }),
    title: `title %20 ${i}`,
    description: "description 中文",
    updatedAt: "2026-01-01T00:00:00Z",
  })));
  const calls: string[] = [];
  const result = normalizeSessionCwds(sessions, (cwd) => {
    calls.push(cwd);
    return cwd.replace("%20", " ");
  });
  assert.deepEqual(calls, ["", "/fixture/a%20b"]);
  result.forEach((session, i) => {
    assert.deepEqual(session, { ...sessions[i], cwd: i % 2 ? "/fixture/a b" : "" });
    assert.equal(session.persistence, sessions[i].persistence);
  });
  assert.equal(sessions[1].cwd, "/fixture/a%20b");
});

test("later session-list events recheck paths rather than reusing stale results", (t) => {
  const { root, dir } = fixture(t);
  const cwd = join(root, "new%20directory");
  const sessions = [{ cwd, persistence: { version: 1, data: { sessionId: "fixture" } } }];
  assert.equal(normalizeSessionCwds(sessions)[0].cwd, cwd);
  const decoded = dir("new directory");
  assert.equal(normalizeSessionCwds(sessions)[0].cwd, decoded);
  dir("new%20directory");
  assert.equal(normalizeSessionCwds(sessions)[0].cwd, cwd);
});
