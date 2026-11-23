# Antigravity Plus

Antigravity Plus runs the installed and signed-in official `agy acp` CLI inside Paseo with progress notices, bounded cancellation, process-group cleanup, byte-aware history replay, and official CLI usage quota reporting.

## How it works

Select Antigravity Plus when creating a new agent. Existing sessions created with the built-in Antigravity provider are not migrated. Models, thinking options, slash commands, skills, tool approvals, and session resume continue to use the Paseo ACP SDK. Full access mode is available as an opt-in option and is not enabled by default.

After roughly 30 seconds without progress during an active turn, the plugin inserts one warning notice into the timeline. Long-running foreground tools and pending permission approvals are not terminated solely for silence. If a turn has no active foreground tools or pending approvals and makes no progress for 15 minutes, the plugin closes the stuck process. When you stop a turn, an unresponsive cancel request is closed after a 5-second fallback deadline. On shutdown, the plugin attempts a time-bounded graceful ACP close and then cleans up the detached process group. Prompts are never resent automatically.

Session history replay waits for complete frames and a 200ms quiet boundary in the transport layer so large fragmented histories are not truncated mid-frame. Host sleep intervals longer than 5 seconds reset pre-sleep progress timers so waking a machine does not trigger false timeouts.

## Setup and requirements

Requires macOS or Linux, Paseo 0.17.3, and the official `agy` CLI version 1.5 or later already installed and signed in on the daemon host.

Provider status checks verify the `agy` CLI version and perform an ACP handshake. Account eligibility and model access are still verified when opening a session. Usage quotas are queried through `agy -p /usage --output-format json` using the existing CLI login and environment.

## Privacy and boundaries

The plugin does not create a separate OAuth flow, account directory, or network proxy. It does not copy or store credentials, and it does not overwrite `GEMINI_HOME`, `SSH_*`, or `BROWSER`. It does not read private native session SQLite databases or transcripts. Progress notices in Paseo 0.17.3 cannot be retracted once inserted and remain in the timeline as historical records. Account eligibility, rate limits, and network failures cannot be bypassed by the plugin.
