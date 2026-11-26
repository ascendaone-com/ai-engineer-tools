const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Everything here writes under a throwaway ASCENDA_HOME, never the real one.
process.env.ASCENDA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-home-"));
delete process.env.ASCENDA_CALL_CAPTURE;

const {
  captureDir, captureEnabled, setCaptureEnabled, runCallCapture, pruneCapture,
  parseUnifiedDiff, diffSnapshots, normaliseLine, isTrivialLine, touchesOffloadable, offloadableFolders,
  hashCapturePath, hashCaptureLine, classifyHunk, indexRecords, parseHunks, isGeneratedPath, dayFilePath
} = require("../out/index.js");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-repo-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "a.txt"), "first original line\nsecond original line\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

function records() {
  const dir = captureDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("calls-"))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (hook, cwd, extra = {}) => runCallCapture({ hook, agent: "claude_code", cwd, toolName: "Bash", session: "s", callId: "c", ...extra });

test("the unified diff parser reads added and removed lines per path, new and deleted files included", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "index 1..2 100644",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -3 +3 @@",
    "-old line",
    "+new line",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed entirely",
    "diff --git a/new.ts b/new.ts",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2 @@",
    "+--- a line that looks like a header",
    "+second",
    "\\ No newline at end of file"
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.get("src/x.ts"), { add: ["new line"], del: ["old line"] });
  assert.deepEqual(files.get("gone.ts"), { add: [], del: ["removed entirely"] });
  assert.deepEqual(files.get("new.ts"), { add: ["--- a line that looks like a header", "second"], del: [] });
});

test("lines are normalised as the matcher reads them, and trivial lines are recognised", () => {
  assert.equal(normaliseLine("   const  x =\t1;  "), "const x = 1;");
  for (const t of ["", "   ", "}", "});", "  ],", "*/", "=>"]) assert.equal(isTrivialLine(t), true, JSON.stringify(t));
  for (const t of ["x", "return 0;", "} else {"]) assert.equal(isTrivialLine(t), false, JSON.stringify(t));
});

test("an offloadable folder rules out a repository under it and one that contains it", () => {
  const folders = ["/h/Library/Mobile Documents", "/h/Documents"];
  assert.equal(touchesOffloadable("/h/Documents/proj", folders), true);
  assert.equal(touchesOffloadable("/h", folders), true, "a repository rooted at home would walk into Documents");
  assert.equal(touchesOffloadable("/h/Dev/proj", folders), false);
  assert.equal(touchesOffloadable("/h/Documentsx", folders), false, "a sibling with a shared prefix is not inside");
});

test("Desktop and Documents count as offloadable only when iCloud syncs them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-icloud-"));
  assert.ok(!offloadableFolders(home).includes(path.join(home, "Documents")));
  fs.mkdirSync(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"), { recursive: true });
  assert.ok(offloadableFolders(home).includes(path.join(home, "Documents")));
  assert.ok(!offloadableFolders(home).includes(path.join(home, "Desktop")));
});

test("a snapshot difference keeps multiplicity", () => {
  const prev = { f: { a: { h1: 1 }, d: {} } };
  const next = { f: { a: { h1: 3, h2: 1 }, d: { h3: 1 } }, g: { a: {}, d: {} } };
  assert.deepEqual(diffSnapshots(prev, next), { files: [{ p: "f", w: ["h1", "h1", "h2"], x: ["h3"] }], lines: 4 });
});

test("capture is off by default and does nothing", async () => {
  const repo = makeRepo();
  assert.equal(captureEnabled({}), false);
  const out = await call("PostToolUse", repo);
  assert.equal(out.result, "disabled");
  assert.equal(fs.existsSync(captureDir()), false);
});

test("a read-only tool and a non-tool hook are not snapshotted", async () => {
  setCaptureEnabled(true);
  try {
    const repo = makeRepo();
    assert.equal((await call("PostToolUse", repo, { toolName: "Read" })).result, "read_only_tool");
    assert.equal((await call("Stop", repo)).result, "not_a_tool_hook");
    assert.equal((await call("PostToolUse", os.tmpdir())).result, "not_a_repo");
  } finally {
    setCaptureEnabled(false);
  }
});

test("a repository in a synced Documents folder is never read", async () => {
  setCaptureEnabled(true);
  try {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-capture-synced-")));
    fs.mkdirSync(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"), { recursive: true });
    const repo = path.join(home, "Documents", "proj");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    const out = await runCallCapture({ hook: "PostToolUse", agent: "claude_code", cwd: repo, toolName: "Bash" }, { home });
    assert.equal(out.result, "offloadable");
    assert.equal(fs.existsSync(path.join(captureDir(), "baselines")), false, "not even a baseline");
  } finally {
    setCaptureEnabled(false);
  }
});

test("a call's shell write, a hand edit between calls, and a checkout are told apart", async () => {
  setCaptureEnabled(true);
  try {
    const repo = makeRepo();
    await call("PreToolUse", repo, { callId: "c1" });
    fs.appendFileSync(path.join(repo, "a.txt"), "line the agent wrote with sed\n");
    await call("PostToolUse", repo, { callId: "c1" });
    await sleep(3_100);
    fs.appendFileSync(path.join(repo, "a.txt"), "line the person typed\n");
    await call("PreToolUse", repo, { callId: "c2" });
    git(repo, "stash", "-q");
    git(repo, "checkout", "-q", "-b", "other");
    fs.writeFileSync(path.join(repo, "b.txt"), "on another branch\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "other");
    git(repo, "checkout", "-q", "-");
    await call("PostToolUse", repo, { callId: "c2" });
    const r = records();
    assert.deepEqual(r.map((x) => [x.kind, x.moved ?? null]), [["call", null], ["between", null]]);
    assert.equal(r[0].files[0].w.length, 1);
    assert.equal(r[0].files[0].w[0], hashCaptureLine(fs.readFileSync(path.join(captureDir(), "path-salt"), "utf8").trim(), "line the agent wrote with sed"));
    assert.equal(r[1].files[0].w.length, 1);

    // The stash took both lines away and HEAD came back where it was: nothing
    // was written, so the call leaves no record. Now a reset that moves HEAD.
    await sleep(3_100);
    await call("PreToolUse", repo, { callId: "c3" });
    git(repo, "reset", "-q", "other");
    await call("PostToolUse", repo, { callId: "c3" });
    const moved = records().filter((x) => x.callId === "c3");
    assert.equal(moved.length, 1);
    assert.equal(moved[0].moved, "other", "a reset onto another branch is not a commit");
  } finally {
    setCaptureEnabled(false);
  }
});

test("lines written and committed inside one call are still seen", async () => {
  setCaptureEnabled(true);
  try {
    const repo = makeRepo();
    await call("PreToolUse", repo, { callId: "k1" });
    fs.appendFileSync(path.join(repo, "a.txt"), "written then committed in the same call\n");
    git(repo, "commit", "-qam", "same call");
    await call("PostToolUse", repo, { callId: "k1" });
    const r = records().filter((x) => x.callId === "k1");
    assert.equal(r.length, 1);
    assert.equal(r[0].moved, "commit");
    assert.equal(r[0].files[0].w.length, 1);
  } finally {
    setCaptureEnabled(false);
  }
});

test("a PreToolUse right after another snapshot of the same folder is skipped", async () => {
  setCaptureEnabled(true);
  try {
    const repo = makeRepo();
    await call("PostToolUse", repo);
    assert.equal((await call("PreToolUse", repo)).result, "skipped_recent");
  } finally {
    setCaptureEnabled(false);
  }
});

test("pruning removes old capture day files only, and counts them", () => {
  setCaptureEnabled(true);
  try {
    const dir = captureDir();
    const old = path.join(dir, "calls-2020-01-01.jsonl");
    const fresh = dayFilePath(new Date());
    const unrelated = path.join(dir, "not-a-capture-file.json");
    const outside = path.join(process.env.ASCENDA_HOME, "calls-2020-01-01.jsonl");
    for (const f of [old, fresh, unrelated, outside]) fs.writeFileSync(f, "{}\n");
    assert.equal(pruneCapture(new Date(), true), 1);
    assert.equal(fs.existsSync(old), false);
    for (const f of [fresh, unrelated, outside]) assert.equal(fs.existsSync(f), true, f);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).pruned, 1);
    assert.equal(pruneCapture(new Date()), 0, "at most once a day");
  } finally {
    setCaptureEnabled(false);
  }
});

test("the matcher calls a hunk agent-led, hand-led, mixed or unclassified by its lines' latest records", () => {
  const salt = "s".repeat(64);
  const p = hashCapturePath(salt, "src/x.ts");
  const h = (l) => hashCaptureLine(salt, l);
  const t0 = Date.parse("2026-12-01T00:00:00Z");
  const rec = (kind, at, lines, moved) => ({ v: 1, at: new Date(at).toISOString(), kind, agent: "claude_code", repo: "r", common: "c", ms: 1, ...(moved ? { moved } : {}), files: [{ p, w: lines.map(h) }] });
  const index = indexRecords([
    rec("call", t0, ["alpha line", "beta line", "gamma line", "delta line", "epsilon line"]),
    rec("between", t0 + 1000, ["typed by hand"]),
    rec("call", t0 - 20 * 86400000, ["too old to count"]),
    rec("call", t0, ["came from a reset"], "other"),
    { v: 1, at: new Date(t0).toISOString(), kind: "call", agent: "claude_code", repo: "r2", common: "elsewhere", ms: 1, files: [{ p, w: [h("other repository")] }] }
  ], "c");
  const hunk = (add) => ({ newPath: "src/x.ts", oldPath: "src/x.ts", index: 0, add, del: [] });
  const at = t0 + 3600000;
  assert.equal(classifyHunk(hunk(["alpha line", "beta line", "gamma line", "delta line", "epsilon line"]), at, index, salt).verdict, "agent-led");
  assert.equal(classifyHunk(hunk(["typed by hand", "}"]), at, index, salt).verdict, "hand-led");
  assert.equal(classifyHunk(hunk(["alpha line", "typed by hand"]), at, index, salt).verdict, "mixed");
  assert.equal(classifyHunk(hunk(["too old to count"]), at, index, salt).verdict, "unclassified");
  assert.equal(classifyHunk(hunk(["came from a reset"]), at, index, salt).verdict, "unclassified");
  assert.equal(classifyHunk(hunk(["other repository"]), at, index, salt).verdict, "unclassified");
  assert.equal(classifyHunk(hunk(["alpha line"]), t0 - 120000, index, salt).verdict, "unclassified", "a record after the commit does not count");
  assert.equal(classifyHunk(hunk(["  }", ""]), at, index, salt), undefined, "trivial-only is excluded");
  assert.equal(classifyHunk({ ...hunk(["a  b"]), del: ["ab"] }, at, index, salt), undefined, "formatting-only is excluded");
  assert.equal(isGeneratedPath("app/lib/x.g.dart"), true);
  assert.equal(isGeneratedPath("node_modules/x/y.js"), true);
  assert.equal(isGeneratedPath("src/x.ts"), false);
});

test("the hunk parser keeps a renamed file's old path", () => {
  const hunks = parseHunks([
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -2 +2 @@",
    "-before",
    "+after",
    "@@ -9,0 +10 @@",
    "+added"
  ].join("\n"));
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], { oldPath: "old.ts", newPath: "new.ts", index: 0, add: ["after"], del: ["before"] });
  assert.equal(hunks[1].index, 1);
});
