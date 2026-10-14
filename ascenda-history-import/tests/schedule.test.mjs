/**
 * The recurring-import job: generated files against golden copies, the
 * retention guard, and install/remove/status against a scratch home with the
 * scheduler stubbed out. Nothing here touches launchd, systemd or a crontab.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRetention, installSchedule, launchdPlist, parseInterval, removeSchedule, scheduleFiles,
  scheduleStatus, scheduledCommand, schtasksCommand, systemdService, systemdTimer, DEFAULT_INTERVAL_DAYS
} from "../dist/schedule.js";

const golden = (name) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", name), "utf8");
const command = { argv: ["/usr/local/bin/node", "/opt/ascenda/dist/cli.js", "import", "--ship"], env: { ASCENDA_HOME: "/Users/dev/.ascenda" } };

test("launchd plist matches the golden file", () => {
  const text = launchdPlist({ command, everyDays: 14, logFile: "/Users/dev/.ascenda/logs/history-import.log", pathEnv: "/usr/local/bin:/usr/bin:/bin" });
  assert.equal(text, golden("history-import.plist"));
});

test("systemd service and timer match the golden files", () => {
  assert.equal(systemdService({ command, logFile: "/home/dev/.ascenda/logs/history-import.log" }), golden("ascenda-history-import.service"));
  assert.equal(systemdTimer({ everyDays: 14 }), golden("ascenda-history-import.timer"));
});

test("windows gets a schtasks command, quoted", () => {
  const text = schtasksCommand({ argv: ["C:\\Program Files\\nodejs\\node.exe", "C:\\x\\cli.js", "import", "--ship"], env: {} }, 14);
  assert.equal(text, golden("schtasks.txt").trim());
});

test("the default is two weeks", () => assert.equal(DEFAULT_INTERVAL_DAYS, 14));

test("intervals are whole days in range", () => {
  assert.equal(parseInterval("14d"), 14);
  assert.equal(parseInterval("7"), 7);
  for (const bad of ["0", "91", "1.5d", "2w", "", "abc"]) assert.throws(() => parseInterval(bad), /--every/, bad);
});

test("retention guard: unset keeps a 14-day schedule, refuses 30 and 21", () => {
  const unset = { currentCleanupPeriodDays: null };
  assert.equal(checkRetention(unset, 14).ok, true);
  for (const days of [21, 30]) {
    const verdict = checkRetention(unset, days);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /30 days \(the default\)/);
    assert.match(verdict.reason, /fix-retention --apply/);
  }
});

test("retention guard: a fixed cleanupPeriodDays admits every interval it covers twice", () => {
  assert.equal(checkRetention({ currentCleanupPeriodDays: 3650 }, 30).ok, true);
  assert.equal(checkRetention({ currentCleanupPeriodDays: 28 }, 14).ok, true);
  assert.equal(checkRetention({ currentCleanupPeriodDays: 20 }, 14).ok, false);
  assert.equal(checkRetention({ currentCleanupPeriodDays: 14 }, 14).ok, false);
});

test("a copy in npx's cache runs through npx instead", () => {
  const cmd = scheduledCommand("/Users/dev/.npm/_npx/abc/node_modules/.bin/ascenda-history-import", "/usr/local/bin/node", {});
  assert.deepEqual(cmd.argv, ["/usr/local/bin/npx", "-y", "@ascenda-one/history-import", "import", "--ship"]);
});

test("the job pins ASCENDA_HOME only when it is set", () => {
  assert.deepEqual(scheduledCommand("/x/cli.js", "/n/node", {}).env, {});
  assert.deepEqual(scheduledCommand("/x/cli.js", "/n/node", { ASCENDA_HOME: "/h" }).env, { ASCENDA_HOME: "/h" });
});

function scratch(platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-sched-"));
  const calls = [];
  return { home, calls, env: { platform, home, uid: 501, run: async (argv) => { calls.push(argv.join(" ")); return { code: 0, stdout: "" }; } } };
}

test("macOS install writes the plist under the scratch home and loads it", async () => {
  const { home, calls, env } = scratch("darwin");
  try {
    const result = await installSchedule(env, { everyDays: 14, command, pathEnv: "/usr/bin" });
    const [plist] = scheduleFiles(env).files;
    assert.equal(plist.startsWith(home), true);
    assert.deepEqual(result.written, [plist]);
    assert.match(fs.readFileSync(plist, "utf8"), /<integer>1209600<\/integer>/);
    assert.deepEqual(calls, [`launchctl bootout gui/501/one.ascenda.history-import`, `launchctl bootstrap gui/501 ${plist}`]);
    const status = await scheduleStatus(env);
    assert.deepEqual([status.installed, status.everyDays, status.active], [true, 14, true]);
    const removed = await removeSchedule(env);
    assert.deepEqual(removed.removed, [plist]);
    assert.equal((await scheduleStatus(env)).installed, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Linux install writes both units and enables the timer", async () => {
  const { home, calls, env } = scratch("linux");
  try {
    await installSchedule(env, { everyDays: 14, command });
    const [service, timer] = scheduleFiles(env).files;
    assert.equal(fs.existsSync(service) && fs.existsSync(timer), true);
    assert.equal(calls.at(-1), "systemctl --user enable --now ascenda-history-import.timer");
    assert.equal((await scheduleStatus(env)).everyDays, 14);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Windows install writes nothing and returns the command", async () => {
  const { home, calls, env } = scratch("win32");
  try {
    const result = await installSchedule(env, { everyDays: 14, command });
    assert.deepEqual(result.written, []);
    assert.match(result.printed, /^schtasks \/Create/);
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
