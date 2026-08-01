const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyCommand, isVerificationCommand } = require("../out/index.js");

test("classifyCommand: test runners", () => {
  for (const cmd of ["npm test", "npm run test", "yarn test", "pnpm test", "jest", "vitest", "pytest -k auth", "go test ./...", "cargo test", "dotnet test"]) {
    assert.equal(classifyCommand(cmd), "test", cmd);
  }
});

test("classifyCommand: lint / typecheck / build", () => {
  assert.equal(classifyCommand("npm run lint"), "lint");
  assert.equal(classifyCommand("eslint . --fix"), "lint");
  assert.equal(classifyCommand("ruff check src"), "lint");
  assert.equal(classifyCommand("tsc -p ./"), "typecheck");
  assert.equal(classifyCommand("mypy app"), "typecheck");
  assert.equal(classifyCommand("npm run build"), "build");
  assert.equal(classifyCommand("next build"), "build");
  assert.equal(classifyCommand("cargo build --release"), "build");
});

test("classifyCommand: git / install / run", () => {
  assert.equal(classifyCommand("git status"), "git");
  assert.equal(classifyCommand("npm install"), "install");
  assert.equal(classifyCommand("pip install requests"), "install");
  assert.equal(classifyCommand("npm run dev"), "run");
  assert.equal(classifyCommand("node server.js"), "run");
});

test("classifyCommand: unknown and empty input", () => {
  assert.equal(classifyCommand("ls -la"), "unknown");
  assert.equal(classifyCommand(""), "unknown");
  assert.equal(classifyCommand(null), "unknown");
  assert.equal(classifyCommand(undefined), "unknown");
});

test("isVerificationCommand: verification classes only", () => {
  for (const cls of ["test", "lint", "typecheck", "build"]) assert.equal(isVerificationCommand(cls), true, cls);
  for (const cls of ["run", "git", "install", "unknown"]) assert.equal(isVerificationCommand(cls), false, cls);
});
