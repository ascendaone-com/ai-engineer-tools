import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The plugin's launcher runs `npx -y <package> plugin-sync` in the
// background, and that run copies its own bundle to ~/.ascenda/plugin.
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("plugin-sync copies this bundle where the plugin's launcher runs it", () => {
  const home = mkdtempSync(join(tmpdir(), "ascenda-plugin-sync-"));
  try {
    const run = () => spawnSync(process.execPath, [cli, "plugin-sync"], { encoding: "utf8", input: "", env: { ...process.env, ASCENDA_HOME: home } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Installed the plugin's bundle/);
    assert.ok(readFileSync(join(home, "plugin", "agent-mcp.mjs")).equals(readFileSync(cli)));
    assert.ok(readFileSync(join(home, "plugin", "agent-mcp.version"), "utf8").trim());

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
