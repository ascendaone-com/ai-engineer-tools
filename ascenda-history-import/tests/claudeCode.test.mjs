import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { lineageFigures } from "./lineageFigures.mjs";
import {
  sniffClaudeLine,
  KNOWN_CLAUDE_LINE_TYPES,
  META_CLAUDE_LINE_TYPES,
  extractClaudeCode,
  isToolFailureLine,
  foldableModelOf,
  SYNTHETIC_CLAUDE_MODEL
} from "../dist/extractors/claudeCode.js";

// Fixture lines shaped like Claude Code 2.1.x transcripts (real field shapes,
// content replaced). Per the contract-test rule: one fixture set per known
// (tool, version) pair, and
// an unknown shape must sniff as unparsed rather than half-parse.

const userLine = JSON.stringify({
  type: "user",
  timestamp: "2026-07-21T03:14:15.926Z",
  sessionId: "0f0e0d0c-1111-2222-3333-444455556666",
  version: "2.1.227",
  cwd: "/Users/example/Dev/some-repo",
  gitBranch: "main",
  message: { role: "user", content: "redacted" }
});

const assistantLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-21T03:14:22.001Z",
  sessionId: "0f0e0d0c-1111-2222-3333-444455556666",
  version: "2.1.227",
  message: {
    role: "assistant",
    model: "claude-opus-5",
    usage: { input_tokens: 12, output_tokens: 34 }
  }
});

// Claude Code writes its own notices as assistant lines under the literal
// model string `<synthetic>` — "No response requested", plan-limit hits,
// sleep-drop and connection-loss notices, 529 overloads. Field shapes copied
// from real lines (345 of them on one 852-transcript store), content replaced:
// the `usage` block is present and every figure in it is zero, because no
// model ran.
const syntheticNoticeLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-21T03:14:30.500Z",
  sessionId: "0f0e0d0c-1111-2222-3333-444455556666",
  version: "2.1.227",
  message: {
    role: "assistant",
    model: "<synthetic>",
    stop_reason: "stop_sequence",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  }
});

test("sniffs a user line with its schema anchor fields", () => {
  const sniffed = sniffClaudeLine(userLine);
  assert.equal(sniffed.kind, "user");
  assert.equal(sniffed.sourceVersion, "2.1.227");
  assert.equal(sniffed.occurredAt, "2026-07-21T03:14:15.926Z");
  assert.equal(sniffed.sessionId, "0f0e0d0c-1111-2222-3333-444455556666");
});

test("sniffs the model id off an assistant line", () => {
  const sniffed = sniffClaudeLine(assistantLine);
  assert.equal(sniffed.kind, "assistant");
  assert.equal(sniffed.model, "claude-opus-5");
});

// Pinned literal, deliberately NOT derived from KNOWN_CLAUDE_LINE_TYPES. The
// loop below used to iterate the constant it was validating, which made it a
// tautology: deleting a type from the extractor deleted the assertion that
// covered it, and the suite stayed green. Verified by removing "attachment"
// and "last-prompt" from the constant — all 108 tests passed. A dropped type
// stops being parsed and starts counting as `unknownLines`, i.e. the drift
// signal itself becomes the drift, so this list must be updated by hand and
// on purpose.
const DOCUMENTED_CLAUDE_LINE_TYPES = [
  "user",
  "assistant",
  "attachment",
  "system",
  "queue-operation",
  "last-prompt",
  "custom-title"
];

test("every documented line type is recognised", () => {
  for (const type of DOCUMENTED_CLAUDE_LINE_TYPES) {
    const sniffed = sniffClaudeLine(JSON.stringify({ type, version: "2.1.227" }));
    assert.equal(sniffed.kind, type, `expected ${type} to be known`);
  }
});

test("the extractor's known-type list matches the documented one", () => {
  // Fails in both directions: a type quietly dropped from the extractor, and a
  // type added without a fixture or a decision about what it should fold into.
  assert.deepEqual(
    [...KNOWN_CLAUDE_LINE_TYPES].sort(),
    [...DOCUMENTED_CLAUDE_LINE_TYPES].sort()
  );
});

test("unknown-but-valid line types sniff as unknown with the type named", () => {
  const alien = JSON.stringify({ type: "hologram", version: "99.0.0" });
  const sniffed = sniffClaudeLine(alien);
  assert.equal(sniffed.kind, "unknown");
  assert.equal(sniffed.type, "hologram");
});

test("observed meta types (mode, ai-title, pr-link) are meta, not unknown", () => {
  // These used to sniff as `unknown` and count toward `unknownLines`, because
  // META_CLAUDE_LINE_TYPES was declared, exported, and never read. Every real
  // store is full of these, so the drift signal was mostly them.
  for (const type of ["mode", "ai-title", "pr-link", "worktree-state"]) {
    assert.equal(sniffClaudeLine(JSON.stringify({ type })).kind, "meta");
  }
});

test("a meta line names its type, and a genuinely new type is still unknown", () => {
  // The distinction the split exists for: recognised-and-ignored on one side,
  // nobody-has-classified-this-yet on the other. Collapsing them in either
  // direction is what this asserts against.
  const meta = sniffClaudeLine(JSON.stringify({ type: "file-history-snapshot" }));
  assert.equal(meta.kind, "meta");
  assert.equal(meta.type, "file-history-snapshot");

  const alien = sniffClaudeLine(JSON.stringify({ type: "hologram" }));
  assert.equal(alien.kind, "unknown");
  assert.equal(alien.type, "hologram");
});

test("every meta type is recognised as meta", () => {
  // Pinned literal, not derived from META_CLAUDE_LINE_TYPES — same reason the
  // known-type list is pinned: a loop over the constant it validates cannot
  // fail when the constant loses an entry.
  const DOCUMENTED_META_TYPES = [
    "ai-title",
    "mode",
    "pr-link",
    "worktree-state",
    "relocated",
    "create",
    "file",
    "directory",
    "image",
    "file-history-snapshot",
    "summary"
  ];
  for (const type of DOCUMENTED_META_TYPES) {
    assert.equal(
      sniffClaudeLine(JSON.stringify({ type })).kind,
      "meta",
      `expected ${type} to be meta`
    );
  }
  assert.deepEqual([...META_CLAUDE_LINE_TYPES].sort(), [...DOCUMENTED_META_TYPES].sort());
});

test("non-JSON and blank lines sniff as unparsed", () => {
  assert.equal(sniffClaudeLine("not json at all").kind, "unparsed");
  assert.equal(sniffClaudeLine("").kind, "unparsed");
  assert.equal(sniffClaudeLine("   ").kind, "unparsed");
});

test("a JSON scalar is unparsed, not a crash", () => {
  assert.equal(sniffClaudeLine("42").kind, "unparsed");
  assert.equal(sniffClaudeLine("null").kind, "unparsed");
});

test("isToolFailureLine reads the is_error marker, not the toolUseResult text", () => {
  assert.equal(
    isToolFailureLine({ message: { content: [{ type: "tool_result", is_error: true }] } }),
    true
  );
  assert.equal(
    isToolFailureLine({ message: { content: [{ type: "tool_result", is_error: false }] } }),
    false
  );
  assert.equal(isToolFailureLine({ message: { content: [{ type: "tool_result" }] } }), false);
  // A string toolUseResult alone (no is_error flag reachable) is not enough —
  // several tools' error text doesn't start with "Error", so the marker is
  // read structurally rather than sniffed from formatting.
  assert.equal(
    isToolFailureLine({ toolUseResult: "Error: boom", message: { content: "typed by a person" } }),
    false
  );
  assert.equal(isToolFailureLine({ message: { content: [{ type: "text", text: "hi" }] } }), false);
});

// Contract-vocabulary pin. The backend's metrics service reads
// `durationBucket` off create_focus_session events expecting exactly the
// tool-contract vocabulary ("0-1m" | "1-5m" | "5-10m" | "10-30m" | "30-60m" |
// "60m+", packages/tool-contract/src/index.ts DurationBucket). This extractor
// used to emit a third, incompatible dialect ("0-5m" | "5-30m" | ...), which
// silently zeroed out SessionMinutesPerDay for every historical session. This
// test fails if that drift reopens, from either side: a bucket string outside
// the contract vocabulary, or a session whose durationBucket and sessionMinutes
// disagree about which bucket the duration falls in.
const CONTRACT_DURATION_BUCKETS = new Set(["0-1m", "1-5m", "5-10m", "10-30m", "30-60m", "60m+"]);

async function withTempSnapshot(lines, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-import-test-"));
  try {
    const projectDir = path.join(dir, "projects", "testproj");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "session1.jsonl"), lines.join("\n") + "\n", "utf8");
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("create_focus_session emits a contract-vocabulary durationBucket plus exact sessionMinutes", async () => {
  const start = "2026-07-21T03:00:00.000Z";
  const end = "2026-07-21T03:03:00.000Z"; // 3 minutes apart — falls in "1-5m"
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: start,
      sessionId: "session1",
      version: "2.1.227",
      cwd: "/Users/example/Dev/testproj",
      message: { role: "user", content: "redacted" }
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: end,
      sessionId: "session1",
      version: "2.1.227",
      message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } }
    })
  ];

  await withTempSnapshot(lines, async (snapshotDir) => {
    const events = [];
    for await (const event of extractClaudeCode(snapshotDir, "extraction-1")) {
      events.push(event);
    }
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.ok(session, "expected a create_focus_session event");
    assert.ok(
      CONTRACT_DURATION_BUCKETS.has(session.metrics.durationBucket),
      `durationBucket ${session.metrics.durationBucket} is not in the tool-contract vocabulary`
    );
    assert.equal(session.metrics.durationBucket, "1-5m");
    assert.equal(session.metrics.sessionMinutes, 3);
  });
});

test("the sniff reads `<synthetic>` verbatim — the fold is what excludes it", () => {
  // The sniff stays a faithful read of the line: `<synthetic>` IS the string
  // in the file. Turning it into `null` here would hide the placeholder from
  // every other reader of the sniff, so the judgement lives one layer up.
  const sniffed = sniffClaudeLine(syntheticNoticeLine);
  assert.equal(sniffed.kind, "assistant");
  assert.equal(sniffed.model, SYNTHETIC_CLAUDE_MODEL);
});

test("foldableModelOf treats a runtime notice as carrying no model", () => {
  assert.equal(foldableModelOf("<synthetic>"), null);
  assert.equal(foldableModelOf(null), null);
  assert.equal(foldableModelOf(""), null);
  // Everything that IS a model identifier passes through untouched — the
  // exclusion is one literal string, not a heuristic about odd-looking names.
  assert.equal(foldableModelOf("claude-opus-5"), "claude-opus-5");
  assert.equal(foldableModelOf("synthetic"), "synthetic");
  assert.equal(foldableModelOf("<synthetic-2>"), "<synthetic-2>");
});

test("a `<synthetic>` notice moves none of the three model figures", async () => {
  // The regression this pins: a notice interrupting a run used to read as a
  // second model and as two switches, out and back. On one real store that
  // was 40% of all recorded switches.
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-21T03:14:15.926Z",
      sessionId: "session1",
      version: "2.1.227",
      cwd: "/Users/example/Dev/testproj",
      message: { role: "user", content: "redacted" }
    }),
    assistantLine,
    syntheticNoticeLine,
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-21T03:14:40.002Z",
      sessionId: "session1",
      version: "2.1.227",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 8, output_tokens: 6 }
      }
    })
  ];

  await withTempSnapshot(lines, async (snapshotDir) => {
    const events = [];
    for await (const event of extractClaudeCode(snapshotDir, "extraction-synthetic")) {
      events.push(event);
    }
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.ok(session, "expected a create_focus_session event");
    assert.equal(session.metrics.modelCount, 1);
    assert.equal(session.metrics.modelSwitchCount, 0);
    assert.equal(session.metrics.primaryModel, "claude-opus-5");
    // The notice is still a line the runtime wrote and still a turn that
    // happened — excluded from the model vocabulary, not from the transcript.
    assert.equal(session.metrics.assistantTurns, 3);
    // Its all-zero usage block is folded like any other and moves nothing.
    assert.equal(session.metrics.inputTokens, 20);
    assert.equal(session.metrics.outputTokens, 40);
  });
});

test("a session of nothing but notices reports no model, not an unknown one", async () => {
  // Absent and unknown are different facts and both are typed. Emitting
  // `primaryModel: "<synthetic>"` here would classify as bare `unknown` —
  // the value a garbage string gets — so the key is omitted instead.
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-21T03:14:15.926Z",
      sessionId: "session1",
      version: "2.1.227",
      cwd: "/Users/example/Dev/testproj",
      message: { role: "user", content: "redacted" }
    }),
    syntheticNoticeLine
  ];

  await withTempSnapshot(lines, async (snapshotDir) => {
    const events = [];
    for await (const event of extractClaudeCode(snapshotDir, "extraction-synthetic-only")) {
      events.push(event);
    }
    const session = events.find((e) => e.eventKind === "create_focus_session");
    assert.ok(session, "expected a create_focus_session event");
    assert.equal(session.metrics.modelCount, 0);
    assert.equal(session.metrics.modelSwitchCount, 0);
    assert.equal("primaryModel" in session.metrics, false);
  });
});

// ── Lineage: whose prompts, and whose minutes ──────────────────────────────
//
// `fixtures/claude-store-lineage` is a whole store, content-free, because
// none of these rules can be seen in one transcript. It holds:
//
//  - a resumed pair: `s-alpha` copies `s-zulu`'s two prompts (same uuid, same
//    timestamp) and adds one. `s-alpha` sorts first, so the walk reaches the
//    copies before the originals, and the home file must still win;
//  - two resumes of a purged session, one per project: the first in walk
//    order owns the inherited line, and a copied line with no uuid is counted
//    by both, as before;
//  - a resumed pair sized in minutes: `s-warm` works for five minutes and
//    `s-warm-resume` copies it, then starts three minutes after the tail it
//    copied — inside the five-minute gap, the one case where a descendant's
//    first span could reach back into its ancestor's last;
//  - a fork: `s-branch` copies the first half of `s-trunk` and diverges,
//    while the trunk carries on;
//  - `s-stub`, a resume opened and never used: every line in it belongs to
//    `s-warm`, so it has no timeline of its own;
//  - chips: `s-parent` offers two on its main thread and its subagent a third.
//    Their sessions open on the prompt verbatim, behind the worktree wrapper,
//    and from the subagent's chip. `s-near-miss` types something close to a
//    chip's text but not it, and `s-chip-resumed` copies a chip-launched
//    session's opener.
//
// The desktop app's importer is held to the same numbers:
// `fixtures/claude-store-lineage.cli.json` is this writer's output for the
// fixture, and the app's test copies both.

const LINEAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-store-lineage");

async function extractStore(root) {
  const events = [];
  for await (const event of extractClaudeCode(root, "extraction-lineage")) events.push(event);
  return events;
}

const sessionsByRef = (events) =>
  Object.fromEntries(
    events.filter((e) => e.eventKind === "create_focus_session").map((e) => [e.sessionRef, e.metrics])
  );

/** A copy of the fixture with only some of its transcripts, as a purge or a fresh machine would leave it. */
async function lineageSubset(keep) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-subset-"));
  await fs.cp(LINEAGE, root, { recursive: true });
  for (const slug of await fs.readdir(path.join(root, "projects"))) {
    for (const name of await fs.readdir(path.join(root, "projects", slug))) {
      if (name.endsWith(".jsonl") && !keep.includes(name.slice(0, -".jsonl".length))) {
        await fs.rm(path.join(root, "projects", slug, name));
      }
    }
  }
  return root;
}

test("a resumed transcript's copies of its ancestor's prompts count once, in the ancestor", async () => {
  const events = await extractStore(LINEAGE);
  const s = sessionsByRef(events);
  assert.equal(s["s-zulu"].promptCount, 2, "the home file owns its lines though it's walked last");
  assert.equal(s["s-alpha"].promptCount, 1, "the resume counts only what was typed in it");
  const prompts = events.filter(
    (e) => e.eventKind === "ai_prompt_submitted" && (e.sessionRef === "s-alpha" || e.sessionRef === "s-zulu")
  );
  assert.equal(new Set(prompts.map((e) => e.occurredAt)).size, prompts.length, "no instant is emitted twice");
  assert.equal(prompts.filter((e) => e.sessionRef === "s-alpha").length, 1);
  assert.equal(prompts.filter((e) => e.sessionRef === "s-zulu").length, 2);
});

test("without its home file, the first transcript in walk order owns an inherited line", async () => {
  const s = sessionsByRef(await extractStore(LINEAGE));
  // s-charlie's project sorts before s-bravo's, so it owns the inherited line.
  // The copied line with no uuid has nothing to match, and both count it.
  assert.equal(s["s-charlie"].promptCount, 3);
  assert.equal(s["s-bravo"].promptCount, 2);
});

test("a resume alone in the store keeps every prompt it holds", async () => {
  const root = await lineageSubset(["s-alpha"]);
  try {
    const s = sessionsByRef(await extractStore(root));
    assert.equal(s["s-alpha"].promptCount, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// This test used to assert the opposite — that adding the home file moved the
// counts and left the minutes where they were. Both figures now follow the one
// ownership rule: a copied line's instant belongs to the session it was typed
// in, so a resume's minutes, spans and start are its own. Measured on a real
// store of 983 sessions, the old rule summed per-session active time to 2.8x
// the union of the same intervals and made 158 sessions look like they ran
// for more than a day.
test("adding the home file moves the minutes too, not just the counts", async () => {
  const root = await lineageSubset(["s-alpha"]);
  try {
    const alone = sessionsByRef(await extractStore(root))["s-alpha"];
    const withHome = sessionsByRef(await extractStore(LINEAGE))["s-alpha"];
    assert.notEqual(alone.promptCount, withHome.promptCount);
    for (const key of ["activeMinutes", "handsOnMinutes", "agentSupervisingMinutes"]) {
      assert.ok(withHome[key] < alone[key], `${key}: ${withHome[key]} is not below ${alone[key]}`);
    }
    // And the resume starts when it was resumed. Alone in the store it owns
    // everything it holds, so it starts where its ancestor did.
    assert.equal(alone.sessionStartedAt, "2026-09-08T01:00:00.000Z");
    assert.equal(withHome.sessionStartedAt, "2026-09-08T03:00:00.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a resume that continues inside the gap still starts its own first span", async () => {
  const events = await extractStore(LINEAGE);
  const session = events.find(
    (e) => e.eventKind === "create_focus_session" && e.sessionRef === "s-warm-resume"
  );
  // The tail it copied ends at 09:05 and its own work starts at 09:08 — three
  // minutes, inside the five-minute gap. Bridging them would hand the resume
  // its ancestor's five minutes and three more nobody worked.
  assert.equal(session.activeSpans[0].from, Date.parse("2026-09-10T09:08:00.000Z"));
  assert.equal(session.metrics.activeMinutes, 5);
  assert.equal(session.metrics.sessionStartedAt, "2026-09-10T09:08:00.000Z");
  const warm = sessionsByRef(events)["s-warm"];
  assert.deepEqual(
    [warm.activeMinutes, warm.handsOnMinutes, warm.agentSupervisingMinutes],
    [5, 2, 3],
    "and the ancestor keeps every minute of its own"
  );
});

test("a fork counts the half it copied in the trunk, and the trunk keeps working", async () => {
  const s = sessionsByRef(await extractStore(LINEAGE));
  assert.deepEqual(
    [s["s-branch"].activeMinutes, s["s-branch"].handsOnMinutes, s["s-branch"].promptCount],
    [5, 0, 1]
  );
  assert.equal(s["s-branch"].sessionStartedAt, "2026-09-10T11:20:00.000Z");
  // The trunk's hands-on minute is in the half the fork copied. It stays here.
  assert.deepEqual(
    [s["s-trunk"].activeMinutes, s["s-trunk"].handsOnMinutes, s["s-trunk"].promptCount],
    [9, 2, 3]
  );
});

test("a transcript holding nothing but a copy is unusable, and counted as one", async () => {
  const events = await extractStore(LINEAGE);
  assert.equal(sessionsByRef(events)["s-stub"], undefined, "no session is emitted for a pure copy");
  const epoch = events.find((e) => e.eventKind === "extraction_epoch");
  assert.equal(epoch.metrics.sessionsWithOnlyInheritedLines, 1);
});

test("a subagent transcript is never inherited, so its lines stay with its fold", async () => {
  const s = sessionsByRef(await extractStore(LINEAGE));
  // agent-a1's lines carry the parent's sessionId, which is not their file's
  // name — the shape an inherited line has. Read as one they would leave
  // s-parent's timeline, and the two instants they contribute would vanish.
  assert.equal(s["s-parent"].activeMinutes, 1);
  assert.equal(s["s-parent"].subagentTranscripts, 1);
  assert.equal(s["s-parent"].activeSplitInstants, 9);
});

test("a chip's prompt opening its session is dispatched, not typed, with or without the wrapper", async () => {
  const s = sessionsByRef(await extractStore(LINEAGE));
  assert.deepEqual(
    [s["s-chip-plain"].promptCount, s["s-chip-plain"].dispatchedPromptLines],
    [1, 1],
    "verbatim opener declined; the prompt typed after it still counts"
  );
  assert.deepEqual([s["s-chip-wrapped"].promptCount, s["s-chip-wrapped"].dispatchedPromptLines], [0, 1]);
  assert.deepEqual(
    [s["s-chip-sub"].promptCount, s["s-chip-sub"].dispatchedPromptLines],
    [0, 1],
    "a chip a subagent offered matches too"
  );
  assert.deepEqual(
    [s["s-near-miss"].promptCount, s["s-near-miss"].dispatchedPromptLines],
    [1, 0],
    "text close to a chip's is still typed"
  );
  assert.equal(s["s-parent"].promptCount, 1);
  assert.equal(s["s-parent"].dispatchedPromptLines, 0);
});

test("a copied chip opener is dispatched once, in the session it opened", async () => {
  const s = sessionsByRef(await extractStore(LINEAGE));
  assert.deepEqual([s["s-chip-resumed"].promptCount, s["s-chip-resumed"].dispatchedPromptLines], [1, 0]);
});

test("the agent runs on a chip's prompt, so cutting that first turn short counts", async () => {
  const s = sessionsByRef(await extractStore(LINEAGE));
  assert.equal(s["s-chip-plain"].interruptedRuns, 1);
});

test("with the chip's issuer purged, its opener counts as typed (the known miss)", async () => {
  const root = await lineageSubset(["s-chip-wrapped"]);
  try {
    const s = sessionsByRef(await extractStore(root));
    assert.deepEqual([s["s-chip-wrapped"].promptCount, s["s-chip-wrapped"].dispatchedPromptLines], [1, 0]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the desktop app's copy of the expected output still matches this writer", async () => {
  const expected = JSON.parse(await fs.readFile(`${LINEAGE}.cli.json`, "utf8"));
  const events = await extractStore(LINEAGE);
  assert.deepEqual(lineageFigures(events), expected.figures);
});
