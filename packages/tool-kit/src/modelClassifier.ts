import { ModelClass } from "@ascenda-one/tool-contract";

/**
 * A raw model identifier onto the coarse vendor:tier vocabulary. Total for any
 * input; `undefined` only for a genuinely absent one, keeping "no model was
 * reported" distinct from "a model was reported that we could not place".
 *
 * Shared, not copied. It lives here — beside `classifyCommand`,
 * `classifyGitAction` and `deriveWorkContext` — because two pipelines now feed
 * the same column: the live Claude Code hooks classify a `SessionStart`
 * model, and the retrospective importer classifies the `primaryModel` it
 * folded out of a months-old transcript. A norm table pools those rows. Two
 * implementations that agreed on the day they were written would drift on the
 * first model whose name only one of them learned, and the drift would show up
 * as a *population* shift rather than as a bug — the failure mode that
 * `contextUsagePercent` already cost us once. One function cannot drift from
 * itself.
 *
 * **Two steps, not one, and the split is the whole design.** Vendor is read
 * first, tier second, so partial recognition degrades to `<vendor>:unknown`
 * rather than to bare `unknown`. The day a vendor ships a tier name we have
 * not mapped is certain — it is the reason this rule exists — and on that day
 * a flat `unknown` would make those rows indistinguishable from a garbage
 * string, losing the vendor along with the tier. Tiers churn on a release
 * cadence; vendors persist, and vendor-mix-over-time is the reading this
 * field exists to serve. Coarsening `anthropic:unknown` down to `unknown`
 * later costs a query rewrite; inventing the vendor back is impossible, and
 * this corpus is append-only.
 *
 * Vendor is therefore matched on more than its tier words — the family name
 * (`claude`, `gemini`, `grok`), the corporate prefix that Bedrock and Vertex
 * ids carry (`us.anthropic.…`, `publishers/google/…`), and, for OpenAI's
 * reasoning line which carries no family word at all, the bare `o1`/`o3`/`o4`
 * form. Tier is then matched within that vendor only, so the two halves of a
 * `vendor:tier` value can never disagree.
 *
 * **Vendor means who trained the model, never who served it.** DeepSeek,
 * Alibaba (Qwen), Moonshot (Kimi), Zhipu (GLM), MiniMax, Mistral and Meta
 * (Llama) are read from their family words and the organisation prefixes
 * OpenRouter and Hugging Face put in front (`moonshotai/`, `z-ai/`,
 * `meta-llama/`). A cloud or gateway prefix (`vertex_ai/`, `bedrock/`,
 * `openrouter/`, `us.`) is a route, not a vendor, so `vertex_ai/deepseek-r1`
 * is DeepSeek's. The route travels separately as `modelRoute`. The one
 * exception is a local runtime, read before any vendor and filed as
 * `local:on_device`; see `LOCAL_RUNTIME` below.
 *
 * Bare `unknown` means exactly one thing: the *vendor* could not be read
 * either. `<synthetic>` is a real value in Claude Code's store, is not a
 * model, and correctly lands there — as does `octopus-1`, which the word
 * boundaries keep out of `anthropic:opus`.
 *
 * **An auto-router is read before any vendor is.** `copilot/auto` and Cursor's
 * `default` are not models and not vendors: they are the record of a person
 * delegating the choice, and the store then never writes down which model
 * served the turn. A real model ran, so this is not absence; no vendor is
 * named, so `<vendor>:unknown` is unavailable; and bare `unknown` would put a
 * quarter of one store's sessions in the same bucket as a garbage string.
 * `router:auto` says the true thing instead. It is matched on the WHOLE id
 * rather than on a word, so a model whose name merely contains `auto` or
 * `default` is untouched — the same conservatism that keeps `octopus-1` out of
 * `anthropic:opus`, applied to a token far more likely to appear inside a real
 * name.
 *
 * Matched on words rather than whole ids. Real identifiers from the store are
 * `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`,
 * `claude-haiku-4-5-20251001` and a bare `fable`, and the same words survive
 * the dated, Bedrock- and Vertex-prefixed forms — so a point release cannot
 * silently re-bucket a person's whole norm table.
 *
 * **The class is a reading, and the raw string is the record.** Both writers
 * keep the string that produced the class on the same row — the importer as
 * `primaryModel`, the live hooks as `modelId` — so the coarsening is
 * recoverable and the vocabulary can be revised against history rather than
 * only against new rows. Those two keys are deliberately separate:
 * `primaryModel` is a whole session's dominant model, `modelId` is the model
 * at session open, and they are not the same measurement.
 *
 * Two fallbacks, and the line between them is *absence*, not *failure*:
 *
 *  - `undefined` — nothing was reported. No model field, `null`, or a string
 *    that is empty once trimmed. The key is then omitted entirely, so a
 *    collector with no concept of a model (the Codex hooks, the VS Code
 *    extension) stays distinguishable from one whose value we could not place.
 *  - an `unknown` — something was reported. `<vendor>:unknown` where the
 *    vendor was readable, bare `unknown` where it was not. That includes any
 *    non-string value that is not nullish: a number, a boolean, an object. The
 *    parameter is typed `string | undefined` and the hook path satisfies that,
 *    but the importer's `metrics{}` is a `number | string | boolean` union and
 *    JSON from a foreign store is unityped, so the guard is real rather than
 *    theatre. Reporting those as absent would hide a broken extractor inside
 *    the same silence as a collector that never had a model to report.
 */
export function classifyModelClass(raw: string | undefined): ModelClass | undefined {
  // Widened on purpose: the declared type is the contract, this is the guard
  // for callers who reach it from JavaScript or from an unityped store.
  const candidate: unknown = raw;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "string") return "unknown";
  const value = candidate.trim().toLowerCase();
  if (!value) return undefined;

  // Before the vendor read, because a delegated choice is not a vendor claim:
  // the only party `copilot/auto` names is the router.
  if (ROUTER_SENTINEL.test(value)) return "router:auto";

  // Also before the vendor read: an id that names a local runtime says where
  // the weights ran, and that is the fact this class keeps. `ollama/gpt-oss`
  // is not the hosted GPT line and `ollama/llama3.1:8b` is not a Meta API
  // call. The trainer is still in the raw slug beside the class, and the
  // route key says `local` as well.
  if (LOCAL_RUNTIME.test(value)) return "local:on_device";

  const vendor = readModelVendor(value);
  if (vendor === undefined) return "unknown";

  for (const [pattern, modelClass] of TIER_PATTERNS_BY_VENDOR[vendor]) {
    if (pattern.test(value)) return modelClass;
  }
  return UNKNOWN_TIER_BY_VENDOR[vendor];
}

type ModelVendor =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "alibaba"
  | "mistral"
  | "meta"
  | "local";

/**
 * The vendor from the shape of the identifier alone. Ordered: the first match
 * wins. Order matters where one id names two trainers: a distilled model such
 * as `deepseek-r1-distill-qwen-32b` or `deepseek-r1-distill-llama-70b` is
 * DeepSeek's, so DeepSeek sits above Alibaba and Meta.
 */
function readModelVendor(value: string): ModelVendor | undefined {
  for (const [pattern, vendor] of VENDOR_PATTERNS) {
    if (pattern.test(value)) return vendor;
  }
  return undefined;
}

/**
 * The whole id is a router's "let it choose" setting, optionally behind the
 * product prefix the store writes: `copilot/auto`, `default`, `auto`,
 * `openrouter/auto`. Anchored at both ends on purpose — `auto` and `default`
 * are ordinary English words and a real model called `auto-coder-9` must stay
 * a model, so nothing but the sentinel alone can match.
 *
 * If a router prefix ever names a real model vendor (`google/auto`, say), the
 * honest answer changes: the vendor IS known there and only the tier is not.
 * No store has emitted that shape, so it is left for the day one does rather
 * than guessed at now.
 */
const ROUTER_SENTINEL = /^(?:[a-z0-9][a-z0-9._-]*\/)?(?:auto|default)$/;

/**
 * A local runtime named in the id: Ollama, llama.cpp, LM Studio, or an
 * on-device model. Read before any vendor, so a local copy of an open-weights
 * model is filed by where it ran.
 *
 * `\b` treats `_` as a word character, so `on_device_small` still misses here
 * (pinned in the tests as a known blind spot).
 */
const LOCAL_RUNTIME = /\b(ollama|llamacpp|llama\.cpp|lmstudio|lm-studio|on[-_]?device)\b/;

/**
 * Family words are matched with `(?![a-z])` rather than a closing `\b` where
 * the family name runs straight into a version number: `qwen3-coder`,
 * `llama3.1`, `glm4`. A closing `\b` would miss those, and `(?![a-z])` still
 * keeps a longer word (`qwenfoo`, `kimiko`) out.
 *
 * `vertex` is not a vendor marker. Vertex AI serves Anthropic, Meta, Mistral,
 * DeepSeek and Qwen models as well as Gemini, so `vertex_ai/deepseek-…` is
 * DeepSeek's model and the route key records that it came through Vertex.
 * Google is read from `google` and `gemini` only.
 */
const VENDOR_PATTERNS: readonly (readonly [RegExp, ModelVendor])[] = [
  [/\b(anthropic|claude|opus|sonnet|haiku|fable)\b/, "anthropic"],
  [/\b(openai|gpt|o[1-9])\b/, "openai"],
  [/\b(google|gemini)\b/, "google"],
  // xAI carries no corporate prefix in any observed id — the family name is
  // the whole marker, exactly as `claude` and `gemini` are for theirs.
  [/\b(xai|grok)\b/, "xai"],
  [/\bdeepseek(?:-ai)?(?![a-z])/, "deepseek"],
  [/\b(moonshot(?:ai)?|kimi)(?![a-z])/, "moonshot"],
  [/\b(zhipu(?:ai)?|z-ai|zai-org|chatglm|glm)(?![a-z])/, "zhipu"],
  [/\bminimax(?:ai)?(?![a-z])/, "minimax"],
  [/\b(alibaba|qwen|qwq)(?![a-z])/, "alibaba"],
  [/\b(mistral(?:ai)?|mixtral|codestral|devstral|magistral|ministral|pixtral)(?![a-z])/, "mistral"],
  [/\b(meta-llama|meta|llama|codellama)(?![a-z])/, "meta"],
  [/\blocal\b/, "local"]
];

/**
 * Tier patterns scoped to the vendor that was already read, so a tier is only
 * ever reachable from its own vendor and the two halves of a `vendor:tier`
 * value cannot contradict each other.
 *
 * The vendors added in November 2026 have no tiers yet. Their names churn
 * faster than the older lines' (`kimi-k2`, `k2-thinking`, `glm-4.6`,
 * `qwen3-coder-plus`), and `<vendor>:unknown` keeps the vendor, which is what
 * a vendor comparison needs. A tier is added when a reader needs one.
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
  // One tier for now. The line's coding variants (`grok-code-fast-1`) are the
  // same tier word plus a suffix, and splitting them off would be inventing a
  // distinction the ids do not yet draw — `<vendor>:unknown` is waiting for
  // the day one does.
  xai: [[/\bgrok\b/, "xai:grok"]],
  deepseek: [],
  moonshot: [],
  zhipu: [],
  minimax: [],
  alibaba: [],
  mistral: [],
  meta: [],
  // The runtime words are read before any vendor, so only a bare `local`
  // reaches here, and it names no runtime.
  local: []
};

const UNKNOWN_TIER_BY_VENDOR: Record<ModelVendor, ModelClass> = {
  anthropic: "anthropic:unknown",
  openai: "openai:unknown",
  google: "google:unknown",
  xai: "xai:unknown",
  deepseek: "deepseek:unknown",
  moonshot: "moonshot:unknown",
  zhipu: "zhipu:unknown",
  minimax: "minimax:unknown",
  alibaba: "alibaba:unknown",
  mistral: "mistral:unknown",
  meta: "meta:unknown",
  local: "local:unknown"
};
