/**
 * Reading a usage limit's reset out of Claude Code's sentence (P-D64.2).
 * Every case pins `now` and the zone, so a run anywhere gives the same
 * answer. The rule throughout: an answer only when the sentence is clear,
 * and `undefined` otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseUsageLimitReset, resumesAtFor, autoContinueEnabled } from "../dist/usageLimitReset.js";

const at = (iso) => new Date(iso);
const utc = (iso) => Date.parse(iso);

test("the wording Claude Code uses today, with a zone in brackets", () => {
  // 13:00 in Nicosia (UTC+3 in October, before the clocks change).
  const now = at("2026-10-08T10:00:00Z");
  assert.equal(parseUsageLimitReset("You've hit your limit · resets 4:30pm (Asia/Nicosia)", now), utc("2026-10-08T13:30:00Z"));
  assert.equal(parseUsageLimitReset("5-hour limit reached ∙ resets 4pm (Asia/Nicosia)", now), utc("2026-10-08T13:00:00Z"));
});

test("older and looser wordings", () => {
  // 11:00 in New York (UTC-4).
  const now = at("2026-10-08T15:00:00Z");
  const fourPm = utc("2026-10-08T20:00:00Z");
  for (const text of [
    "Claude usage limit reached. Your limit will reset at 4pm (America/New_York).",
    "resets 4:00 PM (America/New_York)",
    "Resets 4 p.m. (America/New_York)",
    "resets at 4pm (America/New_York)",
    "Session limit reached ∙ resets 16:00 (America/New_York)"
  ]) {
    assert.equal(parseUsageLimitReset(text, now), fourPm, text);
  }
});

test("12am is midnight and 12pm is noon", () => {
  assert.equal(parseUsageLimitReset("resets 12pm (UTC)", at("2026-10-08T09:00:00Z")), utc("2026-10-08T12:00:00Z"));
  assert.equal(parseUsageLimitReset("resets 12:15am (UTC)", at("2026-10-08T21:00:00Z")), utc("2026-10-09T00:15:00Z"));
});

test("a time already gone today is tomorrow", () => {
  // 17:00 in Nicosia, so 4:30pm has passed.
  const now = at("2026-10-08T14:00:00Z");
  assert.equal(parseUsageLimitReset("resets 4:30pm (Asia/Nicosia)", now), utc("2026-10-09T13:30:00Z"));
  // 23:00 in Nicosia; 1am is two hours away, across midnight.
  assert.equal(parseUsageLimitReset("resets 1am (Asia/Nicosia)", at("2026-10-08T20:00:00Z")), utc("2026-10-08T22:00:00Z"));
});

test("zones with half-hour offsets, no daylight saving, and the far side of the date line", () => {
  // 18:30 in Kolkata (UTC+5:30).
  assert.equal(parseUsageLimitReset("resets 9:30pm (Asia/Kolkata)", at("2026-10-08T13:00:00Z")), utc("2026-10-08T16:00:00Z"));
  // 09:00 on the 9th in Auckland (UTC+13 in October).
  assert.equal(parseUsageLimitReset("resets 11am (Pacific/Auckland)", at("2026-10-08T20:00:00Z")), utc("2026-10-08T22:00:00Z"));
  // 10:00 on the 8th in Honolulu (UTC-10).
  assert.equal(parseUsageLimitReset("resets 2pm (Pacific/Honolulu)", at("2026-10-08T20:00:00Z")), utc("2026-10-09T00:00:00Z"));
});

test("a reset on the far side of a daylight-saving change lands on the new offset", () => {
  // London leaves BST at 02:00 on 25 October 2026. 00:30 BST, so 3am is GMT.
  assert.equal(parseUsageLimitReset("resets 3am (Europe/London)", at("2026-10-24T23:30:00Z")), utc("2026-10-25T03:00:00Z"));
  // Sydney starts daylight saving on 4 October 2026. 01:00 AEST, so 5am is AEDT.
  assert.equal(parseUsageLimitReset("resets 5am (Australia/Sydney)", at("2026-10-03T15:00:00Z")), utc("2026-10-03T18:00:00Z"));
});

test("without a zone, the time is this machine's", () => {
  // 13:00 in Brisbane (UTC+10).
  assert.equal(parseUsageLimitReset("resets 5pm", at("2026-10-08T03:00:00Z"), "Australia/Brisbane"), utc("2026-10-08T07:00:00Z"));
});

test("a date in the sentence is read, and a weekly reset is then too far away", () => {
  const now = at("2026-10-08T10:00:00Z");
  const weekly = "Weekly limit reached ∙ resets Oct 9, 4pm (Asia/Nicosia)";
  assert.equal(parseUsageLimitReset(weekly, now), utc("2026-10-09T13:00:00Z"));
  assert.equal(resumesAtFor(weekly, now), undefined);
  assert.equal(parseUsageLimitReset("resets October 8 at 4pm (Asia/Nicosia)", now), utc("2026-10-08T13:00:00Z"));
  // A date already gone this year is next year.
  assert.equal(parseUsageLimitReset("resets Jan 2, 9am (UTC)", now), utc("2027-01-02T09:00:00Z"));
});

test("the older pipe form carries the epoch itself", () => {
  const now = at("2026-10-08T10:00:00Z");
  const inThreeHours = Math.floor(utc("2026-10-08T13:00:00Z") / 1000);
  assert.equal(parseUsageLimitReset(`Claude AI usage limit reached|${inThreeHours}`, now), inThreeHours * 1000);
  assert.equal(resumesAtFor(`Claude AI usage limit reached|${inThreeHours}`, now), inThreeHours);
});

test("anything unclear is no answer", () => {
  const now = at("2026-10-08T10:00:00Z");
  for (const text of [
    "API Error: Rate limit reached",
    "resets Thu 4pm (UTC)",
    "resets tomorrow at 4pm",
    "resets 4 (UTC)",
    "resets 13pm (UTC)",
    "resets 0am (UTC)",
    "resets 4:75pm (UTC)",
    "resets 25:00 (UTC)",
    "resets 4pm (Mars/Olympus_Mons)",
    "resets Feb 31, 4pm (UTC)",
    "resets Octopus 9, 4pm (UTC)",
    ""
  ]) {
    assert.equal(parseUsageLimitReset(text, now), undefined, text);
  }
  assert.equal(resumesAtFor(undefined, now), undefined);
});

test("resumesAt is epoch seconds on the minute, and only within six hours", () => {
  const now = at("2026-10-08T10:00:00Z");
  assert.equal(resumesAtFor("resets 2:30pm (UTC)", now), utc("2026-10-08T14:30:00Z") / 1000);
  assert.equal(resumesAtFor("resets 4:00pm (UTC)", now), utc("2026-10-08T16:00:00Z") / 1000, "exactly six hours is in");
  assert.equal(resumesAtFor("resets 4:01pm (UTC)", now), undefined, "a minute past six hours is out");
  // A time earlier today rolls to tomorrow, which is then too far.
  assert.equal(resumesAtFor("resets 9am (UTC)", now), undefined);
  const piped = Math.floor(utc("2026-10-08T12:00:30Z") / 1000);
  assert.equal(resumesAtFor(`usage limit reached|${piped}`, now) % 60, 0);
});

function settingsTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-autocontinue-"));
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const paths = {
    managed: path.join(root, "managed-settings.json"),
    local: path.join(projectDir, ".claude", "settings.local.json"),
    project: path.join(projectDir, ".claude", "settings.json"),
    user: path.join(home, ".claude", "settings.json")
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(paths[name]), { recursive: true });
    fs.writeFileSync(paths[name], typeof content === "string" ? content : JSON.stringify(content));
  }
  return { sources: { managedPath: paths.managed, projectDir, home }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("auto-continue follows Claude Code's precedence: managed, project-local, project, user", () => {
  const on = { autoContinueAtUsageLimit: true };
  const off = { autoContinueAtUsageLimit: false };
  const cases = [
    [{}, false],
    [{ user: on }, true],
    [{ user: on, project: off }, false],
    [{ user: off, project: on }, true],
    [{ project: on, local: off }, false],
    [{ project: off, local: on }, true],
    [{ local: on, managed: off }, false],
    [{ user: off, managed: on }, true],
    // A file without the key says nothing, so the next one down decides.
    [{ managed: { model: "opus" }, local: {}, user: on }, true],
    // Only a literal true counts.
    [{ user: { autoContinueAtUsageLimit: "true" } }, false],
    // A broken file is skipped, not read as off.
    [{ project: "{ not json", user: on }, true]
  ];
  for (const [files, expected] of cases) {
    const tree = settingsTree(files);
    assert.equal(autoContinueEnabled(tree.sources), expected, JSON.stringify(files));
    tree.cleanup();
  }
});

test("with no project, only managed and user settings are read", () => {
  const tree = settingsTree({ user: { autoContinueAtUsageLimit: true } });
  assert.equal(autoContinueEnabled({ ...tree.sources, projectDir: undefined }), true);
  tree.cleanup();
});
