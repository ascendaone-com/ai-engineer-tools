const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readOrCreateMachineSalt, hashWithMachineSalt, machineSaltFilePath } = require("../out/index.js");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-salt-")), "salt");

test("the salt is created once and reused", () => {
  const p = tmp();
  const first = readOrCreateMachineSalt(p);
  assert.equal(first.length, 64, "32 random bytes, hex");
  assert.equal(fs.readFileSync(p, "utf8"), first, "persisted verbatim");
  assert.equal(readOrCreateMachineSalt(p), first, "a second call must not rotate it");
});

test("an existing salt file is adopted, never overwritten", () => {
  // The write uses the `wx` flag precisely so a producer that loses the race
  // adopts the winner's salt. Two salts would split one workspace in two.
  const p = tmp();
  fs.writeFileSync(p, "a".repeat(64));
  assert.equal(readOrCreateMachineSalt(p), "a".repeat(64));
  assert.equal(fs.readFileSync(p, "utf8"), "a".repeat(64));
});

test("hashing is stable under one salt and unrelated across salts", () => {
  const a = tmp();
  const b = tmp();
  const underA = hashWithMachineSalt("ai-engineer-tools", a);
  assert.equal(hashWithMachineSalt("ai-engineer-tools", a), underA, "stable for the same machine");
  assert.notEqual(hashWithMachineSalt("ai-engineer-tools", b), underA, "not comparable across machines");
});

test("the digest is not the unsalted digest — the whole point", () => {
  // Guards the regression this fixes: a plain sha256 of a folder name is
  // recoverable from a dictionary of repository names.
  const unsalted = require("node:crypto").createHash("sha256").update("ai-engineer-tools").digest("hex").slice(0, 16);
  assert.notEqual(hashWithMachineSalt("ai-engineer-tools", tmp()), unsalted);
});

test("the salt never appears in the value that gets sent", () => {
  const p = tmp();
  const salt = readOrCreateMachineSalt(p);
  const hash = hashWithMachineSalt("ai-engineer-tools", p);
  assert.equal(hash.length, 16);
  assert.ok(!salt.includes(hash), "hash is not a slice of the salt");
  assert.ok(!hash.includes(salt), "salt does not leak into the hash");
});

test("empty input stays null so optional fields pass through", () => {
  const p = tmp();
  for (const v of [undefined, null, ""]) assert.equal(hashWithMachineSalt(v, p), null);
});

test("the salt file is owner-only", { skip: process.platform === "win32" ? "POSIX permissions" : false }, () => {
  const p = tmp();
  readOrCreateMachineSalt(p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
});

test("the default location is ~/.ascenda/salt", () => {
  assert.equal(machineSaltFilePath(), path.join(os.homedir(), ".ascenda", "salt"));
});
