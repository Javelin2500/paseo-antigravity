import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

export interface Limits {
  startup: number;
  silent: number;
  cancel: number;
  hint: number;
}
export const defaults: Limits = {
  startup: 90_000,
  silent: 900_000,
  cancel: 5_000,
  hint: 30_000,
};
type Id = string | number;
interface Call {
  method: string;
  session?: string;
  at: number;
}
interface Tool {
  status: string;
  detached: boolean;
}
interface Session {
  prompts: Set<Id>;
  tools: Map<string, Tool>;
  approvals: Set<Id>;
  progress: number;
  cancelAt?: number;
  noticed: boolean;
  replay: boolean;
  retiredTools: Set<string>;
}
export type WatchResult = { failure?: string; hints: string[] };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One state per native session. Policy does not interpret or mutate model payloads. */
export class Watch {
  private calls = new Map<Id, Call>();
  private sessions = new Map<string, Session>();
  private permissions = new Map<Id, string>();
  constructor(readonly limits: Limits = defaults) {}
  private session(id: string, now: number): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        prompts: new Set(),
        tools: new Map(),
        approvals: new Set(),
        progress: now,
        noticed: false,
        replay: false,
        retiredTools: new Set(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }
  private hasTools(s: Session) {
    return [...s.tools.values()].some((t) => !t.detached);
  }
  private disarmIdle(s: Session) {
    if (!s.prompts.size && !this.hasTools(s)) s.cancelAt = undefined;
  }
  private clearTransient(s: Session) {
    for (const id of s.tools.keys()) s.retiredTools.add(id);
    while (s.retiredTools.size > 2048)
      s.retiredTools.delete(s.retiredTools.values().next().value!);
    s.tools.clear();
    s.approvals.clear();
    for (const [id, sid] of this.permissions)
      if (this.sessions.get(sid) === s) this.permissions.delete(id);
    this.disarmIdle(s);
  }
  /** Only the SDK knows when a deferred turn really finishes. */
  settle() {
    for (const s of this.sessions.values())
      if (!s.prompts.size) this.clearTransient(s);
  }
  /** A suspended host is not a silent agent. Preserve operations started after wake. */
  resume(now: number, lastTick: number) {
    for (const c of this.calls.values()) if (c.at <= lastTick) c.at = now;
    for (const s of this.sessions.values()) {
      if (s.progress <= lastTick) s.progress = now;
      if (s.cancelAt !== undefined && s.cancelAt <= lastTick) s.cancelAt = now;
    }
  }
  observe(direction: "out" | "in", frame: AcpStreamMessage, now: number): void {
    const m = frame as unknown as Record<string, unknown>;
    const id =
      typeof m.id === "string" || typeof m.id === "number" ? m.id : undefined;
    const p = record(m.params);
    const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
    if (direction === "out") {
      if (typeof m.method === "string" && id !== undefined) {
        this.calls.set(id, { method: m.method, session: sid, at: now });
        if (m.method === "session/load" && sid)
          this.session(sid, now).replay = true;
        if (m.method === "session/prompt" && sid) {
          const s = this.session(sid, now);
          this.disarmIdle(s);
          if (!s.prompts.size && !this.hasTools(s)) s.noticed = false;
          s.replay = false;
          s.prompts.add(id);
          s.progress = now;
        }
      }
      if (m.method === "session/cancel" && sid) {
        const s = this.session(sid, now);
        if (s.prompts.size || this.hasTools(s)) s.cancelAt ??= now;
        else s.cancelAt = undefined;
      }
      if (!m.method && id !== undefined) {
        const session = this.permissions.get(id);
        if (session) {
          const s = this.session(session, now);
          s.approvals.delete(id);
          s.progress = now;
          this.permissions.delete(id);
        }
      }
      return;
    }
    if (!m.method && id !== undefined) {
      const call = this.calls.get(id);
      this.calls.delete(id);
      if (call?.method === "session/prompt" && call.session) {
        const s = this.session(call.session, now);
        s.prompts.delete(id);
        s.progress = now;
        // A terminal failure/cancel clears transient tools only once all wire prompts settled.
        if (
          !s.prompts.size &&
          (m.error !== undefined || record(m.result).stopReason === "cancelled")
        )
          this.clearTransient(s);
        this.disarmIdle(s);
      }
    }
    if (m.method === "session/request_permission" && sid && id !== undefined) {
      const s = this.session(sid, now);
      s.approvals.add(id);
      s.progress = now;
      this.permissions.set(id, sid);
    }
    if (m.method !== "session/update" || !sid) return;
    const u = record(p.update),
      s = this.session(sid, now);
    if (
      s.replay ||
      (typeof u.toolCallId === "string" && s.retiredTools.has(u.toolCallId))
    )
      return;
    if (
      [
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "compaction_update",
      ].includes(String(u.sessionUpdate))
    ) {
      s.progress = now;
    }
    if (typeof u.toolCallId === "string") {
      const old = s.tools.get(u.toolCallId),
        input = record(u.rawInput);
      const tool = {
        status:
          typeof u.status === "string" ? u.status : (old?.status ?? "pending"),
        detached:
          old?.detached === true ||
          input.IsDaemon === true ||
          (typeof input.CronExpression === "string" &&
            input.CronExpression.trim().length > 0),
      };
      if (["completed", "failed", "cancelled"].includes(tool.status))
        s.tools.delete(u.toolCallId);
      else s.tools.set(u.toolCallId, tool);
      this.disarmIdle(s);
    }
  }
  check(now: number): WatchResult {
    const hints: string[] = [];
    for (const call of this.calls.values()) {
      if (
        call.method !== "session/prompt" &&
        now - call.at >= this.limits.startup
      )
        return {
          failure: `Antigravity 在 ${call.method} 阶段超时。请检查本机 CLI 和网络后刷新会话。`,
          hints,
        };
    }
    for (const s of this.sessions.values()) {
      if (s.cancelAt !== undefined && now - s.cancelAt >= this.limits.cancel)
        return {
          failure:
            "Antigravity 未及时结束取消请求，已关闭本会话进程；未重发消息。",
          hints,
        };
      const tools = [...s.tools.values()].some((t) => !t.detached);
      if (s.approvals.size > 0) continue;
      if (!s.prompts.size && !tools) continue;
      if (!s.noticed && now - s.progress >= this.limits.hint) {
        s.noticed = true;
        hints.push(
          tools
            ? "Antigravity 仍有工具或子任务运行，暂未报告进展；不会仅因工具沉默而强杀。可点击停止。"
            : "Antigravity 暂未报告新进展。可继续等待或点击停止；不会自动重发。",
        );
      }
      if (s.prompts.size && !tools && now - s.progress >= this.limits.silent)
        return {
          failure:
            "Antigravity 连续无进展且没有待审批或运行中的工具，已关闭旧进程。请刷新会话后继续；未重发消息。",
          hints,
        };
    }
    return { hints };
  }
}
