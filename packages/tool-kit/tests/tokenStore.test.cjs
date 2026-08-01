const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { defaultTokenFilePath, persistEventWriteToken, readTokenFile } = require("../out/index.js");

test("persist and read round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-test-"));
  const file = path.join(dir, "nested", "token");
  persistEventWriteToken(file, "tok_abc");
  assert.equal(readTokenFile(file), "tok_abc");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("persist tightens permissions on a token file that already exists", { skip: process.platform === "win32" ? "POSIX permissions" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-test-"));
  const tokens = path.join(dir, "tokens");
  // Simulate the pre-fix state: a world-readable token file and directory.
  fs.mkdirSync(tokens, { mode: 0o755 });
  const file = path.join(tokens, "tok");
  fs.writeFileSync(file, "old", { mode: 0o644 });

  persistEventWriteToken(file, "tok_rotated");

  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "token file must end up owner-only");
  assert.equal(fs.statSync(tokens).mode & 0o777, 0o700, "token directory must end up owner-only");
  assert.equal(readTokenFile(file), "tok_rotated");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("persist creates a fresh token file owner-only", { skip: process.platform === "win32" ? "POSIX permissions" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-test-"));
  const file = path.join(dir, "tokens", "tok");
  persistEventWriteToken(file, "tok_new");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTokenFile: missing or empty file is undefined", () => {
  assert.equal(readTokenFile(path.join(os.tmpdir(), "ascenda-nope", "missing")), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-test-"));
  const empty = path.join(dir, "empty");
  fs.writeFileSync(empty, "  \n");
  assert.equal(readTokenFile(empty), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("defaultTokenFilePath lives under ~/.ascenda/tokens and sanitises the id", () => {
  const p = defaultTokenFilePath("claude_code:abc-123");
  assert.ok(p.includes(path.join(".ascenda", "tokens")));
  assert.equal(path.basename(p), "claude_code_abc-123");
  const evil = defaultTokenFilePath("weird/../id with spaces");
  assert.ok(!path.basename(evil).includes("/"));
  assert.ok(!path.basename(evil).includes(" "));
});

test("defaultTokenFilePath: no Windows-illegal character survives sanitising", () => {
  // On Windows these either fail the write or, for `:`, silently create an NTFS
  // alternate data stream — a token that can never be read back.
  const illegal = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
  const name = path.basename(defaultTokenFilePath(`a${illegal.join("")}b`));
  for (const ch of illegal) assert.ok(!name.includes(ch), `sanitised name still contains ${ch}`);
  assert.equal(name, "a_________b");
});
