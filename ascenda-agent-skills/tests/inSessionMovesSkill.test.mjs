import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The skill is instruction text: everything it does is what it says. So the
// lines that keep it inside its remit (ask before offering, honour a refusal,
// once per session, never join two facts with a cause, never describe the
// person) are the code, and these are the tests of that code.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const skill = fs.readFileSync(
  path.join(root, "skills/ascenda-in-session-moves/SKILL.md"),
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

test("frontmatter names the skill and describes when it triggers", () => {
  const fm = frontmatter(skill);
  assert.equal(fm.name, "ascenda-in-session-moves");
  assert.ok(fm.description.length > 80);
  assert.match(fm.description, /get_in_session_move/);
  assert.match(fm.description, /once per session/);
  assert.equal(fm.license, "Apache-2.0");
});

test("the skill directory name matches the frontmatter name", () => {
  const dirs = fs
    .readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(dirs.includes(frontmatter(skill).name));
});

test("it names the tool, and stays quiet when the tool is absent", () => {
  assert.match(skill, /get_in_session_move/);
  assert.match(skill, /don't mention Ascenda/i);
});

test("it names exactly the two triggers the tool accepts", () => {
  assert.match(skill, /`approach_churn_detected`/);
  assert.match(skill, /`session_compacted`/);
  // Churn shares its threshold with the work-signals event of the same name.
  assert.match(skill, /three or more materially different approaches/i);
  assert.match(skill, /more than two hours/);
});

test("a refusal means silence, for every reason the tool can give", () => {
  assert.match(skill, /When `offer` is false, say nothing/);
  for (const reason of [
    "line_says_no",
    "flow_holds_the_ask",
    "rested",
    "history_unread",
  ]) {
    assert.match(skill, new RegExp("`" + reason + "`"), reason);
  }
  assert.match(skill, /Do not call the tool again in the same session/);
});

test("it offers once per session, at a boundary, and drops a decline", () => {
  assert.match(skill, /One offer per session, across both patterns/);
  assert.match(skill, /boundary the work produced/);
  assert.match(skill, /never because time has passed/);
  assert.match(skill, /drop it/);
});

test("it quotes the app's sentences as given, never joined by a cause", () => {
  assert.match(skill, /`pattern`/);
  assert.match(skill, /`lastTime`/);
  assert.match(skill, /as given/);
  assert.match(skill, /never joined by a cause/);
  assert.match(skill, /`move\.ask` as written/);
});

test("it never grades a commitment and never describes the person", () => {
  assert.match(skill, /Never say they planned, promised or meant to do it/);
  assert.match(skill, /describes \*\*the work\*\*/);
  assert.match(skill, /banned-vocabulary\.txt/);
});

test("it writes nothing and picks nothing", () => {
  assert.match(skill, /the tool is a read/);
  assert.match(skill, /It does not pick the change/);
});
