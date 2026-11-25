import { lstatSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";

type StatPath = (path: string) => { isDirectory(): boolean };

/** Normalize ACP session summaries only; never rewrite persistence or history. */
export function normalizeSessionCwd(
  cwd: string,
  fs: { lstat: StatPath; stat: StatPath } = { lstat: lstatSync, stat: statSync },
): string {
  // Do not introduce separators, NULs, or encoded dot-segment traversal.
  // fileURLToPath alone does not reject %5C or %00 on POSIX.
  if (
    /%(?:2f|5c|00)/i.test(cwd) ||
    cwd.includes("\0") ||
    cwd.split(/[\\/]/).some((segment) => {
      if (!/%2e/i.test(segment)) return false;
      const decoded = segment.replace(/%2e/gi, ".");
      return decoded === "." || decoded === "..";
    })
  )
    return cwd;

  if (/^file:/i.test(cwd)) {
    // A file URL is unambiguous: convert once, even if its directory has gone.
    // Reject relative/ambiguous URLs rather than letting URL parsing silently
    // strip controls, reinterpret backslashes, or discard query/fragment data.
    // An authority without a path (file:// or file://localhost) must not
    // silently become the root directory. Explicit file:/// is still valid.
    if (
      !/^file:(?:\/(?!\/)|\/\/(?:localhost)?\/)/i.test(cwd) ||
      /[\\?#\u0000-\u0020]/.test(cwd)
    )
      return cwd;
    try {
      return fileURLToPath(cwd);
    } catch {
      return cwd;
    }
  }

  if (!isAbsolute(cwd) || !cwd.includes("%")) return cwd;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cwd);
  } catch {
    return cwd;
  }
  if (decoded === cwd) return cwd;

  // At most two synchronous probes per candidate preserve SDK event ordering,
  // not a time bound on slow mounts. Existing entries (including dangling
  // symlinks) win. Only ENOENT permits guessing; other errors are not absence.
  try {
    fs.lstat(cwd);
    return cwd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") return cwd;
  }
  try {
    return fs.stat(decoded).isDirectory() ? decoded : cwd;
  } catch {
    return cwd;
  }
}

/** Cache only within one event: later lists must observe filesystem changes. */
export function normalizeSessionCwds(
  sessions: readonly ProviderSessionSummary[],
  normalize: (cwd: string) => string = normalizeSessionCwd,
): ProviderSessionSummary[] {
  const cache = new Map<string, string>();
  return sessions.map((session) => {
    let cwd = cache.get(session.cwd);
    if (cwd === undefined) {
      cwd = normalize(session.cwd);
      cache.set(session.cwd, cwd);
    }
    return { ...session, cwd };
  });
}
