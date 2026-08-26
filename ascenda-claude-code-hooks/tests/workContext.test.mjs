import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end against the built CLI: a hook invocation whose payload names a
// cwd must put context hashes on what it records, and must leave the labels
// in the local registry. This is the live-stream half of the project-identity
// groundwork — before it, every live Claude Code event went out with no
// workspace identity at all (the env var nobody sets), which is a gap no
// later feature can backfill.
//
// The unpaired+log path is used because it exercises the same
// buildEventPayload identity as a real send, without a network.
//
// HOME is a throwaway directory via tests/isolateHome.cjs, inherited by the
// spawned CLI, so the salt and registry these assertions read are test state.

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runHook(hookName, input, env = {}) {
  return spawnSync("node", [cliPath, hookName], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      ASCENDA_TOOL_INSTALLATION_ID: "",
      ASCENDA_EVENT_WRITE_TOKEN: "",
      ASCENDA_WORKSPACE_HASH: "",
      ASCENDA_PROJECT_HASH: "",
      ...env
    }
  });
}

function makeRepoWithWorktree(root) {
  const repo = path.join(root, "repo-alpha");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "busy-bee"), { recursive: true });
  const worktree = path.join(root, "busy-bee");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "busy-bee")}\n`);
  return { repo, worktree };
}

test("an unpaired hook logs its event with hashes derived from the payload cwd, and registers the labels", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-ctx-"));
  const { worktree } = makeRepoWithWorktree(root);
  const logFile = path.join(root, "events.jsonl");

  const result = runHook(
    "PreToolUse",
    { tool_name: "Bash", cwd: worktree },
    { ASCENDA_EVENT_LOG_FILE: logFile }
  );
  assert.equal(result.status, 0, result.stderr);

  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1);
  const { payload } = JSON.parse(lines[0]);
  assert.match(payload.workspaceHash, /^[0-9a-f]{16}$/);
  assert.match(payload.projectHash, /^[0-9a-f]{16}$/);
  assert.notEqual(payload.workspaceHash, payload.projectHash, "worktree and parent repo are different digests");

  const registry = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".ascenda", "work-contexts.json"), "utf8")
  );
  assert.equal(registry.contexts[payload.projectHash].label, "repo-alpha");
  assert.equal(registry.contexts[payload.projectHash].kind, "project");
  assert.equal(registry.contexts[payload.workspaceHash].label, "busy-bee");
  assert.equal(registry.contexts[payload.workspaceHash].kind, "workspace");

  fs.rmSync(root, { recursive: true, force: true });
});

test("explicit env hashes still override derivation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-hook-ctx-"));
  const { worktree } = makeRepoWithWorktree(root);
  const logFile = path.join(root, "events.jsonl");

  const result = runHook(
    "PreToolUse",
    { tool_name: "Bash", cwd: worktree },
    {
      ASCENDA_EVENT_LOG_FILE: logFile,
      ASCENDA_WORKSPACE_HASH: "feedfacefeedface",
      ASCENDA_PROJECT_HASH: "cafebabecafebabe"
    }
  );
  assert.equal(result.status, 0, result.stderr);

  const { payload } = JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n")[0]);
  assert.equal(payload.workspaceHash, "feedfacefeedface");
  assert.equal(payload.projectHash, "cafebabecafebabe");

  fs.rmSync(root, { recursive: true, force: true });
});
