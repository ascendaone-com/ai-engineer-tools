/**
 * The elapsed reading over every store at once — `elapsed/cross-store.json`.
 *
 * Each store's handoff already unions its own overlapping sessions, and each
 * of those is true. Adding two of them is not: an hour in which Claude Code
 * and Codex were both running is that hour twice, and no reader can repair it
 * because a handoff carries minutes and the spans are gone. So the importer
 * takes the union over both while it still holds both, and this pins what that
 * file has to be for the app to accept it.
 *
 * End-to-end through the CLI on purpose. Three of the four invariants below —
 * the nesting, the shared `extractionId`, and the two stores actually meeting
 * in one process — are properties of the RUN, not of any function in it, and a
 * unit test over the pool would pass just as happily with the file written
 * beside the handoffs where every older build would read it as a store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASCENDA_ACTIVE_TIME_QUANTITIES } from "@ascenda-one/tool-contract";
import { CROSS_STORE_ACTIVE_TIME_QUANTITIES } from "../dist/handoffActiveTime.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const APP_BUNDLE_ID = "one.ascenda.ascendaMissionControl";
const PROJECT = "/Users/x/proj";

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

const claudeUser = (at) =>
  JSON.stringify({
    type: "user",
    uuid: `u-${at}`,
    sessionId: "s1",
    timestamp: at,
    cwd: PROJECT,
    message: { role: "user", content: "go" }
  });

const claudeAssistant = (at) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a-${at}`,
    sessionId: "s1",
    timestamp: at,
    cwd: PROJECT,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
  });

/**
 * A home where both stores worked in one project, overlapping.
 *
 * Claude Code runs 10:00 → 10:04: the first stretch ends at the agent and the
 * second at a prompt of the person's own, so the session is half supervising
 * and half hands-on. Codex runs 10:01 → 10:03 and ends at a prompt, so it is
 * hands-on throughout. The two overlap by two minutes, which is the whole
 * subject of this file.
 */
async function makeHome({ withCodex = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "asc-cross-store-"));
  // The signal the CLI reads as "the app is installed on this Mac"; without it
  // no handoff is written at all and there is nothing here to test.
  await fs.mkdir(path.join(home, "Library", "Application Support", APP_BUNDLE_ID), {
    recursive: true
  });

  const proj = path.join(home, ".claude", "projects", "-Users-x-proj");
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(
    path.join(proj, "s1.jsonl"),
    [
      claudeUser("2026-08-01T10:00:00.000Z"),
      claudeAssistant("2026-08-01T10:02:00.000Z"),
      claudeUser("2026-08-01T10:04:00.000Z")
    ].join("\n") + "\n"
  );

  if (withCodex) {
    const codex = path.join(home, ".codex", "sessions", "2026", "08", "01");
    await fs.mkdir(codex, { recursive: true });
    await fs.writeFile(
      path.join(codex, "rollout-2026-08-01T10-01-00-c1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-08-01T10:01:00.000Z",
          type: "session_meta",
          payload: { id: "c1", cwd: PROJECT, cli_version: "0.144.0" }
        }),
        JSON.stringify({
          timestamp: "2026-08-01T10:01:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "go", images: [] }
        }),
        JSON.stringify({
          timestamp: "2026-08-01T10:03:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "again", images: [] }
        })
      ].join("\n") + "\n"
    );
  }
  return home;
}

const handoffDir = (home) => path.join(home, ".ascenda", "history-import");
const crossStorePath = (home) => path.join(handoffDir(home), "elapsed", "cross-store.json");

const readJson = async (at) => JSON.parse(await fs.readFile(at, "utf8"));

/** The `elapsed` block of the one project in a store's handoff. */
async function storeElapsed(home, store) {
  const handoff = await readJson(path.join(handoffDir(home), `${store}.json`));
  const project = handoff.projects.find((p) => p.elapsed);
  return project.elapsed;
}

async function importedHome(options) {
  const home = await makeHome(options);
  const run = await runCli(["import"], home);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  return home;
}

test("four minutes worked in two stores are four minutes, not six", async () => {
  const home = await importedHome();

  const claude = await storeElapsed(home, "claude_code");
  const codex = await storeElapsed(home, "codex");
  const added =
    claude.handsOnMinutes +
    claude.agentSupervisingMinutes +
    codex.handsOnMinutes +
    codex.agentSupervisingMinutes;
  assert.equal(added, 6, "the addition this file replaces");

  const union = await readJson(crossStorePath(home));
  const project = union.projects.find((p) => p.stores.length === 2);
  assert.ok(project, "the project both stores worked in is in the union");

  assert.equal(
    project.elapsed.handsOnMinutes,
    3,
    "hands-on wins the overlap, so 10:02→10:04 and 10:01→10:03 union to 10:01→10:04"
  );
  assert.equal(
    project.elapsed.agentSupervisingMinutes,
    1,
    "what is left of 10:00→10:02 once hands-on has taken 10:01 onwards — the halves stay an exact partition"
  );
  assert.equal(
    project.elapsed.handsOnMinutes + project.elapsed.agentSupervisingMinutes,
    4,
    "the stretch the person actually lived. A figure larger than the period it describes is a category error, not an over-estimate"
  );
  assert.deepEqual(project.stores, ["claude_code", "codex"]);
  assert.deepEqual(union.stores, ["claude_code", "codex"]);
});

test("the union is nested, never a sibling of the handoffs", async () => {
  const home = await importedHome();

  // The app reads every *.json directly in the handoff directory as a store's
  // handoff — that is how a store it has never heard of is still reported — so
  // a sibling file here would read as a store called `cross-store` on every
  // build, including every build shipped before this one.
  const siblings = (await fs.readdir(handoffDir(home))).filter((name) => name.endsWith(".json"));
  assert.deepEqual(siblings.sort(), ["claude_code.json", "codex.json"]);

  const nested = await fs.stat(crossStorePath(home));
  assert.ok(nested.isFile());
});

test("the union names the run every handoff it pooled was written by", async () => {
  const home = await importedHome();
  const union = await readJson(crossStorePath(home));

  // The app accepts this file by identity and not by age: it is refused unless
  // every elapsed-bearing handoff on disk carries the same stamp. A stamp
  // minted per store could never be matched against.
  for (const store of union.stores) {
    const handoff = await readJson(path.join(handoffDir(home), `${store}.json`));
    assert.equal(handoff.extractionId, union.extractionId, `${store} was written by another run`);
  }
  assert.ok(union.extractionId.length > 0);
});

test("every project with an elapsed block is in the union", async () => {
  const home = await importedHome();
  const union = await readJson(crossStorePath(home));

  // Not a formality: the app takes the union only where it covers every
  // project in the window, so one project missing here would drop EVERY row
  // back to summed minutes with nothing said.
  const covered = new Set(union.projects.map((p) => p.projectLabel));
  for (const store of ["claude_code", "codex"]) {
    const handoff = await readJson(path.join(handoffDir(home), `${store}.json`));
    for (const project of handoff.projects) {
      if (!project.elapsed) continue;
      assert.ok(
        covered.has(project.projectLabel),
        `${store} reports elapsed time for ${project.projectLabel}, which the union does not cover`
      );
    }
  }
});

test("one store contributing spans writes no file at all", async () => {
  const home = await importedHome({ withCodex: false });

  // With one store the per-store union already is the union, and a second copy
  // of a figure is a thing for the first to drift from.
  await assert.rejects(fs.stat(crossStorePath(home)), { code: "ENOENT" });
  assert.ok((await storeElapsed(home, "claude_code")).handsOnMinutes > 0, "and the store still reports its own");
});

test("every figure the union writes says what it measures", async () => {
  const home = await importedHome();
  const union = await readJson(crossStorePath(home));

  assert.deepEqual(union.activeTimeQuantities, CROSS_STORE_ACTIVE_TIME_QUANTITIES);
  for (const [figurePath, quantity] of Object.entries(union.activeTimeQuantities)) {
    assert.ok(
      ASCENDA_ACTIVE_TIME_QUANTITIES.includes(quantity),
      `the union stamps ${figurePath} as '${quantity}', which is not a contract quantity`
    );
  }
  // The union is the elapsed reading alone, so it must not stamp — or carry —
  // the summed pair a per-store digest keeps under the same spelling.
  assert.equal(union.activeTimeQuantities["projects[].handsOnMinutes"], undefined);
  for (const project of union.projects) {
    assert.deepEqual(Object.keys(project).sort(), ["elapsed", "projectHash", "projectLabel", "stores"]);
  }
  assert.equal(union.activeTimeQuantities["projects[].elapsed.handsOnMinutes"], "hands_on");
});

test("a union this run did not write is retired, not left to be judged", async () => {
  // The stamps very nearly make an old file inert on their own — but the app
  // skips a store whose handoff carries no `elapsed` block, so a run where one
  // store stops handing over spans while another store's handoff goes
  // untouched leaves an old union matching everything the reader still checks.
  // It would then speak for minutes no handoff on disk reports.
  const home = await importedHome();
  await fs.stat(crossStorePath(home));

  // The same machine after Codex is gone: Claude Code's handoff is rewritten,
  // Codex's is left exactly as found, and no union can be taken.
  await fs.rm(path.join(home, ".codex"), { recursive: true });
  const run = await runCli(["import"], home);
  assert.equal(run.code, 0, run.stdout + run.stderr);

  await assert.rejects(fs.stat(crossStorePath(home)), { code: "ENOENT" });
  assert.match(run.stdout, /removed the previous one/);
  // And the store's own reading is still there — retiring the union is not
  // taking anything away.
  assert.ok((await storeElapsed(home, "claude_code")).handsOnMinutes > 0);
});

test("a run that rewrote no handoff leaves the union alone", async () => {
  // Nothing this run touched is described by the file, so removing it would
  // throw away a reading still exactly true of the handoffs beside it. Here
  // the desktop app is not installed, so no handoff is written at all.
  const home = await importedHome();
  const union = await readJson(crossStorePath(home));
  await fs.rm(path.join(home, "Library", "Application Support", APP_BUNDLE_ID), { recursive: true });
  await fs.rm(path.join(home, ".codex"), { recursive: true });

  const run = await runCli(["import"], home);
  assert.equal(run.code, 0, run.stdout + run.stderr);

  assert.deepEqual(await readJson(crossStorePath(home)), union, "the union is untouched");
});

test("a union that cannot be written does not cost the run its output", async () => {
  // The app treats this file as optional and falls back to the summed reading
  // without it. Everything after it — the events file, the shipment, the
  // closing summary — is the run's actual output, and is what a caller reads
  // instead of inferring an outcome from a stack trace.
  const home = await makeHome();
  // `elapsed` occupied by a regular file: the directory cannot be created.
  await fs.mkdir(handoffDir(home), { recursive: true });
  await fs.writeFile(path.join(handoffDir(home), "elapsed"), "not a directory\n");

  const run = await runCli(["import"], home);

  assert.equal(run.code, 0, run.stdout + run.stderr);
  // The message the contained failure prints, not the one a run that simply
  // had no union to write prints — this has to be the throwing path.
  assert.match(run.stdout, /elapsed across stores: not written — /);
  assert.match(run.stdout, /your per-store figures are unaffected/);
  assert.match(run.stdout, /summary/, "the closing summary is printed on every path");
  assert.match(run.stdout, /events file:/);
  // And the handoffs the run is actually for are on disk and complete.
  assert.ok((await storeElapsed(home, "claude_code")).handsOnMinutes > 0);
  assert.ok((await storeElapsed(home, "codex")).handsOnMinutes > 0);
});
