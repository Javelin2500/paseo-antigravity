import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

export interface Limits {
  startup: number;
  silent: number;
  cancel: number;
}
export const defaults: Limits = {
  startup: 90_000,
  silent: 900_000,
  cancel: 5_000,
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
  cancelPrompts: Map<Id, number>;
  cancelTools: Map<string, number>;
  replay: boolean;
  retiredTools: Set<string>;
}
export type WatchResult = { failure?: string };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One state per native session. Policy does not interpret or mutate model payloads. */
export class Watch {
  private calls = new Map<Id, Call>();
  private sessions = new Map<string, Session>();
  private permissions = new Map<Id, string>();
  constructor(
    readonly limits: Limits = defaults,
    private readonly onToolResult: () => void = () => {},
  ) {}
  private session(id: string, now: number): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        prompts: new Set(),
        tools: new Map(),
        approvals: new Set(),
        progress: now,
        cancelPrompts: new Map(),
        cancelTools: new Map(),
        replay: false,
        retiredTools: new Set(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }
  private retireTool(s: Session, id: string) {
    s.tools.delete(id);
    s.cancelTools.delete(id);
    s.retiredTools.add(id);
    while (s.retiredTools.size > 2048)
      s.retiredTools.delete(s.retiredTools.values().next().value!);
  }
  /** A completed turn can preserve background tools. Only actual tool terminal events retire them. */
  finishTool(id: string) {
    for (const s of this.sessions.values())
      if (!s.replay && s.tools.has(id)) this.retireTool(s, id);
  }
  /** Reset pre-suspension clocks, including the final timer slice, but preserve fresh post-wake work. */
  resume(now: number, lastTick: number) {
    const rebase = (at: number) =>
      (now < lastTick && at > now) || now - at > 5000 ? now : at;
    for (const c of this.calls.values()) c.at = rebase(c.at);
    for (const s of this.sessions.values()) {
      s.progress = rebase(s.progress);
      for (const [id, at] of s.cancelPrompts)
        s.cancelPrompts.set(id, rebase(at));
      for (const [id, at] of s.cancelTools) s.cancelTools.set(id, rebase(at));
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
          s.replay = false;
          s.prompts.add(id);
          s.progress = now;
        }
      }
      if (m.method === "session/cancel" && sid) {
        const s = this.session(sid, now);
        // Snapshot only the targets that exist now. Repeated Stop keeps each old
        // target's first deadline; newly targeted work receives its own deadline.
        for (const id of s.prompts)
          if (!s.cancelPrompts.has(id)) s.cancelPrompts.set(id, now);
        for (const [id, tool] of s.tools)
          if (!tool.detached && !s.cancelTools.has(id))
            s.cancelTools.set(id, now);
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
        s.cancelPrompts.delete(id);
        // Tool and approval completion comes from explicit wire/SDK events, not
        // from a prompt's stop reason, which may coexist with other active work.
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
      if (["completed", "failed", "cancelled"].includes(tool.status)) {
        if (u.status === "completed" || u.status === "failed") this.onToolResult();
        this.retireTool(s, u.toolCallId);
      }
      else s.tools.set(u.toolCallId, tool);
    }
  }
  check(now: number): WatchResult {
    for (const call of this.calls.values()) {
      if (
        call.method !== "session/prompt" &&
        now - call.at >= this.limits.startup
      )
        return {
          failure: `Antigravity 在 ${call.method} 阶段超时。请检查本机 CLI 和网络后刷新会话。`,
        };
    }
    for (const s of this.sessions.values()) {
      if (
        [...s.cancelPrompts.values(), ...s.cancelTools.values()].some(
          (at) => now - at >= this.limits.cancel,
        )
      )
        return {
          failure:
            "Antigravity 未及时结束取消请求，已关闭本会话进程；未重发消息。",
        };
      const tools = [...s.tools.values()].some((t) => !t.detached);
      if (s.approvals.size > 0) continue;
      if (!s.prompts.size && !tools) continue;
      if (s.prompts.size && !tools && now - s.progress >= this.limits.silent)
        return {
          failure:
            "Antigravity 连续无进展且没有待审批或运行中的工具，已关闭旧进程。请刷新会话后继续；未重发消息。",
        };
    }
    return {};
  }
}
