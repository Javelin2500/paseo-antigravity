# TODO / Roadmap

Planned usability improvements for **Better Paseo Antigravity** while preserving its core reliability and boundary principles (no custom credential store or Keychain manipulation, no undocumented internal Google APIs, and strict process/transport safety).

Reference inspiration: [jule-x/antigravity-plus](https://github.com/jule-x/antigravity-plus) (reviewed at commit `549bab1`).

## Planned Features

- [ ] **Mid-turn steering (`prompt.steer`)**
  - **Goal**: Allow messages sent during an active turn to join the running turn instead of interrupting or restarting it.
  - **Scope & constraints**:
    - Coordinate JSON-RPC `session/prompt` requests in the transport/connection wrapper so `agy`'s early `end_turn` response on the initial prompt is held until the final steered prompt completes.
    - Keep `Watch` progress timers, per-request cancellation deadlines, and background tool tracking consistent when a turn is extended by steering.
    - Add unit and real-SDK regression tests covering single steer, chained steers, rejected steers, and cancellation mid-steer.
  - **Reference**:
    - [antigravity-plus `server/agy-stream.ts` (`SteeringRelay`)](https://github.com/jule-x/antigravity-plus/blob/main/server/agy-stream.ts)
    - [antigravity-plus `server/session-wrapper.ts`](https://github.com/jule-x/antigravity-plus/blob/main/server/session-wrapper.ts)

- [ ] **Automatic conversation title sync**
  - **Goal**: Replace Paseo's provisional 60-character first-prompt title with `agy`'s generated short title after a turn finishes, without overwriting user-edited agent names.
  - **Scope & constraints**:
    - Note: `antigravity-plus` implements this by reading `agy`'s private `conversation_summaries.db` SQLite file and dynamically loading internal Paseo daemon client modules.
    - Before implementing, evaluate whether `agy acp` session updates and public Paseo plugin APIs expose title sync cleanly; avoid coupling to private SQLite schemas or undocumented host internals unless explicitly accepted as an opt-in trade-off.
  - **Reference**:
    - [antigravity-plus `server/title-sync.ts`](https://github.com/jule-x/antigravity-plus/blob/main/server/title-sync.ts)
    - [antigravity-plus `index.server.ts`](https://github.com/jule-x/antigravity-plus/blob/main/index.server.ts)

- [ ] **Optional companion `agy` hook for Paseo subagent routing**
  - **Goal**: Provide an opt-in companion `agy` plugin (`PreToolUse` hook) and system-prompt guidance that blocks `agy`'s hidden `invoke_subagent` tool inside Better Paseo Antigravity sessions and directs the model to use Paseo's visible, controllable `create_agent` tool instead.
  - **Scope & constraints**:
    - Gate the hook strictly on a dedicated environment variable injected only by this provider so standalone `agy` CLI and IDE sessions remain completely unaffected.
    - Keep installation opt-in and document the symlink/install step clearly.
  - **Reference**:
    - [antigravity-plus `server/subagents.ts`](https://github.com/jule-x/antigravity-plus/blob/main/server/subagents.ts)
    - [antigravity-plus `agy-plugin/`](https://github.com/jule-x/antigravity-plus/tree/main/agy-plugin)
    - [antigravity-plus `agy-plugin/subagent-guard.sh`](https://github.com/jule-x/antigravity-plus/blob/main/agy-plugin/subagent-guard.sh)

## Explicitly Out of Scope

To keep the security and compatibility boundary clean, the following features from `jule-x/antigravity-plus` are intentionally **not** planned:

- Reading or writing OS Keychain / Credential Manager slots for multi-account switching.
- Calling undocumented internal Google Cloud Code endpoints (`daily-cloudcode-pa.googleapis.com/v1internal`) instead of the official `agy -p /usage --output-format json` command.
