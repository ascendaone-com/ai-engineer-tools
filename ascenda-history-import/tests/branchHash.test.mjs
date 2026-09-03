import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBranchHash, hashWithMachineSalt, readWorkContextRegistry } from "@ascenda-one/tool-kit";
import { toWirePayload } from "../dist/ship.js";

// The import half of the live/retrospective join. See the note in the Claude
// adapter's branchHash test: the two paths cannot be compared in one process
// because the salt differs per isolated test home, so what is pinned here is
// that this path calls the SAME `deriveBranchHash` the hooks call. Both sides
// anchored to one function is what makes the digests equal in production.

function shipWithBranch(gitBranch) {
  return toWirePayload(
    {
      eventKind: "create_focus_session",
      extractionId: "test-extraction",
      store: "claude_code",
      occurredAt: "2026-09-03T02:00:00.000Z",
      sessionRef: "session-1",
      repoRef: "/Users/example/Dev/repo-a",
      metrics: { gitBranch }
    },
    1,
    "claude_code:test-install"
  );
}

test("the shipped digest is the shared derivation, under the shared key", () => {
  const payload = shipWithBranch("feat/time-on-projects");
  assert.equal(payload.metadata.branchHash, deriveBranchHash("feat/time-on-projects"));
  assert.match(payload.metadata.branchHash, /^[0-9a-f]{16}$/);
  // The name is a local metric only; it must not survive onto the wire, under
  // this key or the one this replaced.
  assert.equal(payload.metadata.gitBranch, undefined);
  assert.equal(payload.metadata.gitBranchHash, undefined);
  assert.equal(JSON.stringify(payload).includes("time-on-projects"), false);
});

test("a ref path and a bare name are one branch on the import path too", () => {
  assert.equal(
    shipWithBranch("refs/heads/main").metadata.branchHash,
    shipWithBranch("main").metadata.branchHash
  );
});

test("a branch the store could not name produces no key, not an empty string", () => {
  // The behaviour this replaced wrote "" here, which is a value a reader can
  // group on: it asserted a branch for every session that had none.
  for (const branch of ["", "   ", "HEAD"]) {
    const payload = shipWithBranch(branch);
    assert.equal("branchHash" in payload.metadata, false, JSON.stringify(branch));
  }
});

test("the digest this import used to ship stays nameable as an alias", () => {
  // Rows already stored under `hash(raw branch string)` can never be re-keyed —
  // the import is immutable by design — so where normalisation changed the
  // digest, the older one is registered locally, exactly as the full-cwd repo
  // digest is.
  const raw = "refs/heads/feat/legacy-form";
  const payload = shipWithBranch(raw);
  const legacyHash = hashWithMachineSalt(raw);

  assert.notEqual(legacyHash, payload.metadata.branchHash, "normalisation must have moved the digest");
  const entry = readWorkContextRegistry().contexts[legacyHash];
  assert.ok(entry, "legacy digest is registered");
  assert.equal(entry.kind, "alias");
  assert.equal(entry.label, raw);
});

test("a branch needing no normalisation registers no alias", () => {
  // `main` hashes identically under both forms, so there is nothing to alias
  // and nothing should be written.
  shipWithBranch("main");
  const entry = readWorkContextRegistry().contexts[hashWithMachineSalt("main")];
  assert.equal(entry, undefined);
});
