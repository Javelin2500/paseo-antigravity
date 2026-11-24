# Antigravity Plus 0.2.2 Validation

Environment: macOS, Paseo 0.17.3, official `agy` 1.5.15. This is a targeted follow-up to 0.2.1, not a new provider architecture.

## ACP fidelity follow-up (unreleased)

- Tool text carried only in ACP `content` is exposed to the pinned SDK through `rawOutput` when no explicit `rawOutput` is present. Original content blocks, native structured output (including explicit null/empty values), and diffs are preserved. Snapshot updates replace text rather than accumulating duplicate content; shell details accept plain text output.
- Two wire-level counterexamples failed before the mapping fix. Real-SDK tests verify shell and MCP text results and native diff presentation.
- Empty-result warnings now require a completed turn with neither nonblank assistant text nor a live wire-confirmed completed/failed tool result. Watch excludes replay and retired tool echoes; SDK-synthesized terminal rows cannot suppress warnings. Pending calls and reasoning alone do not suppress warnings. Tests verify tool-only turns do not warn and a subsequent genuinely empty turn still does.
- A slow-consumer test exposed read-ahead growth: every consumed frame resumed another pipe chunk even when decoded frames remained queued. The transport now drains decoded frames before resuming stdout. The regression sends 2,000 Unicode frames (roughly 14 MB), confirms the producer remains backpressured after 600 slow reads, then verifies all frames arrive unchanged and in order.
- Additional pressure tests verify 10,000 fragmented mixed text/tool events and bounded cleanup when canceling an output flood. These are automated fixture tests, not a UI latency benchmark, RSS bound, or proof of indefinite memory stability.
- Independent review identified and prompted fixes for replay completing while stdout was paused, synthetic tool terminalization hiding empty results, stale fallback text after content replacement, and later content overriding native output. Regression tests cover all four, including real-SDK history ghosts/pending tools and structured shell output preservation.
- Replay quiet time does not advance to completion while stdout is paused; resumption starts a fresh quiet window. Output provenance is scoped by transport/session/tool and cleared on transport close. It stores only source markers, not payloads, and grows with distinct tools like SDK snapshots; no eviction is used because late updates must retain their native-output protection.
- All 119 automated tests, `pnpm typecheck`, and `git diff --check` pass. Both independent reviewers reran the tests and approved the fixes; rollback probes also confirmed the new regression tests detect the original failures.
- Explicit native `rawOutput` (including null/empty values) remains authoritative, even when content text also exists. Multiple text blocks are joined with a display newline; this is not a byte-for-byte stdout representation. Non-text blocks remain on the wire, but this fallback does not add SDK rendering support for images/audio/resources. ACP snapshot semantics are followed; agy-specific delta behavior has not been confirmed live.
- Empty-result warnings reflect the evidence available when the turn completes. A tool result that arrives afterward can coexist with an earlier warning; the warning is not retracted. The plugin does not delay completion indefinitely waiting for possible late output.
- Under an extremely stalled consumer, stdout backpressure can delay cancellation acknowledgments beyond the fixed timeout and trigger bounded process cleanup. Timeout protections remain enabled; this is not a guarantee of preserving a stalled runtime indefinitely.
- No live account prompts, installed-plugin reload, mobile UI validation, or deployment were performed for this follow-up.

## Issue #1 follow-up (unreleased)

- Removed both no-progress notices, their per-turn state and the 30-second hint timer setting. Idle sessions and quiet active turns now wait silently.
- Startup, cancellation and 15-minute inactivity failure handling are unchanged; foreground tools and pending approvals still prevent silence-only termination. Cleanup failures and empty-result warnings remain visible.
- `pnpm typecheck`, `git diff --check` and all 92 tests pass. Watch tests cover repeated quiet intervals, subsequent turns, idle sessions and long-running tools; real-SDK tests with a mock CLI verify quiet waiting and preserved concrete failure diagnostics.
- Documentation and plugin descriptions now describe quiet waiting. Existing timeline notices are not removed. No installed plugin reload, live CLI run or UI verification was performed for this change.

## Issue #2 follow-up (unreleased)

- Session-list `cwd` values are normalized before publication to Paseo, which validates the directory before `session.open`. No persistence, title, timestamp or transcript fields are rewritten.
- Explicit local file URLs are converted with `fileURLToPath`. Pathless `file://` and `file://localhost` inputs stay unchanged instead of becoming `/`; explicit root URLs still work. Ambiguous URLs, encoded separators/NULs (including `%5C` on POSIX) and encoded dot-segment traversal are left unchanged. Bare absolute paths are decoded at most once, only after the original entry returns `ENOENT` from `lstat` and the decoded path is an existing directory according to `stat`. Literal entries, dangling symlinks and unknown filesystem errors are preserved.
- Normalization is synchronous to preserve event order. Repeated cwd values share a result only within one `sessions` event; later events recheck the filesystem. This reduces duplicate I/O but does not impose a time bound on slow mounts.
- The original real-SDK regression failed before the fix for both an encoded Chinese directory and a file URL. Review follow-up counterexamples for pathless file URLs and dangling symlinks also failed before their fixes. All 91 tests and `pnpm typecheck` now pass on macOS with the pinned `@getpaseo/plugin` 0.17.3 development SDK.
- Twenty-five added tests cover Chinese/nested paths, spaces, special characters, literal percent names, one-pass decoding, valid/dangling symlinks, file URL boundaries, invalid encodings, unsafe paths, missing directories, files, filesystem errors, per-event deduplication, filesystem changes between lists, mixed/duplicate session rows and empty lists. The real SDK with a mock ACP server resumes the original native session using the corrected process directory, reports the corrected opened cwd and replays encoded transcript text unchanged.
- Real CLI validation passed with official `agy` 1.5.16 and `gemini-4-neon`: a new synthetic conversation in a temporary Chinese/space directory appeared in the unmodified SDK's list with an encoded cwd. The patched list restored its actual directory and preserved its metadata. Native filtering by the actual cwd found the same session; loading it with the corrected cwd succeeded and replayed the synthetic marker with the original persistence identity.
- Reproduce that opt-in check with `node --import tsx scripts/live-session-cwd.ts --confirm-live`. It uses the existing CLI subscription for one small synthetic prompt, denies permission requests, and prints only validation flags. It closes its runtimes and removes its temporary directory, but leaves the synthetic native history entry; no existing conversation is opened or prompted.
- The installed plugin and daemon were not changed. Actual import through the Paseo UI, including the reported daemon 0.17.4 environment, remains unverified. The release validation below is the previous 0.2.2 record, separate from this follow-up.

## Changes and regression evidence

| Issue | 0.2.2 fix and evidence |
| --- | --- |
| Late replay leaking after ready | Retains the transport's 200ms byte-aware boundary and sets SDK `loadReplayQuietPeriodMs` to 1 instead of 0. This preserves the SDK's `skip` guard until the first new prompt. Real-SDK tests cover both history modes, history arriving at 260ms, ghost tools, and the next prompt completing. Large fragmented UTF-8 replay remains covered. |
| Follow-up removing preserved background tools | Removed whole-turn `settle()` cleanup. Retires individual tools on explicit ACP terminal updates or SDK completed/failed/canceled tool events. A test keeps a background tool active across an auto follow-up beyond the scaled silence deadline, then verifies its completion. |
| Cancel deadline crossing into later work | Request IDs and tool IDs retain separate cancellation timestamps. Completing a target releases only its own deadline; later targets receive their own deadlines; repeated Stop does not postpone an existing deadline. Tests cover response order, repeated cancellation, new tools, and similar tool/request IDs. |
| Status probe cold-start inconsistency | Version check and handshake share a ~95-second budget. Recognized fixed transport diagnostics preserve sign-in guidance without exposing raw exec/SDK output or authorization URLs. Tests use scaled budgets for slow-start, timeout and redaction cases. |
| Final pre-sleep timer slice | Rebase stale timestamps older than 5 seconds and future timestamps after clock regression, including work started after the last tick. Preserve fresh post-wake cancellation deadlines. Tested with injected clocks, not a physical lid-close test. |
| Missing exit diagnostics | Flush final frames first, then wait at most 100ms for the exit event. Include an exit code or signal when available. Exit code 17 and SIGTERM are verified in both SDK runtime-failure and failed-turn events, including the generic `ACP connection closed` variant. |

## Verification

- Before implementation changes, six added counterexamples failed on 0.2.1: two late-replay modes, preserved background work, an old cancel killing a new request, a later cancellation inheriting an earlier deadline, and the pre-sleep final timer slice.
- `pnpm typecheck`, `git diff --check`, and all 66 tests pass.
- Corrected older unit tests that assumed a prompt/turn ending implied all tools ended. They now simulate explicit SDK tool-terminal events; real-SDK cancellation coverage still passes, and a new RPC-error integration test verifies stale tools do not poison the next turn.
- `pnpm test:live --confirm-live`: 9 models discovered; Gemini 4 Neon replies correctly, remembers the marker after native close/reload, cancels after visible streaming (8ms in this run), handles an immediate follow-up, and handles a new prompt 6 seconds after idle cancellation.
- Paseo's installed compiler built the server bundle. The plugin was reloaded only with no running Plus requests. A separate test agent using `gemini-4-neon` / `high` / `default` returned `PASEO_022_OK`; reloading that test agent and asking for the marker returned it again. No existing user conversation was prompted or archived.
- Installed usage source: `antigravity-plus`, `available`, 5 windows. No CLI login or credentials were changed.

## Limits

These checks validate the listed scenarios, not indefinite stability. Late-history protection follows the SDK's first-new-prompt boundary. Native SQLite/inbox/transcript inspection, hidden upstream-error classification, orphan-subagent detection, Windows support and Paseo 0.18 compatibility remain out of scope. Long tools that never report completion can still require manual Stop. Real long-running subagent stress testing and mobile visual testing were not performed.

During the earlier 0.2.1 installed test, one post-reload request exceeded 90 seconds without a reply; Stop, a subsequent new turn and a later reload succeeded. Its root cause remains unknown. The successful 0.2.2 checks do not retroactively diagnose that incident.

## Historical 0.2.1 validation record

The following is the previous release's record; its whole-turn cleanup and replay-timer assumptions are superseded by the 0.2.2 changes above.

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
