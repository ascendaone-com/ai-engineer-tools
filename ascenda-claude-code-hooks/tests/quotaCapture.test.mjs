/**
 * The opt-in status line quota capture: reading rate_limits out of the
 * status line input, wrapping and restoring a user's status line, and the
 * hold's reset time preferring the reported number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { quotaFromStatusline, recordQuota, readQuota, resumesAtFromQuota } = await import("../dist/quotaSnapshot.js");
const { wrapStatusLine, unwrapStatusLine } = await import("../dist/setup.js");
const { statuslineChainPath } = await import("../dist/statusline.js");

const BINARY = "/home/dev/.ascenda/bin/ascenda-claude-hook";
const NOW = new Date("2026-11-17T10:00:00Z");
const sec = (iso) => Date.parse(iso) / 1000;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-quota-"));
}
function settingsWith(contents) {
  const file = path.join(tmp(), "settings.json");
  if (contents !== undefined) fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("reads both windows from the documented shape", () => {
  const snapshot = quotaFromStatusline({
    model: { display_name: "x" },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      spend_limit: { used_percentage: 62.8, resets_at: 1740787200 }
    }
  }, NOW);
  assert.deepEqual(snapshot, {
    capturedAt: NOW.getTime() / 1000,
    fiveHour: { usedPercentage: 23.5, resetsAt: 1738425600 },
    sevenDay: { usedPercentage: 41.2, resetsAt: 1738857600 }
  });
});

test("a missing object, a missing window or a bad field gives only what is sound", () => {
  assert.equal(quotaFromStatusline({}, NOW), undefined);
  assert.equal(quotaFromStatusline({ rate_limits: {} }, NOW), undefined);
  assert.equal(quotaFromStatusline(null, NOW), undefined);
  const half = quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 100 }, seven_day: { used_percentage: "9" , resets_at: 5 } } }, NOW);
  assert.deepEqual(half.fiveHour, { usedPercentage: 10, resetsAt: 100 });
  assert.equal(half.sevenDay, undefined);
});

test("records, skips an unchanged reading inside a minute, rewrites a changed one", () => {
  const file = path.join(tmp(), "q.json");
  const a = { capturedAt: 1000, fiveHour: { usedPercentage: 10, resetsAt: 9000 } };
  assert.equal(recordQuota(a, file), true);
  assert.equal(recordQuota({ ...a, capturedAt: 1030 }, file), false);
  assert.equal(recordQuota({ ...a, capturedAt: 1100 }, file), true);
  assert.equal(recordQuota({ capturedAt: 1101, fiveHour: { usedPercentage: 11, resetsAt: 9000 } }, file), true);
  assert.equal(readQuota(file).fiveHour.usedPercentage, 11);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the hold uses the exhausted window's reset, and only inside six hours", () => {
  const soon = sec("2026-11-17T13:00:00Z");
  const weekly = sec("2026-11-20T13:00:00Z");
  const snap = (five, seven) => ({ capturedAt: 0, ...(five ? { fiveHour: five } : {}), ...(seven ? { sevenDay: seven } : {}) });
  assert.equal(resumesAtFromQuota(snap({ usedPercentage: 100, resetsAt: soon }, { usedPercentage: 40, resetsAt: weekly }), NOW), soon);
  // A window short of 100% didn't stop the session.
  assert.equal(resumesAtFromQuota(snap({ usedPercentage: 97, resetsAt: soon }), NOW), undefined);
  // A reset already past is not a hold.
  assert.equal(resumesAtFromQuota(snap({ usedPercentage: 100, resetsAt: sec("2026-11-17T09:00:00Z") }), NOW), undefined);
  // The weekly window being out means the latest reset governs, which is past the ceiling.
  assert.equal(resumesAtFromQuota(snap({ usedPercentage: 100, resetsAt: soon }, { usedPercentage: 100, resetsAt: weekly }), NOW), undefined);
  assert.equal(resumesAtFromQuota(undefined, NOW), undefined);
});

test("wrapping keeps the user's status line and its other keys, and unwrapping restores it", () => {
  const original = { type: "command", command: "~/.claude/statusline.sh", padding: 2 };
  const file = settingsWith({ model: "x", statusLine: original });
  const message = wrapStatusLine(file, BINARY, false);
  assert.match(message, /wrapped your status line/);
  const wrapped = read(file);
  assert.equal(wrapped.model, "x");
  assert.equal(wrapped.statusLine.padding, 2);
  assert.match(wrapped.statusLine.command, /ascenda-claude-hook" statusline$/);
  assert.deepEqual(read(statuslineChainPath()), original);
  assert.deepEqual(read(`${file}.ascenda-backup`).statusLine, original);

  // Running again neither re-wraps nor overwrites the saved original.
  assert.equal(wrapStatusLine(file, BINARY, false), "status line already wrapped");
  assert.deepEqual(read(statuslineChainPath()), original);

  assert.match(unwrapStatusLine(file, false), /put your own status line back/);
  assert.deepEqual(read(file).statusLine, original);
  assert.equal(fs.existsSync(statuslineChainPath()), false);
});

test("with no status line, wrapping adds one and unwrapping removes it", () => {
  const file = settingsWith({ model: "x" });
  assert.match(wrapStatusLine(file, BINARY, false), /prints nothing/);
  assert.ok(read(file).statusLine.command.endsWith(" statusline"));
  assert.match(unwrapStatusLine(file, false), /you had no status line/);
  assert.equal("statusLine" in read(file), false);
});

test("a dry run writes nothing, and a settings file that isn't JSON is refused", () => {
  const original = { type: "command", command: "echo hi" };
  const file = settingsWith({ statusLine: original });
  wrapStatusLine(file, BINARY, true);
  assert.deepEqual(read(file).statusLine, original);
  assert.equal(fs.existsSync(`${file}.ascenda-backup`), false);

  const broken = path.join(tmp(), "settings.json");
  fs.writeFileSync(broken, "{nope");
  const realError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(wrapStatusLine(broken, BINARY, false), null);
  } finally {
    console.error = realError;
  }
  assert.equal(fs.readFileSync(broken, "utf8"), "{nope");
});

test("the wrapper records the quota and passes the previous status line's output through", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".ascenda"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".ascenda", "claude-statusline-chain.json"),
    JSON.stringify({ type: "command", command: "cat >/dev/null; echo from-the-old-line" })
  );
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 4102444800 } } });
  const run = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "statusline"], {
    input, encoding: "utf8", env: { ...process.env, HOME: home, ASCENDA_HOME: path.join(home, ".ascenda") }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "from-the-old-line");
  const stored = readQuota(path.join(home, ".ascenda", "claude-quota.json"));
  assert.equal(stored.fiveHour.usedPercentage, 100);
});
