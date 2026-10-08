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
  /**
   * Install-path markers for a CLI that runs as a script under `node`, `bun`
   * or `deno`. A runtime ancestor counts when its arguments contain one
   * between slashes, as in `node /opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js`.
   */
  scriptMarkers?: readonly string[];
}

/**
 * How a PID was found, so the app can check it the same way.
 *
 * `executable` is the agent's own binary. `path` is a script runtime, and
 * `marker` is the install path its arguments contained: the executable alone
 * says "some node process", which a recycled PID could also be.
 */
export type AgentProcessMatch =
  | { pid: number; match: "executable" }
  | { pid: number; match: "path"; marker: string };

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
 *  - Claude Code from npm execs the native binary its postinstall copied to
 *    `@anthropic-ai/claude-code/bin/claude.exe`, `claude` through npm's bin
 *    link. Releases before the native binary ran `cli.js` under `node`,
 *    which is what the script marker is for.
 *  - Gemini CLI runs `@google/gemini-cli/bundle/gemini.js` under `node`, and
 *    relaunches itself once with a bigger heap. The child runs the
 *    conversation and is the nearer ancestor. `--acp` (and the older
 *    `--experimental-acp`) serves editor sessions over one process, so it
 *    isn't named.
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
      path.basename(command) === "claude" ||
      /\/claude\/versions\/[^/]+$/.test(command) ||
      /\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/.test(command),
    scriptMarkers: ["@anthropic-ai/claude-code"]
  },
  codex: {
    executable: (command) => /^codex(-(aarch64|x86_64)-apple-darwin)?$/.test(path.basename(command)),
    args: (args) => !/\s(app-server|mcp-server)(\s|$)/.test(args)
  },
  gemini_cli: {
    executable: () => false,
    args: (args) => !/\s--(experimental-)?acp(\s|=|$)/.test(args),
    scriptMarkers: ["@google/gemini-cli"]
  }
};

/** Runtimes a CLI may run under as a script. Their path names no agent. */
const SCRIPT_RUNTIME = /^(node|bun|deno)$/;

/**
 * The first of `markers` that appears between slashes in `args`.
 *
 * The slashes keep `@anthropic-ai/claude-code` from matching the
 * `ascenda-claude-code-hooks` path in a hook's own command line, or a
 * sibling package like `@anthropic-ai/claude-code-darwin-arm64`.
 */
export function scriptMarkerIn(args: string, markers: readonly string[]): string | undefined {
  return markers.find((marker) => args.includes(`/${marker}/`));
}

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
 *
 * The hook's own process is never a candidate. Its command line names the
 * hook package, and a walk that started there could match on that.
 */
export function findAgentProcess(
  rule: AgentProcessRule | undefined,
  options: FindAgentPidOptions = {}
): AgentProcessMatch | undefined {
  if (!rule) return undefined;
  if ((options.platform ?? process.platform) !== "darwin") return undefined;
  const lookup = options.lookup ?? psLookup;
  const argsLookup = options.argsLookup ?? psArgsLookup;
  const markers = rule.scriptMarkers ?? [];

  let pid = options.startPid ?? process.ppid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const info = lookup(pid);
    if (!info) return undefined;
    if (pid !== process.pid) {
      if (rule.executable(info.command)) {
        // A matching binary we can't read the arguments of may be the
        // server shape, so it isn't named.
        return accepts(rule, rule.args ? argsLookup(pid) : "") ? { pid, match: "executable" } : undefined;
      }
      if (markers.length > 0 && SCRIPT_RUNTIME.test(path.basename(info.command))) {
        const args = argsLookup(pid);
        const marker = args === undefined ? undefined : scriptMarkerIn(args, markers);
        // A runtime running something else is a wrapper, and the walk
        // carries on past it.
        if (marker !== undefined) {
          return accepts(rule, args) ? { pid, match: "path", marker } : undefined;
        }
      }
    }
    pid = info.ppid;
  }
  return undefined;
}

function accepts(rule: AgentProcessRule, args: string | undefined): boolean {
  if (!rule.args) return true;
  return args !== undefined && rule.args(args);
}

/** {@link findAgentProcess}, for a caller that only wants the number. */
export function findAgentPid(rule: AgentProcessRule | undefined, options: FindAgentPidOptions = {}): number | undefined {
  return findAgentProcess(rule, options)?.pid;
}

/**
 * The live-bus fields for a match: `pid`, plus `pidMatch` and `pidMarker`
 * when it was a path match. Empty when there's no match.
 */
export function livePidFields(
  match: AgentProcessMatch | undefined
): { pid?: number; pidMatch?: "path"; pidMarker?: string } {
  if (!match) return {};
  if (match.match === "executable") return { pid: match.pid };
  return { pid: match.pid, pidMatch: "path", pidMarker: match.marker };
}
