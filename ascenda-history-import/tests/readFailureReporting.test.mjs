/**
 * A project whose transcripts can no longer be read must be counted in the
 * run's read-failure total.
 *
 * `projectsWithNoReadableTranscript` has always been emitted on the Claude
 * Code epoch marker — a session directory whose `tool-results/` sidecars
 * outlived the transcript the 30-day purge took, which is a true positive and
 * the reason the counter exists. It was simply absent from the list the CLI
 * sums, so a Claude Code import printed no warning however many projects it
 * could not open. The store's own diagnostic was correct; nothing read it.
 *
 * That is the same failure as the context-key mismatch one level up: a value
 * measured, emitted, and then not resolved by the thing meant to consume it.
 * Here the consumer is our own CLI, so it is ours to keep honest — the whole
 * point of the warning is that the window is short by an unknown amount, and
 * a silent zero says the opposite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(args, home) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, HOME: home }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });
}

/**
 * One readable project so the run has a window to report, and one purged
 * project — files present, no `.jsonl` among them — which is exactly the
 * shape that sets the counter.
 */
async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-readfail-"));

  const readable = path.join(home, ".claude", "projects", "-Users-x-proj");
  await fs.mkdir(readable, { recursive: true });
  await fs.writeFile(
    path.join(readable, "s1.jsonl"),
    [
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-08-01T10:00:00.000Z", cwd: "/Users/x/proj", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-08-01T10:00:05.000Z", cwd: "/Users/x/proj", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })
    ].join("\n") + "\n"
  );

  const purged = path.join(home, ".claude", "projects", "-Users-x-purged");
  await fs.mkdir(path.join(purged, "tool-results"), { recursive: true });
  await fs.writeFile(path.join(purged, "tool-results", "r1.json"), JSON.stringify({ ok: true }));

  return home;
}

test("a project with no readable transcript is reported as a read failure", async () => {
  const home = await makeHome();
  try {
    const { stdout } = await runCli(["import"], home);

    assert.match(
      stdout,
      /could not read — the window is short by an unknown amount/,
      `a purged project must raise the read-failure warning, got:\n${stdout}`
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a store with nothing unreadable raises no read-failure warning", async () => {
  const home = await makeHome();
  try {
    // Remove the purged project; the readable one alone must stay quiet, or
    // the warning means nothing when it does appear.
    await fs.rm(path.join(home, ".claude", "projects", "-Users-x-purged"), {
      recursive: true,
      force: true
    });

    const { stdout } = await runCli(["import"], home);

    assert.doesNotMatch(
      stdout,
      /could not read — the window is short by an unknown amount/,
      `a clean store must not warn, got:\n${stdout}`
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
