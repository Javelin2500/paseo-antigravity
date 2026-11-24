import { randomUUID } from "node:crypto";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

// The pinned SDK retains fallback text IDs across load. Give the first anonymous
// live chunk run its own identity, without changing native IDs or text.
export class LoadBoundary {
  private loads = new Map<string | number, string>();
  private firstRuns = new Map<string, { id: string; kind?: string }>();
  outgoing(frame: AcpStreamMessage) {
    if (!("method" in frame)) return;
    const p = frame.params as {sessionId?: string} | undefined;
    if (typeof p?.sessionId !== "string") return;
    // The SDK resets its own fallback IDs when a new prompt starts. Our
    // restoration-only identity must never escape into subsequent turns.
    if (frame.method === "session/prompt" || frame.method === "session/load")
      this.firstRuns.delete(p.sessionId);
    if (frame.method === "session/load" && "id" in frame && frame.id !== null)
      this.loads.set(frame.id, p.sessionId);
  }
  incoming(frame: AcpStreamMessage): {frame: AcpStreamMessage; boundary: boolean} {
    if (!("method" in frame) && frame.id !== null && this.loads.has(frame.id)) {
      const sid = this.loads.get(frame.id)!;
      this.loads.delete(frame.id);
      if ("result" in frame) {
        this.firstRuns.set(sid, {id: "paseo-live:" + randomUUID()});
        return {frame, boundary:true};
      }
    }
    if ("method" in frame && frame.method === "session/update") {
      const p = frame.params as {sessionId?: string; update?: Record<string, unknown>} | undefined;
      const run = p?.sessionId ? this.firstRuns.get(p.sessionId) : undefined;
      const u = p?.update, kind = u?.sessionUpdate;
      if (run && u && typeof kind === "string") {
        if (["agent_message_chunk", "agent_thought_chunk"].includes(kind)) {
          if ((run.kind && run.kind !== kind) ||
              (typeof u.messageId === "string" && u.messageId.length > 0)) {
            this.firstRuns.delete(p!.sessionId!);
          } else {
            run.kind = kind;
            frame = {...frame, params:{...p, update:{...u,messageId:run.id}}};
          }
        } else if (["user_message_chunk","tool_call","plan"].includes(kind)) {
          this.firstRuns.delete(p!.sessionId!);
        }
      }
    }
    return {frame, boundary:false};
  }
  clear() { this.loads.clear(); this.firstRuns.clear(); }
}
