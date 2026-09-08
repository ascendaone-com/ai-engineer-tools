import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ASCENDA_ACTIVE_TIME_QUANTITIES } from "@ascenda-one/tool-contract";
import {
  ACTIVE_TIME_FIGURES,
  NOT_ACTIVE_TIME_FIGURES,
  quantityOf,
  isElapsed
} from "../dist/activeTimeFigures.js";

/**
 * Every active-time figure the handoff carries says what it measures.
 *
 * **Discovery is a source scan, because TypeScript erases interfaces.** There is
 * no runtime object to reflect over — `HandoffSession` does not exist once the
 * code is compiled — so the only way to start from the code rather than from the
 * registry is to read the declarations. Starting from the registry would be
 * worthless: a registry is opt-in, and the figure that causes the incident is
 * the one nobody remembered to register.
 *
 * The thing this guards is not hypothetical in this file. `handsOnMinutes` is
 * summed on `HandoffProjectDigest` and unioned on `ProjectElapsedActive` — same
 * spelling, one nesting level apart, 4.2x apart in value on the reference
 * machine. Both are deliberate and documented, and nothing mechanical told them
 * apart until this table.
 */

/**
 * The package's source, not one file of it.
 *
 * It read only `localHandoff.ts` until now, which left `daySlice.ts` carrying
 * three unlabelled figures the guard never looked at. A scan scoped to a single
 * file is the same defect one level up from the one it exists to catch: the
 * figure that causes the incident is the one nothing looks at.
 */
const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src"
);

/**
 * Figure-shaped field names. Name-based because these are bare `number` fields,
 * indistinguishable by type from a count — the same trade asc-core-be's
 * `LooksLikeActiveTimeFigure` makes, with the same escape hatch for a false
 * positive: an entry in `NOT_ACTIVE_TIME_FIGURES` with a reason.
 *
 * **`Minutes` is not anchored, and that is the correction.** The comment above
 * has always claimed parity with `LooksLikeActiveTimeFigure`, which tests
 * `Contains("Minutes")`; this tested `/Minutes$/`, so a name carrying the word
 * anywhere but the end was figure-shaped in two rails and invisible in this
 * one. `sessionMinutesMeasured` and `minutesFollowingMeetings` are both real
 * names in the sibling repos and neither would have matched here.
 *
 * Nothing in this package's source is currently named that way, so this adds
 * no figure today. It is fixed because a discovery rule narrower than its
 * siblings' is a rail that cannot see a defect the others would catch, and the
 * cross-repo read the three registries depend on assumes all three are looking
 * for the same thing.
 *
 * `Hours` stays anchored to the end in all three: `afterHoursPrompts` and
 * `afterHoursSessions` are counts that happen to contain the word.
 */
function looksLikeFigure(field) {
  return (
    /Minutes/.test(field) || /^minutes/.test(field) || /Hours$/.test(field)
  );
}

/** Every `Interface.field: number` declaration across the package's source. */
function declaredFigures() {
  const found = [];

  for (const file of sourceFiles(SRC_DIR)) {
    let iface = null;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const decl = line.match(/^export (?:interface|type) ([A-Za-z0-9_]+)/);
      if (decl) {
        iface = decl[1];
        continue;
      }
      if (!iface) continue;

      const field = line.match(/^\s{2}([A-Za-z0-9_]+)\??:\s*number;/);
      if (field && looksLikeFigure(field[1])) {
        found.push({ iface, field: field[1], key: `${iface}.${field[1]}` });
      }
    }
  }
  return found;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("the scan actually reads the handoff source", () => {
  // Without this the whole suite passes just as happily against a renamed file,
  // which is the failure mode a guard must not have.
  const found = declaredFigures();
  assert.ok(found.length >= 17, `the scan found only ${found.length} figures — it is not reading src/`);
  assert.ok(found.some((f) => f.key === "ProjectElapsedActive.handsOnMinutes"));
  assert.ok(found.some((f) => f.key === "HandoffProjectDigest.handsOnMinutes"));
  // From daySlice.ts — proof the scan reaches past localHandoff.ts.
  assert.ok(found.some((f) => f.key === "SessionDaySlice.activeMinutes"));
});

test("the name test matches what the sibling rails would match", () => {
  // The divergence this pins shut. asc-core-be tests `Contains("Minutes")` and
  // the app workspace `contains('Minutes')`; this tested `/Minutes$/`, so the
  // three registries the cross-repo ritual depends on were not looking for the
  // same thing. A rail whose discovery is narrower than its siblings' cannot
  // catch a defect they would, and it says nothing while failing to.
  //
  // These four names are real in the sibling repos. None is declared here
  // today; all four must be figure-shaped if one ever is.
  for (const name of [
    "sessionMinutesMeasured", // asc-core-be, ToolTelemetryDemandBucket
    "minutesFollowingMeetings", // app workspace, ProjectWeekRecord
    "summedHandsOnMinutes", // this package, ProjectElapsedDay
    "longestPromptBlockHours" // asc-core-be, TlxWeeklySignals
  ]) {
    assert.ok(looksLikeFigure(name), `${name} is figure-shaped in a sibling rail`);
  }

  // And the false positives all three deliberately exclude stay excluded.
  for (const name of ["afterHoursPrompts", "afterHoursSessions", "promptCount"]) {
    assert.ok(!looksLikeFigure(name), `${name} is a count, not a figure`);
  }
});

test("every declared figure says what it measures", () => {
  const undeclared = declaredFigures()
    .filter((f) => !(f.key in ACTIVE_TIME_FIGURES) && !(f.key in NOT_ACTIVE_TIME_FIGURES))
    .map((f) => f.key);

  assert.deepEqual(
    undeclared,
    [],
    `these active-time figures do not say what they measure — add them to ` +
      `ACTIVE_TIME_FIGURES, or excuse them in NOT_ACTIVE_TIME_FIGURES with a reason:\n  ` +
      undeclared.join("\n  ")
  );
});

test("the registry only names quantities the contract owns", () => {
  for (const [figure, quantity] of Object.entries(ACTIVE_TIME_FIGURES)) {
    assert.ok(
      ASCENDA_ACTIVE_TIME_QUANTITIES.includes(quantity),
      `${figure} reports '${quantity}', which is not a contract quantity`
    );
  }
});

test("every registered and excused figure still exists", () => {
  // A stale entry is a claim about code that is gone. Both directions matter:
  // the registry must not outlive the figure it describes.
  const declared = new Set(declaredFigures().map((f) => f.key));

  for (const key of Object.keys(ACTIVE_TIME_FIGURES)) {
    assert.ok(declared.has(key), `${key} is registered but no longer declared — drop the entry`);
  }
  for (const [key, reason] of Object.entries(NOT_ACTIVE_TIME_FIGURES)) {
    assert.ok(declared.has(key), `${key} is excused (${reason}) but no longer declared — drop the entry`);
  }
});

test("the same spelling carries different quantities where the code means different things", () => {
  // The specific ambiguity this table exists to resolve. If these ever agree,
  // either the code changed or the registry stopped describing it.
  assert.equal(quantityOf("HandoffProjectDigest", "handsOnMinutes"), "hands_on_agent_hours");
  assert.equal(quantityOf("ProjectElapsedActive", "handsOnMinutes"), "hands_on");
  assert.notEqual(
    quantityOf("HandoffProjectDigest", "handsOnMinutes"),
    quantityOf("ProjectElapsedActive", "handsOnMinutes")
  );
});

test("only the unioned figures may be rendered as elapsed time", () => {
  assert.equal(isElapsed(quantityOf("ProjectElapsedActive", "handsOnMinutes")), true);
  assert.equal(isElapsed(quantityOf("ProjectElapsedDay", "handsOnMinutes")), true);
  assert.equal(isElapsed(quantityOf("HandoffProjectDigest", "handsOnMinutes")), false);
  assert.equal(isElapsed(quantityOf("ProjectElapsedDay", "summedHandsOnMinutes")), false);
});

test("a session's own figures are elapsed, since one session cannot overlap itself", () => {
  for (const field of ["activeMinutes", "handsOnMinutes", "agentSupervisingMinutes"]) {
    assert.equal(isElapsed(quantityOf("HandoffSession", field)), true, `HandoffSession.${field}`);
    assert.equal(isElapsed(quantityOf("CodexHandoffSession", field)), true, `CodexHandoffSession.${field}`);
  }
});

test("the gap label is excused rather than registered", () => {
  // activeGapMinutes says how the figures were cut. Registering it would claim
  // the gap is itself a measurement of something.
  assert.equal(quantityOf("HandoffFile", "activeGapMinutes"), undefined);
  assert.ok("HandoffFile.activeGapMinutes" in NOT_ACTIVE_TIME_FIGURES);
});
