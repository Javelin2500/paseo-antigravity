import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface GroupOps {
  signal(signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}
/** ESRCH is terminal: never signal that numeric group again after it has disappeared. */
export async function stopGroup(
  ops: GroupOps,
  graceMs = 1000,
): Promise<string | undefined> {
  let gone = false;
  const attempt = async (
    signal: NodeJS.Signals | 0,
  ): Promise<"ok" | "gone" | "denied"> => {
    if (gone) return "gone";
    for (let retry = 0; retry < 3; retry++) {
      try {
        ops.signal(signal);
        return "ok";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          gone = true;
          return "gone";
        }
        if (code !== "EPERM") return "denied";
        // macOS can return EPERM until SIGCHLD has reaped an exited leader.
        if (retry < 2) await ops.sleep(25);
      }
    }
    return "denied";
  };
  if ((await attempt("SIGTERM")) === "gone") return;
  const until = ops.now() + Math.max(0, graceMs);
  while (ops.now() < until) {
    const state = await attempt(0);
    if (state === "gone") return;
    if (state === "denied") break;
    await ops.sleep(20);
  }
  // A failed graceful signal must not skip the force-stop attempt.
  if ((await attempt("SIGKILL")) === "denied")
    return "无法确认 Antigravity 进程组已回收（系统拒绝信号）。请检查本机进程权限。";
}
const TASKKILL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
/** Windows has no process groups: taskkill /T walks the live tree from the leader.
 * shortcut: descendants whose parent chain to the leader is already broken are
 * not reached; switch to a Job Object if agy is observed leaving such orphans. */
export function windowsSignal(
  pid: number,
  signal: NodeJS.Signals | 0,
  run = (args: string[]) => spawnSync(TASKKILL, args, { windowsHide: true, stdio: "ignore" }).status,
) {
  if (signal === 0) return void process.kill(pid, 0);
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");
  const status = run(args);
  if (status === 0) return;
  // Exit codes are ambiguous: non-forced taskkill on a console-only tree returns 128
  // ("not found") while it is alive. Probe the leader; a refusal then reads like a
  // failed SIGTERM and the state machine forces after the grace period.
  process.kill(pid, 0);
  throw Object.assign(new Error(`taskkill exited with ${status}`), { code: "EIO" });
}
export function stopProcessGroup(pid: number | undefined, graceMs = 1000) {
  return pid === undefined
    ? Promise.resolve(undefined)
    : stopGroup(
        {
          signal: (s) => {
            if (process.platform === "win32") windowsSignal(pid, s);
            else process.kill(-pid, s);
          },
          sleep,
          now: Date.now,
        },
        graceMs,
      );
}
