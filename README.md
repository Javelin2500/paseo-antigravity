# Antigravity Plus

A [Paseo](https://paseo.sh) plugin that provides a more reliable ACP provider and usage source (`antigravity-plus`) for Google's official Antigravity CLI (`agy acp`).

## Why Antigravity Plus?

Paseo's built-in Antigravity provider can run into reliability and ergonomics issues during real-world sessions—such as silent stalls with no feedback, hung cancellation requests, orphaned child processes, truncated large history replays, and swallowed error messages.

Antigravity Plus wraps the official `agy acp` binary using Paseo's ACP SDK while fixing these transport, lifecycle, and state-tracking issues without altering your CLI login, credentials, or environment.

### What It Fixes

- **Progress visibility without premature kills**
  - Emits a single timeline warning notice per active turn after ~30 seconds without progress.
  - Distinguishes active foreground tools and pending permission approvals from genuine stalls—long-running tools and pending approvals are never killed solely for being quiet.
  - Closes genuinely stuck generation processes after 15 minutes of silence (only when no foreground tools or approvals are active) and never silently resends prompts.
- **Reliable cancellation and process-group cleanup**
  - Enforces a 5-second fallback deadline if `session/cancel` does not terminate an active turn.
  - Performs a time-bounded graceful ACP close (5-second grace) followed by detached POSIX process-group cleanup (`SIGTERM` with 1-second grace, then `SIGKILL`).
  - Handles `ESRCH` and `EPERM` races safely so exited leaders never cause infinite waits or stray signals.
- **Cancel race and stale tool-call protection**
  - Ignores idle cancel requests so they cannot poison or kill a subsequent turn.
  - Keeps `session/load` history replay out of live tool-call tracking.
  - Clears transient tool and approval state on cancellation, RPC failure, and SDK turn settlement, and ignores late updates for already-retired tool calls.
- **Preserved root-cause error messages**
  - Records the underlying transport or watchdog failure reason before closing the stream.
  - Replaces generic SDK errors (`ACP transport closed unexpectedly`, `Connection closed`, `ACP turn failed`) with the actual cause without overwriting meaningful upstream errors.
- **Byte-aware history replay for large sessions**
  - Holds the `session/load` response in the byte-aware transport until no partial frame remains and a 200ms quiet boundary is reached, preventing large or fragmented multi-byte UTF-8 histories from being truncated mid-frame.
- **Host sleep and wake resilience**
  - Detects system suspend or clock jumps (>5-second timer gap) and resets pre-sleep progress and request timers instead of falsely timing out after waking a machine.
- **EOF, EPIPE, and backpressure safety**
  - Flushes `StringDecoder` and parses trailing newline-free frames on EOF.
  - Avoids discarding queued replies on `EPIPE` and respects consumer backpressure without manufacturing premature EOF.
- **Full official CLI compatibility and quota reporting**
  - Reuses your existing `agy` login, config, and environment (`GEMINI_HOME`, `SSH_*`, and `BROWSER` are never overwritten).
  - Keeps per-model thinking options, slash commands, skills, native/MCP tool-call mappings, and opt-in `Full access` mode.
  - Restores real CLI version + ACP handshake diagnostics in provider status checks and quota reporting via `agy -p /usage --output-format json`.

## Requirements

- **OS**: macOS or Linux (Windows is not currently supported due to POSIX process-group signaling)
- **Paseo**: `>=0.17.3 <0.18.0`
- **Antigravity CLI**: Official `agy` `>=1.5.0`, installed and signed in on the daemon host

## Installation

Make sure plugins are enabled on your Paseo daemon (**Settings → Plugins → Enable plugins**).

### Via Paseo App (Settings)

1. Open Paseo and go to **Settings → Plugins → Plugin source**.
2. Paste the repository URL or GitHub shorthand:
   - `https://github.com/robbin/paseo-antigravity`
   - or `github:robbin/paseo-antigravity`
3. Click **Install plugin**.

### Via Paseo CLI

```bash
paseo plugin install github:robbin/paseo-antigravity
```

To update later:

```bash
paseo plugin update antigravity-plus
```

## Usage

1. Create a new agent in Paseo and select **Antigravity Plus** as the provider.
2. Choose your model, thinking level, and permission mode (`Full access` is available as an opt-in mode and is not enabled by default).
3. Existing sessions created with Paseo's built-in Antigravity provider are not automatically migrated.

## Known Boundaries

- Does not create a custom OAuth flow, proxy, or credential store; sign in using the official `agy` CLI on the host.
- Does not read private Antigravity SQLite databases, inboxes, or raw transcripts.
- Never automatically resends prompts after a stall, disconnect, or cancellation.
- Progress notices inserted into Paseo 0.17.3 timelines remain as historical records of that moment rather than a live-updating status bar.
- See [VALIDATION.md](./VALIDATION.md) for the test matrix and verification notes.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

To run the live integration test against your local signed-in `agy` CLI:

```bash
pnpm test:live --confirm-live
```

## License

Portions derived from Paseo's ACP provider and usage patterns remain under the Apache License 2.0 (see [LICENSE-Paseo](./LICENSE-Paseo)).
