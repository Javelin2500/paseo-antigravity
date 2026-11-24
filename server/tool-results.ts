import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Per transport, retain provenance (never payloads) for as long as the SDK retains
 * tool snapshots. Do not evict completed IDs: late updates must not overwrite native
 * output. All entries are released on close. ACP content updates replace snapshots.
 */
export class ToolResultMapper {
  private sources = new Map<string, "native" | "synthetic">();
  clear() { this.sources.clear(); }

  map(frame: AcpStreamMessage): AcpStreamMessage {
    const m = record(frame);
    if (m.method !== "session/update") return frame;
    const params = record(m.params);
    const update = record(params.update);
    if (
      !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) ||
      typeof params.sessionId !== "string" || typeof update.toolCallId !== "string"
    ) return frame;
    const key = JSON.stringify([params.sessionId, update.toolCallId]);
    if (update.rawOutput !== undefined) {
      this.sources.set(key, "native");
      return frame;
    }
    if (this.sources.get(key) === "native" || update.content === undefined)
      return frame;
    if (update.content !== null && !Array.isArray(update.content)) return frame;
    const texts: string[] = [];
    for (const entry of update.content ?? []) {
      const block = record(entry);
      if (block.type !== "content") continue;
      const content = record(block.content);
      if (content.type === "text" && typeof content.text === "string")
        texts.push(content.text);
    }
    if (!texts.length && this.sources.get(key) !== "synthetic") return frame;
    if (texts.length) this.sources.set(key, "synthetic");
    else this.sources.delete(key);
    return {
      ...frame,
      params: { ...params, update: {
        ...update, rawOutput: texts.length ? texts.join("\n") : null,
      } },
    } as AcpStreamMessage;
  }
}
