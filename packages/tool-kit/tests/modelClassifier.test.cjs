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
 * A local runtime named in the id is read before any vendor. `ollama/gpt-oss`
 * is OpenAI's open-weights model running on someone's machine, not the hosted
 * GPT line, and filing it as `openai:gpt` lost the one fact that sets it
 * apart. Until November 2026 the vendor won here (these three cases were
 * pinned the other way). The trainer is still in the raw slug, and the route
 * key says `local` too.
 */
test("a local runtime named in the id outranks the model's trainer", () => {
  assert.equal(classifyModelClass("ollama/gpt-oss"), "local:on_device");
  assert.equal(classifyModelClass("ollama/gpt-oss-20b"), "local:on_device");
  assert.equal(classifyModelClass("ollama/grok-1"), "local:on_device");
  assert.equal(classifyModelClass("lmstudio/qwen3-coder-30b"), "local:on_device");
  assert.equal(classifyModelClass("ollama/llama3.1:8b"), "local:on_device");
  // Without a runtime word the trainer is all the id says.
  assert.equal(classifyModelClass("gpt-oss-120b"), "openai:gpt");
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

/**
 * The vendors added in November 2026, in the forms their own APIs, OpenRouter,
 * Bedrock, Vertex and Hugging Face write. Vendor is who trained the model, so
 * a gateway or cloud prefix never changes it. None of them has a tier yet, so
 * each reads as `<vendor>:unknown`.
 */
const VENDOR_CASES = [
  ["deepseek-chat", "deepseek:unknown"],
  ["deepseek-reasoner", "deepseek:unknown"],
  ["deepseek/deepseek-chat-v3.1", "deepseek:unknown"],
  ["deepseek-ai/DeepSeek-V3.2", "deepseek:unknown"],
  ["us.deepseek.r1-v1:0", "deepseek:unknown"],
  ["vertex_ai/deepseek-ai/deepseek-r1-0528-maas", "deepseek:unknown"],
  // A distilled model names two trainers; the distiller is the vendor.
  ["deepseek-r1-distill-qwen-32b", "deepseek:unknown"],
  ["deepseek-r1-distill-llama-70b", "deepseek:unknown"],
  ["qwen3-coder", "alibaba:unknown"],
  ["qwen3-coder-plus", "alibaba:unknown"],
  ["qwen/qwen3-coder-480b-a35b-instruct", "alibaba:unknown"],
  ["Qwen2.5-Coder-32B-Instruct", "alibaba:unknown"],
  ["qwq-32b", "alibaba:unknown"],
  ["qwen.qwen3-coder-480b-a35b-v1:0", "alibaba:unknown"],
  ["kimi-k2", "moonshot:unknown"],
  ["kimi-k2-thinking", "moonshot:unknown"],
  ["openrouter/moonshotai/kimi-k2", "moonshot:unknown"],
  ["moonshotai/Kimi-K2-Instruct-0905", "moonshot:unknown"],
  ["glm-4.6", "zhipu:unknown"],
  ["glm4-9b", "zhipu:unknown"],
  ["z-ai/glm-4.6", "zhipu:unknown"],
  ["zai-org/GLM-4.5-Air", "zhipu:unknown"],
  ["minimax-m2", "minimax:unknown"],
  ["MiniMaxAI/MiniMax-M2", "minimax:unknown"],
  ["mistral-large-latest", "mistral:unknown"],
  ["devstral-medium-2507", "mistral:unknown"],
  ["codestral-2508", "mistral:unknown"],
  ["mistral.mistral-large-2407-v1:0", "mistral:unknown"],
  ["mistralai/mixtral-8x7b-instruct", "mistral:unknown"],
  ["meta-llama/llama-3.3-70b-instruct", "meta:unknown"],
  ["meta.llama3-1-70b-instruct-v1:0", "meta:unknown"],
  ["llama-4-maverick", "meta:unknown"],
  ["vertex_ai/meta/llama-4-scout-17b-16e-instruct-maas", "meta:unknown"]
];

test("each new vendor is read from its family word or organisation prefix", () => {
  for (const [id, expected] of VENDOR_CASES) {
    assert.equal(classifyModelClass(id), expected, id);
  }
});

/**
 * `vertex` named a route, never a vendor. Vertex AI serves Anthropic, Meta,
 * Mistral, DeepSeek and Qwen models as well as Google's, and reading the word
 * as Google filed a DeepSeek model served through Vertex as `google:unknown`.
 */
test("vertex is not a vendor marker", () => {
  assert.equal(classifyModelClass("vertex_ai/deepseek-r1"), "deepseek:unknown");
  assert.equal(classifyModelClass("vertex_ai/claude-sonnet-4-5@20250929"), "anthropic:sonnet");
  assert.equal(classifyModelClass("vertex_ai/gemini-2.5-pro"), "google:gemini");
  assert.equal(classifyModelClass("vertex_ai/some-new-thing"), "unknown");
  // Google's own resource path still names Google.
  assert.equal(classifyModelClass("publishers/google/models/palm-9"), "google:unknown");
});

test("the older vendors are unchanged by the new patterns", () => {
  assert.equal(classifyModelClass("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "anthropic:sonnet");
  assert.equal(classifyModelClass("bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0"), "anthropic:opus");
  assert.equal(classifyModelClass("openrouter/auto"), "router:auto");
  assert.equal(classifyModelClass("azure/gpt-5"), "openai:gpt");
  assert.equal(classifyModelClass("openrouter/openai/gpt-oss-120b"), "openai:gpt");
});

test("a new family word inside a longer word is not that vendor", () => {
  assert.equal(classifyModelClass("qwenfoo-1"), "unknown");
  assert.equal(classifyModelClass("kimiko-2"), "unknown");
  assert.equal(classifyModelClass("metadata-model"), "unknown");
  assert.equal(classifyModelClass("glmx"), "unknown");
  // And the runtime `llamacpp` is not Meta.
  assert.equal(classifyModelClass("llamacpp-model"), "local:on_device");
  // `<synthetic>` is still not a model.
  assert.equal(classifyModelClass("<synthetic>"), "unknown");
});
