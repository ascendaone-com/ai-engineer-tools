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
 * Bare `unknown` means exactly one thing: the *vendor* could not be read
 * either. `<synthetic>` is a real value in Claude Code's store, is not a
 * model, and correctly lands there — as does `octopus-1`, which the word
 * boundaries keep out of `anthropic:opus`.
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

  const vendor = readModelVendor(value);
  if (vendor === undefined) return "unknown";

  for (const [pattern, modelClass] of TIER_PATTERNS_BY_VENDOR[vendor]) {
    if (pattern.test(value)) return modelClass;
  }
  return UNKNOWN_TIER_BY_VENDOR[vendor];
}

type ModelVendor = "anthropic" | "openai" | "google" | "xai" | "local";

/**
 * The vendor from the shape of the identifier alone. Ordered: the first match
 * wins, and the lists are disjoint on every id shape seen so far.
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
  // xAI carries no corporate prefix in any observed id — the family name is
  // the whole marker, exactly as `claude` and `gemini` are for theirs.
  [/\b(xai|grok)\b/, "xai"],
  [/\b(ollama|llamacpp|on[-_]?device|local)\b/, "local"]
];

/**
 * Tier patterns scoped to the vendor that was already read, so a tier is only
 * ever reachable from its own vendor and the two halves of a `vendor:tier`
 * value cannot contradict each other.
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
  local: [[/\b(ollama|llamacpp|on[-_]?device)\b/, "local:on_device"]]
};

const UNKNOWN_TIER_BY_VENDOR: Record<ModelVendor, ModelClass> = {
  anthropic: "anthropic:unknown",
  openai: "openai:unknown",
  google: "google:unknown",
  xai: "xai:unknown",
  local: "local:unknown"
};
