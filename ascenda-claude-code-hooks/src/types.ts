import type { AscendaEventPayload } from "@ascenda-one/tool-contract";

export type { AscendaEventPayload, CommandOutcome, IngestResult } from "@ascenda-one/tool-contract";
export { ASCENDA_CONSENT_SCOPE, ASCENDA_PROVENANCE } from "@ascenda-one/tool-contract";

export type ClaudeHookEventName =
  | "SessionStart" | "UserPromptSubmit" | "PreToolUse"
  // Success and failure are separate events in Claude Code's hook model — a
  // failed tool call fires PostToolUseFailure and never reaches PostToolUse.
  // Registering only PostToolUse makes failures invisible entirely.
  | "PostToolUse" | "PostToolUseFailure"
  | "PreCompact" | "PostCompact" | "Stop" | "Notification" | "SessionEnd";

/**
 * The same names as a value, so an unrecognised argument can be rejected
 * *before* the CLI blocks on stdin. Without this check `--version` (or any
 * typo) waits forever on a pipe that will never carry a hook payload —
 * measured at over three minutes before the caller gave up.
 */
export const CLAUDE_HOOK_EVENT_NAMES: readonly ClaudeHookEventName[] = [
  "SessionStart", "UserPromptSubmit", "PreToolUse",
  "PostToolUse", "PostToolUseFailure",
  "PreCompact", "PostCompact", "Stop", "Notification", "SessionEnd"
];

export function isClaudeHookEventName(value: string): value is ClaudeHookEventName {
  return (CLAUDE_HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

export type MappedAscendaEvent = Omit<AscendaEventPayload, "toolInstallationId" | "source" | "occurredAt" | "consentScope" | "provenance" | "privacyMode">;
export type ClaudeHookInput = Record<string, unknown>;

export const ASCENDA_TOOL_TYPE = "claude_code";
export const CLAUDE_HOST = "claude_code";

/**
 * Where this Claude Code is running, read from the variable Claude Code sets
 * in its hosted sessions (Claude Code on the web and the sessions it spawns).
 * Anything but an explicit true reads as `local`: this adapter always knows
 * which of the two it is in, so it never omits the key.
 */
export function claudeRuntime(env: NodeJS.ProcessEnv = process.env): "local" | "cloud" {
  const flag = env.CLAUDE_CODE_REMOTE?.trim().toLowerCase();
  return flag === "true" || flag === "1" ? "cloud" : "local";
}
