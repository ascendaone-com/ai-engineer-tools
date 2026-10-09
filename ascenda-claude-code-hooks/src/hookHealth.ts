import { readLastHook as readToolLastHook, resolveHookNode as resolveLauncherNode, stampLastHook as stampToolLastHook } from "@ascenda-one/tool-kit";
import type { LastHook, NodeResolution } from "@ascenda-one/tool-kit";
import { hookBinPath } from "./paths.js";

/**
 * Claude Code's half of the hook-health facts every adapter records (see
 * `hookRunner.ts` in tool-kit): whether Claude Code has ever run one of these
 * hooks, and whether the launcher can find a Node to run them with. Claude
 * Code swallows a failing hook, so "13/13 registered" used to sit beside a
 * machine where no hook had ever run.
 */
export { describeAge } from "@ascenda-one/tool-kit";
export type { LastHook, NodeResolution } from "@ascenda-one/tool-kit";

const TOOL = "claude_code";

export function stampLastHook(event: string, now = new Date()): void {
  stampToolLastHook(TOOL, event, now);
}

export function readLastHook(): LastHook | undefined {
  return readToolLastHook(TOOL);
}

export function resolveHookNode(): NodeResolution {
  return resolveLauncherNode(hookBinPath());
}
