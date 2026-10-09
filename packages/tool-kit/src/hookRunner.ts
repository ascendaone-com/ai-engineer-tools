import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ascendaHome } from "./tokenStore";

/**
 * How an agent's hooks start, and the two facts nobody could see from
 * outside a broken install: whether the agent has ever run one, and whether
 * there is a Node to run them with. Shared by every hook adapter, Claude
 * Code's included.
 *
 * `setup` installs three files beside each other in `~/.ascenda/bin`:
 *
 *  - `<binary>`, a POSIX `sh` launcher, which is what the hook command names;
 *  - `<binary>.mjs`, the self-contained hook bundle it runs;
 *  - `<binary>.node`, the Node it ran with last time.
 *
 * Why a launcher: every way of pointing straight at Node failed somebody.
 * `#!/usr/bin/env node` needs Node on the PATH the agent passes to hooks,
 * and under nvm, fnm, volta or asdf, or with the agent started from the Dock
 * or an IDE, it often isn't: exit 127, swallowed as a non-blocking error.
 * Writing `process.execPath` into the command pins the exact Node that ran
 * `setup`, which disappears the day that version is uninstalled, while
 * `status` still counts every registration.
 *
 * So the launcher finds Node: the recorded one if it still runs, otherwise
 * the first of PATH and the usual install locations that is Node 20 or newer,
 * which it records for next time. It repairs itself the first time a hook
 * runs after the old Node goes away. Cost on the hot path is a `read` and an
 * `exec`.
 *
 * Windows keeps the pinned interpreter: there is no `sh` to run a launcher.
 */

export interface HookRunnerPaths {
  /** The launcher; what the hook command names. */
  launcher: string;
  bundle: string;
  /** The Node the launcher ran last, one path per file. */
  record: string;
  /** Written when a hook ran and no Node could be found. */
  noNode: string;
}

export function hookRunnerPaths(binaryName: string): HookRunnerPaths {
  const launcher = path.join(ascendaHome(), "bin", binaryName);
  return { launcher, bundle: `${launcher}.mjs`, record: `${launcher}.node`, noNode: `${launcher}.no-node` };
}

/**
 * Words on argv that mean a person ran the launcher, as against an agent
 * running a hook. With no Node, the first get an error and an exit status,
 * and a hook gets silence: an agent that shows hook stderr would otherwise
 * print the same complaint on every tool call.
 */
const LAUNCHER_MANAGEMENT_COMMANDS = ["setup", "install", "status", "uninstall", "doctor", "pair", "join", "object", "-h", "--help"];

export interface HookLauncherOptions {
  binaryName: string;
  /** What to run once Node is installed, e.g. `npx @ascenda-one/codex-hooks setup`. */
  setupCommand: string;
  /**
   * The one hook allowed to complain when there is no Node, once per session
   * rather than per call: Claude Code's `SessionStart`, which shows the
   * message. Others stay silent, because their agents' handling of a failing
   * hook's stderr is unknown or noisy.
   */
  loudEvent?: string;
}

export function hookLauncherScript(options: HookLauncherOptions): string {
  const { binaryName, setupCommand, loudEvent } = options;
  return [
    "#!/bin/sh",
    `# Ascenda hook launcher (${binaryName}). Written by \`setup\`, replaced by the`,
    "# next one; edits here are lost. Finds a Node to run the hook bundle beside it.",
    "",
    "dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd) || exit 0",
    `bundle="$dir/${binaryName}.mjs"`,
    `record="$dir/${binaryName}.node"`,
    `missing="$dir/${binaryName}.no-node"`,
    "",
    "runs() { [ -n \"$1\" ] && [ -f \"$1\" ] && [ -x \"$1\" ]; }",
    "",
    "# The hook bundle needs Node 20 or newer. Checked only while searching, so",
    "# the recorded path costs nothing to reuse.",
    "recent() {",
    "  runs \"$1\" && \"$1\" -e 'process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)' >/dev/null 2>&1",
    "}",
    "",
    "newest_nvm() {",
    "  [ -d \"$HOME/.nvm/versions/node\" ] || return 0",
    "  ls \"$HOME/.nvm/versions/node\" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | sed 's/^/v/'",
    "}",
    "",
    "node=\"\"",
    "how=recorded",
    "[ -r \"$record\" ] && IFS= read -r node < \"$record\"",
    "",
    "if ! runs \"$node\"; then",
    "  node=\"\"",
    "  how=found",
    "  nvm_default=\"\"",
    "  if [ -r \"$HOME/.nvm/alias/default\" ]; then",
    "    IFS= read -r wanted < \"$HOME/.nvm/alias/default\"",
    "    wanted=${wanted#v}",
    "    for candidate in \"$HOME/.nvm/versions/node/v$wanted\"*; do",
    "      [ -x \"$candidate/bin/node\" ] && nvm_default=\"$candidate/bin/node\"",
    "    done",
    "  fi",
    "  nvm_newest=$(newest_nvm)",
    "  for candidate in \\",
    "    \"$(command -v node 2>/dev/null)\" \\",
    "    /opt/homebrew/bin/node \\",
    "    /usr/local/bin/node \\",
    "    \"$HOME/.volta/bin/node\" \\",
    "    \"$nvm_default\" \\",
    "    \"$HOME/.local/share/fnm/aliases/default/bin/node\" \\",
    "    \"$HOME/Library/Application Support/fnm/aliases/default/bin/node\" \\",
    "    \"$HOME/.asdf/shims/node\" \\",
    "    \"$HOME/.local/share/mise/shims/node\" \\",
    "    \"$HOME/.nvm/versions/node/$nvm_newest/bin/node\"",
    "  do",
    "    if recent \"$candidate\"; then node=$candidate; break; fi",
    "  done",
    "  if [ -n \"$node\" ]; then",
    "    printf '%s\\n' \"$node\" > \"$record.$$\" 2>/dev/null && mv -f \"$record.$$\" \"$record\" 2>/dev/null",
    "    rm -f \"$missing\" 2>/dev/null",
    "  fi",
    "fi",
    "",
    "if [ -n \"$ASCENDA_HOOK_LAUNCHER_PROBE\" ]; then",
    "  [ -n \"$node\" ] || { echo \"no Node 20 or newer found on PATH or in the usual install locations\" >&2; exit 1; }",
    "  printf '%s\\t%s\\n' \"$node\" \"$how\"",
    "  exit 0",
    "fi",
    "",
    "if [ -z \"$node\" ]; then",
    "  date -u +%Y-%m-%dT%H:%M:%SZ > \"$missing\" 2>/dev/null",
    "  case \"$1\" in",
    ...(loudEvent ? [
      `    ${loudEvent})`,
      "      cat >/dev/null 2>&1",
      `      echo "Ascenda hooks cannot find Node 20 or newer, so none of them are running. Install Node, then run: ${setupCommand}" >&2`,
      "      exit 1 ;;"
    ] : []),
    `    ${LAUNCHER_MANAGEMENT_COMMANDS.join("|")})`,
    `      echo "${binaryName}: no Node 20 or newer found on PATH or in the usual install locations." >&2`,
    "      exit 1 ;;",
    "    *)",
    "      # A hook: say nothing per tool call. status and doctor read the",
    "      # file written above.",
    "      cat >/dev/null 2>&1",
    "      exit 0 ;;",
    "  esac",
    "fi",
    "",
    "exec \"$node\" \"$bundle\" \"$@\"",
    ""
  ].join("\n");
}

/**
 * Installs the running bundle, its launcher and the Node record, each
 * write-then-rename, so a hook the agent starts mid-install runs the old
 * file or the new one, never half of one. Returns the path the hook command
 * should name.
 */
export function installHookRunner(options: HookLauncherOptions & { dryRun: boolean; source?: string }): string {
  const paths = hookRunnerPaths(options.binaryName);
  if (options.dryRun) return paths.launcher;

  const source = path.resolve(options.source ?? process.argv[1]);
  fs.mkdirSync(path.dirname(paths.launcher), { recursive: true });

  if (process.platform === "win32") {
    // Same file when re-running an already-installed binary; copying it onto
    // itself would truncate it.
    if (source !== path.resolve(paths.launcher)) fs.copyFileSync(source, paths.launcher);
    return paths.launcher;
  }

  // Read before anything is written: an install from before the launcher
  // kept the bundle at the launcher's path, and re-running its own `setup`
  // runs from exactly the file about to be replaced.
  if (source !== path.resolve(paths.bundle)) writeAtomically(paths.bundle, fs.readFileSync(source), 0o755);
  writeAtomically(paths.launcher, hookLauncherScript(options), 0o755);
  writeAtomically(paths.record, `${process.execPath}\n`, 0o644);
  fs.rmSync(paths.noNode, { force: true });
  return paths.launcher;
}

/** Removes the launcher, bundle, Node record and no-Node marker. Returns what it removed. */
export function removeHookRunner(binaryName: string): string[] {
  const removed: string[] = [];
  for (const file of Object.values(hookRunnerPaths(binaryName))) {
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/**
 * The command a hooks file should carry: the launcher, quoted. On Windows,
 * the Node that ran setup and the bundle.
 */
export function hookRunnerCommand(launcher: string): string {
  return process.platform === "win32" ? `"${process.execPath}" "${launcher}"` : `"${launcher}"`;
}

function writeAtomically(target: string, contents: string | Buffer, mode: number): void {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

// ------------------------------------------------------------- last hook ---

const stateDir = (): string => process.env.ASCENDA_STATE_DIR ?? path.join(ascendaHome(), "state");

/** `state/<tool>-last-hook.json`, e.g. `claude_code-last-hook.json`. */
export function lastHookPath(tool: string): string {
  return path.join(stateDir(), `${tool}-last-hook.json`);
}

export interface LastHook {
  event: string;
  at: string;
}

/**
 * Records that the agent ran this hook. One small file, overwritten each
 * time: the event name and the instant, nothing from the payload. Never
 * throws: a health stamp must never cost a turn.
 */
export function stampLastHook(tool: string, event: string, now = new Date()): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const file = lastHookPath(tool);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ event, at: now.toISOString() })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best effort.
  }
}

export function readLastHook(tool: string): LastHook | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastHookPath(tool), "utf8")) as Partial<LastHook>;
    if (typeof parsed.event !== "string" || typeof parsed.at !== "string") return undefined;
    return { event: parsed.event, at: parsed.at };
  } catch {
    return undefined;
  }
}

/** "4 s ago", "12 min ago", "3 h ago", "2 days ago". */
export function describeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// ------------------------------------------------------------------ node ---

export interface NodeResolution {
  /** The Node the launcher would run, or undefined when it found none. */
  node?: string;
  /** How it was found: `recorded` or `found` (searched and recorded). */
  how?: string;
  version?: string;
  /** Set when nothing usable was found, or the launcher itself is missing. */
  problem?: string;
}

/**
 * Asks the installed launcher which Node it would run, with the environment
 * a Dock-launched app gets (no shell profile, a bare PATH) rather than this
 * terminal's. That is the case that fails silently: a terminal that loaded
 * nvm finds Node, an agent started from the Dock or an IDE may not.
 */
export function resolveHookNode(launcher: string): NodeResolution {
  if (!fs.existsSync(launcher)) return { problem: "the hook launcher is not installed" };
  const probe = spawnSync("/bin/sh", [launcher], {
    encoding: "utf8",
    timeout: 5000,
    env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ASCENDA_HOOK_LAUNCHER_PROBE: "1" }
  });
  const [node, how] = (probe.stdout ?? "").trim().split("\t");
  if (probe.status !== 0 || !node) {
    return { problem: (probe.stderr ?? "").trim() || "the launcher found no Node it can run" };
  }
  const version = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0) return { node, how, problem: `${node} did not run` };
  return { node, how, version: version.stdout.trim() };
}

/** A path under the home folder written with `~`, for what a person reads. */
export function tidyHomePath(file: string, home = process.env.HOME ?? ""): string {
  return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}
