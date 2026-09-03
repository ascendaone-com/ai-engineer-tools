# Claude Code to Ascenda Mapping

Aligned to [TOOL_PAIRING_API_REFERENCE.md](../../api-docs/TOOL_PAIRING_API_REFERENCE.md) canonical event catalog.

This adapter is the **primary Phase 1 source for `AIInteractionLoad`** and workflow friction signals in the tooling repo.

## Event mapping (catalog only)

| Claude hook | Ascenda event | Workload category |
| --- | --- | --- |
| SessionStart (startup/resume) | `create_focus_session` | creation |
| SessionStart (clear/compact) | *(skipped — a context reset, not a new session)* | — |
| UserPromptSubmit | `ai_prompt_submitted` | creation |
| UserPromptSubmit (correction inferred) | `ai_correction_prompt` | supervision |
| PreToolUse | `ai_tool_call_started` | supervision |
| PostToolUse Write | `ai_file_write` | creation |
| PostToolUse Edit/MultiEdit | `ai_file_edit` | creation |
| PostToolUse Bash test/lint/build | `editor_verification_activity` (`outcome: success`) | verification |
| **PostToolUseFailure** Bash test/lint/build | `compile_error` | risk |
| **PostToolUseFailure** (other tools) | `ai_tool_call_failed` | supervision |
| PostToolUse/Failure interrupted | `ai_tool_call_failed` (`outcome: cancelled`, `reason: manual_interrupt`) | supervision |
| PreCompact manual | `context_compression_manual` | neutral |
| PreCompact auto | `context_compression_auto` | neutral |
| PostCompact | `context_pressure_high` | risk |
| Stop (long duration only) | `agent_loop_long` | risk |
| Notification | *(skipped — no catalog event)* | — |

## Outcome comes from the event, not the payload

Verified against a live Claude Code session (27 Jul 2026), replacing what had
been inferred — and the inference was wrong in a way that silently disabled a
shipped feature:

| | Hook event | Payload carries | Exit code? |
| --- | --- | --- | --- |
| Success | `PostToolUse` | `tool_response` (`stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`), top-level `duration_ms` | **No** |
| Failure | `PostToolUseFailure` | `error` (a string beginning `"Exit code N\n…"`), `is_interrupt`, `duration_ms`; **no `tool_response`** | Only inside the `error` string |

Consequences that shape the adapter (`outcomeForHook` in `@ascenda-one/tool-kit`):

- **The arrival of `PostToolUse` is the success signal** — a failed call never
  reaches it. Nothing needs parsing to know the call succeeded.
- **Registering only `PostToolUse` makes failures invisible entirely**, and
  leaves every outcome `unknown` — which suppresses `compile_error`,
  `ai_tool_call_failed`, and the `outcome: "success"` marker the backend's
  verification and commit boundaries key on. `PostToolUseFailure` is not
  optional.
- **`stderr` is not failure** — successful calls routinely carry it (shell
  notices, tool progress).
- **`is_interrupt` is `cancelled`, not `failure`** — stopped work is not wrong
  work, so an interrupted test run is never a `compile_error`, and `gitAction`
  / milestone facts are only read off `outcome: "success"`.
- Field naming is snake_case throughout: `tool_name`, `tool_input`,
  `tool_response`, `duration_ms`, `is_interrupt`.

Still present in captured payloads and not used: an Edit's
`tool_response.structuredPatch` (real line counts, as opposed to the
`old_string`/`new_string` estimate below).

## Three signals the payload carried and the mapper dropped

`permission_mode`, `model` and `tool_response.userModified` all arrive in
Claude Code's own payloads — the first and third are in this package's captured
fixtures — and until 28 Aug 2026 none of them was read. `ClaudeHookInput` is a
loose `Record<string, unknown>`, so they arrived and were discarded with
nothing raising anywhere.

Why that mattered more than it looks: ingest is a **denylist**
(`ToolPairingService.SanitizeMetadata` strips `prompt`, `response`,
`sourceCode`, `code`, `fileName`, `filePath`, `branch`, `repository`,
`terminalOutput`, and preserves everything else verbatim into `MetadataJson`).
A key a collector sends is a key that gets stored, so **no backend change is
needed to capture any of these** — and a key it does not send is simply history
that was never recorded. Do not add a server-side allowlist to make these
"official": that would invert the denylist into a gate and silently drop every
other collector key already flowing.

The finding behind the work: the retrospective import already carries model,
token and human-correction metrics, so **imported history was richer than the
live stream that costs roughly twenty times the storage.** These three close
the part of that gap the live payloads can actually answer.

| Field | Read from | Rides | Grain |
| --- | --- | --- | --- |
| `autonomyMode` | `permission_mode` | `ai_file_*`, `ai_tool_call_*`, `compile_error`, `editor_verification_activity`, `ai_prompt_submitted`, `ai_correction_prompt`, `agent_loop_long` | per event |
| `modelClass` + `modelId` | `model` (optional) | `create_focus_session` | per session |
| `userModified` | `tool_response.userModified` | `ai_file_edit`, `ai_file_write` | per write |

Measured wire cost: 29 B on a tool-call, prompt or stop row; 31 B on a session
row; 48 B on a file row carrying both posture and `userModified`. Against the
179 B/row reclaimed on 26 Aug, the row still shrinks.

None of the three mints a new event type. They ride existing events for the
same reason `gitAction` and `milestoneKind` do: a posture, a model and a
correction are facts *about* the call that just happened, not different kinds
of thing happening.

### `autonomyMode` — the permission posture, mirrored

Six documented `permission_mode` values (checked against Claude Code's hooks
reference, 28 Aug 2026). **Each takes its own token, and snake-casing is the
only transformation applied:**

| `permission_mode` | `autonomyMode` |
| --- | --- |
| `default` | `default` |
| `plan` | `plan` |
| `acceptEdits` | `accept_edits` |
| `auto` | `auto` |
| `dontAsk` | `dont_ask` |
| `bypassPermissions` | `bypass_permissions` |
| *anything else* | `unknown` |
| *field not in the payload* | *key omitted* |

`default` is the mode the UI labels **Manual** — it never arrives on the wire
as `"manual"`, and a mapping written from the UI's vocabulary would have missed
the most common posture entirely. Keeping it as `default` rather than renaming
it to `manual` is safe because the fallback is `unknown`: a `default` on the
wire is always a posture Anthropic reported, never one this mapper invented.

Mirroring buys three things a rename cannot: the vocabulary is auditable
against Anthropic's published reference with no translation table, nobody has
to defend a word upstream does not use, and there is no second vocabulary to
keep in step as upstream's grows.

`auto` collides with `trigger`'s `auto`, which means *what initiated this
event*. Accepted and documented rather than dodged: the keys are namespaced and
meaning is per key, so it is legal and readable — but it is a trap for a query
that reads values rather than pairs.

#### Granular at capture, coarse at read

The five-rung ladder this field first shipped with —
`planning`/`supervised`/`edits_auto`/`delegated`/`unsupervised` — **is gone
from the wire.** It mapped both `auto` and `dontAsk` onto `delegated`, and that
collapse is not injective.

That matters because the corpus is effectively immutable: `ToolTelemetryEvents`
has no retention window and no erasure pathway, and imported rows are never
rewritten. Coarsening at capture is therefore indistinguishable from
discarding, and it is the one decision here that cannot be revisited. A reader
can always pool two tokens; no reader can un-collapse one.

The test for any transformation applied at capture is **whether it is
injective**. Snake-casing is (`accept_edits` recovers `acceptEdits`), so it is
safe. Fusing two modes into one rung is not, so it moved to the reader:
`autonomyBand` in `@ascenda-one/tool-kit` derives the same ladder from the
stored token, and those bands are explicitly **not frozen** — changing our mind
there costs a query rewrite rather than a lost year of rows.

- **The mapping is total.** Anthropic's list may grow; an unrecognised value
  becomes `unknown` and is still sent, so a new mode shows up as a rising
  `unknown` count rather than as nothing having changed.
- **Absent is not `unknown`.** Where the payload carries no posture the key is
  omitted, so "this runtime has no such concept" stays distinguishable from
  "we failed to map a value we were given".
- **Not gated on success**, unlike `gitAction`/`milestoneKind`. A failed or
  interrupted call still happened under a posture, and an interrupt is the most
  interesting posture datum there is — a person stepping in.
- **Not sent on `PreToolUse`.** `PreToolUse` and `PostToolUse` are a pair over
  the same call under the same posture, so carrying it once halves the cost on
  the highest-volume event with no information lost. The exception is a call
  that starts and never completes; if that turns out to matter, adding it to
  `mapPreToolUse` is a one-line change.
- **Live-only by nature.** Transcripts do not reliably record permission state,
  so unlike model mix this cannot be recovered by a later import. Every day
  uncaptured is gone.
- **Absent on `SessionStart`** — hence per event, not per session. That is also
  the honest grain: the mode is switched mid-session, and a session summarised
  by one posture would average away the transition this exists to see.

### `modelClass` + `modelId` — the reading, and the record it came from

`anthropic:opus` | `anthropic:sonnet` | `anthropic:haiku` | `anthropic:fable` |
`anthropic:unknown` | `openai:gpt` | `openai:unknown` | `google:gemini` |
`google:unknown` | `xai:grok` | `xai:unknown` | `local:on_device` |
`local:unknown` | `unknown`.

**Partial recognition degrades to the vendor, not to nothing.** The classifier
reads vendor and tier as two separate steps, so an Anthropic model whose tier
we have not mapped is `anthropic:unknown`. The day a vendor ships an unmapped
tier name is certain — it is the reason this rule exists — and flat `unknown`
would make those rows indistinguishable from a garbage string, losing the
vendor. Tiers churn on a release cadence; vendors persist, and
vendor-mix-over-time is the reading this field exists to serve. Coarsening
`anthropic:unknown` down to `unknown` later costs a query; inventing the vendor
back costs the rows.

Bare `unknown` therefore means exactly one thing: **the vendor could not be
read either.** `<synthetic>` is a real value in the store, is not a model, and
correctly lands there.

**`modelId` carries the raw slug on the same row, on its own key.** A class is
a lossy derivation written into an append-only corpus, so on its own it cannot
be revised: a row holding only `anthropic:unknown` has lost which model
actually ran. With the slug beside it the coarsening is recoverable, and the
vocabulary can be improved against history rather than only against new rows.
Both keys ship together or neither does.

`modelId` is deliberately **not** the importer's `primaryModel`, and must never
be merged with it. `primaryModel` is the *dominant* model across a whole
imported session; `modelId` is the model at *session open*, and a mid-session
switch is invisible to it. Two different measurements under one key is a column
no reader can interpret — the same error as fusing two provenances into one
rollup row.

Session-grain by necessity. **`SessionStart` is the only live hook that can
carry a model**, and even there the docs do not guarantee it — it is omitted
after `/clear` and on conversation recovery. There is no `$CLAUDE_MODEL`
environment variable, and no other event carries it. So **absence is the normal
case, not an error**, and no surface may treat a missing `modelClass` as an
anomaly. The existing `startup`/`resume` gate is unchanged; it happens to align
with when a model is present at all.

`transcript_path` is on every event, so the model is technically recoverable by
reading the transcript. Deliberately not done: that puts file I/O on a
per-tool-call hot path, against a format the docs say can lag the live
conversation.

Matching is on words, not on whole ids. The tier word survives every form seen
in Claude Code's own store — `claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5`, `claude-haiku-4-5-20251001`, a bare `fable`, and the dated,
Bedrock- and Vertex-prefixed variants — so a point release cannot silently
re-bucket a person's norm table. The vendor is read from more than its tier
words: the family name, the corporate prefix a Bedrock or Vertex id carries,
and, for OpenAI's reasoning line, the bare `o1`/`o3` form that carries no
family word at all. That is what lets an unmapped tier still land under its
vendor.

`modelClass` is a reading; `modelId` is the record. Charts group by the class,
and anything that needs to know exactly which build ran reads the slug.

Claude-Code-first, not uniform: the VS Code extension knows no model at all,
and while Codex payloads do carry an active model slug on every hook, that
adapter does not read it yet (see
[CODEX_MAPPING.md](../../ascenda-codex-hooks/docs/CODEX_MAPPING.md#still-on-the-wire-and-not-read)).
So this must never be promised as a cross-collector field.

### `userModified` — the human correction signal

From `tool_response.userModified` on Edit-family `PostToolUse` payloads. The
one live signal of *correction* rather than production: everything else on a
file event counts what the agent did, and none of it says whether a person then
had to fix it.

`false` is sent, not suppressed — without the negatives there is a numerator
and no denominator, and no correction rate can be computed. Absence still means
the payload said nothing, and a non-boolean value is treated as saying nothing
rather than guessed at, so payload drift degrades to "not collected".

**Read the corpus before trusting a zero.** The import side records this as
`userModifiedEditCount` and had to document that Claude Code never sets it true
in transcripts — a `0` there would have asserted "no AI edit was ever corrected
by hand" when it only meant the store never says so. If the live field turns
out to be inert the same way, an all-`false` corpus is evidence about the
field, not about the work.

### The enum values freeze

Nothing server-side validates metadata vocabulary, so a collector typo becomes
permanent history in an immutable corpus. These values freeze the way
`retrospective` did under P-D28: once emitted they are in the record and cannot
be renamed retroactively. They are provisional pending a decision-register
ratification; the tests in `tests/mapClaudeEvent.test.mjs` spell out every
string deliberately, because the consumer is in another repository and cannot
be typechecked against.

## Acceptance-boundary metadata (`linesChangedBucket`)

`PostToolUse` for `Write`/`Edit`/`MultiEdit` now computes a lines-changed count from `tool_input` (`content` for Write; `old_string`/`new_string` for Edit; summed across `edits` for MultiEdit), buckets it with `bucketLinesChanged` (`@ascenda-one/tool-kit`), and attaches it as `metadata.linesChangedBucket` on the existing `ai_file_write`/`ai_file_edit` event — no new event type. The edited text itself is read only to count lines and is discarded immediately; only the bucket (`"0"` | `"1-10"` | `"10-50"` | `"50-200"` | `"200+"`) ever reaches the wire.

At `"200+"` this is the "substantial accepted change" boundary the Ascenda app's confidence self-report triggers on — the bucket *is* the boundary marker; there's nothing further to emit, since the write already happened.

## SessionStart context injection

Separately from telemetry, `SessionStart` (on `startup`/`resume` only — `clear`/`compact` are mid-session resets, not new sessions) writes a `hookSpecificOutput.additionalContext` JSON payload to **stdout**, inviting the agent to ask what the session should accomplish. This is the only hook in this package that writes anything to stdout; every other hook stays silent.

- Independent of pairing state: the injection happens before config loading, so a broken pairing or no network never suppresses it.
- Opt out with `ASCENDA_DISABLE_INTENTION_INVITE=true`.
- Feeds `session_intention_declared` — but not from here. This hook only asks the question; the semantic event (if the user answers) is the [`ascenda-agent-skills`](../../ascenda-agent-skills/) skill's job, since only the model that saw the answer can judge whether one was actually given. See that package's `docs/EMISSION_CRITERIA.md`.

## Ingest contract

```http
POST /v1/tool-events
Authorization: Bearer <eventWriteToken>
```

Payload fields:

- `consentScope: "ide_telemetry"`
- `provenance: "ai_work_telemetry"`
- `privacyMode: "metadata_only"`
- `source: "claude_code"`

Token renewal (unattended):

```http
POST /v1/tool-events/renew-token
Authorization: Bearer <eventWriteToken>
```

Renewed tokens are persisted under `~/.ascenda/tokens/<toolInstallationId>` (or `ASCENDA_EVENT_WRITE_TOKEN_FILE`).

## Privacy

Metadata-only. Raw prompts are used locally for correction inference only; outbound events carry `reason` and `trigger`, not prompt text.
