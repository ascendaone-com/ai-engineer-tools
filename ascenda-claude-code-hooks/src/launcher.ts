import { hookLauncherScript } from "@ascenda-one/tool-kit";

/**
 * The shell launcher `setup` installs as `~/.ascenda/bin/ascenda-claude-hook`.
 * Shared with every hook adapter; see `hookRunner.ts` in tool-kit for why it
 * exists. Claude Code shows a failing `SessionStart` hook's message, so that
 * one hook says when there is no Node, once per session.
 */
export const LAUNCHER_OPTIONS = {
  binaryName: "ascenda-claude-hook",
  setupCommand: "npx @ascenda-one/claude-code-hooks setup",
  loudEvent: "SessionStart"
};

export const LAUNCHER_SCRIPT = hookLauncherScript(LAUNCHER_OPTIONS);
