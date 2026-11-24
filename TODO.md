# TODO / Roadmap

## Product direction

Better Paseo Antigravity makes the official `agy acp` integration in Paseo easy to use, robust, stable, and faithful to native behavior. Prioritize streaming fidelity, tool-result presentation, session recovery, cancellation, and actionable error diagnostics.

Do not disable Antigravity's native capabilities or force its internal orchestration into Paseo's agent model. Improvements should adapt the ACP interface, not replace the agent's behavior.

## Active feature commitments

None. Evaluate concrete ACP integration defects and user-visible reliability improvements before adding new work; do not add features merely to fill the roadmap.

## Explicitly out of scope

- Reading or writing OS Keychain / Credential Manager slots for multi-account switching.
- Calling undocumented internal Google Cloud Code endpoints (`daily-cloudcode-pa.googleapis.com/v1internal`) instead of the official `agy -p /usage --output-format json` command.
- Reading private native session databases or depending on undocumented Paseo host modules for cosmetic enhancements.
- Disabling or forcibly rerouting Antigravity's native subagents.
