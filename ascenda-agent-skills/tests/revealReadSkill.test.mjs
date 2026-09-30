import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Reveal read skill is instruction text, like the checkpoints skill:
// what it does is what it says. The things that keep it inside its remit —
// one read per session, silence unless asked, one digest, no label about
// the person, no "because" across the crossing — are the code, and these
// are the tests of that code.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const skill = fs.readFileSync(
  path.join(root, "skills/ascenda-reveal-read/SKILL.md"),
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
  assert.equal(fm.name, "ascenda-reveal-read");
  assert.ok(fm.description.length > 80);
  assert.match(fm.description, /get_reveal/);
  assert.match(fm.description, /unless they ask/i);
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
  assert.match(skill, /get_reveal/);
  assert.match(skill, /don't\s+mention Ascenda/i);
});

test("it reads once per session and never volunteers the read", () => {
  assert.match(skill, /Once per session, at the start, and never again/);
  assert.match(skill, /Never volunteer it otherwise/);
  assert.match(skill, /on a timer/i);
});

test("it passes its own cwd and reads only its own digest", () => {
  assert.match(skill, /"cwd"/);
  assert.match(skill, /projects\.thisProject/);
  assert.match(skill, /must not try\s+to/i);
  assert.match(skill, /Never a project by name/);
});

test("a record below the floors is silence, not a thin history", () => {
  assert.match(skill, /`eligible`/);
  assert.match(skill, /floors/);
  assert.match(skill, /Don't tell the person their\s+history is thin/i);
});

test("it treats notCollected as unmeasured rather than zero", () => {
  assert.match(skill, /notCollected/);
  assert.match(skill, /unmeasured, not zero/i);
  assert.match(skill, /quarter of a\s+year/i);
});

test("the crossing is a pairing and never a cause", () => {
  assert.match(skill, /shape\.literature/);
  assert.match(skill, /a pairing, not a cause/i);
  assert.match(skill, /Never the word "because"/);
});

test("the band is a reading of the work, and the bird is the person's own", () => {
  assert.match(skill, /`band`/);
  assert.match(skill, /cannot say when the person woke/i);
  assert.match(skill, /Never a label about the person/);
  assert.match(skill, /Never call\s+them anything from the numbers/i);
});

test("it quotes the facts rather than strengthening them", () => {
  assert.match(skill, /`facts`/);
  assert.match(skill, /Quote them; don't paraphrase them into something stronger/);
});

test("it defers to the app's interference budget when speaking unprompted", () => {
  assert.match(skill, /intervention\.warranted/);
  assert.match(skill, /honour it rather than\s+reasoning around it/i);
});

test("it points at the vocabulary file and treats it as a floor", () => {
  assert.match(skill, /banned-vocabulary\.txt/);
  assert.match(skill, /floor, not the ceiling/i);
});

test("it does not claim the cloud read exists", () => {
  assert.ok(!/workdemand:read/i.test(skill));
  assert.match(skill, /local|on the user's own Mac/i);
});

test("the three skills stay distinct: this one reads the past and emits nothing", () => {
  assert.ok(
    !skill.includes("ascenda_emit_work_signal("),
    "the read skill must not call the emit tool"
  );
  assert.match(skill, /ascenda-work-signals/);
  assert.match(skill, /ascenda-work-checkpoints/);
  assert.match(skill, /doesn't offer checkpoints/i);
});
