import * as os from "os";
import * as path from "path";
import type { CliAgentSetupSpec } from "@ascenda-one/tool-kit";
import { checkCodexHookTrust } from "./hookTrust.js";
import { ASCENDA_TOOL_TYPE, CODEX_HOST } from "./types.js";

/**
 * Only the hooks that map to a catalog event — and this list moves with the
 * mapper, never after it. A hook mapped here but absent there sends nothing; a
 * hook mapped there but absent here never fires at all, which is how Claude
 * Code's `PostToolUseFailure` reported zero failures for months.
 *
 * `PermissionRequest` is Codex's approval gate: the agent has stopped and is
 * waiting on the person. It now maps to `supervision_interruption`, the same
 * leg as Claude Code's `Notification`. One process per approval is bounded by
 * how often a human is asked, not by tool volume.
 *
 * The subagent lifecycle pair stays unregistered: it maps to nothing, and a
 * subagent starting is not an interruption of the person.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse", "PostToolUse",
  "PreCompact", "PostCompact",
  "Stop",
  "PermissionRequest",
  // Codex 0.146 and later; an older Codex ignores an event it doesn't know.
  "SessionEnd"
] as const;

/**
 * Matches the timeout in `examples/hooks.json`, so a hand-merged file and a
 * `setup`-written one do not disagree. Generous on purpose: the adapter caps
 * its own HTTP at 3 s (ASCENDA_HTTP_TIMEOUT_MS), so this ceiling is only ever
 * reached by a wedged process, and Codex awaits command hooks.
 */
const HOOK_TIMEOUT_SECONDS = 10;

/**
 * Where Codex keeps its user-level files: `$CODEX_HOME` when it is set, as
 * Codex itself reads it, otherwise `~/.codex`. A project's own `.codex`
 * folder is not affected by it.
 */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

/**
 * Codex caps `SessionEnd` at 3 s (1 s when none is given) because it runs as
 * the process exits, and drops a hook that asks for more. Registering the
 * 10 s default would have it ignored or clamped depending on the version.
 */
const SESSION_END_TIMEOUT_SECONDS = 3;

export const hookTimeoutSeconds = (event: string): number => event === "SessionEnd" ? SESSION_END_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;

export const SETUP: CliAgentSetupSpec = {
  host: CODEX_HOST,
  displayName: "Codex CLI",
  toolType: ASCENDA_TOOL_TYPE,
  packageName: "@ascenda-one/codex-hooks",
  binaryName: "ascenda-codex-hook",
  hookEvents: HOOK_EVENTS,
  restartHint: "Restart Codex, then open /hooks to review and trust the Ascenda hooks. Registration alone does not run them.",
  // Codex reports the posture it was working under, its approval gate, and
  // the git action or milestone a shell command reached. It sends no model and
  // no per-file change size.
  sends: ["posture", "waiting", "git", "turns", "forge"],
  trust: {
    check: checkCodexHookTrust,
    fix: "Restart Codex and open /hooks, then approve the Ascenda hooks. A hook whose command changed needs approving again."
  },
  settings: {
    settingsPath: (scope, projectDir) =>
      scope === "user" ? path.join(codexHome(), "hooks.json") : path.join(projectDir, ".codex", "hooks.json"),
    // Codex nests as Gemini does — each event maps to an array of
    // { hooks: [{ type, command }] } — but reads the event from argv rather
    // than stdin, so unlike Gemini the name has to be on the command line.
    entry: (command, event) => ({ hooks: [{ type: "command", command: `${command} ${event}`, timeout: hookTimeoutSeconds(event) }] }),
    grouped: true
  }
};
