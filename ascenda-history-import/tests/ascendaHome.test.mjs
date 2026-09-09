/**
 * `ASCENDA_HOME` and this importer's own files.
 *
 * The variable moves Ascenda's tree: tokens, credentials, the send journal,
 * the turn-start files. This package used to resolve `~/.ascenda` from
 * `os.homedir()` on its own, so setting it moved half the tree and left the
 * handoffs, the staging area and the archive behind in the real home — the
 * same split, one package over, that the tool-kit fix closed.
 *
 * The other half of the rule matters just as much and is easier to get wrong
 * in the other direction: the stores this importer READS are not Ascenda's.
 * `~/.claude` and `~/.codex` belong to Claude Code and Codex, and an Ascenda
 * variable that relocated them would simply stop finding anyone's history.
 * So the two halves are pinned together here — what moves, and what must not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import { handoffDir, handoffFilePath } from "../dist/localHandoff.js";
import { defaultStagingRoot } from "../dist/staging.js";
import { defaultArchiveRoot } from "../dist/archive.js";
import { crossStoreElapsedPath } from "../dist/crossStoreElapsed.js";
import { resolveStorePaths } from "../dist/stores.js";

/** Run `fn` with `ASCENDA_HOME` set, restoring whatever was there before. */
function withAscendaHome(value, fn) {
  const before = process.env.ASCENDA_HOME;
  if (value === undefined) delete process.env.ASCENDA_HOME;
  else process.env.ASCENDA_HOME = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.ASCENDA_HOME;
    else process.env.ASCENDA_HOME = before;
  }
}

test("ASCENDA_HOME moves the handoffs, the staging area and the archive together", () => {
  const root = path.join(os.tmpdir(), "asc-home-fixture");
  withAscendaHome(root, () => {
    const home = "/Users/someone";
    for (const resolved of [
      handoffDir(home),
      handoffFilePath(home, "claude_code"),
      crossStoreElapsedPath(home),
      defaultStagingRoot(home),
      defaultArchiveRoot(home)
    ]) {
      assert.ok(
        resolved.startsWith(root + path.sep),
        `${resolved} should sit under ASCENDA_HOME`
      );
      assert.ok(
        !resolved.includes(path.join(home, ".ascenda")),
        `${resolved} should not fall back to the real home`
      );
    }
  });
});

test("the cross-store file stays beside the handoffs it speaks for", () => {
  const root = path.join(os.tmpdir(), "asc-home-fixture");
  withAscendaHome(root, () => {
    // Nested one level down, never a sibling: the app reads every .json
    // sitting directly in the handoff directory as a store.
    assert.equal(
      path.dirname(path.dirname(crossStoreElapsedPath("/Users/someone"))),
      handoffDir("/Users/someone")
    );
  });
});

test("without ASCENDA_HOME the layout is unchanged, under the home it is given", () => {
  withAscendaHome(undefined, () => {
    const home = "/Users/someone";
    assert.equal(handoffDir(home), path.join(home, ".ascenda", "history-import"));
    assert.equal(defaultStagingRoot(home), path.join(home, ".ascenda", "history-import", "staging"));
    assert.equal(defaultArchiveRoot(home), path.join(home, ".ascenda", "history-import", "archive"));
  });
});

test("ASCENDA_HOME does not relocate the stores this importer reads", () => {
  const home = "/Users/someone";
  const plain = resolveStorePaths(home);
  const moved = withAscendaHome(path.join(os.tmpdir(), "asc-home-fixture"), () =>
    resolveStorePaths(home)
  );

  // Claude Code's and Codex's own directories, and the app's Application
  // Support: all three answer to the OS home and to nothing of ours.
  assert.deepEqual(moved, plain);
  assert.equal(moved.claudeProjects, path.join(home, ".claude", "projects"));
  assert.equal(moved.codexRoot, path.join(home, ".codex"));
});
