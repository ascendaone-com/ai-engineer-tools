/**
 * Where each store lives on disk. Resolution is centralised here because the
 * paths are the reverse-engineered part of the whole design: every one of
 * them (except git) is an undocumented internal of someone else's product,
 * and when an upstream release moves a store, this file is where the fix
 * lands.
 */
import { readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extraClaudeProfileDirs } from "@ascenda-one/tool-kit";

export interface StorePaths {
  home: string;
  /** `~/.claude` — transcripts, prompt history, file snapshots, settings.
   * The first entry of `CLAUDE_CONFIG_DIR` when that's set. */
  claudeRoot: string;
  claudeProjects: string;
  claudeSettings: string;
  /** Every Claude Code config dir to read, `claudeRoot` first. One entry
   * unless `CLAUDE_CONFIG_DIR` lists several. */
  claudeConfigDirs: string[];
  /** The `projects/` dir under each of `claudeConfigDirs`, same order. */
  claudeProjectsDirs: string[];
  /** `~/Library/Application Support/Claude/local-agent-mode-sessions` —
   * Claude Desktop's Cowork sessions, each with its own `.claude` dir. */
  claudeDesktopSessionsRoot: string;
  /** The Cowork `projects/` dirs found under `claudeDesktopSessionsRoot`,
   * sorted. Empty off macOS. Also the tail of `claudeProjectsDirs`. */
  claudeCoworkProjectsDirs: string[];
  /** `~/.codex`, or `CODEX_HOME` when set — Codex CLI's home; rollouts,
   * config, skills, caches. */
  codexRoot: string;
  /** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` — one rollout
   * per session, append-only JSONL. Plaintext unless history compression is
   * on, which writes `.jsonl.zst`. A long thread continues in
   * `rollout-<ts>-<id>_<rollout>.jsonl`. */
  codexSessions: string;
  /** `~/.codex/archived_sessions` — rollouts the user archived from the
   * resume picker, same shape, moved rather than deleted. */
  codexArchivedSessions: string;
  /** `~/.copilot/session-state` — Copilot CLI's session logs. One directory
   * per session holding `events.jsonl` and `workspace.yaml`; older builds
   * left a flat `<id>.jsonl` beside the directories instead. */
  copilotSessionState: string;
  /** Cursor's global SQLite KV — conversations and bubbles. WAL mode: never
   * open read-write; copy db+wal, or read with `immutable=1`. */
  cursorStateDb: string;
  cursorSearchDb: string;
  /** VS Code Timeline local history — per-file snapshot dirs. */
  vscodeHistory: string;
  /** Copilot chat sessions, one JSON per session, under workspaceStorage. */
  vscodeWorkspaceStorage: string;
  /** Every VS Code install this machine might have, Code first. Each keeps its
   * own history, workspace storage and loose chat directories. */
  vscodeVariants: VsCodeVariantPaths[];
  /** Where git repos are looked for. Overridable — `~/Dev` is one machine's
   * convention, not a rule. */
  devRoot: string;
  zshHistory: string;
}

/** One VS Code flavour's stores. All three share a layout under
 * `<Application Support>/<name>/User`. */
export interface VsCodeVariantPaths {
  name: string;
  history: string;
  workspaceStorage: string;
  /** Chats made with no folder open. */
  emptyWindowChatSessions: string;
  /** Sessions VS Code moved between windows. */
  transferredChatSessions: string;
}

export const VSCODE_VARIANT_NAMES = ["Code", "Code - Insiders", "VSCodium"] as const;

function expandHome(entry: string, home: string): string {
  if (entry === "~") return home;
  if (entry.startsWith("~/")) return path.join(home, entry.slice(2));
  return path.resolve(entry);
}

/**
 * Claude Code's config dirs. `CLAUDE_CONFIG_DIR` moves the whole of
 * `~/.claude`, and may list several dirs separated by commas, one per
 * account. An entry ending in `projects` is read as that projects dir, since
 * people point the variable at either. Unset or empty means `~/.claude`.
 */
export function claudeConfigDirsOf(
  home: string,
  env: NodeJS.ProcessEnv
): { configDir: string; projectsDir: string }[] {
  const out: { configDir: string; projectsDir: string }[] = [];
  const seen = new Set<string>();
  for (const raw of (env.CLAUDE_CONFIG_DIR ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const resolved = expandHome(entry, home);
    const dirs =
      path.basename(resolved) === "projects"
        ? { configDir: path.dirname(resolved), projectsDir: resolved }
        : { configDir: resolved, projectsDir: path.join(resolved, "projects") };
    if (seen.has(dirs.projectsDir)) continue;
    seen.add(dirs.projectsDir);
    out.push(dirs);
  }
  if (out.length === 0) {
    out.push({ configDir: path.join(home, ".claude"), projectsDir: path.join(home, ".claude", "projects") });
  }
  // Profile folders beside the default one, `~/.claude-work` and the like,
  // which people point CLAUDE_CONFIG_DIR at from a shell alias. A process
  // started without the variable would never see them. Only a folder that
  // already holds a `projects` dir counts, so `~/.claude-backup` copies of
  // settings alone don't.
  for (const configDir of extraClaudeProfileDirs(home)) {
    const dirs = { configDir, projectsDir: path.join(configDir, "projects") };
    if (seen.has(dirs.projectsDir)) continue;
    seen.add(dirs.projectsDir);
    out.push(dirs);
  }
  return out;
}

/** How many directory levels below the Cowork root are searched. */
const COWORK_WALK_DEPTH = 5;

/**
 * The `projects/` dirs of Claude Desktop's Cowork sessions:
 *
 *   <root>/<account>/<org>/local_<id>/.claude/projects
 *   <root>/<account>/<org>/agent/local_ditto_<id>/.claude/projects
 *
 * Walks at most five levels down (account, org, agent, session, `.claude`) for a `projects` dir whose parent is `.claude`,
 * and doesn't go inside one. Anything with `audit` in its path is skipped:
 * `audit.jsonl` sits beside `.claude/` and repeats the session's usage.
 * `claude-code-sessions/` next to the root holds manifests only and is never
 * visited. macOS only; the other platforms keep Claude Desktop's data
 * elsewhere, and this isn't resolved for them. Sorted, so runs agree.
 */
export function coworkProjectsDirsOf(root: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.toLowerCase().includes("audit")) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === "projects" && path.basename(dir) === ".claude") {
        found.push(child);
      } else if (depth < COWORK_WALK_DEPTH) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found.filter((p) => !p.toLowerCase().includes("audit")).sort();
}

/** Codex's home: `CODEX_HOME` when it's set and non-empty, else `~/.codex`. */
export function codexHomeOf(home: string, env: NodeJS.ProcessEnv): string {
  const entry = env.CODEX_HOME?.trim();
  return entry ? expandHome(entry, home) : path.join(home, ".codex");
}

export function resolveStorePaths(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): StorePaths {
  const appSupport = path.join(home, "Library", "Application Support");
  const claudeDesktopSessionsRoot = path.join(appSupport, "Claude", "local-agent-mode-sessions");
  const claudeCoworkProjectsDirs = coworkProjectsDirsOf(claudeDesktopSessionsRoot, platform);
  const claude = claudeConfigDirsOf(home, env);
  const codexRoot = codexHomeOf(home, env);
  return {
    home,
    claudeRoot: claude[0].configDir,
    claudeProjects: claude[0].projectsDir,
    claudeSettings: path.join(claude[0].configDir, "settings.json"),
    claudeConfigDirs: claude.map((c) => c.configDir),
    claudeProjectsDirs: [...claude.map((c) => c.projectsDir), ...claudeCoworkProjectsDirs],
    claudeDesktopSessionsRoot,
    claudeCoworkProjectsDirs,
    codexRoot,
    codexSessions: path.join(codexRoot, "sessions"),
    codexArchivedSessions: path.join(codexRoot, "archived_sessions"),
    copilotSessionState: path.join(home, ".copilot", "session-state"),
    cursorStateDb: path.join(appSupport, "Cursor", "User", "globalStorage", "state.vscdb"),
    cursorSearchDb: path.join(
      appSupport,
      "Cursor",
      "User",
      "globalStorage",
      "conversation-search.db"
    ),
    vscodeHistory: path.join(appSupport, "Code", "User", "History"),
    vscodeWorkspaceStorage: path.join(appSupport, "Code", "User", "workspaceStorage"),
    vscodeVariants: VSCODE_VARIANT_NAMES.map((name) => {
      const user = path.join(appSupport, name, "User");
      return {
        name,
        history: path.join(user, "History"),
        workspaceStorage: path.join(user, "workspaceStorage"),
        emptyWindowChatSessions: path.join(user, "globalStorage", "emptyWindowChatSessions"),
        transferredChatSessions: path.join(user, "globalStorage", "transferredChatSessions")
      };
    }),
    devRoot: path.join(home, "Dev"),
    zshHistory: path.join(home, ".zsh_history")
  };
}
