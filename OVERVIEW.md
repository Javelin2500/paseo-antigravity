# Better Paseo Antigravity

Better Paseo Antigravity runs the installed and signed-in official `agy acp` CLI inside Paseo with quiet waiting, bounded cancellation, process-group cleanup, byte-aware history replay, and official CLI usage quota reporting.

## How it works

Select Better Paseo Antigravity when creating a new agent. Existing sessions created with the built-in Antigravity provider are not migrated. Models, thinking options, slash commands, skills, tool approvals, and session resume continue to use the Paseo ACP SDK. Full access mode is available as an opt-in option and is not enabled by default.

Idle sessions and quiet active turns wait silently without no-progress notices. Timeout and failure diagnostics are preserved. Long-running foreground tools and pending permission approvals are not terminated solely for silence. If a turn has no active foreground tools or pending approvals and makes no progress for 15 minutes, the plugin closes the stuck process. When you stop a turn, cancellation targets the requests and foreground tools present at that moment, each with a 5-second fallback deadline. Later requests do not inherit an old target's deadline. On shutdown, the plugin attempts a time-bounded graceful ACP close and then cleans up the detached process group. Prompts are never resent automatically.

Session history replay waits for complete frames and a 200ms quiet boundary in the transport layer. The SDK then skips late history until the first new prompt, preventing historical tools from becoming live work. Tool state is retired on explicit tool-terminal events, not merely because a foreground turn completed; background tools preserved for a follow-up keep running. Sleep recovery includes work started in the last timer slice before suspension while preserving fresh post-wake deadlines.

## Setup and requirements

Requires macOS or Linux, Paseo 0.17.3, and the official `agy` CLI version 1.5 or later already installed and signed in on the daemon host.

Provider status checks verify the `agy` CLI version and perform an ACP handshake within a shared ~95-second cold-start budget. Recognized sign-in failures are reported without printing authorization URLs. Account eligibility and model access are still verified when opening a session. Usage quotas are queried through `agy -p /usage --output-format json` using the existing CLI login and environment.

## Privacy and boundaries

Prompts, tool outputs, and usage queries are sent to Google's Antigravity backend through the local official `agy` CLI using your existing sign-in. The plugin does not create a separate OAuth flow, account directory, or network proxy. It does not copy or store credentials, and it does not overwrite `GEMINI_HOME`, `SSH_*`, or `BROWSER`. It does not read private native session SQLite databases or transcripts. Progress notices inserted by older versions remain in timeline history. Account eligibility, rate limits, and network failures cannot be bypassed by the plugin.
