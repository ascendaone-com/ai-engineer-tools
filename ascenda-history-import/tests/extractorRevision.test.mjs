/**
 * The output-hash guard for extractor revisions.
 *
 * A fix that changes a figure an extractor already ships has to bump that
 * store's revision, or the backend answers `duplicate` for every session it
 * already holds and the old figure stays. This runs each extractor that has a
 * committed fixture, hashes its normalized output, and compares the hash with
 * the one recorded beside the revision it was recorded at.
 *
 * Failing means the output moved. If a figure that was already shipped
 * changed, bump the store in `src/extractorRevisions.ts` and re-record. If the
 * change only adds a metric, re-record the hash and leave the revision alone.
 *
 * Re-record with: RECORD_EXTRACTOR_HASHES=1 npm test -w @ascenda-one/history-import
 *
 * Stores without a committed fixture (cursor, vscode, git) build theirs
 * inline in their own tests and aren't covered here; `UNGUARDED` says so.
 */
import "./isolateHome.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { extractCopilotCli } from "../dist/extractors/copilotCli.js";
import { extractCodex } from "../dist/extractors/codex.js";
import { EXTRACTOR_REVISION } from "../dist/extractorRevisions.js";

// Clock-derived figures (after-hours counts) read the local zone; pin it so the
// recorded hash is the same on every machine.
process.env.TZ = "UTC";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(HERE, "extractorRevision.recorded.json");
const UNGUARDED = ["cursor", "vscode", "git"];

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Stable JSON: keys sorted, so the hash doesn't depend on property order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function hashOf(events) {
  return createHash("sha256").update(JSON.stringify(canonical(events))).digest("hex");
}

async function outputs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hist-import-revision-"));
  const project = path.join(root, "projects", "-Users-example-Dev-repo-a");
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(
    path.join(HERE, "fixtures", "claude-session-real.jsonl"),
    path.join(project, "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001.jsonl")
  );
  // A resume that repeats its own lines, so the hash moves with the rung-2 fix.
  await fs.copyFile(
    path.join(HERE, "fixtures", "claude-resume-replay.jsonl"),
    path.join(project, "5e5e5e5e-0000-4000-8000-000000000001.jsonl")
  );
  try {
    return {
      claude_code: hashOf(await collect(extractClaudeCode(root, "revision-guard"))),
      copilot_cli: hashOf(
        await collect(extractCopilotCli(path.join(HERE, "fixtures", "copilot-cli-store"), "revision-guard"))
      ),
      codex: hashOf(await collect(extractCodex(path.join(HERE, "fixtures", "codex-store"), "revision-guard")))
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("a store's output hash only moves with its revision", async () => {
  const actual = await outputs();
  if (process.env.RECORD_EXTRACTOR_HASHES) {
    const next = Object.fromEntries(
      Object.entries(actual).map(([store, outputHash]) => [store, { revision: EXTRACTOR_REVISION[store], outputHash }])
    );
    await fs.writeFile(RECORD, JSON.stringify(next, null, 2) + "\n");
    return;
  }
  const recorded = JSON.parse(await fs.readFile(RECORD, "utf8"));
  for (const [store, outputHash] of Object.entries(actual)) {
    const was = recorded[store];
    assert.ok(was, `${store} has no recorded hash; record one`);
    if (was.revision === EXTRACTOR_REVISION[store]) {
      assert.equal(
        outputHash,
        was.outputHash,
        `${store}'s output changed and its revision is still ${was.revision}. If a figure it already shipped changed, bump it in src/extractorRevisions.ts. If the change only adds a metric, re-record the hash and leave the revision alone.`
      );
    }
  }
});

test("every store has a revision, and an unguarded one is named", () => {
  for (const store of ["claude_code", "codex", "copilot_cli", "cursor", "vscode", "git"]) {
    assert.ok(Number.isInteger(EXTRACTOR_REVISION[store]) && EXTRACTOR_REVISION[store] >= 1, store);
  }
  assert.deepEqual(UNGUARDED.sort(), ["cursor", "git", "vscode"]);
});
