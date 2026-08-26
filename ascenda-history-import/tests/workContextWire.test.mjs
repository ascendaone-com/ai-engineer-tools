import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toWirePayload } from "../dist/ship.js";
import { deriveWorkContext, hashWithMachineSalt, readWorkContextRegistry } from "@ascenda-one/tool-kit";

// The importer must put the SAME digests on the wire as the live hooks do for
// the same repository — that agreement is the entire point of the shared
// derivation. It must also keep the legacy digest (hash of the full cwd,
// which early imports actually shipped) nameable via a local alias, because
// the rows stored under it are immutable.
//
// HOME is a throwaway directory (tests/isolateHome.cjs), so the registry and
// salt read here are test state.

function eventFor(repoRef) {
  return {
    occurredAt: "2026-05-10T03:00:00.000Z",
    store: "claude_code",
    sourceVersion: "2.1.0",
    sessionRef: "s-1",
    repoRef,
    eventKind: "ai_prompt_submitted",
    metrics: {},
    provenance: "historical_direct",
    extractionId: "e-1"
  };
}

test("historical and live digests agree, and the legacy full-path digest is aliased locally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-import-ctx-"));
  const repo = path.join(root, "repo-hist");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const payload = toWirePayload(eventFor(repo), 0, "claude_code:test");

  // Agreement with the live derivation for the same folder.
  const live = deriveWorkContext(repo);
  assert.equal(payload.workspaceHash, live.workspaceHash);
  assert.equal(payload.projectHash, live.projectHash);
  assert.equal(payload.projectHash, hashWithMachineSalt("repo-hist"));

  // The digest early imports shipped — hash of the FULL path — stays nameable.
  const legacyHash = hashWithMachineSalt(repo);
  const registry = readWorkContextRegistry();
  assert.equal(registry.contexts[legacyHash].kind, "alias");
  assert.equal(registry.contexts[legacyHash].label, "repo-hist");
  assert.equal(registry.contexts[payload.projectHash].kind, "project");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a repo that no longer exists still ships basename digests", () => {
  const gone = path.join(os.tmpdir(), "ascenda-nonexistent", "repo-ghost");
  const payload = toWirePayload(eventFor(gone), 0, "claude_code:test");
  assert.equal(payload.workspaceHash, hashWithMachineSalt("repo-ghost"));
  assert.equal(payload.projectHash, hashWithMachineSalt("repo-ghost"));
});

test("no repo ref means no context digests, not a crash", () => {
  const payload = toWirePayload(eventFor(null), 0, "claude_code:test");
  assert.equal(payload.workspaceHash, null);
  assert.equal(payload.projectHash, null);
});
