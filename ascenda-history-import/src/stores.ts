/**
 * Where each store lives on disk. Resolution is centralised here because the
 * paths are the reverse-engineered part of the whole design: every one of
 * them (except git) is an undocumented internal of someone else's product,
 * and when an upstream release moves a store, this file is where the fix
 * lands.
 */
import * as os from "node:os";
import * as path from "node:path";

export interface StorePaths {
  home: string;
  /** `~/.claude` — transcripts, prompt history, file snapshots, settings. */
  claudeRoot: string;
  claudeProjects: string;
  claudeSettings: string;
  /** `~/.codex` — Codex CLI's home; rollouts, config, skills, caches. */
  codexRoot: string;
  /** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` — one rollout
   * per session, append-only JSONL, plaintext. */
  codexSessions: string;
  /** `~/.codex/archived_sessions` — rollouts the user archived from the
   * resume picker, same shape, moved rather than deleted. */
  codexArchivedSessions: string;
  /** Cursor's global SQLite KV — conversations and bubbles. WAL mode: never
   * open read-write; copy db+wal, or read with `immutable=1`. */
  cursorStateDb: string;
  cursorSearchDb: string;
  /** VS Code Timeline local history — per-file snapshot dirs. */
  vscodeHistory: string;
  /** Copilot chat sessions, one JSON per session, under workspaceStorage. */
  vscodeWorkspaceStorage: string;
  /** Where git repos are looked for. Overridable — `~/Dev` is one machine's
   * convention, not a rule. */
  devRoot: string;
  zshHistory: string;
}

export function resolveStorePaths(home: string = os.homedir()): StorePaths {
  const appSupport = path.join(home, "Library", "Application Support");
  return {
    home,
    claudeRoot: path.join(home, ".claude"),
    claudeProjects: path.join(home, ".claude", "projects"),
    claudeSettings: path.join(home, ".claude", "settings.json"),
    codexRoot: path.join(home, ".codex"),
    codexSessions: path.join(home, ".codex", "sessions"),
    codexArchivedSessions: path.join(home, ".codex", "archived_sessions"),
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
    devRoot: path.join(home, "Dev"),
    zshHistory: path.join(home, ".zsh_history")
  };
}
