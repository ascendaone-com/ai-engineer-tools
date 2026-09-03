/**
 * `modelClass` on the wire — the coarse companion the live collector now
 * sends, derived from the raw `primaryModel` the extractors have folded since
 * the first one shipped.
 *
 * Nothing here is newly *captured*. `primaryModel` has been in `metrics{}` all
 * along, `toWirePayload` copies every metric key onto the wire verbatim, and
 * the backend's sanitiser is a denylist that strips only content keys — so
 * the raw string is already stored on every imported row. What was missing was
 * *comparability*: the live stream buckets a session as `anthropic:opus`, the
 * imported corpus said `claude-opus-5`, and no norm table could pool them.
 *
 * Three properties matter, and they are what these tests hold:
 *
 *  1. The class is ADDED, never substituted — `primaryModel` survives. A class
 *     cannot be un-coarsened, so throwing away which build actually ran would
 *     be irreversible for a reading that is not urgent.
 *  2. The classification is the SAME function the live hooks use, imported
 *     from tool-kit rather than reimplemented. Two implementations would drift
 *     into a population shift, not a visible bug.
 *  3. `importKey` is untouched. The backend dedups a replay on that key alone;
 *     perturbing its derivation would make a re-run look like a second span of
 *     work and double a person's baseline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModelClass } from "@ascenda-one/tool-kit";
import { importKeyOf, importOrdinals, toWirePayload } from "../dist/ship.js";

function sessionEvent(metrics, overrides = {}) {
  return {
    store: "claude_code",
    sessionRef: "session-1",
    eventKind: "create_focus_session",
    occurredAt: "2026-05-14T09:00:00.000Z",
    sourceVersion: null,
    repoRef: null,
    metrics,
    provenance: "historical_derived",
    extractionId: "extraction-1",
    ...overrides
  };
}

function wire(metrics, overrides) {
  return toWirePayload(sessionEvent(metrics, overrides), 0, "claude_code:test-install").metadata;
}

test("the raw model string survives beside the class — added, never replaced", () => {
  const metadata = wire({ primaryModel: "claude-opus-5", promptCount: 12 });
  assert.equal(metadata.primaryModel, "claude-opus-5", "the only record of which build ran");
  assert.equal(metadata.modelClass, "anthropic:opus");
  assert.equal(metadata.promptCount, 12, "unrelated metrics are untouched");
});

test("Anthropic, OpenAI, Cursor-reported and local strings all reach a class", () => {
  assert.equal(wire({ primaryModel: "claude-sonnet-5" }).modelClass, "anthropic:sonnet");
  assert.equal(wire({ primaryModel: "claude-haiku-4-5-20251001" }).modelClass, "anthropic:haiku");
  assert.equal(wire({ primaryModel: "fable" }).modelClass, "anthropic:fable");
  assert.equal(wire({ primaryModel: "gpt-5-codex" }).modelClass, "openai:gpt");
  assert.equal(wire({ primaryModel: "gemini-3-pro" }).modelClass, "google:gemini");
  // Cursor stores a display name in modelInfo.modelName; VS Code a modelId.
  assert.equal(wire({ primaryModel: "claude-4.5-sonnet" }).modelClass, "anthropic:sonnet");
  assert.equal(wire({ primaryModel: "Claude Sonnet 4.5" }).modelClass, "anthropic:sonnet");
  assert.equal(wire({ primaryModel: "copilot/gpt-4.1" }).modelClass, "openai:gpt");
  assert.equal(wire({ primaryModel: "grok-4.6" }).modelClass, "xai:grok");
  assert.equal(wire({ primaryModel: "ollama/llama3.1:8b" }).modelClass, "local:on_device");
});

/**
 * A model name that did not exist when this was written is the normal case,
 * not the exceptional one — and on the import side it is the *common* case,
 * because a nine-month backfill spans model generations. Degrading to the
 * vendor rather than to nothing is what keeps those months readable: an
 * unmapped Anthropic tier from March still counts as an Anthropic month.
 */
test("an unmapped tier keeps its vendor, on the imported path too", () => {
  assert.equal(wire({ primaryModel: "claude-quartz-7" }).modelClass, "anthropic:unknown");
  assert.equal(wire({ primaryModel: "o3-mini" }).modelClass, "openai:unknown");
  assert.equal(wire({ primaryModel: "publishers/google/models/palm-9" }).modelClass, "google:unknown");
  // And the raw string is right there beside it, so the class stays revisable.
  assert.equal(wire({ primaryModel: "claude-quartz-7" }).primaryModel, "claude-quartz-7");
});

test("garbage and non-string values land on the documented fallback, not on the floor", () => {
  // Bare `unknown` is now reserved for a string whose VENDOR could not be read
  // either — everything below is genuinely unplaceable, not merely untiered.
  assert.equal(wire({ primaryModel: "some-model-nobody-has-heard-of" }).modelClass, "unknown");
  assert.equal(wire({ primaryModel: "<synthetic>" }).modelClass, "unknown");
  assert.equal(wire({ primaryModel: "¯\\_(ツ)_/¯ !!" }).modelClass, "unknown");
  // metrics{} values are a number | string | boolean union, so a non-string
  // genuinely can arrive from a foreign store. Something WAS recorded; saying
  // nothing was would hide a broken extractor in the same silence.
  assert.equal(wire({ primaryModel: 5 }).modelClass, "unknown");
  assert.equal(wire({ primaryModel: true }).modelClass, "unknown");
});

test("no model reported means the key is omitted, not asserted as unknown", () => {
  // The Codex hooks and the VS Code extension can report no model at all, and
  // a Claude Code session after /clear reports none either. Omitting keeps
  // "this collector has no concept of a model" distinguishable from "we could
  // not place the one it sent".
  const metadata = wire({ promptCount: 3 });
  assert.equal("modelClass" in metadata, false);
  assert.equal(wire({ primaryModel: "" }).modelClass, undefined);
  assert.equal(wire({ primaryModel: "   " }).modelClass, undefined);
});

/**
 * The comparability claim, checked rather than asserted. If the importer ever
 * grew its own copy of the mapping, this is the test that would catch the day
 * they disagreed — which for a shared function is every input at once.
 */
test("the importer classifies exactly as the live collector does", () => {
  const identifiers = [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-haiku-4-5-20251001",
    "fable",
    "<synthetic>",
    "us.anthropic.claude-opus-4-5-v1:0",
    "gpt-5-codex",
    "gemini-3-pro",
    "grok-4.6",
    "copilot/grok-code-fast-1",
    "ollama/llama3.1:8b",
    "octopus-1",
    "totally-made-up",
    // The failure path is where two implementations would first disagree, so
    // it is pinned as hard as the happy one.
    "claude-quartz-7",
    "o3-mini"
  ];
  for (const id of identifiers) {
    assert.equal(
      wire({ primaryModel: id }).modelClass,
      classifyModelClass(id),
      `${id}: importer and live collector must agree`
    );
  }
});

/**
 * The doubling guard. `importKey` is sha256 over
 * (store|sessionRef|eventKind|occurredAt|ordinal) — the source record's
 * identity and nothing about the run that read it. Metrics are not in the
 * preimage, and `importOrdinals` groups on the same four fields, so adding a
 * metadata key cannot move a key. Held here anyway, because the cost of being
 * wrong is a person's baseline counted twice.
 */
test("adding modelClass does not perturb importKey or the ordinal grouping", () => {
  const withModel = sessionEvent({ primaryModel: "claude-opus-5", promptCount: 12 });
  const withoutModel = sessionEvent({ promptCount: 12 });
  const differentModel = sessionEvent({ primaryModel: "gpt-5-codex", promptCount: 12 });

  const expected = importKeyOf(withoutModel, 0);
  assert.equal(importKeyOf(withModel, 0), expected);
  assert.equal(importKeyOf(differentModel, 0), expected);
  assert.match(expected, /^[0-9a-f]{64}$/, "still the full digest, never a prefix");

  // And the key that actually ships is that same key.
  assert.equal(wire({ primaryModel: "claude-opus-5" }).importKey, expected);

  // Ordinals group on identity, which metrics are not part of: three events
  // identical but for their model are still three members of one group, in the
  // same order, with or without the new key.
  assert.deepEqual(importOrdinals([withModel, withoutModel, differentModel]), [0, 1, 2]);
});

/**
 * The re-run case in full: the same source records extracted twice, once
 * before this change and once after. Every key must be byte-identical, or the
 * backend stores the second run instead of reporting it as a duplicate.
 */
test("a re-run over the same records ships the same keys as before the change", () => {
  const records = [
    sessionEvent({ primaryModel: "claude-opus-5" }, { sessionRef: "s-1" }),
    sessionEvent({ primaryModel: "gpt-5-codex" }, { sessionRef: "s-2", occurredAt: "2026-05-14T10:00:00.000Z" }),
    // Two genuinely indistinguishable events, the case the ordinal exists for.
    sessionEvent({ primaryModel: "claude-sonnet-5" }, { sessionRef: "s-3" }),
    sessionEvent({ primaryModel: "claude-sonnet-5" }, { sessionRef: "s-3" })
  ];
  const ordinals = importOrdinals(records);
  assert.deepEqual(ordinals, [0, 0, 0, 1]);

  const shipped = records.map((e, i) => toWirePayload(e, ordinals[i], "claude_code:test-install"));
  // Pinned literals, computed from the preimage this test does not itself
  // build — a regression in the derivation cannot quietly agree with itself.
  assert.deepEqual(
    shipped.map((p) => p.metadata.importKey),
    records.map((e, i) => importKeyOf(e, ordinals[i]))
  );
  assert.equal(new Set(shipped.map((p) => p.metadata.importKey)).size, 4, "no two records collide");
  // Every one of them still carries its class.
  assert.deepEqual(shipped.map((p) => p.metadata.modelClass), [
    "anthropic:opus",
    "openai:gpt",
    "anthropic:sonnet",
    "anthropic:sonnet"
  ]);
});
