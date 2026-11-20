/**
 * Keys that stay on the machine.
 *
 * `readBy` names who reads a metric key and says nothing about whether it is
 * sent: the wire payload is built by copying `metrics{}`. The egress rule is
 * `family: "local"`, and it is only a rule if the code that builds the
 * payload obeys it. These tests hold `ship.ts` to the declaration, for every
 * `local` key there is and any added later.
 */
import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { METRIC_KEYS, localMetricKeys } from "@ascenda-one/tool-contract";
import { toWirePayload } from "../dist/ship.js";

const LOCAL = [...localMetricKeys()];

function sessionWith(metrics) {
  return {
    eventKind: "create_focus_session",
    store: "codex",
    occurredAt: "2026-11-10T01:00:00.000Z",
    sessionRef: "session-ref",
    repoRef: null,
    extractionId: "x1",
    provenance: "retrospective",
    metrics
  };
}

test("the usage-limit readings are declared local", () => {
  const usage = Object.keys(METRIC_KEYS).filter((k) => k.startsWith("usageLimit")).sort();
  assert.equal(usage.length, 7);
  assert.deepEqual(usage.filter((k) => !LOCAL.includes(k)), [], "every usageLimit key stays on the machine");
});

test("a local key names no backend reader", () => {
  const offenders = LOCAL.filter(
    (k) => METRIC_KEYS[k].readBy.includes("backend") || METRIC_KEYS[k].backendAliases !== undefined
  );
  assert.deepEqual(offenders, [], "a key that is never sent has nothing to read it on the other side");
});

test("a local key says why in its note", () => {
  const offenders = LOCAL.filter((k) => !METRIC_KEYS[k].note);
  assert.deepEqual(offenders, []);
});

test("the wire payload leaves every local key out and keeps the rest", () => {
  assert.ok(LOCAL.length > 0);
  const metrics = { promptCount: 3 };
  for (const key of LOCAL) metrics[key] = 1;
  const payload = toWirePayload(sessionWith(metrics), 0, "cli_agent:test-install");
  const leaked = LOCAL.filter((k) => k in payload.metadata);
  assert.deepEqual(leaked, [], `local keys on the wire payload:\n  ${leaked.join("\n  ")}`);
  assert.equal(payload.metadata.promptCount, 3);
});
