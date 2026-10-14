import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../dist/extractors/claudeCode.js";
import { importOrdinals, importKeyOf } from "../dist/ship.js";

// One session, three compact_boundary lines (manual, auto, auto) spread over
// two hours, and a last line well after the final compaction. Each boundary
// must come out at its own instant, not at the session's last timestamp.

const SESSION = "cccccccc-0000-1111-2222-333344445555";
const V = "2.1.227";
const T = (hh, mm, ss = 0) => `2026-09-01T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;
const line = (o) => JSON.stringify({ sessionId: SESSION, version: V, cwd: "/Users/example/Dev/compaction-proj", ...o });
const boundary = (timestamp, trigger) =>
  line({ type: "system", subtype: "compact_boundary", timestamp, ...(trigger ? { compactMetadata: { trigger } } : {}) });
const assistant = (timestamp) =>
  line({ type: "assistant", timestamp, message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } } });

async function extract(lines) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-events-"));
  try {
    const project = path.join(root, "projects", "-Users-example-Dev-compaction-proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, `${SESSION}.jsonl`), lines.join("\n") + "\n");
    const events = [];
    for await (const e of extractClaudeCode(root, "compaction-test")) events.push(e);
    return events;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const compressions = (events) => events.filter((e) => e.eventKind.startsWith("context_compression_"));

test("each compact_boundary line becomes its own event at its own timestamp", async () => {
  const events = await extract([
    line({ type: "user", timestamp: T(9, 0), message: { role: "user", content: "x" } }),
    assistant(T(9, 1)),
    boundary(T(9, 30), "manual"),
    assistant(T(10, 0)),
    boundary(T(10, 15), "auto"),
    boundary(T(10, 55), "auto"),
    assistant(T(11, 30))
  ]);
  const found = compressions(events);
  assert.deepEqual(
    found.map((e) => [e.eventKind, e.occurredAt, e.metrics.compactionOrdinal, e.metrics.compactionCount]),
    [
      ["context_compression_manual", T(9, 30), 1, 1],
      ["context_compression_auto", T(10, 15), 2, 1],
      ["context_compression_auto", T(10, 55), 3, 1]
    ]
  );
  const session = events.find((e) => e.eventKind === "create_focus_session");
  assert.equal(session.occurredAt, T(11, 30), "the session event is still stamped at the session's last line");
  assert.equal(session.metrics.compactionCount, 3);
  assert.ok(found.every((e) => e.occurredAt !== session.occurredAt), "none is stamped at session end");
  assert.ok(found.every((e) => e.sessionRef === SESSION));
});

test("a boundary with no readable trigger keeps its ordinal and ships nothing", async () => {
  const events = await extract([
    line({ type: "user", timestamp: T(9, 0), message: { role: "user", content: "x" } }),
    boundary(T(9, 10), null),
    boundary(T(9, 20), "auto"),
    assistant(T(9, 30))
  ]);
  const found = compressions(events);
  assert.equal(found.length, 1);
  assert.equal(found[0].metrics.compactionOrdinal, 2, "the second boundary of the session, not the first shipped");
});

test("two compactions in the same millisecond still get distinct, stable import keys", async () => {
  const lines = [
    line({ type: "user", timestamp: T(9, 0), message: { role: "user", content: "x" } }),
    boundary(T(9, 10), "auto"),
    boundary(T(9, 10), "auto"),
    assistant(T(9, 30))
  ];
  const keysOf = async () => {
    const found = compressions(await extract(lines));
    return importOrdinals(found).map((n, i) => importKeyOf(found[i], n));
  };
  const first = await keysOf();
  assert.equal(new Set(first).size, 2);
  assert.deepEqual(await keysOf(), first, "a re-run keys the same records the same way");
});

test("a per-compaction key differs from the old session-end key, so re-importing adds rows", async () => {
  // Pins the consequence the PR states: the old row was keyed on the
  // session's last timestamp, ordinal 0.
  const events = await extract([
    line({ type: "user", timestamp: T(9, 0), message: { role: "user", content: "x" } }),
    boundary(T(9, 10), "auto"),
    assistant(T(9, 30))
  ]);
  const [found] = compressions(events);
  const session = events.find((e) => e.eventKind === "create_focus_session");
  const oldKey = importKeyOf({ ...found, occurredAt: session.occurredAt }, 0);
  assert.notEqual(importKeyOf(found, 0), oldKey);
});
