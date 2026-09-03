/**
 * The shared vendor:tier classifier — shared because the live Claude Code
 * hooks and the retrospective importer both write `modelClass`, and their rows
 * are pooled into the same per-person norms. A second implementation would
 * drift on the first model only one of them learned, and the drift would look
 * like a population shift rather than a bug.
 *
 * The Claude Code identifiers below are real strings read out of this
 * machine's own `~/.claude` store; the Cursor/VS Code and OpenAI ones are the
 * shapes those stores report. The point of every case is the same: words, not
 * the full id, are what is matched — so a dated build, a Bedrock prefix or a
 * Vertex prefix all land in the bucket their tier deserves, and a point
 * release cannot silently re-bucket a person's whole baseline.
 *
 * Vendor and tier are read as two separate steps, so the failure path degrades
 * to `<vendor>:unknown` rather than losing both halves. Bare `unknown` is
 * reserved for a string whose vendor could not be read either.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyModelClass } = require("../out/index.js");

test("Anthropic tiers, in the exact forms Claude Code's store holds", () => {
  assert.equal(classifyModelClass("claude-opus-5"), "anthropic:opus");
  assert.equal(classifyModelClass("claude-sonnet-5"), "anthropic:sonnet");
  assert.equal(classifyModelClass("claude-fable-5"), "anthropic:fable");
  // Dated build: the suffix moves on Anthropic's cadence, the bucket does not.
  assert.equal(classifyModelClass("claude-haiku-4-5-20251001"), "anthropic:haiku");
  // A bare tier word really does appear in the store.
  assert.equal(classifyModelClass("fable"), "anthropic:fable");
});

test("deployment prefixes do not change the tier", () => {
  assert.equal(classifyModelClass("us.anthropic.claude-opus-4-5-v1:0"), "anthropic:opus");
  assert.equal(classifyModelClass("anthropic.claude-3-5-sonnet-20241022-v2:0"), "anthropic:sonnet");
  assert.equal(classifyModelClass("publishers/anthropic/models/claude-haiku-4-5"), "anthropic:haiku");
});

test("case and surrounding whitespace are not part of the identity", () => {
  assert.equal(classifyModelClass("  Claude-Sonnet-5  "), "anthropic:sonnet");
  assert.equal(classifyModelClass("GPT-5-Codex"), "openai:gpt");
});

test("OpenAI and Google", () => {
  assert.equal(classifyModelClass("gpt-5-codex"), "openai:gpt");
  assert.equal(classifyModelClass("gpt-4o-mini"), "openai:gpt");
  assert.equal(classifyModelClass("gemini-3-pro"), "google:gemini");
});

/**
 * Cursor names a model with a vendor-prefixed display string in
 * `modelInfo.modelName`, and VS Code with a `modelId`. Both go through the
 * same tier match, which is why the importer can hand them straight over
 * without a per-store table.
 */
test("Cursor- and VS Code-reported display names", () => {
  assert.equal(classifyModelClass("claude-4.5-sonnet"), "anthropic:sonnet");
  assert.equal(classifyModelClass("Claude Sonnet 4.5"), "anthropic:sonnet");
  assert.equal(classifyModelClass("copilot/gpt-4.1"), "openai:gpt");
  assert.equal(classifyModelClass("Gemini 2.5 Pro (Preview)"), "google:gemini");
});

/**
 * xAI reached bare `unknown` for as long as it had no vendor pattern, even
 * though `grok` is as plain a family word as `claude` or `gemini`. That is the
 * one thing bare `unknown` is not allowed to mean — the vendor was right there
 * in the id. The strings below are the forms the Cursor and VS Code stores
 * actually report.
 */
test("xAI is a vendor, read from the family word like the others", () => {
  assert.equal(classifyModelClass("grok-4.6"), "xai:grok");
  assert.equal(classifyModelClass("grok-4.5"), "xai:grok");
  // Copilot's router prefix rides along the same way it does for `claude` and
  // `gpt` — the vendor word survives it.
  assert.equal(classifyModelClass("copilot/grok-code-fast-1"), "xai:grok");
  assert.equal(classifyModelClass("Grok 4.6 (Preview)"), "xai:grok");
  // The corporate name is read too, for a form no store has emitted yet.
  assert.equal(classifyModelClass("xai/some-future-thing"), "xai:unknown");
});

test("a tier word embedded in a longer word is not xAI either", () => {
  // Same rule that keeps `octopus-1` out of `anthropic:opus`: the boundary is
  // what makes the vendor list safe to extend.
  assert.equal(classifyModelClass("grokking-the-codebase"), "unknown");
});

/**
 * `xai` sits above `local` in the vendor list, so a grok served by a local
 * runtime reads as xAI rather than as the runtime. Not a new rule — it is
 * exactly where `ollama/gpt-oss-20b` already landed before xAI existed here —
 * but adding a vendor is what makes that ordering load-bearing, so it is
 * pinned rather than left to be rediscovered.
 */
test("a model's vendor outranks the runtime serving it", () => {
  assert.equal(classifyModelClass("ollama/grok-1"), "xai:grok");
  assert.equal(classifyModelClass("ollama/gpt-oss-20b"), "openai:gpt");
  // And a runtime with no readable model vendor is still the runtime.
  assert.equal(classifyModelClass("ollama/llama3.1:8b"), "local:on_device");
});

test("local and on-device runtimes are their own class, not unknown", () => {
  assert.equal(classifyModelClass("ollama/llama3.1:8b"), "local:on_device");
  assert.equal(classifyModelClass("llamacpp-qwen2.5-coder"), "local:on_device");
  assert.equal(classifyModelClass("on-device-foundation"), "local:on_device");
  assert.equal(classifyModelClass("ondevice-foundation"), "local:on_device");
  assert.equal(classifyModelClass("on_device"), "local:on_device");
});

/**
 * Pinned as observed, not as desired. `\b` treats `_` as a word character, so
 * an underscore-joined suffix defeats the boundary and `on_device_small` misses
 * the `on-device` tier while `on-device-small` does not. Left alone
 * deliberately: this classifier is shared with the live hooks, no store has
 * been seen to emit that form, and the honest place to widen it is the day one
 * does — with the change landing for both pipelines at once, which is the
 * point of sharing it.
 *
 * Note that this one costs the vendor as well as the tier, because the only
 * thing marking the string as local *is* the defeated `on-device` token —
 * unlike `local-foundation-xl` below, where a separate vendor marker survives
 * an unreadable tier. Pinned as measured, not as wished.
 */
test("an underscore-joined on-device suffix is a known blind spot", () => {
  assert.equal(classifyModelClass("on_device_small"), "unknown");
  assert.equal(classifyModelClass("on-device-small"), "local:on_device");
});

/**
 * Absent is not the same as unplaceable, and the distinction is the whole
 * fallback design. Omitting the key says "this collector reports no model" —
 * true of the Codex hooks and the VS Code extension, and of `SessionStart`
 * after a `/clear`. Saying `unknown` says "a model was reported and we could
 * not place it", which is the signal that a new tier has shipped.
 */
/**
 * The fourth state. Copilot and Cursor both let a person delegate the model
 * choice, and their stores record the delegation rather than the model that
 * served the turn — `copilot/auto` is the dominant value on a quarter of one
 * store's sessions. A real model ran (so this is not absence), no vendor is
 * named (so `<vendor>:unknown` is unavailable), and bare `unknown` would file
 * those sessions beside the garbage strings. `router:auto` is the true
 * statement: the choice was delegated and the identity was never written down.
 */
test("a delegated model choice is router:auto, not bare unknown", () => {
  assert.equal(classifyModelClass("copilot/auto"), "router:auto");
  assert.equal(classifyModelClass("default"), "router:auto");
  assert.equal(classifyModelClass("auto"), "router:auto");
  // A product prefix nobody has emitted yet rides along the same way.
  assert.equal(classifyModelClass("openrouter/auto"), "router:auto");
  // Same normalisation every other input gets.
  assert.equal(classifyModelClass("  Copilot/Auto  "), "router:auto");
});

/**
 * `auto` and `default` are ordinary English words — far likelier to turn up
 * inside a real model name than `opus` is. The sentinel is therefore anchored
 * at both ends and matched against the WHOLE id, never as a word within one.
 */
test("a sentinel word inside a longer id is not a router", () => {
  assert.equal(classifyModelClass("auto-coder-9"), "unknown");
  assert.equal(classifyModelClass("default-llm-v2"), "unknown");
  // And an id that names a vendor keeps it: the router check runs first, but
  // it cannot fire here, so nothing is stolen from the vendor read.
  assert.equal(classifyModelClass("claude-auto"), "anthropic:unknown");
});

test("absent input yields undefined, so the key is omitted rather than guessed", () => {
  assert.equal(classifyModelClass(undefined), undefined);
  assert.equal(classifyModelClass(null), undefined);
  assert.equal(classifyModelClass(""), undefined);
  assert.equal(classifyModelClass("   "), undefined);
});

/**
 * The rule the failure path exists for: **degrade to the vendor, not to
 * nothing.** Vendor and tier are read as two separate steps precisely so that
 * the certain future — a vendor shipping a tier name nobody here has mapped —
 * costs the tier and not the vendor as well.
 *
 * Flat `unknown` for those rows would make them indistinguishable from a
 * garbage string, and vendor mix over time is the reading this column exists
 * to serve. Tiers churn on a release cadence; vendors persist. Coarsening
 * `anthropic:unknown` down to `unknown` later costs a query rewrite;
 * inventing the vendor back is impossible, and this corpus is append-only.
 */
test("a readable vendor with an unreadable tier keeps the vendor", () => {
  assert.equal(classifyModelClass("claude-quartz-7"), "anthropic:unknown");
  assert.equal(classifyModelClass("us.anthropic.claude-quartz-7-v1:0"), "anthropic:unknown");
  // OpenAI's reasoning line carries no family word at all, so the vendor is
  // read from the bare `o3` shape and the tier is honestly not placed.
  assert.equal(classifyModelClass("o3-mini"), "openai:unknown");
  assert.equal(classifyModelClass("openai/whatever-next"), "openai:unknown");
  assert.equal(classifyModelClass("publishers/google/models/palm-9"), "google:unknown");
  assert.equal(classifyModelClass("xai-quicksilver-2"), "xai:unknown");
  assert.equal(classifyModelClass("local-foundation-xl"), "local:unknown");
});

test("bare unknown is reserved for a string whose VENDOR could not be read", () => {
  assert.equal(classifyModelClass("some-model-nobody-has-heard-of"), "unknown");
  // Claude Code's own placeholder for a non-model. Not a tier, so not a tier.
  assert.equal(classifyModelClass("<synthetic>"), "unknown");
  assert.equal(classifyModelClass("� ?!!! ¯\\_(ツ)_/¯ 8^&*"), "unknown");
  assert.equal(classifyModelClass("model-2099-not-yet-invented"), "unknown");
});

/**
 * The tier word is matched on a word boundary, so a longer word that merely
 * contains one is NOT that tier. Without this, `octopus` would be an Opus
 * session. The garbage case above is safe by accident; this one is on purpose.
 */
test("a tier word embedded in a longer word is not that tier", () => {
  assert.equal(classifyModelClass("octopus-1"), "unknown");
  assert.equal(classifyModelClass("gpts-router"), "unknown");
});

/**
 * The declared parameter is `string | undefined`, but the importer's
 * `metrics{}` values are a `number | string | boolean` union and foreign JSON
 * stores are unityped, so a non-string can genuinely arrive. It must be
 * reported, not swallowed: something WAS recorded, we simply cannot read it,
 * and folding that into the same silence as "no model reported" would hide a
 * broken extractor.
 */
test("non-string input reaches the unknown fallback instead of throwing", () => {
  assert.equal(classifyModelClass(5), "unknown");
  assert.equal(classifyModelClass(0), "unknown");
  assert.equal(classifyModelClass(true), "unknown");
  assert.equal(classifyModelClass(false), "unknown");
  assert.equal(classifyModelClass({ id: "claude-opus-5" }), "unknown");
  assert.equal(classifyModelClass(["claude-opus-5"]), "unknown");
});
