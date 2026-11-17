const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deriveAccountKey, readPlanTier, extraClaudeProfileDirs } = require("../out/index.js");

let root, salt, home;
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-acct-"));
  salt = path.join(root, "salt");
  home = path.join(root, "home");
  fs.mkdirSync(home);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("two folders give two keys, one folder gives the same key twice", () => {
  const a = deriveAccountKey(path.join(home, ".claude"), home, {}, salt);
  const b = deriveAccountKey(path.join(home, ".claude-work"), home, {}, salt);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
  assert.equal(a, deriveAccountKey(path.join(home, ".claude"), home, {}, salt));
});

test("a plan change gives the folder a new key", () => {
  const dir = path.join(home, ".claude-plan");
  write(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" } }));
  const before = deriveAccountKey(dir, home, {}, salt);
  write(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } }));
  assert.notEqual(before, deriveAccountKey(dir, home, {}, salt));
});

test("only the tier is read: email and token never move the key", () => {
  const dir = path.join(home, ".claude-secret");
  const body = (email, token) => JSON.stringify({ oauthAccount: { organizationRateLimitTier: "t1", emailAddress: email, accessToken: token } });
  write(path.join(dir, ".claude.json"), body("a@example.com", "tok-1"));
  const one = deriveAccountKey(dir, home, {}, salt);
  write(path.join(dir, ".claude.json"), body("b@example.com", "tok-2"));
  assert.equal(one, deriveAccountKey(dir, home, {}, salt));
  assert.ok(!one.includes("example"));
  assert.equal(readPlanTier(dir, home, {}), "t1");
});

test("default folder reads ~/.claude.json; CLAUDE_CONFIG_DIR reads its own", () => {
  write(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "home-tier" } }));
  assert.equal(readPlanTier(path.join(home, ".claude"), home, {}), "home-tier");
  const custom = path.join(root, "custom");
  assert.equal(readPlanTier(custom, home, { CLAUDE_CONFIG_DIR: custom }), "");
});

test("an unreadable or malformed file still yields a key", () => {
  const dir = path.join(home, ".claude-bad");
  write(path.join(dir, ".claude.json"), "{not json");
  assert.ok(deriveAccountKey(dir, home, {}, salt));
});

test("extra profile discovery wants a projects dir and sorts", () => {
  const h = path.join(root, "disc");
  fs.mkdirSync(path.join(h, ".claude-work", "projects"), { recursive: true });
  fs.mkdirSync(path.join(h, ".claude-alpha", "projects"), { recursive: true });
  fs.mkdirSync(path.join(h, ".claude-backup"), { recursive: true });
  assert.deepEqual(extraClaudeProfileDirs(h), [path.join(h, ".claude-alpha"), path.join(h, ".claude-work")]);
  assert.deepEqual(extraClaudeProfileDirs(path.join(root, "nope")), []);
});
