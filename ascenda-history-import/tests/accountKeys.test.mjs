import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveAccountKey } from "@ascenda-one/tool-kit";
import { accountKeysFor, writeAccountKeys, readAccountKeys } from "../dist/accountKeys.js";
import { claudeConfigDirsOf } from "../dist/stores.js";

function profile(home, name, sessions) {
  const dir = path.join(home, name);
  const slug = path.join(dir, "projects", "-proj");
  fs.mkdirSync(slug, { recursive: true });
  for (const id of sessions) fs.writeFileSync(path.join(slug, `${id}.jsonl`), "");
  return { configDir: dir, projectsDir: path.join(dir, "projects") };
}

test("each session is keyed by the profile it came from", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-acct-imp-"));
  const a = profile(home, ".claude", ["s-a"]);
  const b = profile(home, ".claude-work", ["s-b"]);
  const keys = accountKeysFor([a, b], home, {});
  assert.equal(keys["s-a"], deriveAccountKey(a.configDir, home, {}));
  assert.equal(keys["s-b"], deriveAccountKey(b.configDir, home, {}));
  assert.notEqual(keys["s-a"], keys["s-b"]);
});

test("a session id under two profiles keeps the first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-acct-imp-"));
  const a = profile(home, ".claude", ["same"]);
  const b = profile(home, ".claude-work", ["same"]);
  assert.equal(accountKeysFor([a, b], home, {}).same, deriveAccountKey(a.configDir, home, {}));
});

test("the sidecar round-trips and a missing one reads empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-acct-side-"));
  assert.deepEqual(await readAccountKeys(dir), {});
  await writeAccountKeys(dir, { x: "abc" });
  assert.deepEqual(await readAccountKeys(dir), { x: "abc" });
});

test("extra ~/.claude-* profiles with a projects dir are found, with or without CLAUDE_CONFIG_DIR", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-acct-disc-"));
  profile(home, ".claude-work", []);
  fs.mkdirSync(path.join(home, ".claude-backup"));
  const unset = claudeConfigDirsOf(home, {}).map((d) => d.configDir);
  assert.deepEqual(unset, [path.join(home, ".claude"), path.join(home, ".claude-work")]);
  const custom = path.join(home, "elsewhere");
  const set = claudeConfigDirsOf(home, { CLAUDE_CONFIG_DIR: custom }).map((d) => d.configDir);
  assert.deepEqual(set, [custom, path.join(home, ".claude-work")]);
});
