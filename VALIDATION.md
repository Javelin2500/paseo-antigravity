# Antigravity Plus 0.2.1 Validation

Environment: macOS, Paseo 0.17.3, official `agy` 1.5.15.

## Issues Addressed

| Issue | 0.2.1 Resolution & Evidence |
| --- | --- |
| Idle cancel killing or poisoning next turn | Cancel deadline is armed only when active prompts or foreground tools exist; cleared when idle; follow-up prompts do not disarm an in-flight cancel. Verified by unit tests, SDK integration tests, and live CLI runs. |
| History replay and canceled tool-call leaks | `session/load` replay updates are excluded from live tool state; cancel and RPC failures clear transient state; SDK turn settlement clears stale tools; late updates for retired tool IDs are ignored. |
| Specific errors swallowed by SDK | Preserves the transport/watch failure reason before closing; replaces only known generic SDK messages (`ACP transport closed unexpectedly`, `Connection closed`, `ACP turn failed`) on `runtime_failed` and failed turns without overwriting meaningful upstream errors. |
| Process-group signal races | Extracted testable `stopGroup`; treats `ESRCH` as terminal without re-signaling; bounds `EPERM` retries; still attempts `SIGKILL` if `SIGTERM` fails; reports unconfirmed cleanup rather than hanging the close promise. |
| Large history replay truncation | Moved the 200ms quiet boundary into the byte-aware transport; holds the `session/load` response until no partial frame remains and the quiet window elapses while streaming history notifications inside the SDK replay window; disabled the SDK's second blind timer. Tested with 300 KB fragmented, multi-byte UTF-8 histories spanning >200ms. |
| Shutdown ordering and grace period | Calls `core.close()` first for native `session/close`; falls back to forced cleanup after 5s total grace; `SIGTERM` grace is 1s; concurrent `close()` calls share one promise. Verified when session open hangs. |
| EOF, EPIPE, and backpressure | Flushes `decoder.end()` and parses trailing frames without a newline on EOF; avoids immediately erroring the readable stream on `EPIPE`; does not fake EOF while a slow consumer pauses stdout. |
| Duplicate notices and invalid dismissal | Removed ineffective dismissal notifications; emits at most one no-progress notice per wire prompt turn. |
| Resource and config hygiene | Cleans up `hasText` on terminal events; unrefs monitor timers with a 10ms minimum interval; rejects non-positive watch limits; preserves command prefixes before `acp` in `inspect`; removed direct `esbuild` dependency. |
| Sleep / wake recovery | Detects timer gaps >5s or clock regressions and resets pre-sleep progress and request timers without resetting cancels issued after wake. Verified with injected clock tests (no physical lid-close test). |
| Status and usage reporting | Restored real ACP handshake and SSH environment hints in `status`; registered `antigravity-plus` usage source parsing `agy -p /usage --output-format json`; verified 5 live quota windows. |

## Automated & Live Verification

- All 6 regression cases added before the fix failed beforehand and pass after the fix.
- `pnpm typecheck` passes.
- `pnpm test` passes all 49 tests, including real Paseo SDK integration with a mock CLI fixture.
- Local Paseo compiler builds the server bundle cleanly and loads the plugin in `running` state.
- `pnpm test:live --confirm-live` verified against existing CLI login: 9 models discovered, live reply from Gemini 4 Neon, native session close/reload remembers context, mid-stream cancel returns `canceled`, immediate follow-up turn succeeds, and post-idle-cancel turn succeeds.
- Standalone `status` check verified CLI version check and ACP handshake; `usage` source returned `available` with 5 quota windows.
- Installed plugin verified end-to-end in Paseo (`gemini-4-neon`, thinking `high`, mode `default`), including stop/recovery and reload context persistence without auto-resending prompts.

## Known Boundaries

- Addresses known provider defects rather than guaranteeing immunity from upstream network, quota, or long-task failures. Normal long tools and pending approvals are not killed for silence; a tool that permanently fails to report a terminal state still requires manual stop.
- Does not read native session SQLite files, inboxes, or transcripts.
- Does not create an OAuth page, copy credentials, modify `GEMINI_HOME`, `SSH_*`, or `BROWSER`, or alter built-in providers or native session data.
- `Full access` remains opt-in; migration from built-in provider sessions, Windows support, and Paseo 0.18 compatibility are out of scope (`>=0.17.3 <0.18.0`).
- No-progress notices remain timeline history items in Paseo 0.17.3; mobile visual testing and heavy real-world long subagent stress tests were not performed.
