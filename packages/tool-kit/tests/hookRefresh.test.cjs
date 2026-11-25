// The refresh writes agents' settings files, so nothing here may resolve the
// real home folder: HOME and ASCENDA_HOME point at a throwaway directory
// before the module is loaded, and every settings file lives under it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-refresh-"));
process.env.HOME = SANDBOX;
process.env.ASCENDA_HOME = path.join(SANDBOX, ".ascenda");
delete process.env.ASCENDA_DISABLE_HOOK_REFRESH;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  HOOK_REFRESH_INTERVAL_MS,
  assessHookRegistrations,
  cliAgentRefreshAdapter,
  forgetHookRegistration,
  hookRefreshDisabled,
  hookRegistrationDoctorLines,
  hookRegistrationsPath,
  readHookRegistrations,
  readLastHookRefresh,
  readMachineCredentials,
  recordHookRegistration,
  refreshCliAgentHooks,
  refreshHookRegistrations,
  runCliAgentSetup,
  writeHookRefreshSetting,
  writeTopLevelCredentials
} = require("../out/index.js");

const NOW = Date.parse("2026-11-26T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const BIN = path.join(SANDBOX, ".ascenda", "bin", "ascenda-grouped-hook");

let counter = 0;
/** A grouped (Codex/Gemini-shaped) adapter whose hooks file is unique to the test. */
function fixture({ events = ["Start", "Fail", "Stop"], hookSet } = {}) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, "project-"));
  const host = `grouped${++counter}`;
  const file = path.join(dir, "hooks.json");
  const spec = {
    host, displayName: "Grouped", toolType: "cli_agent", packageName: "@ascenda-one/grouped-hooks",
    binaryName: "ascenda-grouped-hook", hookEvents: events, restartHint: "", sends: [],
    ...(hookSet !== undefined ? { hookSet } : {}),
    settings: {
      settingsPath: () => file,
      entry: (command, event) => ({ hooks: [{ type: "command", command: `${command} ${event}`, timeout: 5 }] }),
      grouped: true
    }
  };
  return { dir, file, spec, adapter: cliAgentRefreshAdapter(spec, dir) };
}

const ours = (event, set) => ({ hooks: [{ type: "command", command: `"${BIN}"${set ? ` --hook-set ${set}` : ""} ${event}`, timeout: 5 }] });
const theirs = { hooks: [{ type: "command", command: "/usr/local/bin/someone-elses-hook" }] };
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const commands = (settings, event) => (settings.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
const refresh = (adapter, extra = {}) => refreshHookRegistrations(adapter, { version: "0.1.50", now: NOW, force: true, env: {}, ...extra });

test("a registration from before an event was added gains it, and nobody else's hook moves", () => {
  const { file, adapter } = fixture();
  write(file, { model: "keep-me", hooks: { Start: [ours("Start"), theirs], Stop: [ours("Stop")] } });

  const result = refresh(adapter);

  assert.deepEqual(result, { kind: "checked", updated: [file], failed: [] });
  const after = read(file);
  assert.equal(after.model, "keep-me", "everything outside our hooks stays");
  assert.deepEqual(commands(after, "Fail"), [`"${BIN}" Fail`], "the missing event is registered");
  assert.ok(commands(after, "Start").includes("/usr/local/bin/someone-elses-hook"), "a hook the person added stays");
  assert.equal(commands(after, "Start").filter((command) => command.includes(BIN)).length, 1, "ours isn't doubled");
  const [record] = readHookRegistrations(adapter.tool);
  assert.equal(record.collectorVersion, "0.1.50", "the registration now names the release that wrote it");
  assert.equal(record.by, "refresh");
  assert.deepEqual(record.events, ["Start", "Fail", "Stop"]);
  assert.deepEqual(readLastHookRefresh(adapter.tool).updated, [file]);
});

test("a current registration is left byte for byte, and a second refresh changes nothing", () => {
  const { file, adapter } = fixture();
  write(file, { hooks: { Start: [ours("Start")], Stop: [ours("Stop")] } });
  refresh(adapter);
  const once = fs.readFileSync(file, "utf8");
  assert.deepEqual(refresh(adapter), { kind: "checked", updated: [], failed: [] });
  assert.equal(fs.readFileSync(file, "utf8"), once);
});

test("it runs at most once a day, and the stamp is taken before the work", () => {
  const { file, adapter } = fixture();
  write(file, { hooks: { Start: [ours("Start")] } });
  assert.equal(refresh(adapter, { force: false }).kind, "checked");
  // Back to a registration from before records, so the next check has work.
  // With the record kept, the missing events would read as taken out by hand.
  write(file, { hooks: { Start: [ours("Start")] } });
  forgetHookRegistration(adapter.tool);
  assert.deepEqual(refresh(adapter, { force: false, now: NOW + HOOK_REFRESH_INTERVAL_MS - 1 }), { kind: "not-due" });
  assert.equal(commands(read(file), "Fail").length, 0, "nothing was written inside the day");
  assert.equal(refresh(adapter, { force: false, now: NOW + DAY + 1 }).kind, "checked");
  assert.equal(commands(read(file), "Fail").length, 1);
});

test("an event a person took out of a recorded registration stays out", () => {
  const { file, adapter } = fixture();
  recordHookRegistration(adapter.tool, { settingsFile: file, scope: "project", collectorVersion: "0.1.40", events: ["Start", "Fail", "Stop"] });
  write(file, { hooks: { Start: [ours("Start")], Stop: [ours("Stop")] } });

  const [assessment] = assessHookRegistrations(adapter, "0.1.50");
  assert.deepEqual(assessment.removedByPerson, ["Fail"]);
  assert.deepEqual(assessment.toAdd, []);
  refresh(adapter);
  assert.equal(read(file).hooks.Fail, undefined, "the event the person removed isn't put back");
  assert.deepEqual(readHookRegistrations(adapter.tool)[0].events, ["Start", "Stop"]);
});

test("a recorded event list only adds what is new since it", () => {
  const { file, adapter } = fixture({ events: ["Start", "Fail", "Stop", "Wait"] });
  recordHookRegistration(adapter.tool, { settingsFile: file, scope: "project", collectorVersion: "0.1.40", events: ["Start", "Fail", "Stop"] });
  write(file, { hooks: { Start: [ours("Start")], Stop: [ours("Stop")] } });
  refresh(adapter);
  const after = read(file);
  assert.equal(commands(after, "Wait").length, 1, "the event this release added arrives");
  assert.equal(after.hooks.Fail, undefined, "the one the person removed doesn't");
});

test("a file holding none of our hooks is never written, recorded or not", () => {
  const { file, adapter } = fixture();
  recordHookRegistration(adapter.tool, { settingsFile: file, scope: "project", collectorVersion: "0.1.40", events: ["Start"] });
  write(file, { hooks: { Start: [theirs] } });
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(refresh(adapter), { kind: "checked", updated: [], failed: [] });
  assert.equal(fs.readFileSync(file, "utf8"), before, "removing every one of ours is an uninstall, and it holds");
});

test("a file that isn't JSON is left alone", () => {
  const { file, adapter } = fixture();
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(refresh(adapter), { kind: "checked", updated: [], failed: [] });
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("an older bundle never rewrites a registration a newer release wrote", () => {
  const { file, adapter } = fixture();
  recordHookRegistration(adapter.tool, { settingsFile: file, scope: "project", collectorVersion: "0.2.0", events: ["Start"] });
  write(file, { hooks: { Start: [ours("Start")] } });
  const before = fs.readFileSync(file, "utf8");
  refresh(adapter);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(readHookRegistrations(adapter.tool)[0].collectorVersion, "0.2.0");
});

test("a hook set behind this release is rewritten to the current one", () => {
  const { file, adapter } = fixture({ hookSet: 2 });
  write(file, { hooks: { Start: [ours("Start", 1)], Fail: [ours("Fail", 1)], Stop: [ours("Stop", 1)] } });
  refresh(adapter);
  for (const event of ["Start", "Fail", "Stop"]) {
    assert.deepEqual(commands(read(file), event), [`"${BIN}" --hook-set 2 ${event}`]);
  }
});

test("a build from a checkout doesn't refresh: it has no release to stamp", () => {
  const { file, adapter } = fixture();
  write(file, { hooks: { Start: [ours("Start")] } });
  assert.equal(refresh(adapter, { version: "unreleased" }).kind, "skipped");
  assert.equal(read(file).hooks.Fail, undefined);
});

test("the environment variable turns it off", () => {
  const { file, adapter } = fixture();
  write(file, { hooks: { Start: [ours("Start")] } });
  const result = refresh(adapter, { env: { ASCENDA_DISABLE_HOOK_REFRESH: "true" } });
  assert.equal(result.kind, "off");
  assert.match(result.reason, /ASCENDA_DISABLE_HOOK_REFRESH/);
  assert.equal(read(file).hooks.Fail, undefined);
});

test("setup --no-hook-refresh turns it off machine-wide, survives a re-pair, and --hook-refresh undoes it", () => {
  const { file, adapter } = fixture();
  write(file, { hooks: { Start: [ours("Start")] } });
  writeHookRefreshSetting(false);
  writeTopLevelCredentials({ toolInstallationId: "claude_code:x", pairedAt: "2026-11-26T00:00:00Z" });
  assert.equal(readMachineCredentials().hookRefresh, false, "Claude Code's own credentials write keeps the setting");
  assert.equal(hookRefreshDisabled({}), true);
  const result = refresh(adapter);
  assert.equal(result.kind, "off");
  assert.match(result.reason, /--no-hook-refresh/);
  writeHookRefreshSetting(true);
  assert.equal(readMachineCredentials().hookRefresh, undefined);
  assert.equal(refresh(adapter).kind, "checked");
});

test("the hook-path entry does nothing unless it's the bundle setup installed", () => {
  const { file, spec } = fixture();
  write(file, { hooks: { Start: [ours("Start")] } });
  assert.equal(refreshCliAgentHooks(spec, { script: path.join(SANDBOX, "node_modules", "x", "dist", "cli.js") }), undefined, "npx and a checkout never write a registration");
  assert.equal(read(file).hooks.Fail, undefined);
  const result = refreshCliAgentHooks(spec, { script: path.join(SANDBOX, ".ascenda", "bin", "ascenda-grouped-hook.mjs") });
  assert.ok(result, "the installed bundle runs the check");
});

test("doctor names the versions, what is missing, and why the refresh is off", () => {
  const { file, adapter } = fixture();
  recordHookRegistration(adapter.tool, { settingsFile: file, scope: "project", collectorVersion: "0.1.20", events: ["Start", "Stop"], registeredAt: new Date(NOW - 3 * DAY).toISOString() });
  write(file, { hooks: { Start: [ours("Start")], Stop: [ours("Stop")] } });

  const lines = hookRegistrationDoctorLines({ adapter, installedBundleVersion: "0.1.20", setupCommand: "npx -y @ascenda-one/grouped-hooks setup", now: NOW, version: "0.1.50", env: {} }).join("\n");
  assert.match(lines, /Installed bundle +0\.1\.20, older than this CLI \(0\.1\.50\)\. Update it with: npx -y @ascenda-one\/grouped-hooks setup/);
  assert.match(lines, /2\/3 events, written by 0\.1\.20 \(setup, 3 days ago\)/);
  assert.match(lines, /Missing: Fail/);
  assert.match(lines, /Daily refresh +on, once a day from the installed bundle \(not checked yet\)/);

  const off = hookRegistrationDoctorLines({ adapter, installedBundleVersion: "0.1.20", setupCommand: "npx -y @ascenda-one/grouped-hooks setup", now: NOW, version: "0.1.20", env: { ASCENDA_DISABLE_HOOK_REFRESH: "true" } }).join("\n");
  assert.match(off, /Installed bundle +0\.1\.20\n/, "no comparison when doctor is the installed release");
  assert.match(off, /Daily refresh +off \(ASCENDA_DISABLE_HOOK_REFRESH is set\)/);
});

test("setup records the registration it wrote, and uninstall forgets it", async () => {
  const { dir, file, spec } = fixture();
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await runCliAgentSetup(["setup", "--no-pair", "--project-dir", dir, "--api-base-url", "http://127.0.0.1:1"], spec), 0);
    const [record] = readHookRegistrations(spec.host);
    assert.equal(record.settingsFile, file);
    assert.equal(record.by, "setup");
    assert.deepEqual(record.events, spec.hookEvents);
    assert.ok(fs.existsSync(hookRegistrationsPath()));
    assert.ok(hookRegistrationsPath().startsWith(SANDBOX), "the record lives under the sandbox, never the real home");

    assert.equal(await runCliAgentSetup(["uninstall", "--project-dir", dir], spec), 0);
    assert.deepEqual(readHookRegistrations(spec.host), []);
  } finally {
    console.log = log;
  }
});

test("teardown", () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});
