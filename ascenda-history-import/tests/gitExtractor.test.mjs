import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractGit, parseGitLog } from "../dist/extractors/git.js";
import { toWirePayload } from "../dist/ship.js";

// A throwaway repository built inside the test. The environment is scrubbed
// of the developer's own git config so the author identity is the one set
// here, and HOME points at a scratch directory (see isolateHome.cjs).

const ME = "me@example.test";
const OTHER = "someone-else@example.test";

function run(repo, args, env = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env
    },
    encoding: "utf8"
  });
}

function commit(repo, file, content, when, email, message = "msg") {
  return fs.writeFile(path.join(repo, file), content).then(() => {
    run(repo, ["add", "-A"]);
    run(repo, ["commit", "-q", "-m", message, "--author", `A <${email}>`], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
      GIT_COMMITTER_NAME: "A",
      GIT_COMMITTER_EMAIL: email
    });
  });
}

async function makeRepo({ identity = true } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "git-extract-"));
  run(repo, ["init", "-q", "-b", "main"]);
  if (identity) run(repo, ["config", "user.email", ME]);
  run(repo, ["config", "user.name", "Me"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

const now = new Date("2026-10-14T00:00:00Z");
async function collect(refs) {
  const events = [];
  for await (const e of extractGit(refs, "git-test", { now })) events.push(e);
  return events;
}

test("emits one metadata-only event per commit of mine, at the commit's own time", async () => {
  const repo = await makeRepo();
  try {
    await commit(repo, "a.txt", "1\n2\n3\n", "2026-10-01T09:00:00Z", ME, "SECRET subject");
    await commit(repo, "b.txt", "x\n", "2026-10-02T09:00:00Z", OTHER);
    await commit(repo, "a.txt", "1\n2\n3\n4\n", "2026-10-03T09:00:00Z", ME);
    run(repo, ["checkout", "-q", "-b", "feature/x"]);
    await commit(repo, "c.txt", Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n") + "\n", "2026-10-04T09:00:00Z", ME);
    run(repo, ["checkout", "-q", "main"]);
    run(repo, ["merge", "--no-ff", "-q", "feature/x", "-m", "merge"], {
      GIT_AUTHOR_DATE: "2026-10-05T09:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-05T09:00:00Z",
      GIT_AUTHOR_NAME: "Me",
      GIT_AUTHOR_EMAIL: ME,
      GIT_COMMITTER_NAME: "Me",
      GIT_COMMITTER_EMAIL: ME
    });

    const events = await collect([repo, path.join(repo, "nonexistent")]);
    const commits = events.filter((e) => e.eventKind === "editor_activity");
    assert.deepEqual(
      commits.map((e) => e.occurredAt).sort(),
      ["2026-10-01T09:00:00.000Z", "2026-10-03T09:00:00.000Z", "2026-10-04T09:00:00.000Z", "2026-10-05T09:00:00.000Z"],
      "the other author's commit is not emitted"
    );
    const byTime = Object.fromEntries(commits.map((e) => [e.occurredAt, e]));
    const first = byTime["2026-10-01T09:00:00.000Z"].metrics;
    assert.equal(first.gitAction, "commit");
    assert.equal(first.activity, "git_commit");
    assert.equal(first.isMergeCommit, false);
    assert.equal(first.authoredByMe, true);
    assert.equal(first.filesChangedCount, 1);
    assert.equal(first.linesAddedBucket, "1-10");
    assert.equal(first.linesRemovedBucket, "0");

    const onFeature = byTime["2026-10-04T09:00:00.000Z"].metrics;
    assert.equal(onFeature.linesAddedBucket, "50-200");
    assert.equal(onFeature.gitBranch, "feature/x", "a feature-branch commit names the branch it is reachable from");
    assert.equal(first.gitBranch, undefined, "a default-branch commit carries no branch");

    const merge = byTime["2026-10-05T09:00:00.000Z"].metrics;
    assert.equal(merge.isMergeCommit, true);
    assert.equal(merge.filesChangedCount, 0);

    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.equal(epoch.metrics.gitReposRead, 1);
    assert.equal(epoch.metrics.gitReposSkipped, 1, "the path that doesn't exist is counted");

    // Nothing that identifies a person, a file or a commit survives.
    const serialised = JSON.stringify(events);
    for (const secret of [ME, OTHER, "SECRET subject", "a.txt", "c.txt", "\"Me\""]) {
      assert.ok(!serialised.includes(secret), `${secret} must not appear in any event`);
    }
    const shas = run(repo, ["log", "--all", "--format=%H"]).split("\n").filter(Boolean);
    for (const sha of shas) assert.ok(!serialised.includes(sha), "no commit id on an event");

    // On the wire the branch is a digest, and the type is a catalog type.
    const wire = toWirePayload(onFeature && byTime["2026-10-04T09:00:00.000Z"], 0, "install-1");
    assert.equal(wire.eventType, "editor_activity");
    assert.equal(wire.source, "code_forge");
    assert.equal(wire.metadata.gitBranch, undefined);
    assert.match(String(wire.metadata.branchHash), /^[0-9a-f]+$/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("a repository with no user.email emits nothing and says so", async () => {
  const repo = await makeRepo({ identity: false });
  try {
    await commit(repo, "a.txt", "1\n", "2026-10-01T09:00:00Z", ME);
    const events = await collect([repo]);
    assert.equal(events.filter((e) => e.eventKind === "editor_activity").length, 0);
    const epoch = events.find((e) => e.eventKind === "extraction_epoch");
    assert.equal(epoch.metrics.gitReposWithoutIdentity, 1);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("a commit older than the window is left out, and two commits in one second key apart", async () => {
  const repo = await makeRepo();
  try {
    await commit(repo, "a.txt", "1\n", "2020-01-01T09:00:00Z", ME);
    await commit(repo, "b.txt", "1\n", "2026-10-01T09:00:00Z", ME);
    await commit(repo, "c.txt", "1\n", "2026-10-01T09:00:00Z", ME);
    const commits = (await collect([repo])).filter((e) => e.eventKind === "editor_activity");
    assert.equal(commits.length, 2);
    assert.notEqual(commits[0].sessionRef, commits[1].sessionRef);
    const again = (await collect([repo])).filter((e) => e.eventKind === "editor_activity");
    assert.deepEqual(again.map((e) => e.sessionRef).sort(), commits.map((e) => e.sessionRef).sort());
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("parseGitLog counts binary files as files with no lines", () => {
  const out = "\x1eabc\x1f\x1f1700000000\x1fme@x\x1fmain\n1\t2\ta.txt\n-\t-\timg.png\n";
  const [c] = parseGitLog(out);
  assert.equal(c.files, 2);
  assert.equal(c.added, 1);
  assert.equal(c.removed, 2);
});
