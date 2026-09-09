# Handoff: Codex never executes our hooks on codex-cli 0.153.4

**Status:** resolved for codex-cli 0.153.4; see [resolution](HOOK_EXECUTION_RESOLUTION.md).
**Written:** 9 Sep 2026. The investigation below is preserved as historical context;
its inference that an absent expected journal proves non-execution was disproved.
**Ask:** find out why Codex does not run the hooks we register, and make it run
them — or establish that it cannot on this build, with evidence.

This document exists so you do not repeat six experiments that already failed.
Read "Already ruled out" before forming a hypothesis.

---

## 1. The problem in one paragraph

`@ascenda-one/codex-hooks` registers seven command hooks in `~/.codex/hooks.json`.
Codex accepts the file, `status` reports `7/7 registered`, and the hook binary
works when invoked by hand. But Codex never invokes it. Across six real Codex
sessions on 9 Sep 2026 — three non-interactive (`codex exec`), three interactive
from a terminal — **not one hook ran**. Telemetry that looks configured and
delivers nothing is worse than telemetry that is obviously absent, so this
blocks shipping the Codex path in the product's Connections pane.

## 2. Environment (all facts verified, not assumed)

| | |
|---|---|
| Codex | `codex-cli 0.153.4`, `macos-aarch64` |
| Binary | `/Applications/ChatGPT.app/Contents/Resources/codex` — Codex ships **inside ChatGPT.app**, there is no separate Codex.app or `codex` on PATH |
| ChatGPT.app | 26.212.1823 |
| macOS | 26.5.1, Apple silicon |
| Node | v24.11.0 (nvm) |
| Hooks feature flag | `codex features list` → `hooks   stable   true` (also `plugin_hooks   removed   false`) |
| Our adapter | `ascenda-codex-hooks`, built from source at `~/Dev/ascendaone.com/ai-engineer-tools` |

## 3. How to tell whether a hook ran — read this before testing anything

Three independent signals. Use at least two — none of them is conclusive alone.
Signal 1 was misread during this investigation; see the correction under it.

1. **The send journal.** `~/.ascenda/state/<toolInstallationId>.json`, written on
   **every** delivery attempt including failures. **Correction:** it is keyed by
   the *resolved* identity, not by which adapter wrote it — so a missing journal
   for the id you expect means "nothing ran under that id", never "nothing ran".
   Check every journal in the directory, and read the event log for
   `metadata.host` before concluding an adapter is silent.
2. **The local event log.** Set `ASCENDA_EVENT_LOG_FILE=~/.ascenda/events.jsonl`
   (already exported in this machine's `~/.zshrc`). Logs each payload as sent.
3. **A marker script.** Point the hook at a shell script that does
   `touch /tmp/marker` — takes Ascenda out of the path entirely and proves
   whether *any* handler executes. Use this to separate "Codex is not calling
   hooks" from "our binary is failing silently". It was used below.

To confirm a Codex session really happened, check for a new rollout:
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, one file per session.

## 4. Already ruled out — do not redo these

Each row is a real Codex session that completed. "Fired" means any hook handler
executed at all (marker file or journal).

| # | Configuration | Mode | Fired |
|---|---|---|---|
| 1 | `~/.codex/hooks.json`, as `setup` writes it (TitleCase, nested `hooks` array, `type`/`command`/`timeout`) | `codex exec` | no |
| 2 | Same file | interactive TUI ×3 | no |
| 3 | Hook inline via `-c 'hooks.SessionStart=[{hooks=[{…}]}]'` | `codex exec` | no |
| 4 | Hook inline via `-c 'hooks.UserPromptSubmit=[{…, timeoutSec=10}]'` (flat, no nested array) | `codex exec` | no |
| 5 | `[[hooks.user_prompt_submit]]` block appended to `~/.codex/config.toml` (snake_case, `timeout_sec`) | `codex exec` | no — **and the run hung with no output** |
| 6 | `~/.codex/hooks.json` with `"matcher": "startup|resume"` on `SessionStart`, handlers pointing at a marker script | `codex exec` | no — **also hung** |

Also checked and eliminated as causes:

- **Not a format mismatch.** The official reference (`https://learn.chatgpt.com/docs/hooks`)
  specifies `~/.codex/hooks.json`, TitleCase event names, a nested `hooks` array
  per matcher group, and handler fields `type` / `command` / `timeout` (seconds,
  default 600). What `setup` writes matches on every one of those. The only
  documented field we omit is `matcher`; row 6 added it and changed nothing.
- **Not our binary.** `~/.ascenda/bin/ascenda-codex-hook` is executable and, run
  by hand with a JSON payload on stdin, resolves its identity and attempts a
  send. Rows 5 and 6 removed it from the path entirely and still nothing ran.
- **Not disabled by config.** `~/.codex/config.toml` has no `hooks` key, no
  disable flag. `codex doctor` reports nothing about hooks. The `hooks` feature
  flag is `stable / true`.
- **Not exec-only.** Row 2 covers three interactive sessions.
- **Not a broken install.** With the original files restored, a clean
  `codex exec` completes normally in seconds.

**Unexplained and worth attention:** rows 5 and 6 *hung with zero output* and had
to be killed, while every run with the original files completed. So Codex is
demonstrably **reading** these files — a malformed one wedges it — but not
executing the handlers. Whatever is wrong is downstream of parsing. That hang is
probably the single best lead in this document.

## 5. Hypotheses still open, best first

1. **The app-hosted CLI ignores user-scope hooks.** Codex here is a binary inside
   ChatGPT.app that talks to a shared local app-server daemon (`codex agents`
   mentions it; `codex-code-mode-host` runs alongside). Hook execution may live
   in the daemon, which may load config only at its own launch, or may not load
   user hooks at all. **Test:** find and restart the daemon (or reboot), then one
   interactive session. Also try a *project-scoped* `<repo>/.codex/hooks.json`,
   which the docs list and which we have never tested.
2. **A trust or approval gate.** The binary's strings carry
   `UnlessTrusted / OnRequest / Never` near the TOML config region, and
   `config.toml` records a `trust_level` per project. A hook is arbitrary code
   execution; it would be reasonable to gate it on a trusted workspace or a
   one-time approval that never appeared. **Test:** run in a directory whose
   project entry is trusted, and watch for any prompt.
3. **The shape has moved and the public doc is stale.** The binary contains a
   snake_case `HookEventName` enum (`pre_tool_use`, `user_prompt_submit`, …),
   `timeout_sec`, `status_message`, `additional_context_limit`, handler kinds
   `Command / Mcp / Tool / Prompt / Agent`, and a config-source enum
   (`system user project mdm session_flags plugin cloud_requirements …`). Rows 4
   and 5 tried the obvious snake_case forms and failed, but not exhaustively —
   the nesting may differ from what we guessed. **Test:** disassemble or trace
   `core/src/hook_runtime.rs` symbols (`run_pending_session_start_hooks`,
   `run_turn_stop_hooks`, `codex.hooks.run`) and read the deserializer rather
   than guessing. Strings referencing `hooks/hooks.json` next to `PLUGIN_ROOT`
   suggest a plugin-scoped location too.
4. **Hooks are gated to a distribution we are not on.** `install method: other`,
   `commit: unknown` in `codex doctor` — this is an app-bundled build, not an npm
   one. **Test:** install `codex` from npm separately and register the same file.

## 6. Guardrails — this is someone's working machine

- **Back up before editing, restore after.** The two files that matter are
  `~/.codex/config.toml` and `~/.codex/hooks.json`. A malformed edit to either
  hangs Codex (rows 5 and 6), which is a real interruption to whoever is using it.
- **Do not delete anything under `~/.ascenda/`.** Tokens, journals and the
  credentials file are live pairings for this person's real account.
- **Do not disconnect tools in the Ascenda app.** Two identities are correctly
  paired now (`claude_code:…` for Claude Code, `cli_agent:…` for Codex) after a
  day spent untangling them; disconnecting risks losing that.
- **Every `codex exec` run costs the user tokens** (~7.5k for a trivial prompt).
  Prefer marker scripts and one prompt per configuration, and batch several
  hypotheses into a single run where you can.
- Installation ids are deliberately not quoted in this document. Read them from
  `~/.ascenda/credentials.json` on the machine.

## 7. Done means

1. A Codex session — interactive, ordinary use, no special flags — produces a
   journal file at `~/.ascenda/state/cli_agent_<uuid>.json` with
   `"lastOutcome": "accepted"`.
2. The event log shows payloads carrying `metadata.host: "codex"`.
3. Whatever configuration achieved that is expressed in
   `ascenda-codex-hooks/src/setup.ts` (the `CliAgentSetupSpec`), so `setup`
   writes it, with a test in `tests/setup.test.mjs` pinning the shape.
4. `examples/hooks.json` matches what `setup` writes — there is already a test
   asserting the two agree; keep it passing.

**Or**: a documented conclusion that this build cannot run user hooks, with the
evidence, so the product can stop offering a Codex path that silently collects
nothing. That outcome is worth as much as a fix and should not be treated as a
failure.

## 8. Repo orientation

Everything below is under `~/Dev/ascendaone.com/ai-engineer-tools`.

| Path | What it is |
|---|---|
| `ascenda-codex-hooks/src/setup.ts` | The spec that decides where and how hooks are written. **The file to change.** |
| `ascenda-codex-hooks/src/cli.ts` | Entry point: management commands, then hook dispatch |
| `ascenda-codex-hooks/src/mapCodexEvent.ts` | Codex hook payload → catalog event |
| `ascenda-codex-hooks/examples/hooks.json` | The hand-merge equivalent of what `setup` writes |
| `packages/tool-kit/src/cliAgentSetup.ts` | Shared `setup`/`status`/`uninstall`; `writeHookSettings` does the registration |
| `packages/tool-kit/src/hookAdapter.ts` | Identity resolution (env → credentials → token store) and delivery |
| `ascenda-cursor-hooks/`, `ascenda-gemini-hooks/`, `ascenda-windsurf-hooks/` | Three working adapters on the same machinery — useful for contrast |
| `ascenda-dev-server/` | Local stub of the ingest contract; run it and point `ASCENDA_API_BASE_URL` at `http://localhost:4477` to test end to end without touching the real account |

Build and test: `npm run build:shared` at the root, then
`cd ascenda-codex-hooks && npm run build && npm test`.
