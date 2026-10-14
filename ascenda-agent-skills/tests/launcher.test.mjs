import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// bin/launch.mjs runs a bundle from ~/.ascenda/plugin and keeps npm off the
// hook's path. These run it against a fake `npx` on PATH that logs each call,
// so nothing here reaches the registry.

const launcher = fileURLToPath(new URL("../bin/launch.mjs", import.meta.url));
const posix = { skip: process.platform === "win32" ? "the fake npx is a sh script" : false };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "ascenda-launch-"));
  const home = join(root, "home");
  const fakeBin = join(root, "bin");
  const log = join(root, "npx.log");
  const project = join(root, "project");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(project);
  writeFileSync(join(fakeBin, "npx"), [
    "#!/bin/sh",
    `printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "${log}"`,
    "echo from-npx",
    "exit 7",
    ""
  ].join("\n"));
  chmodSync(join(fakeBin, "npx"), 0o755);
  const plugin = join(home, "plugin");
  return {
    root,
    home,
    project,
    plugin,
    bundle: (name) => join(plugin, `${name}.mjs`),
    checked: (name) => join(plugin, `${name}.checked`),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const [cwd, args] = line.split("\t");
      return { cwd, args };
    }) : []),
    run(args, { input = "", env = {} } = {}) {
      return spawnSync(process.execPath, [launcher, ...args], {
        cwd: project,
        input,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          ASCENDA_HOME: home,
          ASCENDA_DISABLE_UPDATE_CHECK: "",
          ...env
        }
      });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

/** A bundle that reports what it was given. */
function writeBundle(box, name) {
  mkdirSync(box.plugin, { recursive: true });
  writeFileSync(box.bundle(name), [
    "#!/usr/bin/env node",
    "import { readFileSync } from 'node:fs';",
    "const stdin = readFileSync(0, 'utf8');",
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), stdin, cwd: process.cwd() }));",
    ""
  ].join("\n"));
}

function age(file, hours) {
  mkdirSync(join(file, ".."), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "\n");
  const then = new Date(Date.now() - hours * 60 * 60 * 1000);
  utimesSync(file, then, then);
}

/** The background sync is detached, so its log line can land after the launcher exits. */
async function waitForCalls(box, count) {
  for (let i = 0; i < 100 && box.calls().length < count; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return box.calls();
}

test("runs the installed bundle in-process, with the hook's argv, stdin and cwd", posix, async () => {
  const box = sandbox();
  try {
    writeBundle(box, "claude-code-hooks");
    age(box.checked("claude-code-hooks"), 1);
    const result = box.run(["claude-code-hooks", "SessionStart", "--hook-set", "4"], { input: '{"session_id":"s"}' });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.argv, [box.bundle("claude-code-hooks"), "SessionStart", "--hook-set", "4"]);
    assert.equal(seen.stdin, '{"session_id":"s"}');
    assert.equal(seen.cwd, realpathSync(box.project));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(box.calls(), [], "a refresh inside a day must not start npx");
  } finally {
    box.cleanup();
  }
});

test("a day after the last refresh, it starts plugin-sync in the background from the plugin folder", posix, async () => {
  const box = sandbox();
  try {
    writeBundle(box, "claude-code-hooks");
    age(box.checked("claude-code-hooks"), 25);
    const result = box.run(["claude-code-hooks", "PreToolUse", "--hook-set", "4"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).argv.includes("PreToolUse"), "the hook still runs from the bundle");
    const calls = await waitForCalls(box, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args, "-y @ascenda-one/claude-code-hooks plugin-sync", "name-only, so it follows npm latest");
    assert.equal(calls[0].cwd, realpathSync(box.plugin), "npx prefers a copy in the current project");
    assert.ok(Date.now() - statSync(box.checked("claude-code-hooks")).mtimeMs < 60_000, "the stamp moves before npx starts");
  } finally {
    box.cleanup();
  }
});

test("ASCENDA_DISABLE_UPDATE_CHECK keeps the bundle it has", posix, async () => {
  const box = sandbox();
  try {
    writeBundle(box, "agent-mcp");
    age(box.checked("agent-mcp"), 48);
    const result = box.run(["agent-mcp"], { env: { ASCENDA_DISABLE_UPDATE_CHECK: "true" } });
    assert.equal(result.status, 0, result.stderr);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(box.calls(), []);
  } finally {
    box.cleanup();
  }
});

test("with no bundle yet, it runs npx in the foreground and seeds one in the background", posix, async () => {
  const box = sandbox();
  try {
    const result = box.run(["claude-code-hooks", "Stop", "--hook-set", "4"]);
    assert.equal(result.status, 7, "npx's exit status comes through");
    assert.equal(result.stdout.trim(), "from-npx");
    const calls = await waitForCalls(box, 2);
    assert.deepEqual(
      calls.map((call) => call.args).sort(),
      ["-y @ascenda-one/claude-code-hooks Stop --hook-set 4", "-y @ascenda-one/claude-code-hooks plugin-sync"]
    );
    assert.equal(calls.find((call) => call.args.endsWith("Stop --hook-set 4")).cwd, realpathSync(box.project), "the hook keeps the user's working directory");
  } finally {
    box.cleanup();
  }
});

test("a first sync that failed is tried again after an hour, not a day", posix, async () => {
  const box = sandbox();
  try {
    age(box.checked("claude-code-hooks"), 0.5);
    box.run(["claude-code-hooks", "Stop"]);
    assert.deepEqual((await waitForCalls(box, 1)).map((call) => call.args), ["-y @ascenda-one/claude-code-hooks Stop"]);

    age(box.checked("claude-code-hooks"), 2);
    box.run(["claude-code-hooks", "Stop"]);
    const calls = await waitForCalls(box, 3);
    assert.ok(calls.some((call) => call.args.endsWith("plugin-sync")));
  } finally {
    box.cleanup();
  }
});

test("a bundle that won't load falls back to npx", posix, async () => {
  const box = sandbox();
  try {
    mkdirSync(box.plugin, { recursive: true });
    writeFileSync(box.bundle("claude-code-hooks"), "export const = ;\n");
    age(box.checked("claude-code-hooks"), 2);
    const result = box.run(["claude-code-hooks", "SessionEnd"]);
    assert.equal(result.status, 7);
    assert.match(result.stderr, /didn't load/);
    const calls = await waitForCalls(box, 2);
    assert.ok(calls.some((call) => call.args === "-y @ascenda-one/claude-code-hooks SessionEnd"));
    assert.ok(calls.some((call) => call.args.endsWith("plugin-sync")), "and asks for a fresh copy");
  } finally {
    box.cleanup();
  }
});

test("an unknown name is an error, not an npx run", posix, () => {
  const box = sandbox();
  try {
    const result = box.run(["left-pad"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected one of claude-code-hooks, agent-mcp/);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.cleanup();
  }
});
