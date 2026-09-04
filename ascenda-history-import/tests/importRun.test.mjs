import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * End-to-end `import`, because both defects this file exists for are only
 * visible from outside the process.
 *
 * On 25 Aug 2026 a `--ship` run died partway through the VS Code source.
 * Claude Code and Cursor had extracted; VS Code — the source carrying the
 * great majority of the usable window — had not. The run printed per-source
 * counts for the two that worked, no closing summary, and left its ~20 GB
 * snapshot on disk. The only machine-readable signal a caller had was the
 * exit code.
 *
 * That matters past tidiness: this import backfills the work-demand rail that
 * Act III's cross-leg claim reads. A silent partial import produces a demand
 * series that is quietly short, and the surface consuming it cannot tell the
 * difference between "this person worked less" and "the importer fell over".
 */

function runCli(args, home) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, HOME: home }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    );
  });
}

async function makeHome({ breakClaude = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-home-"));

  const proj = path.join(home, ".claude", "projects", "-Users-x-proj");
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(
    path.join(proj, "s1.jsonl"),
    [
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-08-01T10:00:00.000Z", cwd: "/Users/x/proj", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-08-01T10:00:05.000Z", cwd: "/Users/x/proj", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })
    ].join("\n") + "\n"
  );

  const codex = path.join(home, ".codex", "sessions", "2026", "08", "01");
  await fs.mkdir(codex, { recursive: true });
  await fs.writeFile(
    path.join(codex, "rollout-2026-08-01T20-00-00-c1.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-08-01T10:00:00.000Z", type: "session_meta", payload: { id: "c1", cwd: "/Users/x/proj", cli_version: "0.144.0" } }),
      JSON.stringify({ timestamp: "2026-08-01T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "hi", images: [] } }),
      JSON.stringify({ timestamp: "2026-08-01T10:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } })
    ].join("\n") + "\n"
  );

  const code = path.join(home, "Library", "Application Support", "Code", "User");
  await fs.mkdir(path.join(code, "History", "aaa"), { recursive: true });
  await fs.writeFile(
    path.join(code, "History", "aaa", "entries.json"),
    JSON.stringify({
      version: 1,
      resource: "file:///Users/x/proj/a.ts",
      entries: [{ id: "1.ts", timestamp: 1754000000000, source: "Chat Edit: 'x'" }]
    })
  );
  const ws = path.join(code, "workspaceStorage", "hash1");
  await fs.mkdir(path.join(ws, "chatSessions"), { recursive: true });
  await fs.writeFile(path.join(ws, "workspace.json"), JSON.stringify({ folder: "file:///Users/x/proj" }));
  await fs.writeFile(
    path.join(ws, "chatSessions", "s.json"),
    JSON.stringify({
      version: 3,
      sessionId: "copilot-1",
      requests: [{ message: { text: "a" }, response: [{ value: "b" }], modelId: "gpt-4", timestamp: 1754000000000 }]
    })
  );

  if (breakClaude) {
    // A directory the copier will walk and cannot read. This is the closest
    // faithful stand-in for the real ENOSPC: a mid-copy failure raised by the
    // filesystem, from inside one source, after other sources have succeeded.
    const bad = path.join(home, ".claude", "projects", "unreadable");
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, "s.jsonl"), "{}\n");
    await fs.chmod(bad, 0o000);
  }
  return home;
}

async function stagingRuns(home) {
  const root = path.join(home, ".ascenda", "history-import", "staging");
  try {
    return await fs.readdir(root);
  } catch {
    return [];
  }
}

test("a clean run tears its own snapshot down, keeping only the extracted events", async () => {
  const home = await makeHome();
  const { code, stdout } = await runCli(["import"], home);

  assert.equal(code, 0, stdout);
  const runs = await stagingRuns(home);
  assert.equal(runs.length, 1);
  assert.deepEqual(
    (await fs.readdir(path.join(home, ".ascenda", "history-import", "staging", runs[0]))).sort(),
    ["events.jsonl"],
    "nothing that a run copied may outlive the run that copied it"
  );
  assert.match(stdout, /staging cleaned: freed/);
});

test("a run prints a closing summary naming every source", async () => {
  const home = await makeHome();
  const { stdout } = await runCli(["import"], home);

  assert.match(stdout, /^summary$/m);
  assert.match(stdout, /claude_code\s+\d/);
  assert.match(stdout, /codex\s+\d/);
  assert.match(stdout, /vscode\s+\d/);
  assert.match(stdout, /cursor\s+not present on this machine/);
  assert.match(stdout, /total\s+\d+ extracted/);
});

test("a source that fails is named, and the run exits non-zero", async () => {
  const home = await makeHome({ breakClaude: true });
  try {
    const { code, stdout } = await runCli(["import"], home);

    assert.notEqual(code, 0, "a partial import that reports success is the defect being fixed");
    assert.match(stdout, /claude_code\s+FAILED/, "the summary must name which source failed");
    assert.match(stdout, /EACCES|permission denied/i, "and why");
  } finally {
    await fs.chmod(path.join(home, ".claude", "projects", "unreadable"), 0o755).catch(() => {});
  }
});

test("one source failing does not discard the sources that succeeded", async () => {
  const home = await makeHome({ breakClaude: true });
  try {
    const { stdout } = await runCli(["import"], home);
    // VS Code comes last, after the failing source — before this fix a throw
    // in any source aborted the whole run and threw away everything already
    // extracted above it.
    assert.match(stdout, /vscode\s+\d+ extracted/, "the later sources must still run");
  } finally {
    await fs.chmod(path.join(home, ".claude", "projects", "unreadable"), 0o755).catch(() => {});
  }
});

test("a failed run still tears down its snapshot", async () => {
  const home = await makeHome({ breakClaude: true });
  try {
    await runCli(["import"], home);
    const runs = await stagingRuns(home);
    const left = await fs.readdir(path.join(home, ".ascenda", "history-import", "staging", runs[0]));
    assert.deepEqual(
      left.sort(),
      ["events.jsonl"],
      "the 25 Aug run left ~20 GB behind precisely because it failed"
    );
  } finally {
    await fs.chmod(path.join(home, ".claude", "projects", "unreadable"), 0o755).catch(() => {});
  }
});

test("--keep-staging is the only way to retain a snapshot, and it says so", async () => {
  const home = await makeHome();
  const { code, stdout } = await runCli(["import", "--keep-staging"], home);

  assert.equal(code, 0);
  assert.match(stdout, /staging kept at/);
  const runs = await stagingRuns(home);
  const left = await fs.readdir(path.join(home, ".ascenda", "history-import", "staging", runs[0]));
  assert.ok(left.includes("claude_code"), "debugging needs the snapshot; the default must not");
});

test("a later run sweeps a backlog left by earlier ones", async () => {
  const home = await makeHome();
  await runCli(["import", "--keep-staging"], home);
  const before = await stagingRuns(home);
  assert.equal(before.length, 1);

  const { stdout } = await runCli(["import"], home);
  assert.match(stdout, /swept 1 stale staging run\(s\), freed/);

  const stale = path.join(home, ".ascenda", "history-import", "staging", before[0]);
  assert.deepEqual(
    (await fs.readdir(stale)).sort(),
    ["events.jsonl"],
    "a machine already carrying old snapshots must heal itself"
  );
});

test("VS Code chat sessions are read in place — the 15 GB/run that need not be copied", async () => {
  const home = await makeHome();
  const { stdout } = await runCli(["import", "--keep-staging"], home);
  const runs = await stagingRuns(home);
  const vscodeDir = path.join(home, ".ascenda", "history-import", "staging", runs[0], "vscode");

  assert.ok((await fs.readdir(vscodeDir)).includes("history"), "Timeline history is small and still staged");
  assert.ok(
    !(await fs.readdir(vscodeDir)).includes("workspaceStorage"),
    "chat sessions are read from the live store by default"
  );
  assert.match(stdout, /vscode\s+\d+ extracted/, "and reading them in place still extracts them");
});

test("--snapshot-sessions restores the copy for anyone who wants it", async () => {
  const home = await makeHome();
  await runCli(["import", "--keep-staging", "--snapshot-sessions"], home);
  const runs = await stagingRuns(home);
  const vscodeDir = path.join(home, ".ascenda", "history-import", "staging", runs[0], "vscode");
  assert.ok((await fs.readdir(vscodeDir)).includes("workspaceStorage"));
});

test("a source that succeeds but could not read everything says so", async () => {
  const home = await makeHome();
  const bad = path.join(
    home, "Library", "Application Support", "Code", "User",
    "workspaceStorage", "hash1", "chatSessions", "locked.json"
  );
  await fs.writeFile(bad, "{}");
  await fs.chmod(bad, 0o000);
  try {
    const { code, stdout } = await runCli(["import"], home);
    // Not a failure: the store extracted. But "extracted 12 events" alone
    // would read as complete, and it is not.
    assert.equal(code, 0);
    assert.match(stdout, /could not read/, "an incomplete window must be visible in the summary");
  } finally {
    await fs.chmod(bad, 0o644).catch(() => {});
  }
});

test("a machine with no stores at all is a clean exit, not a failure", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-empty-"));
  const { code, stderr } = await runCli(["import"], home);
  assert.equal(code, 2, "nothing to import is its own answer");
  assert.match(stderr, /nothing to import/);
});

test("the 25 Aug shape: a source that scans fine and dies mid-copy", async () => {
  // The real failure was ENOSPC raised by the filesystem partway through the
  // VS Code copy, after Claude Code and Cursor had already extracted. This is
  // that shape with a permission error standing in for the full disk: the
  // scan succeeds, the copy does not.
  const home = await makeHome();
  const locked = path.join(home, "Library", "Application Support", "Code", "User", "History", "locked");
  await fs.mkdir(locked, { recursive: true });
  await fs.writeFile(path.join(locked, "entries.json"), "{}");
  await fs.chmod(locked, 0o000);
  try {
    const { code, stdout } = await runCli(["import"], home);

    assert.notEqual(code, 0, "the exit code is the only signal a caller gets — it must be wrong-shaped here");
    assert.match(stdout, /vscode\s+FAILED/, "and the summary must name the source that died");
    assert.match(
      stdout,
      /claude_code\s+\d+ extracted/,
      "while the sources that DID work are still reported, and still shipped"
    );
    assert.match(stdout, /staging cleaned/, "a run that dies still cleans up after itself");
  } finally {
    await fs.chmod(locked, 0o755).catch(() => {});
  }
});

/* ---------------------------------------------------------------------- *
 * The archive, end to end — and its one non-negotiable property
 * ---------------------------------------------------------------------- */

test("the archive survives an import, and every sweep an import performs", async () => {
  // Rule 1 of archive.ts. The archive exists because abandoned staging
  // snapshots were accidentally acting as the only second copy; an archive
  // that the staging cleanup can reach would be that same accident with a
  // better name.
  const home = await makeHome();
  const { code } = await runCli(["archive"], home);
  assert.equal(code, 0);

  const archiveRoot = path.join(home, ".ascenda", "history-import", "archive");
  const before = await fs.readdir(path.join(archiveRoot, "manifests"));
  assert.equal(before.length, 1);

  // Two imports: the first leaves a staging run, the second sweeps it.
  await runCli(["import", "--keep-staging"], home);
  const { stdout } = await runCli(["import"], home);
  assert.match(stdout, /swept 1 stale staging run/, "the sweep must actually have run");

  assert.deepEqual(
    await fs.readdir(path.join(archiveRoot, "manifests")),
    before,
    "nothing a cleanup does may touch the archive"
  );
  const { code: verifyCode, stdout: verifyOut } = await runCli(["archive", "--verify"], home);
  assert.equal(verifyCode, 0, verifyOut);
  assert.match(verifyOut, /0 missing, 0 corrupted/);
});

test("archive --verify fails loudly when the archive is damaged", async () => {
  const home = await makeHome();
  await runCli(["archive"], home);
  const objects = path.join(home, ".ascenda", "history-import", "archive", "objects");
  const shard = (await fs.readdir(objects))[0];
  const blob = (await fs.readdir(path.join(objects, shard)))[0];
  await fs.rm(path.join(objects, shard, blob));

  const { code, stdout } = await runCli(["archive", "--verify"], home);
  assert.notEqual(code, 0, "a backup that cannot prove itself must not exit 0");
  assert.match(stdout, /missing/);
});

test("archive skips the 15 GB of VS Code sessions unless asked, and says so", async () => {
  const home = await makeHome();
  const { stdout } = await runCli(["archive"], home);
  assert.match(stdout, /workspaceStorage: skipped/);

  const { stdout: opted } = await runCli(["archive", "--include-vscode-sessions"], home);
  assert.doesNotMatch(opted, /workspaceStorage: skipped/);
});

test("a second archive of an unchanged machine adds no bytes", async () => {
  const home = await makeHome();
  await runCli(["archive"], home);
  const { stdout } = await runCli(["archive"], home);
  assert.match(stdout, /already held/);
  assert.match(stdout, /0 B new/, "dedup is what makes this affordable to run often");
});

test("archive --list reports generations and the size on disk", async () => {
  const home = await makeHome();
  await runCli(["archive"], home);
  const { code, stdout } = await runCli(["archive", "--list"], home);
  assert.equal(code, 0);
  assert.match(stdout, /files/);
  assert.match(stdout, /archive on disk:/);
});

test("archive --restore writes to the destination and never to the live store", async () => {
  const home = await makeHome();
  await runCli(["archive"], home);
  const destination = path.join(home, "restored");
  const liveBefore = await fs.readdir(path.join(home, ".claude", "projects"));

  const { code, stdout } = await runCli(["archive", "--restore", destination], home);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /nothing was written to the live stores/);

  const restored = await fs.readFile(
    path.join(destination, "claude_code", "projects", "-Users-x-proj", "s1.jsonl"),
    "utf8"
  );
  assert.match(restored, /"sessionId":"s1"/);
  assert.deepEqual(
    await fs.readdir(path.join(home, ".claude", "projects")),
    liveBefore,
    "the live store must be untouched by a restore"
  );
});

test("archive --prune bounds the archive rather than letting it grow forever", async () => {
  const home = await makeHome();
  await runCli(["archive"], home);
  await fs.writeFile(
    path.join(home, ".claude", "projects", "-Users-x-proj", "s1.jsonl"),
    JSON.stringify({ type: "user", uuid: "u2", sessionId: "s2", timestamp: "2026-08-02T10:00:00.000Z", cwd: "/Users/x/proj", message: { role: "user", content: "changed" } }) + "\n"
  );
  await runCli(["archive"], home);

  const { code, stdout } = await runCli(["archive", "--prune", "--keep", "1"], home);
  assert.equal(code, 0);
  assert.match(stdout, /pruned 1 generation/);

  const { code: verifyCode } = await runCli(["archive", "--verify"], home);
  assert.equal(verifyCode, 0, "pruning must never damage the generation it keeps");
});
