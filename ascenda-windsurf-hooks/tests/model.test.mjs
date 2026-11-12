/**
 * Cascade documents `model_name` on its hook payloads: the label from its
 * model picker, or `Unknown`. Checked against the hooks reference, not a
 * captured payload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWindsurfEvent, readWindsurfModel, sentModelId } from "../dist/mapWindsurfEvent.js";

test("a picker label is read and classified like a slug; Unknown is no model", () => {
  assert.equal(readWindsurfModel({ model_name: "Claude Sonnet 4" }), "Claude Sonnet 4");
  assert.equal(readWindsurfModel({ model_name: "Unknown" }), undefined);
  assert.equal(readWindsurfModel({ model_name: "  " }), undefined);
  const [event] = mapWindsurfEvent("pre_user_prompt", { model_name: "GPT 4.1", tool_info: { user_prompt: "go" } });
  assert.equal(event.metadata.modelId, "GPT 4.1");
  assert.equal(event.metadata.modelClass, "openai:gpt");
});

test("the first event sends it, an unchanged one doesn't", () => {
  const first = mapWindsurfEvent("pre_read_code", { model_name: "Claude Sonnet 4" });
  assert.equal(sentModelId(first), "Claude Sonnet 4");
  const again = mapWindsurfEvent("pre_read_code", { model_name: "Claude Sonnet 4" }, undefined, "Claude Sonnet 4");
  assert.equal(sentModelId(again), undefined);
});
