import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ourHookPositions, trustProblemLines, writeHookSettings } from "@ascenda-one/tool-kit";
import { checkCodexHookTrust, parseApprovalKeys } from "../dist/hookTrust.js";
import { HOOK_EVENTS, SETUP } from "../dist/setup.js";

// Codex skips a hook with no approval in config.toml and says nothing, so a
// hook-set signal from the hooks themselves can never see it. These pin the
// reading of those approvals.

const BINARY = "/home/dev/.ascenda/bin/ascenda-codex-hook";

function install() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-codex-trust-"));
  const hooksFile = SETUP.settings.settingsPath("project", dir);
  writeHookSettings(hooksFile, BINARY, SETUP, false);
  const settings = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  return { dir, hooksFile, settings, configFile: path.join(path.dirname(hooksFile), "config.toml") };
}

const keyFor = (file, event) => `${file}:${event}:0:0`;

test("reads double-quoted and single-quoted approval keys, including a Windows path with its own colon", () => {
  const keys = parseApprovalKeys([
    '[hooks.state."/home/dev/.codex/hooks.json:pre_tool_use:0:0"]',
    "trusted_hash = \"abc\"",
    "[hooks.state.'C:\\Users\\Jo Doe\\.codex\\hooks.json:session_start:0:1']",
    '[hooks.state."C:\\\\Users\\\\Jo\\\\.codex\\\\hooks.json:stop:2:0"]',
    "[hooks.state.\"not-a-hook-key\"]",
    "[projects.\"/x\"]"
  ].join("\n"));
  assert.deepEqual(keys, [
    { file: "/home/dev/.codex/hooks.json", event: "pre_tool_use", group: 0, handler: 0 },
    { file: "C:\\Users\\Jo Doe\\.codex\\hooks.json", event: "session_start", group: 0, handler: 1 },
    { file: "C:\\Users\\Jo\\.codex\\hooks.json", event: "stop", group: 2, handler: 0 }
  ]);
});

test("every hook approved: no problem lines", () => {
  const { dir, hooksFile, settings, configFile } = install();
  fs.writeFileSync(configFile, HOOK_EVENTS.map((event) => `[hooks.state."${keyFor(hooksFile, event)}"]\ntrusted_hash = "x"\n`).join("\n"));
  // Approvals recorded after the hooks file was written.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(configFile, later, later);
  assert.equal(ourHookPositions(settings, SETUP).length, HOOK_EVENTS.length);
  assert.deepEqual(trustProblemLines(SETUP, hooksFile, settings, ""), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no config.toml: every hook is untrusted and the fix is named", () => {
  const { dir, hooksFile, settings } = install();
  const lines = trustProblemLines(SETUP, hooksFile, settings, "");
  assert.match(lines[0], new RegExp(`${HOOK_EVENTS.length} of ${HOOK_EVENTS.length} hooks are not approved`));
  assert.match(lines[0], /skips them without a message/);
  assert.match(lines.at(-1), /open \/hooks.*approve the Ascenda hooks/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("one missing approval names just that event", () => {
  const { dir, hooksFile, settings, configFile } = install();
  const approved = HOOK_EVENTS.filter((event) => event !== "SessionEnd");
  fs.writeFileSync(configFile, approved.map((event) => `[hooks.state.'${keyFor(hooksFile, event)}']\n`).join(""));
  const report = checkCodexHookTrust(hooksFile, ourHookPositions(settings, SETUP));
  assert.deepEqual(report.untrusted.map((position) => position.event), ["SessionEnd"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an approval whose position no longer holds our hook is reported as stale", () => {
  const { dir, hooksFile, settings, configFile } = install();
  const all = HOOK_EVENTS.map((event) => `[hooks.state."${keyFor(hooksFile, event)}"]\n`).join("");
  fs.writeFileSync(configFile, `${all}[hooks.state."${hooksFile}:stop:3:0"]\n`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(configFile, later, later);
  const report = checkCodexHookTrust(hooksFile, ourHookPositions(settings, SETUP));
  assert.equal(report.untrusted.length, 0);
  assert.equal(report.stale.length, 1);
  assert.match(report.stale[0], /stop \(group 3, handler 0\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hooks file newer than the approvals is flagged as possibly needing re-approval", () => {
  const { dir, hooksFile, settings, configFile } = install();
  fs.writeFileSync(configFile, HOOK_EVENTS.map((event) => `[hooks.state."${keyFor(hooksFile, event)}"]\n`).join(""));
  const earlier = new Date(Date.now() - 60_000);
  fs.utimesSync(configFile, earlier, earlier);
  const report = checkCodexHookTrust(hooksFile, ourHookPositions(settings, SETUP));
  assert.equal(report.untrusted.length, 0);
  assert.match(report.stale[0], /changed after the last approval/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("approvals for some other hooks file don't count", () => {
  const { dir, hooksFile, settings, configFile } = install();
  fs.writeFileSync(configFile, HOOK_EVENTS.map((event) => `[hooks.state."/elsewhere/.codex/hooks.json:${event}:0:0"]\n`).join(""));
  const report = checkCodexHookTrust(hooksFile, ourHookPositions(settings, SETUP));
  assert.equal(report.untrusted.length, HOOK_EVENTS.length);
  fs.rmSync(dir, { recursive: true, force: true });
});
