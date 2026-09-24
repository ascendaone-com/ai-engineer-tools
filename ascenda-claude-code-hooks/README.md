# Ascenda Claude Code Hooks

Claude Code hooks adapter for Ascenda AI workload telemetry.

Part of [ai-engineer-tools](../). For what these measurements do and do not
establish, see [What this measures](../#what-this-measures-and-what-that-does-not-yet-prove).
Event mapping: [docs/CLAUDE_MAPPING.md](./docs/CLAUDE_MAPPING.md).

## Role in workload detection (Phase 1)

This package is the **primary AI interaction load** source in the tooling repo. For AI engineers, digital telemetry from agent workflows is potentially more valuable than wearables in Phase 1.

| Workload input | How this adapter contributes |
| --- | --- |
| AIInteractionLoad | Prompts, tool calls, correction loops, compaction |
| FocusDuration | Long agent loops (`agent_loop_long`) |
| Workflow friction | Tool failures, context pressure |
| Verification load | Test/lint/build bash → `editor_verification_activity` / `compile_error` |

Signals feed backend aggregation into creation / verification / supervision composition and the prototype workload score. Subjective strain and meeting load come from the app; baselines from backend Phase 3.

## Architecture

```text
Claude Code hook adapter
  -> toolInstallationId + eventWriteToken
  -> Ascenda backend (POST /v1/tool-events)
  -> paired anonymous Ascenda user
  -> workload aggregation + baseline comparison
  -> app notification / dashboard
```

Same loose-coupled pairing model as the VS Code and Cursor extensions. See [TOOL_PAIRING_API_REFERENCE.md](../api-docs/TOOL_PAIRING_API_REFERENCE.md).

## Install

### Recommended: the Claude Code plugin

One command installs this adapter, the work-signals skill, and the MCP server
together — already wired to every lifecycle event, no settings file to edit:

```bash
claude plugin marketplace add ascendaone-com/ai-engineer-tools
claude plugin install ascenda@ascenda-one
```

From inside a session, use `/plugin marketplace add …` then `/plugin install …`.
See [ascenda-agent-skills](../ascenda-agent-skills/) for what the bundle holds.

### Alternative: this adapter on its own

If you want the deterministic hooks without the skill or MCP server, the
published package runs with no clone and no build:

```bash
npx @ascenda-one/claude-code-hooks setup
```

This pairs (printing a 6-digit code to confirm in the Ascenda app), installs a
self-contained hook bundle to `~/.ascenda/bin`, writes
`~/.ascenda/credentials.json`, and registers the hooks in this project's
`.claude/settings.local.json`. Restart Claude Code and events flow — no shell
exports, no settings file to hand-edit.

```bash
npx @ascenda-one/claude-code-hooks status      # exits non-zero if anything is unwired
npx @ascenda-one/claude-code-hooks uninstall   # removes hooks and the binary
```

| Option | |
| --- | --- |
| `--api-base-url <url>` | ingest host (default `https://api.ascenda.one`) |
| `--local [port]` | shorthand for a local [dev server](../ascenda-dev-server/) (default `4477`) |
| `--tool-installation-id <id>` / `--token <t>` | reuse an existing pairing instead of creating one |
| `--no-pair` | install the local half only: hooks work, nothing is sent |
| `--scope project\|user` | register in this project (default) or in `~/.claude/settings.json` |
| `--project-dir <path>` | project root for `--scope project` (default cwd) |
| `--dry-run` | print what would change, write nothing |

From a clone, `./scripts/setup-local.sh` builds the workspace, starts the dev
server detached, and runs the same `setup --local` — no backend, no phone, no
DevAuth. Stop it with `./scripts/setup-local.sh --stop`. See
[TESTING.md](../TESTING.md).

#### What setup writes

| Path | |
| --- | --- |
| `~/.ascenda/bin/ascenda-claude-hook` | the self-contained bundle — no `npm -g`, no sudo, no PATH edit |
| `~/.ascenda/credentials.json` | `apiBaseUrl` + `toolInstallationId`, `0600` (plus `localOnly` on an install with no pairing) |
| `~/.ascenda/tokens/<id>` | the event write token, `0600`, rotated in place on renew |
| `.claude/settings.local.json` | one hook entry per lifecycle event, `timeout: 5` |

Registration is idempotent and marker-keyed: re-running replaces our entries
rather than appending, hooks belonging to anyone else are left alone, and the
file is backed up to `.ascenda-backup` before the first write. Settings that
are not valid JSON abort the run rather than being overwritten.

Hooks then need **no environment at all**: the command pins the absolute path
of the Node that ran setup, and configuration comes from the credentials file.
Claude Code spawns hooks with whatever environment it was launched from, so
anything depending on shell exports stops working the moment the editor is
opened from a launcher rather than a terminal. The variables below still
override the file when set.

`status` also flags hook entries pointing at a binary that no longer exists —
those fail silently on every event otherwise. It checks one scope, defaulting
to `project` like `setup`; if it finds nothing there it looks in the other one
and says where the hooks actually are. User settings apply in every project, so
hooks found there answer a project-scope check.

#### Installing without a pairing

`--no-pair` installs the hooks and stops before pairing. A `setup` that tried
to pair and couldn't finish — the backend unreachable, nobody at the keyboard
to confirm the code, the session expired — lands in the same place instead of
failing. The install completes either way, and the summary names which half is
running:

```text
Installed, not paired.
  active       the session prompts, and the live signal to a socket on this machine
  inactive     delivery to https://api.ascenda.one. Nothing is sent, and nothing is queued for later.
  pair later   npx @ascenda-one/claude-code-hooks pair
```

Two things work with no pairing at all, which is why this mode exists. The
session prompts are composed locally in the hook process. The live signal goes
to a socket on your own machine, so a listener there sees an agent working the
moment it starts. Neither owes anything to a backend, and gating the install on
one kept them from the people still setting Ascenda up.

What that install holds: the hook binary, the registered events, and a
credentials file with an installation id, `localOnly: true` and `installedAt`.
No `pairedAt` and no token — nothing here fabricates a credential it doesn't
have. The id is the part that matters later. `pair` claims that same id, so the
hooks already registered in your settings file end up paired; the flag is
dropped and `pairedAt` takes its place.

Delivery is a deliberate no-op until then. Nothing is sent, nothing is queued,
and the send journal stays empty rather than recording an outage on every hook
event. An absent token on an install that *was* paired is a different matter:
that's a revoked or deleted credential, and it goes on being reported. `status`
and `doctor` both distinguish the two:

```text
pairing        claude_code:… (not paired, installed 2026-09-23T05:13:40.907Z)
token          — none until this install is paired
delivery       inactive — nothing is sent, and nothing is queued for later
local features active — the session prompts and the live socket signal need no pairing
hooks          10/10 registered in ~/.claude/settings.json
```

`uninstall` removes an unpaired install the same way, and says there is no
token to revoke. It leaves any other agent's pairing in the credentials file
where it is.

### Pairing by hand (if you skip `setup`)

`setup` pairs for you. To pair this machine directly instead:

```bash
npx -y @ascenda-one/claude-code-hooks pair
```

It prints a 6-digit code — confirm it in the Ascenda app under
**Connections → Ingest telemetry** — then saves the write token to
`~/.ascenda/tokens/` and the pairing to `~/.ascenda/credentials.json`. Restart
Claude Code; there is nothing to add to a shell profile. The token itself is
never copied around — every CLI tool reads it from the file `pair` wrote. (The
editor extension's pairing cannot be reused here: its token lives in the
editor's private secret storage.)

Run on a machine `setup` has already touched, `pair` attaches to the
installation that file names instead of minting a second one, and pairs against
the host recorded there. That's what finishes a `--no-pair` install.

`--tool-type <type>` pairs something else CLI-shaped that has no `setup` of its
own. An explicit type always mints its own id: naming a different tool is
pairing a second one, not re-pairing this one, and reusing the id there would
file the new tool's work under the old tool's identity.

> **How a hook names itself**, in order: `ASCENDA_TOOL_INSTALLATION_ID` if it is
> set, then `~/.ascenda/credentials.json`, then the token store — where exactly
> one `claude_code` token means its filename is the id. With none, or several,
> every hook invocation records a `skipped_no_installation_id` attempt in the
> journal and exits saying so, rather than silently minting a second, unpaired
> identity that would fragment your telemetry across two installations.
>
> The environment variable is per *machine*, while the credentials file is per
> *tool* — so exporting one id on a machine running two agents sends both
> agents' work under it. Prefer the file, which both `pair` and `setup` write.

On a Dev backend with no phone, [pairing-sim](../ascenda-pairing-sim/) stands in
for the app:

```bash
cd ../ascenda-pairing-sim && npm run build
node dist/cli.js e2e --tool-type claude_code
```

Optional environment:

| Variable | Purpose |
| --- | --- |
| `ASCENDA_API_BASE_URL` | Backend to send to. Defaults to `https://api.ascenda.one`; use `http://localhost:5002` or the Azure Dev host for development |
| `ASCENDA_EVENT_WRITE_TOKEN` | Only if you have no prior pairing to reuse — normally the token file supplies this |
| `ASCENDA_EVENT_WRITE_TOKEN_FILE` | Override token file path (default `~/.ascenda/tokens/<toolInstallationId>`) |
| `ASCENDA_SESSION_ID` | Stable session id across hooks |
| `ASCENDA_WORKSPACE_HASH` | Override only. By default the hook derives this from the payload's own `cwd`: a machine-salted hash of the checkout folder's basename (never the path itself) |
| `ASCENDA_PROJECT_HASH` | Override only. Defaults to the salted hash of the canonical repository's basename — a git worktree folds into the repo it was created from |
| `ASCENDA_STATE_FILE` | Override the send journal path (default `~/.ascenda/state/<toolInstallationId>.json`) |
| `ASCENDA_OUTBOX_FILE` | Override the outbox path (default `~/.ascenda/state/<toolInstallationId>.outbox.jsonl`) |
| `ASCENDA_OUTBOX_DRAIN` | `true` lets the next hook re-send queued events. **Off by default** until the ingest endpoint is confirmed to dedupe live events on `idempotencyKey`; see "When the collector cannot reach Ascenda" |
| `ASCENDA_DISABLE_FAILURE_NOTICE` | `true` silences the one-time in-session notice about a collector that has stopped delivering |

On first run the CLI seeds `~/.ascenda/tokens/<toolInstallationId>` so
**tool-scoped renew** can persist rotated tokens without you editing anything.

### Register hooks manually

The plugin does this for you — this section is only for the standalone route.
Merge [`examples/settings.local.json`](./examples/settings.local.json) into
`.claude/settings.local.json` in a project, or into Claude Code's user settings
for machine-wide coverage:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks SessionStart", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks UserPromptSubmit", "timeout": 5 }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PreToolUse", "timeout": 5 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostToolUse", "timeout": 5 }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostToolUseFailure", "timeout": 5 }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PreCompact", "timeout": 5 }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks PostCompact", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks Stop", "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks Notification", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "npx -y @ascenda-one/claude-code-hooks SessionEnd", "timeout": 5 }] }]
  }
}
```

Keep the timeouts. Without one Claude Code gives a hook up to 600s, and all
SessionEnd hooks share 1.5s between them.

### Verify

```bash
npx -y @ascenda-one/claude-code-hooks doctor
```

`doctor` prints the installation id and where it came from (environment,
credentials file, or the token store on disk), the token's presence and age,
the last recorded send outcome, any sends skipped for want of an installation
id, and the result of a live round trip against the real ingest endpoint. It is the first thing to run when the Ascenda app shows a
connected tool that is not producing data.

A telemetry failure never blocks your turn: **every hook invocation exits `0`**,
including one that failed to send. Do not read the exit code — or stderr, which
Claude Code discards for a hook that exits `0` — as evidence of anything. Read
the journal instead.

### When the collector stops sending

Every send attempt — success included — is recorded to
`~/.ascenda/state/<toolInstallationId>.json`:

```json
{
  "lastAttemptAt": "2026-08-17T08:05:17.436Z",
  "lastSuccessAt": "2026-08-17T08:05:04.782Z",
  "lastOutcome": "auth_failed",
  "consecutiveFailures": 1,
  "httpStatus": 401,
  "errorCode": "invalid_token",
  "failingSince": "2026-08-17T08:05:17.436Z"
}
```

Successes are recorded deliberately. If only failures were written, an absent
journal would mean both "healthy" and "never ran" — and telling those apart is
the entire problem. A `lastAttemptAt` that is minutes old with
`"lastOutcome": "accepted"` is positive evidence of health; one that is hours
stale means the collector is not running at all, which is a different fault with
a different fix.

When an installation transitions into a failing state, the next `SessionStart`
or `PostToolUse` adds **one** line of context to the session naming the cause
and offering `doctor` and `pair`. It appears once per outage, not once per tool
call, and never repeats until the collector has recovered and failed again.

`lastSeenAt` in the Ascenda app cannot substitute for any of this: it cannot
distinguish a dead token from a night's sleep, because both are "no events".
Only the collector knows it tried and was refused.

### When the collector cannot reach Ascenda

A send that fails without a verdict — the endpoint unreachable, a timeout, a
`429` or `5xx` — is retried once after 250 ms and then **kept**, not dropped.
The payload is appended to an outbox next to the journal:

```
~/.ascenda/state/<toolInstallationId>.outbox.jsonl
```

one JSON line per event, exactly as it would have gone on the wire, plus the
time it was queued. Anything longer than a blip — a laptop waking from sleep,
a VPN reconnecting, a captive portal, a slow network on a train — used to lose
every event for its duration with no copy anywhere. Now it costs nothing but
delay. A rejection *with* a verdict (`400`, `401`, `403`) is not queued:
replaying it cannot change the answer.

The next hook invocation drains the outbox, oldest first, one batch of up to
100 per invocation and never with a backoff loop — the hook is on your
critical path, and the invocation after that is usually seconds away. An
entry is deleted when the server answers `accepted` **or** `duplicate`; a
duplicate means the server already had it, which is the point of the
`idempotencyKey` every event carries. If the door refuses again, the pass stops
with everything still on disk, and the live event joins the queue instead of
knocking on a door that just said no.

> **Sending from the outbox is off by default.** Set `ASCENDA_OUTBOX_DRAIN=true`
> to enable it. A drain against an ingest endpoint that does not yet dedupe
> live events on `idempotencyKey` would land every queued event a second
> time — the exact double-count that blocked this queue until the key existed.
> Until the deployed backend is confirmed to answer a replay with `duplicate`,
> events are queued, bounded and reported, but not re-sent.

The outbox is bounded: 10,000 entries and 7 days. When a bound evicts, the
discard is recorded in the journal as `"lastOutcome": "outbox_discarded"` with
a cumulative `outboxDiscarded` block — how many, when, why, and how far back
the loss reaches. It survives every later success, because a gap that has
since closed is still a gap in the data.

`doctor` reads all of this:

```
  Outbox                ~/.ascenda/state/claude_code_….outbox.jsonl
  Outbox depth          37 waiting — oldest queued 2026-09-03T01:12:08.114Z (3h 41m ago)
  Outbox drain          off (queued events are kept and bounded, not sent) — ASCENDA_OUTBOX_DRAIN
  Outbox discarded      12 total; last 12 at 2026-09-02T… (12 age, reaching back to 2026-08-25T…)
```

A non-empty outbox is the honest health answer. `consecutiveFailures` resets
on the first success after an outage; the outbox says events from that outage
are still on this machine.

Hooks overlap — Claude Code fires `PreToolUse` and `PostToolUse` from separate
processes — so appends use `O_APPEND` (whole lines, never fragments) and a
drain takes the file by renaming it out from under concurrent appenders. An
entry is never deleted before the server has confirmed it; a drain that dies
mid-way leaves a claim file that the next drain sweeps back in.

## Build from source

Not needed to use this — both routes above ship prebuilt. It is here because
"read what runs on your machine" is a fair thing to want from a telemetry tool.

```bash
# from the repo root (workspace install + shared packages first)
npm install
npm run build:shared

cd ascenda-claude-code-hooks
npm run build
npm link                 # or ./scripts/install-local.sh

which ascenda-claude-hook
ascenda-claude-hook      # prints usage when passed no hook name

npm run test:sample      # pipes a sample PostToolUse payload through the CLI
npm run test:compact
```

A local build exposes the binary as `ascenda-claude-hook` — substitute it for
`npx -y @ascenda-one/claude-code-hooks` in the hook config above. If it is not
on Claude Code's PATH, use an absolute path such as
`/Users/<you>/.nvm/versions/node/<ver>/bin/ascenda-claude-hook`.

## Supported Claude hook events

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
PostToolUseFailure
PreCompact
PostCompact
Stop
Notification
SessionEnd
```

## Ascenda event mappings

Full mapping: [docs/CLAUDE_MAPPING.md](./docs/CLAUDE_MAPPING.md). Catalog-only event types (no aliases).

```text
SessionStart       -> create_focus_session (startup and resume; clear and compact are skipped)
UserPromptSubmit   -> ai_prompt_submitted / ai_correction_prompt
PreToolUse         -> ai_tool_call_started
PostToolUse Edit   -> ai_file_edit
PostToolUse Write  -> ai_file_write
PostToolUse Bash   -> editor_verification_activity / ai_tool_call_completed (success only)
PostToolUseFailure -> compile_error / ai_tool_call_failed
PreCompact         -> context_compression_manual / context_compression_auto
PostCompact        -> context_pressure_high
Stop               -> ai_turn_completed (every turn), agent_loop_long (long only)
Notification       -> supervision_interruption (interruptionKind only, never the message)
SessionEnd         -> recovery_offline_period (activity session_ended, sessionEndReason)
```

## Privacy defaults

Metadata-only telemetry. Does not send raw prompts, responses, code, file names, repository names, branch names, or terminal output.

When the agent stops and waits for you, `Notification` records only which kind
of wait it was — `permission_request`, `idle_prompt` or `other`. The
notification's own wording is read to pick one of those three labels and is
then discarded; it never leaves the hook process, and neither does anything you
answer. `tests/interruptionContentGuard.test.mjs` fails the build if that
changes.

Repository and branch identity travel only as machine-salted digests, derived
in the hook process and never as text: `workspaceHash` and `projectHash` from
the checkout's and repository's folder names, and `metadata.branchHash` from
the branch the checkout is on. The salt is random per machine, stored at
`~/.ascenda/salt`, and never transmitted — without it, a digest of a name from
a short list is recoverable by guessing. A branch name is low-entropy in
exactly that way, so the branch digest is not a security boundary; it is what
lets work be grouped by branch on the other side without the name itself
leaving the machine. On a detached HEAD, outside a checkout, or with no
readable salt the key is omitted entirely rather than sent blank.

Correction detection uses local pattern matching on prompt text in the hook process only — classified metadata (`reason: repeated_reprompting`) is sent; raw prompt text is not.

## Roadmap

| Phase | Scope |
| --- | --- |
| Phase 1 | Hook mappings, metadata-only ingest, shared pairing tokens |
| Phase 2 | Standalone CLI pairing (`ascenda-claude-pair`) |
| Phase 3 | Session rollup metadata aligned with backend baselines |

## Compliance

`consentScope: ide_telemetry` and `provenance: ai_work_telemetry` on every
event. Australian-hosted backend. Not a medical device — workload
self-awareness only, no diagnosis, no clinical claim. Consent is revocable from
the app at any time; after revocation ingest returns `401`.
