import type { AcpTransformer, AcpOptions } from "@getpaseo/plugin/server/acp";
import { z } from "zod";
import { mapToolCall } from "./tool-calls";

// Retain the official Paseo adapter's vendor mappings instead of reducing its capabilities.
const commands = new Set([
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "learn",
  "boost",
]);
const capability = z.object({
  antigravity: z.object({
    systemPrompt: z.object({ append: z.literal(true) }),
  }),
});
export const vendor: AcpTransformer = {
  command(command) {
    return {
      ...command,
      kind: commands.has(command.name) ? "command" : "skill",
    };
  },
  toolCall: mapToolCall,
  sessionOpen({ systemPrompt, agentMetadata }) {
    return {
      metadata:
        systemPrompt && capability.safeParse(agentMetadata).success
          ? { antigravity: { systemPrompt: { append: systemPrompt } } }
          : undefined,
    };
  },
};
export const options: AcpOptions = {
  startupTimeoutMs: 95000,
  perModelThinkingOptions: true,
  waitForInitialCommands: true,
  initialCommandsTimeoutMs: 1000,
  // transport.ts holds session/load's response through a byte-aware replay quiet window.
  // Keep the SDK's post-ready 'skip' guard until the first prompt. Zero disables it.
  // Byte-aware waiting remains in transport; this minimal SDK wait only closes its replay phase.
  loadReplayQuietPeriodMs: 1,
  deferTurnOnRunningTools: {
    keepsTurnOpen(tool) {
      const input = tool.input;
      if (!input || typeof input !== "object" || Array.isArray(input))
        return true;
      return (
        input.IsDaemon !== true &&
        !(
          tool.name === "schedule" &&
          typeof input.CronExpression === "string" &&
          input.CronExpression.trim().length > 0
        )
      );
    },
  },
  autoAcceptMode: {
    mode: {
      id: "full-access",
      label: "Full access",
      description: "Approve tool requests without asking.",
      icon: "ShieldOff",
      colorTier: "dangerous",
    },
    nativeMode: "default",
    default: false,
  },
};
