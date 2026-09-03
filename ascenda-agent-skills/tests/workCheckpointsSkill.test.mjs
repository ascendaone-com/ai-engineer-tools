import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The read skill is instruction text: everything it does is what it says.
// So the things that keep it inside its remit — the tool it names, the
// thresholds, the two figures it must not add, the entries it must not read —
// are the code, and these are the tests of that code.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const skill = fs.readFileSync(
  path.join(root, "skills/ascenda-work-checkpoints/SKILL.md"),
  "utf8"
);

function frontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected a --- delimited frontmatter block");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return fields;
}

test("frontmatter names the skill and describes it specifically enough to trigger", () => {
  const fm = frontmatter(skill);
  assert.equal(fm.name, "ascenda-work-checkpoints");
  assert.ok(fm.description.length > 80);
  assert.match(fm.description, /checkpoint/i);
  assert.equal(fm.license, "Apache-2.0");
});

test("the skill directory name matches the frontmatter name", () => {
  const dirs = fs
    .readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(dirs.includes(frontmatter(skill).name));
});

test("it names the tool it reads, and says to stay quiet when it is absent", () => {
  assert.match(skill, /get_work_demand_context/);
  // An unpaired machine gets silence, not an apology or an install pitch.
  assert.match(skill, /don't mention Ascenda/i);
});

test("it passes its own cwd and reads only its own entry", () => {
  assert.match(skill, /"cwd"/);
  assert.match(skill, /projects\.thisProject/);
  assert.match(skill, /projectDigest/);
  assert.match(skill, /must not try\s+to/i);
});

test("it forbids adding the two minute figures", () => {
  assert.match(skill, /handsOnMinutes/);
  assert.match(skill, /supervisingMinutes/);
  assert.match(skill, /[Nn]ever add the two minute figures/);
});

test("it treats notCollected as unmeasured rather than zero", () => {
  assert.match(skill, /notCollected/);
  assert.match(skill, /unmeasured, not zero/i);
  // The two dimensions that are always absent, and a third whose absence is
  // the easiest to misread as a calm day.
  assert.match(skill, /verificationPass/);
  assert.match(skill, /compactionCount/);
  assert.match(skill, /nothing was watching for a storm/i);
});

test("it never adds a live row to a retrospective one", () => {
  // One context with two origins is two findings, not one bigger day.
  assert.match(skill, /provenance/);
  assert.match(skill, /retrospective/);
  assert.match(skill, /Read the\s+`live` row for your digest and nothing else/);
});

test("it works from a dated bucket rather than the folded window", () => {
  assert.match(skill, /buckets/);
  assert.match(skill, /newest bucket/);
  assert.match(skill, /name its\s+date/);
});

test("a refused or missing read is silence, not an empty week", () => {
  assert.match(skill, /proEntitlementRequired/);
  assert.match(skill, /noRead/);
  assert.match(skill, /don't tell the person their week looks empty/i);
});

test("the trigger states real thresholds rather than a vague sense of 'a lot'", () => {
  // Specific enough to be applied the same way twice — the same discipline
  // EMISSION_CRITERIA.md imposes on the reporting skill.
  const ninetyMentions = skill.match(/90/g) ?? [];
  assert.ok(ninetyMentions.length >= 3, "expected the minute thresholds to be stated");
  assert.match(skill, /minutesSinceLastVerificationPass/);
  assert.match(skill, /lastCommitAt/);
  assert.match(skill, /gapMinutes/);
});

test("it defers to the app's interference budget rather than reasoning around it", () => {
  assert.match(skill, /intervention\.warranted/);
  assert.match(skill, /Honour it rather than reasoning\s+around it/);
  assert.match(skill, /intervention\.guidance/);
});

test("it offers at a boundary, once, and never on a timer", () => {
  assert.match(skill, /boundary/i);
  assert.match(skill, /never on a timer|not on a timer/i);
  assert.match(skill, /Once per session/i);
});

test("it offers a green run before the commit, in that order", () => {
  assert.match(skill, /run the tests and commit/i);
  assert.match(skill, /unverified/i);
});

test("it points at the vocabulary file and treats it as a floor", () => {
  assert.match(skill, /banned-vocabulary\.txt/);
  assert.match(skill, /floor, not the ceiling/i);
});

test("it does not claim the cloud read exists", () => {
  // The cloud instance of this surface is specced and unbuilt. Copy that
  // implied otherwise would be a claim the product cannot honour.
  assert.ok(!/workdemand:read/i.test(skill));
  assert.match(skill, /local MCP server|on the user's own Mac/i);
});

test("the two skills stay distinct: the reader never emits", () => {
  assert.ok(
    !skill.includes("ascenda_emit_work_signal("),
    "the read skill must not call the emit tool"
  );
  assert.match(skill, /ascenda-work-signals/);
});
