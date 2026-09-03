import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildHandoff,
  projectLabelOf,
  writeHandoff,
  handoffFilePath,
  HANDOFF_SCHEMA
} from "../dist/localHandoff.js";

const events = [
  {
    occurredAt: "2026-07-20T11:00:00.000Z",
    store: "claude_code",
    sourceVersion: "2.1.227",
    sessionRef: "session-b",
    repoRef: "/Users/example/Dev/repo-b",
    eventKind: "create_focus_session",
    metrics: {
      promptCount: 4,
      durationBucket: "30m-2h",
      afterHoursPrompts: 0,
      primaryModel: "claude-sonnet-5"
    },
    provenance: "historical_derived",
    extractionId: "x1"
  },
  {
    occurredAt: "2026-07-19T09:00:00.000Z",
    store: "claude_code",
    sourceVersion: "2.1.227",
    sessionRef: "session-a",
    repoRef: "/Users/example/Dev/repo-a/",
    eventKind: "create_focus_session",
    metrics: { promptCount: 2, durationBucket: "0-5m", afterHoursPrompts: 2 },
    provenance: "historical_derived",
    extractionId: "x1"
  },
  {
    occurredAt: "2026-07-19T09:00:00.000Z",
    store: "claude_code",
    sourceVersion: null,
    sessionRef: "session-a",
    repoRef: "/Users/example/Dev/repo-a",
    eventKind: "ai_prompt_submitted",
    metrics: {},
    provenance: "historical_direct",
    extractionId: "x1"
  },
  {
    occurredAt: "2026-07-20T11:00:00.000Z",
    store: "claude_code",
    sourceVersion: null,
    sessionRef: null,
    repoRef: null,
    eventKind: "extraction_epoch",
    metrics: {
      windowOldest: "2026-07-19T09:00:00.000Z",
      windowNewest: "2026-07-20T11:00:00.000Z",
      sessionCount: 2
    },
    provenance: "historical_derived",
    extractionId: "x1"
  }
];

test("projectLabelOf takes the last path segment, trailing slash tolerated", () => {
  assert.equal(projectLabelOf("/Users/example/Dev/repo-a"), "repo-a");
  assert.equal(projectLabelOf("/Users/example/Dev/repo-a/"), "repo-a");
  assert.equal(projectLabelOf("repo-slug"), "repo-slug");
  assert.equal(projectLabelOf(null), null);
});

test("buildHandoff keeps only sessions, sorted oldest first, with the window", () => {
  const handoff = buildHandoff(events, "x1", "2026-07-21T00:00:00.000Z");
  assert.equal(handoff.schema, HANDOFF_SCHEMA);
  assert.equal(handoff.sessions.length, 2); // prompts and the epoch marker are not sessions
  assert.equal(handoff.sessions[0].sessionRef, "session-a"); // sorted by time
  assert.equal(handoff.sessions[1].sessionRef, "session-b");
  assert.equal(handoff.sessions[0].projectLabel, "repo-a");
  assert.equal(handoff.sessions[0].afterHoursPrompts, 2);
  assert.equal(handoff.sessions[0].primaryModel, null); // absent metric → null, not ""
  assert.equal(handoff.windowOldest, "2026-07-19T09:00:00.000Z");
  assert.equal(handoff.windowNewest, "2026-07-20T11:00:00.000Z");
});

test("buildHandoff defaults new friction fields to 0/null for events that predate them", () => {
  // Events without the new metrics (an older extraction, or a fixture that
  // never set them) must not crash the mapping — they fall back cleanly.
  const handoff = buildHandoff(events, "x1", "2026-07-21T00:00:00.000Z");
  const session = handoff.sessions.find((s) => s.sessionRef === "session-b");
  assert.equal(session.startedAt, null);
  assert.equal(session.activeMinutes, 0);
  assert.equal(session.compactionCount, 0);
  assert.equal(session.toolFailureCount, 0);
  assert.equal(session.contextWindowPeakPct, 0);
  // Null, not 0: an absent count means the store could not answer, and on
  // Claude Code it never can — `toolUseResult.userModified` is present
  // 20,133 times in a real store and false every time. A 0 here would ship
  // "no AI edit was ever corrected by hand" as a finding.
  assert.equal(session.userModifiedEditCount, null);
  assert.equal(session.subagentTranscripts, 0);
});

test("buildHandoff carries the new friction/context fields through when present", () => {
  const eventsWithFriction = [
    ...events,
    {
      occurredAt: "2026-07-24T10:00:00.000Z",
      store: "claude_code",
      sourceVersion: "2.1.227",
      sessionRef: "session-c",
      repoRef: "/Users/example/Dev/repo-c",
      eventKind: "create_focus_session",
      metrics: {
        promptCount: 3,
        durationBucket: "30-60m",
        afterHoursPrompts: 0,
        sessionStartedAt: "2026-07-24T09:30:00.000Z",
        activeMinutes: 12,
        compactionCount: 2,
        toolFailureCount: 4,
        contextWindowPeakPct: 0.82,
        userModifiedEditCount: 1,
        subagentTranscripts: 3
      },
      provenance: "historical_derived",
      extractionId: "x1"
    }
  ];
  const handoff = buildHandoff(eventsWithFriction, "x1", "2026-07-24T10:05:00.000Z");
  const session = handoff.sessions.find((s) => s.sessionRef === "session-c");
  assert.ok(session, "expected session-c in the handoff");
  assert.equal(session.startedAt, "2026-07-24T09:30:00.000Z");
  assert.equal(session.activeMinutes, 12);
  assert.equal(session.compactionCount, 2);
  assert.equal(session.toolFailureCount, 4);
  assert.equal(session.contextWindowPeakPct, 0.82);
  assert.equal(session.userModifiedEditCount, 1);
  assert.equal(session.subagentTranscripts, 3);
});

test("every handoff session is derived provenance — never presented as recorded", () => {
  const handoff = buildHandoff(events, "x1", "2026-07-21T00:00:00.000Z");
  assert.ok(handoff.sessions.every((s) => s.provenance === "historical_derived"));
});

test("writeHandoff returns null when the app container is absent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-nohome-"));
  try {
    const handoff = buildHandoff(events, "x1", "2026-07-21T00:00:00.000Z");
    assert.equal(await writeHandoff(handoff, home), null);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("writeHandoff writes valid JSON into the container and replaces cleanly", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-home-"));
  try {
    await fs.mkdir(
      path.join(home, "Library", "Containers", "one.ascenda.ascendaMissionControl", "Data"),
      { recursive: true }
    );
    const handoff = buildHandoff(events, "x1", "2026-07-21T00:00:00.000Z");
    const written = await writeHandoff(handoff, home);
    assert.equal(written, handoffFilePath(home));
    const roundTripped = JSON.parse(await fs.readFile(written, "utf8"));
    assert.equal(roundTripped.sessions.length, 2);

    // A second run must replace, not append or corrupt — re-import is normal.
    const second = buildHandoff(events.slice(0, 1), "x2", "2026-07-22T00:00:00.000Z");
    await writeHandoff(second, home);
    const again = JSON.parse(await fs.readFile(written, "utf8"));
    assert.equal(again.sessions.length, 1);
    assert.equal(again.extractionId, "x2");
    // No temp file left behind.
    const leftovers = await fs.readdir(path.dirname(written));
    assert.deepEqual(leftovers, ["claude_code.json"]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("projectLabelOf folds a deleted Claude worktree into the repository it came from", () => {
  // The importer replays cwds that no longer exist. Before this folded them,
  // every `.claude/worktrees/<name>` the agent had cleaned up became a
  // project of its own in the handoff, and the desktop app counted them.
  assert.equal(projectLabelOf("/Users/example/Dev/repo-a/.claude/worktrees/sweet-wiles-0f5525"), "repo-a");
  assert.equal(projectLabelOf("/Users/example/Dev/repo-a/.claude/worktrees/sweet-wiles-0f5525/src"), "repo-a");
  assert.equal(projectLabelOf("/Users/example/Dev/repo-a-wt/metric-unit-split"), "repo-a");
  // A plain deleted checkout is unchanged: its own basename.
  assert.equal(projectLabelOf("/Users/example/Dev/gone/repo-b"), "repo-b");
});
