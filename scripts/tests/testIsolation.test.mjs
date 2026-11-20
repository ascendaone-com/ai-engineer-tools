import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "../release-artifacts.mjs";

// Collector suites run setup, uninstall and the hooks themselves, and all of
// them resolve ~/.ascenda from HOME. Each package's tests/isolateHome.cjs points
// HOME at a throwaway directory, and it only protects a run if it loads before
// anything else. A preload in the npm test script used to be the only thing
// loading it, so a bare `node --test` skipped it, and the codex setup test's
// `uninstall` removed the developer's real installed hook and pairing. Now every
// test file imports the shim first, and this test keeps it that way.
const ISOLATED_PACKAGES = [
  "ascenda-claude-code-hooks",
  "ascenda-codex-hooks",
  "ascenda-copilot-hooks",
  "ascenda-cursor-hooks",
  "ascenda-gemini-hooks",
  "ascenda-windsurf-hooks",
  "ascenda-history-import"
];

const IMPORT = 'import "./isolateHome.cjs";';

/** The first static import statement in a module's source, or undefined. */
function firstImport(source) {
  return source.match(/^import\b[^\n]*/m)?.[0];
}

test("first-import check finds the first static import, not a later one", () => {
  assert.equal(firstImport(`// header\n${IMPORT}\nimport fs from "node:fs";\n`), IMPORT);
  assert.equal(firstImport(`import fs from "node:fs";\n${IMPORT}\n`), 'import fs from "node:fs";');
  assert.equal(firstImport("const x = 1;\n"), undefined);
});

for (const pkg of ISOLATED_PACKAGES) {
  test(`${pkg}: every test file imports the HOME isolation shim first`, () => {
    const dir = path.join(REPO_ROOT, pkg, "tests");
    assert.ok(fs.existsSync(path.join(dir, "isolateHome.cjs")), `${pkg}/tests/isolateHome.cjs is missing`);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".test.mjs"));
    assert.ok(files.length > 0, `${pkg} has no test files`);
    const missing = files.filter((name) => firstImport(fs.readFileSync(path.join(dir, name), "utf8")) !== IMPORT);
    assert.deepEqual(missing, [], `put ${IMPORT} above every other import in these files`);
  });

  test(`${pkg}: the shim moves HOME and clears every ASCENDA_ variable`, () => {
    const shim = fs.readFileSync(path.join(REPO_ROOT, pkg, "tests", "isolateHome.cjs"), "utf8");
    assert.match(shim, /process\.env\.HOME = fs\.mkdtempSync\(/);
    assert.match(shim, /key\.startsWith\("ASCENDA_"\)\) delete process\.env\[key\]/);
  });
}
