import { classifyCommand, classifyGitAction, isVerificationCommand, isReworkGitAction, classifyWorkMilestone, invitesDebrief } from "@ascenda-one/tool-kit";
import type { AutonomyMode, ModelClass } from "@ascenda-one/tool-contract";
import { CLAUDE_HOST, ClaudeHookEventName, ClaudeHookInput, MappedAscendaEvent } from "./types.js";
import { bucketDurationMs, bucketLinesChanged, getNested, getNestedNumber, getNestedString, getNumber, getString, outcomeForHook, looksLikeCorrection } from "./safeExtract.js";

/**
 * Every adapter tags `metadata.host` so one local log or one backend query can
 * separate agents. Claude also has its own `source`, but staying uniform keeps
 * cross-agent queries from needing a special case.
 */
export function mapClaudeEvent(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  return mapEvent(hookName, input).map((event) => ({
    ...event,
    metadata: { host: CLAUDE_HOST, ...event.metadata }
  }));
}

function mapEvent(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  switch (hookName) {
    case "SessionStart": return mapSessionStart(input);
    case "UserPromptSubmit": return mapUserPromptSubmit(input);
    case "PreToolUse": return mapPreToolUse(input);
    // Success and failure arrive on different hooks with different payloads —
    // PostToolUse carries tool_response and no exit code; PostToolUseFailure
    // carries `error`/`is_interrupt` and no tool_response. One mapper handles
    // both so the event vocabulary cannot drift between the two paths.
    case "PostToolUse":
    case "PostToolUseFailure": return mapPostToolUse(hookName, input);
    case "PreCompact": return mapPreCompact(input);
    case "PostCompact": return [{ eventType: "context_pressure_high", severity: "medium", metadata: { trigger: "inferred", reason: "context_limit" } }];
    case "Stop": return mapStop(input);
    // No catalog event for notifications; skip to avoid unclassified noise.
    case "Notification": return [];
    default: return [];
  }
}

/**
 * "clear" and "compact" restarts are context resets mid-work, not a new
 * working session — asking "what should this session accomplish" again
 * right after one would be repetitive rather than useful. Exported so
 * cli.ts's context-injection decision uses the exact same rule as the
 * telemetry decision below, rather than a second copy that could drift.
 */
export function isNewSessionStart(input: ClaudeHookInput): boolean {
  const source = getString(input, ["source"]);
  return !source || source === "startup" || source === "resume";
}

/**
 * Whether this PostToolUse just completed a piece of work worth debriefing
 * (H1). Exported so the CLI can decide about the invitation without
 * re-extracting the command — and so the "only completions, only successes"
 * rule has one implementation rather than two that can drift.
 *
 * PostToolUse-only by contract (the CLI's one call site gates on the hook
 * name): a failed merge fires PostToolUseFailure and never gets here, so
 * "only successes" is enforced by the runtime's own event split. The
 * remaining check is for the interrupted case — a merge the user stopped
 * finished nothing, so it asks nothing.
 */
export function milestoneInviting(input: ClaudeHookInput): boolean {
  if (outcomeForHook("PostToolUse", input) !== "success") return false;
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"], ["parameters", "command"]]);
  return invitesDebrief(classifyWorkMilestone(command));
}

function mapSessionStart(input: ClaudeHookInput): MappedAscendaEvent[] {
  if (!isNewSessionStart(input)) return [];
  // `SessionStart` is the ONLY live hook that can carry a model — no other
  // event has it, and there is no `$CLAUDE_MODEL` in the environment. It is
  // also not guaranteed here (the docs say it is omitted after `/clear` and on
  // conversation recovery), so the absent path is the normal one, not an
  // error. `transcript_path` is on every event and the model is technically
  // recoverable from it — deliberately not done: that would put file I/O on a
  // per-tool-call hot path, against a format the docs say can lag the live
  // conversation.
  //
  // The `startup`/`resume` gate above is unchanged and happens to align with
  // when a model is present at all; `clear`/`compact` are the resets where it
  // is dropped, and they were already skipped for their own reasons.
  //
  // Both keys or neither. `modelId` is the raw slug and `modelClass` the
  // reading of it, and they ship together because a class alone is a lossy
  // derivation written into an append-only corpus: the day Anthropic ships a
  // tier we have not mapped, a row holding only `anthropic:unknown` has lost
  // which model actually ran, permanently. With the slug beside it the
  // coarsening stays recoverable, so the vocabulary can be revised later
  // against history rather than only against new rows.
  //
  // It is `modelId`, not `primaryModel`, and the two must not be fused: the
  // importer's `primaryModel` is the dominant model across a whole session,
  // while this is the model at session open — a mid-session switch is
  // invisible to it. One key holding two different measurements is a column no
  // reader can interpret.
  //
  // Session-grain, so this is one extra field per session, not per event.
  const modelId = readModelIdentifier(input)?.trim();
  const modelClass = classifyModelClass(modelId);
  return [{
    eventType: "create_focus_session",
    severity: "low",
    metadata: {
      activity: "session_started",
      // `classifyModelClass` returns undefined exactly when nothing was
      // reported (absent, empty, whitespace), so this one guard governs both.
      ...(modelClass !== undefined && modelId ? { modelClass, modelId } : {})
    }
  }];
}

function mapUserPromptSubmit(input: ClaudeHookInput): MappedAscendaEvent[] {
  const prompt = getString(input, ["prompt", "userPrompt", "message"]) ?? getNestedString(input, [["payload", "prompt"], ["payload", "message"]]);
  const autonomy = autonomyModeMetadata(input);
  const events: MappedAscendaEvent[] = [{ eventType: "ai_prompt_submitted", severity: "low", metadata: { promptClass: "unknown", ...autonomy } }];
  if (looksLikeCorrection(prompt)) {
    events.push({ eventType: "ai_correction_prompt", severity: "medium", metadata: { reason: "repeated_reprompting", trigger: "inferred", ...autonomy } });
  }
  return events;
}

function mapPreToolUse(input: ClaudeHookInput): MappedAscendaEvent[] {
  return [{ eventType: "ai_tool_call_started", severity: "low", metadata: { toolName: sanitiseToolName(getToolName(input)) } }];
}

function mapPostToolUse(hookName: ClaudeHookEventName, input: ClaudeHookInput): MappedAscendaEvent[] {
  const toolName = getToolName(input);
  const safeToolName = sanitiseToolName(toolName);
  // The outcome is carried by *which hook fired*, not by the payload: there
  // is no exit code anywhere in a PostToolUse payload, and a failed call is
  // routed to PostToolUseFailure instead. inferOutcome read fields Claude
  // never sends, so every outcome was "unknown" — which silently disabled
  // compile_error, ai_tool_call_failed, and every outcome:"success" marker
  // the backend's verification/commit boundaries key on.
  const outcome = outcomeForHook(hookName, input);
  // `duration_ms` is the real, top-level field (captured 27 Jul); the
  // camelCase and nested forms remain as harmless fallbacks.
  const durationMs = getNumber(input, ["duration_ms", "durationMs", "elapsedMs"]) ?? getNestedNumber(input, [["tool_response", "durationMs"], ["result", "durationMs"]]);
  const command = getString(input, ["command"]) ?? getNestedString(input, [["tool_input", "command"], ["input", "command"], ["parameters", "command"]]);
  const commandClass = classifyCommand(command);
  // Only a git action that actually succeeded is a boundary or a reversion —
  // a failed push moved nothing, a failed reset undid nothing, and an
  // interrupted push proved nothing either way.
  const gitAction = outcome === "success" ? classifyGitAction(command) : undefined;
  // A failed `gh pr merge` did not complete anything, so — like gitAction — a
  // milestone is only read off a command that actually succeeded.
  const milestoneKind = outcome === "success" ? classifyWorkMilestone(command) : undefined;
  // Unlike gitAction/milestoneKind, the posture is NOT gated on success. A
  // call that failed or was interrupted still happened under a supervision
  // posture, and an interrupt is in fact the most interesting posture datum
  // there is — it is a person stepping in. Gating it would erase exactly the
  // moments the signal exists to see.
  const autonomy = autonomyModeMetadata(input);

  if (outcome === "cancelled") {
    // Stopped work is not wrong work: an interrupted test run is not a
    // compile_error (it proved nothing either way), and severity stays low —
    // the user pressing escape is routine, not risk.
    return [{ eventType: "ai_tool_call_failed", severity: "low", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "manual_interrupt", ...autonomy } }];
  }

  if (outcome === "failure") {
    if (toolName?.toLowerCase() === "bash" && isVerificationCommand(commandClass)) {
      return [{ eventType: "compile_error", severity: "medium", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "test_failure", ...autonomy } }];
    }
    return [{ eventType: "ai_tool_call_failed", severity: "medium", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), reason: "tool_failure", ...autonomy } }];
  }

  if (isWriteTool(toolName)) {
    const linesChanged = computeLinesChanged(toolName, input);
    // Whether the human had already changed this file by hand since the agent
    // last wrote it. Every other fact on this event counts what the agent
    // produced; this is the only live one that says a person had to correct
    // it. It rides the existing creation event rather than minting a type —
    // the same reasoning that keeps gitAction and milestoneKind off event
    // types of their own: a correction is a fact about the write that just
    // happened, not a different kind of thing happening.
    const userModified = getNested(input, ["tool_response", "userModified"]);
    return [{
      eventType: toolName?.toLowerCase() === "write" ? "ai_file_write" : "ai_file_edit",
      severity: "low",
      metadata: {
        toolName: safeToolName,
        outcome,
        durationBucket: bucketDurationMs(durationMs),
        ...autonomy,
        // `false` is kept, not suppressed: without the negatives there is a
        // numerator and no denominator, and no correction *rate* can be
        // computed. Absence still means the payload said nothing — a
        // non-boolean value is treated as saying nothing rather than guessed
        // at, so payload drift degrades to "not collected".
        ...(typeof userModified === "boolean" ? { userModified } : {}),
        // The boundary C2/the macOS work-self-report card triggers on: at
        // "200+" this is the "substantial accepted change" moment. No
        // second event type exists for this — the bucket on the existing
        // creation event *is* the boundary, deliberately, since the write
        // already happened; there is nothing else to mark.
        ...(linesChanged !== undefined ? { linesChangedBucket: bucketLinesChanged(linesChanged) } : {})
      }
    }];
  }

  if (toolName?.toLowerCase() === "bash" && isVerificationCommand(commandClass)) {
    return [{ eventType: "editor_verification_activity", severity: "low", metadata: { toolName: safeToolName, commandClass, outcome, durationBucket: bucketDurationMs(durationMs), activity: "ai_test_or_build_run", ...autonomy } }];
  }

  return [{
    eventType: "ai_tool_call_completed",
    severity: "low",
    metadata: {
      toolName: safeToolName,
      commandClass,
      outcome,
      durationBucket: bucketDurationMs(durationMs),
      ...autonomy,
      // The boundary and rework signal both ride this existing event rather
      // than minting a type: the backend already reads `gitAction` off any
      // event, and a commit is not a different *kind* of thing happening, it
      // is a fact about the tool call that just happened.
      ...(gitAction !== undefined ? { gitAction } : {}),
      ...(isReworkGitAction(gitAction) ? { activity: "rework_reversion" } : {}),
      // Same reasoning as `gitAction` above, one grain coarser: a milestone is
      // a fact about the tool call that just happened, not a different kind of
      // event. It rides here so the record carries the work's own rhythm —
      // ticket closed, PR merged — beside the keystroke boundaries (H1).
      ...(milestoneKind !== undefined ? { milestoneKind } : {})
    }
  }];
}

function mapPreCompact(input: ClaudeHookInput): MappedAscendaEvent[] {
  const trigger = getString(input, ["trigger", "reason", "compactType", "type"]) ?? getNestedString(input, [["payload", "trigger"], ["payload", "reason"]]);
  const isManual = trigger?.toLowerCase().includes("manual") ?? false;
  return [{ eventType: isManual ? "context_compression_manual" : "context_compression_auto", severity: isManual ? "medium" : "high", metadata: { trigger: isManual ? "manual" : "auto", reason: "context_limit" } }];
}

function mapStop(input: ClaudeHookInput): MappedAscendaEvent[] {
  const durationMs = getNumber(input, ["durationMs", "duration_ms", "elapsedMs"]) ?? getNestedNumber(input, [["session", "durationMs"], ["payload", "durationMs"]]);
  const durationBucket = bucketDurationMs(durationMs);
  // Catalog only includes agent_loop_long (risk), not agent_loop_completed.
  if (durationBucket === "30-60m" || durationBucket === "60m+") {
    // The posture matters most here of anywhere: a 90-minute loop under
    // `default` is 90 minutes of a person approving every step, and the same
    // 90 minutes under `bypass_permissions` is a person who walked away. The
    // event has never been able to tell those apart.
    return [{ eventType: "agent_loop_long", severity: durationBucket === "60m+" ? "high" : "medium", metadata: { durationBucket, reason: "long_session", trigger: "inferred", ...autonomyModeMetadata(input) } }];
  }
  return [];
}

/**
 * The supervision posture as a metadata fragment, ready to spread.
 *
 * Two states are deliberately different:
 *
 * - **The payload carries no posture at all** → `{}`, so the key is absent.
 *   `SessionStart` is genuinely like this (Claude never sends
 *   `permission_mode` there), as is any future collector without the concept.
 *   Emitting `"unknown"` for these would drown the signal that matters.
 * - **The payload carries a posture we do not recognise** → `{ autonomyMode:
 *   "unknown" }`, sent, never dropped. Anthropic's six documented values may
 *   grow, and a new mode showing up as a rising `unknown` count is how we find
 *   out; a dropped field would look exactly like nothing having changed.
 */
function autonomyModeMetadata(input: ClaudeHookInput): { autonomyMode?: AutonomyMode } {
  const raw = readPermissionMode(input);
  return raw === undefined ? {} : { autonomyMode: classifyAutonomyMode(raw) };
}

/**
 * The raw posture value, at whatever spelling and nesting it arrives in, or
 * `undefined` when the payload has none.
 *
 * Returns `unknown` (the type) rather than `string | undefined` on purpose: a
 * present-but-wrong-typed value must reach the classifier so it becomes
 * `"unknown"`, and using `getString` here would have collapsed it back into
 * absence — the one distinction this pair exists to preserve.
 */
function readPermissionMode(input: ClaudeHookInput): unknown {
  const candidates: unknown[] = [
    input["permission_mode"],
    input["permissionMode"],
    getNested(input, ["payload", "permission_mode"])
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Claude Code's `permission_mode` onto `AutonomyMode`. **Total by contract** —
 * every input, including a number, an object, or a mode Anthropic ships next
 * month, produces a value. Exported so the totality is testable directly
 * rather than only through a hook payload.
 *
 * **A 1:1 mirror of upstream, snake-cased, and that is the entire mapping.**
 * The six documented values (checked against Claude Code's hooks reference, 28
 * Aug 2026) are `default`, `plan`, `acceptEdits`, `auto`, `dontAsk` and
 * `bypassPermissions`, and each gets its own token. Note that `default` is the
 * mode the UI labels *Manual*: it never arrives as `"manual"`, and a mapping
 * written from the UI's vocabulary would have missed the single most common
 * posture entirely. Keeping it as `default` is safe precisely because the
 * fallback below is `unknown` — a `default` on the wire is always a posture
 * Anthropic reported, never one this function invented.
 *
 * **`auto` and `dontAsk` are two tokens, not one.** They previously both
 * coarsened to a `delegated` rung, on the reasoning that they differ in how
 * the user got there rather than in how much the agent may do without asking.
 * That reasoning may well be right — but it is a *reader's* judgement, and
 * coarsening it here is not injective. The corpus is append-only, so a
 * collapsed pair can never be separated again; a separated pair can be pooled
 * by any query, any time. `autonomyBand` in `@ascenda-one/tool-kit` is where
 * that judgement now lives, applied to the stored token at read time.
 *
 * Matching is case-insensitive and trimmed — cheap insurance against a
 * spelling drift that would otherwise turn a known mode into `unknown` and
 * quietly corrupt a trend line.
 */
export function classifyAutonomyMode(raw: unknown): AutonomyMode {
  if (typeof raw !== "string") return "unknown";
  return AUTONOMY_BY_PERMISSION_MODE[raw.trim().toLowerCase()] ?? "unknown";
}

const AUTONOMY_BY_PERMISSION_MODE: Record<string, AutonomyMode> = {
  default: "default",
  plan: "plan",
  acceptedits: "accept_edits",
  auto: "auto",
  dontask: "dont_ask",
  bypasspermissions: "bypass_permissions"
};

/**
 * The model identifier from a `SessionStart` payload, or `undefined` when the
 * hook did not carry one — which the docs say is a normal, expected state
 * (omitted after `/clear` and on conversation recovery), not an error.
 *
 * Probes both a bare string and the object forms, because the payload shape
 * here has not been captured from a live run the way the PostToolUse shapes
 * were; the same defensive posture as every other reader in this file.
 */
function readModelIdentifier(input: ClaudeHookInput): string | undefined {
  return getString(input, ["model", "model_id", "modelId"])
    ?? getNestedString(input, [["model", "id"], ["model", "display_name"], ["model", "name"], ["payload", "model"]]);
}

/**
 * A raw model identifier onto the coarse vendor:tier vocabulary. Total for any
 * string; `undefined` only for a genuinely absent one, keeping "no model was
 * reported" distinct from "a model was reported that we could not place".
 *
 * **Two steps, not one, and the split is the whole design.** Vendor is read
 * first, tier second, so partial recognition degrades to `<vendor>:unknown`
 * rather than to bare `unknown`. The day a vendor ships a tier name we have
 * not mapped is certain, and on that day a flat `unknown` would make those
 * rows indistinguishable from a garbage string — losing the vendor, which is
 * the half that persists and the half vendor-mix-over-time is read from.
 * Coarsening `anthropic:unknown` down to `unknown` later costs a query;
 * inventing the vendor back costs the year of rows.
 *
 * Bare `unknown` therefore means exactly one thing: the *vendor* could not be
 * read either. `<synthetic>` is a real value in Claude Code's store, is not a
 * model, and correctly lands there.
 *
 * Matched on words rather than on whole ids — real identifiers from the store
 * are `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`,
 * `claude-haiku-4-5-20251001` and a bare `fable`, and the same words survive
 * the dated, Bedrock- and Vertex-prefixed forms. A point release therefore
 * cannot silently re-bucket a person's whole norm table.
 *
 * Lossy either way, which is why {@link readModelIdentifier}'s raw string
 * rides the same row under `modelId`. A class is a reading of the record, not
 * the record.
 */
export function classifyModelClass(raw: string | undefined): ModelClass | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;

  const vendor = readModelVendor(value);
  if (vendor === undefined) return "unknown";

  for (const [pattern, modelClass] of TIER_PATTERNS_BY_VENDOR[vendor]) {
    if (pattern.test(value)) return modelClass;
  }
  return UNKNOWN_TIER_BY_VENDOR[vendor];
}

type ModelVendor = "anthropic" | "openai" | "google" | "local";

/**
 * The vendor from the shape of the identifier alone. Ordered: the first match
 * wins, and the lists are disjoint on every id shape seen so far.
 *
 * Each vendor is recognisable by more than its tier words, which is what lets
 * an unmapped tier still land under its vendor: the family name (`claude`,
 * `gemini`), the corporate prefix that Bedrock and Vertex ids carry
 * (`us.anthropic.…`, `publishers/google/…`), and — for OpenAI's reasoning
 * line, which carries no family word at all — the bare `o1`/`o3`/`o4` form.
 */
function readModelVendor(value: string): ModelVendor | undefined {
  for (const [pattern, vendor] of VENDOR_PATTERNS) {
    if (pattern.test(value)) return vendor;
  }
  return undefined;
}

const VENDOR_PATTERNS: readonly (readonly [RegExp, ModelVendor])[] = [
  [/\b(anthropic|claude|opus|sonnet|haiku|fable)\b/, "anthropic"],
  [/\b(openai|gpt|o[1-9])\b/, "openai"],
  [/\b(google|gemini|vertex)\b/, "google"],
  [/\b(ollama|llamacpp|on[-_]?device|local)\b/, "local"]
];

/**
 * Tier patterns scoped to the vendor that was already read, so the two halves
 * of a `vendor:tier` value can never disagree — a tier is only ever reachable
 * from its own vendor.
 */
const TIER_PATTERNS_BY_VENDOR: Record<ModelVendor, readonly (readonly [RegExp, ModelClass])[]> = {
  anthropic: [
    [/\bopus\b/, "anthropic:opus"],
    [/\bsonnet\b/, "anthropic:sonnet"],
    [/\bhaiku\b/, "anthropic:haiku"],
    [/\bfable\b/, "anthropic:fable"]
  ],
  openai: [[/\bgpt\b/, "openai:gpt"]],
  google: [[/\bgemini\b/, "google:gemini"]],
  local: [[/\b(ollama|llamacpp|on[-_]?device)\b/, "local:on_device"]]
};

const UNKNOWN_TIER_BY_VENDOR: Record<ModelVendor, ModelClass> = {
  anthropic: "anthropic:unknown",
  openai: "openai:unknown",
  google: "google:unknown",
  local: "local:unknown"
};

function getToolName(input: ClaudeHookInput): string | undefined {
  return getString(input, ["toolName", "tool_name", "name"]) ?? getNestedString(input, [["tool", "name"], ["tool_use", "name"], ["payload", "toolName"]]);
}

/**
 * Reads `old_string`/`new_string`/`content`/`edits` from `tool_input` — the
 * same fields the model just wrote — purely to count lines, then discards
 * them. Nothing here is transmitted; only the bucketed count downstream
 * ever reaches an event. Returns undefined when the shape doesn't match
 * (missing fields, wrong types), so a version drift in the hook payload
 * degrades to "not collected" rather than a wrong count.
 */
function computeLinesChanged(toolName: string | undefined, input: ClaudeHookInput): number | undefined {
  const toolInput = getNested(input, ["tool_input"]) ?? getNested(input, ["input"]) ?? getNested(input, ["parameters"]);
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const record = toolInput as Record<string, unknown>;

  switch (toolName?.toLowerCase()) {
    case "write": {
      const content = record["content"];
      return typeof content === "string" ? countLines(content) : undefined;
    }
    case "edit": {
      const oldStr = record["old_string"];
      const newStr = record["new_string"];
      if (typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
      return Math.max(countLines(oldStr), countLines(newStr));
    }
    case "multiedit": {
      const edits = record["edits"];
      if (!Array.isArray(edits)) return undefined;
      let total = 0;
      let sawOne = false;
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const oldStr = (edit as Record<string, unknown>)["old_string"];
        const newStr = (edit as Record<string, unknown>)["new_string"];
        if (typeof oldStr !== "string" || typeof newStr !== "string") continue;
        sawOne = true;
        total += Math.max(countLines(oldStr), countLines(newStr));
      }
      return sawOne ? total : undefined;
    }
    default:
      return undefined;
  }
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function isWriteTool(toolName: string | undefined): boolean {
  const value = toolName?.toLowerCase();
  return value === "write" || value === "edit" || value === "multiedit";
}

function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}
