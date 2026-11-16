/**
 * Two imports finishing together must both succeed. The temp file used to be
 * `<target>.tmp` for every writer: writer B truncated it after A wrote, A's
 * rename moved it, and B's rename failed with ENOENT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomically } from "../dist/localHandoff.js";

test("concurrent writers to one target all resolve and leave one valid file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ascenda-atomic-"));
  const target = path.join(dir, "copilot_cli.json");
  try {
    for (let round = 0; round < 20; round += 1) {
      const writers = Array.from({ length: 16 }, (_, i) =>
        writeJsonAtomically(target, { round, writer: i, pad: "x".repeat(50_000) })
      );
      const settled = await Promise.allSettled(writers);
      assert.deepEqual(settled.filter((r) => r.status === "rejected"), []);
      const parsed = JSON.parse(await fs.readFile(target, "utf8"));
      assert.equal(parsed.round, round);
    }
    assert.deepEqual(await fs.readdir(dir), ["copilot_cli.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failed write leaves no temp file behind", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ascenda-atomic-"));
  try {
    // The target is a directory, so the rename fails after the temp is written.
    const target = path.join(dir, "taken");
    await fs.mkdir(path.join(target, "inner"), { recursive: true });
    await assert.rejects(writeJsonAtomically(target, { a: 1 }));
    assert.deepEqual(await fs.readdir(dir), ["taken"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
