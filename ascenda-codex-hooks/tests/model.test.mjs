/**
 * Codex puts the active model slug on every hook payload as `model`. The
 * adapter sends `modelId` and `modelClass` on the session's opening event and
 * again on the first event after the model changes, the way the Claude Code
 * adapter sends the effort level.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapCodexEvent, sentModelId } from "../dist/mapCodexEvent.js";

const sample = async () => JSON.parse(await readFile(new URL("../examples/sample-post-tool-use-bash.json", import.meta.url), "utf8"));

test("the sample payload's model is read off the first event that carries it", async () => {
  const events = mapCodexEvent("PostToolUse", await sample());
  assert.equal(events[0].metadata.modelId, "gpt-5.6-sol");
  assert.equal(events[0].metadata.modelClass, "openai:gpt");
  // A plain slug names no route, and no provider is on hook payloads.
  assert.equal("modelRoute" in events[0].metadata, false);
  assert.equal(sentModelId(events), "gpt-5.6-sol");
});

test("an unchanged model is not repeated", async () => {
  const events = mapCodexEvent("PostToolUse", await sample(), undefined, "gpt-5.6-sol");
  assert.equal("modelId" in events[0].metadata, false);
  assert.equal(sentModelId(events), undefined);
});

test("SessionStart always sends, a change sends, and only the first event of a batch carries it", () => {
  const start = mapCodexEvent("SessionStart", { source: "startup", model: "gpt-5" }, undefined, "gpt-5");
  assert.equal(start[0].metadata.modelId, "gpt-5");
  const changed = mapCodexEvent("UserPromptSubmit", { prompt: "that is wrong, redo it", model: "gpt-5-mini" }, undefined, "gpt-5");
  assert.equal(changed.length, 2);
  assert.equal(changed[0].metadata.modelId, "gpt-5-mini");
  assert.equal("modelId" in changed[1].metadata, false);
});

test("a gateway slug carries its route; a provider field is read if one ever appears", () => {
  const viaGateway = mapCodexEvent("SessionStart", { source: "startup", model: "openrouter/moonshotai/kimi-k2" });
  assert.equal(viaGateway[0].metadata.modelClass, "moonshot:unknown");
  assert.equal(viaGateway[0].metadata.modelRoute, "gateway");
  const custom = mapCodexEvent("SessionStart", { source: "startup", model: "glm-4.6", model_provider: "my-team-proxy" });
  assert.equal(custom[0].metadata.modelRoute, "custom_endpoint");
  assert.ok(!JSON.stringify(custom).includes("my-team-proxy"), "a provider name must never leave the mapper");
});

test("no model on the payload means no model keys", () => {
  const events = mapCodexEvent("SessionStart", { source: "startup" });
  assert.equal("modelId" in events[0].metadata, false);
  assert.equal("modelClass" in events[0].metadata, false);
});
