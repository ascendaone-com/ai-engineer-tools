import { spawnSync } from "child_process";
import * as path from "path";

/**
 * Finds the agent CLI process a hook was spawned from, so the live bus can
 * name a stream by the process rather than by the conversation.
 *
 * Why the process: Claude Code mints a new `session_id` on `/clear`,
 * `/compact` and resume. One terminal running one `claude` therefore speaks
 * under several session ids in an afternoon, and the app counted each as a
 * concurrent stream for its five-minute window. The PID stays put across all
 * of that, and it lets the app notice the process has exited instead of
 * waiting out the stale timer.
 *
 * **Only a process that runs one conversation at a time may be named.**
 * Keying by a process that hosts several (Codex's `app-server`, a Cursor or
 * Windsurf window, an editor's extension host) would fuse concurrent work
 * into one stream and under-count the gauge, the opposite defect. So this
 * returns a PID for exactly the shapes listed in {@link AGENT_PROCESS} and
 * `undefined` for everything else, and the caller sends no `pid` at all.
 *
 * macOS only, because the only reader is the macOS app, and it checks the
 * PID against the same executable rules before trusting it.
 */

/** One ancestor, as `ps` describes it. */
export interface ProcessInfo {
  ppid: number;
  /** Full executable path (macOS `ps -o comm=`). */
  command: string;
}

/** Looks a PID up, or `undefined` when it isn't there. Injectable for tests. */
export type ProcessLookup = (pid: number) => ProcessInfo | undefined;

/** Reads a PID's argument string, only asked for once the executable matched. */
export type ProcessArgsLookup = (pid: number) => string | undefined;

export interface AgentProcessRule {
  /** Matches on the executable path, never on the arguments. */
  executable(command: string): boolean;
  /** A second look at the arguments, for binaries that also run as a server. */
  args?(args: string): boolean;
}

/**
 * Which executables count as an agent CLI, per live-bus tool name.
 *
 * Matching is on the executable path. A loose match on the argument string
 * (the obvious `grep claude`) also matches `/bin/sh -c ".../ascenda-claude-code-hooks/..."`,
 * which is the hook's own parent shell.
 *
 *  - Claude Code runs as `claude` (npm shim targets, the desktop app's bundled
 *    `claude.app/Contents/MacOS/claude`) or as the native installer's
 *    `~/.local/share/claude/versions/<version>`, whose basename is a version
 *    number.
 *  - Codex runs as `codex`, or as `codex-aarch64-apple-darwin` once
 *    Homebrew's symlink is resolved. The same binary serves `app-server` and
 *    `mcp-server` for editor integrations, and those host many threads.
 *
 * Both symlink views are covered on purpose: `ps` here reports the path as
 * it was exec'd (`~/.local/bin/claude`), and the app's `proc_pidpath`
 * reports it resolved (`~/.local/share/claude/versions/2.1.293`).
 *
 * Mirrored by `AgentProcessRules` in the macOS app (`agent_process.dart`).
 * Change both together.
 */
export const AGENT_PROCESS: Readonly<Record<string, AgentProcessRule>> = {
  claude_code: {
    executable: (command) =>
      path.basename(command) === "claude" || /\/claude\/versions\/[^/]+$/.test(command)
  },
  codex: {
    executable: (command) => /^codex(-(aarch64|x86_64)-apple-darwin)?$/.test(path.basename(command)),
    args: (args) => !/\s(app-server|mcp-server)(\s|$)/.test(args)
  }
};

/** Enough levels for `claude → sh → npm exec → sh → node`, with room to spare. */
const MAX_DEPTH = 6;

/** A `ps` that hasn't answered in this long isn't going to help a hook. */
const PS_TIMEOUT_MS = 100;

function ps(columns: string, pid: number): string | undefined {
  try {
    const result = spawnSync("/bin/ps", ["-o", columns, "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    const line = result.stdout.trim();
    return line === "" ? undefined : line;
  } catch {
    return undefined;
  }
}

/** `ps -o ppid=,comm=`, with `comm` last so a path with spaces survives. */
export const psLookup: ProcessLookup = (pid) => {
  const line = ps("ppid=,comm=", pid);
  const match = line ? /^(\d+)\s+(.+)$/.exec(line) : null;
  return match ? { ppid: Number(match[1]), command: match[2] } : undefined;
};

export const psArgsLookup: ProcessArgsLookup = (pid) => ps("args=", pid);

export interface FindAgentPidOptions {
  /** Where the walk starts. Defaults to this process's parent. */
  startPid?: number;
  lookup?: ProcessLookup;
  argsLookup?: ProcessArgsLookup;
  /** Defaults to `process.platform`; anything but `darwin` returns undefined. */
  platform?: NodeJS.Platform;
}

/**
 * Walks up from the hook's parent to the nearest ancestor the rule accepts.
 *
 * Returns `undefined` when nothing matches within {@link MAX_DEPTH} levels,
 * when `ps` fails, or off macOS. The nearest match wins, so a `claude`
 * started from inside another `claude`'s shell names the inner one. Never
 * throws.
 */
export function findAgentPid(rule: AgentProcessRule | undefined, options: FindAgentPidOptions = {}): number | undefined {
  if (!rule) return undefined;
  if ((options.platform ?? process.platform) !== "darwin") return undefined;
  const lookup = options.lookup ?? psLookup;
  const argsLookup = options.argsLookup ?? psArgsLookup;

  let pid = options.startPid ?? process.ppid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const info = lookup(pid);
    if (!info) return undefined;
    if (rule.executable(info.command)) {
      if (!rule.args) return pid;
      const args = argsLookup(pid);
      // A matching binary we can't read the arguments of may be the server
      // shape, so it isn't named.
      return args !== undefined && rule.args(args) ? pid : undefined;
    }
    pid = info.ppid;
  }
  return undefined;
}
