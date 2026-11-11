/**
 * Cursor documents `model_id` (and the older `model` slug) as base fields on
 * its hook payloads. Checked against the hooks reference, not a captured
 * payload: no capture in this repo has them yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCursorEvent, readCursorModel, sentModelId } from "../dist/mapCursorEvent.js";

test("model_id is preferred over the older slug", () => {
  assert.equal(readCursorModel({ model_id: "claude-opus-4-7", model: "claude-opus-4-7-thinking-max" }), "claude-opus-4-7");
  assert.equal(readCursorModel({ model: "gpt-5" }), "gpt-5");
  assert.equal(readCursorModel({}), undefined);
});

test("sessionStart sends the model; later events only on a change; no route", () => {
  const start = mapCursorEvent("sessionStart", { model_id: "claude-opus-4-7" }, undefined, "claude-opus-4-7");
  assert.equal(start[0].metadata.modelId, "claude-opus-4-7");
  assert.equal(start[0].metadata.modelClass, "anthropic:opus");
  assert.equal("modelRoute" in start[0].metadata, false);
  const same = mapCursorEvent("preToolUse", { tool_name: "Shell", model_id: "claude-opus-4-7" }, undefined, "claude-opus-4-7");
  assert.equal(sentModelId(same), undefined);
  const changed = mapCursorEvent("preToolUse", { tool_name: "Shell", model_id: "kimi-k2" }, undefined, "claude-opus-4-7");
  assert.equal(changed[0].metadata.modelClass, "moonshot:unknown");
});
