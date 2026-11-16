#!/usr/bin/env node
// Runs an Ascenda bundle for the Claude Code plugin without asking npm first.
//
//   node "${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs" claude-code-hooks SessionStart --hook-set 4
//
// npx asks the registry before every run, even for a version it has cached.
// Online that's about half a second per hook. On a network that hangs it
// outlasts the 5 s Claude Code gives a hook, which then kills it, and the
// event is lost.
//
// So this imports ~/.ascenda/plugin/<name>.mjs, in this process, when it's
// there. Once a day it starts `npx -y <package> plugin-sync` in the
// background, and that run copies the release npm serves into place. A
// hanging network holds up that background process and nothing else. Until
// the first copy lands, it runs `npx -y <package>` the way the plugin always
// has, unless `setup` installed the hook launcher: then its bundle in
// ~/.ascenda/bin runs in-process instead.
//
// The plugin copy wins whenever both exist. It's refreshed daily, and the
// setup copy is only as new as the last `setup` run. The setup copy fills
// the gap before the first sync, and only from 0.1.33 on, the first release
// that reads --hook-set.
//
// No imports beyond Node's own: this file is the plugin's, not a package's.
// The paths match pluginBundle.ts in tool-kit.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGES = {
  "claude-code-hooks": "@ascenda-one/claude-code-hooks",
  "agent-mcp": "@ascenda-one/agent-mcp"
};

const HOUR_MS = 60 * 60 * 1000;
// How long a refresh stands. An hour when there's no bundle yet, so a first
// sync that failed is tried again soon.
const REFRESH_MS = 24 * HOUR_MS;
const RETRY_MS = HOUR_MS;

const [name, ...args] = process.argv.slice(2);
const pkg = Object.hasOwn(PACKAGES, name ?? "") ? PACKAGES[name] : undefined;
if (!pkg) {
  console.error(`launch.mjs: expected one of ${Object.keys(PACKAGES).join(", ")}, got ${name ?? "nothing"}.`);
  process.exit(1);
}

const home = process.env.ASCENDA_HOME ?? join(homedir(), ".ascenda");
const dir = join(home, "plugin");
// What `setup` installs, per package. Only the hooks have one.
const SETUP_BUNDLES = { "claude-code-hooks": "ascenda-claude-hook" };
const SETUP_MIN_VERSION = [0, 1, 33];
const bundle = join(dir, `${name}.mjs`);
const checked = join(dir, `${name}.checked`);
const windows = process.platform === "win32";

const setupBundle = existsSync(bundle) ? undefined : usableSetupBundle();

if (setupBundle) {
  // Seeds the plugin copy, which takes over from the next run after it lands.
  refreshAfter(RETRY_MS);
  try {
    await runBundle(setupBundle);
  } catch (error) {
    console.error(`launch.mjs: ${setupBundle} didn't load (${error instanceof Error ? error.message : String(error)}). Running through npx.`);
    runThroughNpx();
  }
} else if (existsSync(bundle)) {
  // ASCENDA_DISABLE_UPDATE_CHECK keeps the bundle there is. It doesn't stop
  // the first copy: without one, every run goes through npx anyway.
  if (process.env.ASCENDA_DISABLE_UPDATE_CHECK !== "true") refreshAfter(REFRESH_MS);
  try {
    await runBundle(bundle);
  } catch (error) {
    // A file that won't load (a damaged copy, a Node too old for its
    // syntax) ran nothing, so npx can run the event. The refresh replaces it.
    console.error(`launch.mjs: ${bundle} didn't load (${error instanceof Error ? error.message : String(error)}). Running through npx.`);
    refreshAfter(RETRY_MS);
    runThroughNpx();
  }
} else {
  refreshAfter(RETRY_MS);
  runThroughNpx();
}

/** Imports a bundle in this process. It reads argv as if run directly, and its background sender re-runs argv[1]. */
async function runBundle(file) {
  process.argv = [process.argv[0], file, ...args];
  await import(pathToFileURL(file).href);
}

/** The bundle `setup` installed in ~/.ascenda/bin, when it's there and new enough to read --hook-set. */
function usableSetupBundle() {
  const base = Object.hasOwn(SETUP_BUNDLES, name) ? SETUP_BUNDLES[name] : undefined;
  if (!base) return undefined;
  const file = join(home, "bin", `${base}.mjs`);
  try {
    if (!existsSync(file)) return undefined;
    const version = readFileSync(join(home, "bin", `${base}.version`), "utf8").trim().split(/[.-]/).slice(0, 3).map(Number);
    for (let i = 0; i < 3; i++) {
      if (!(version[i] >= 0)) return undefined;
      if (version[i] !== SETUP_MIN_VERSION[i]) return version[i] > SETUP_MIN_VERSION[i] ? file : undefined;
    }
    return file;
  } catch {
    return undefined;
  }
}

/** Starts a background `plugin-sync` when the last one began longer ago than `ms`. */
function refreshAfter(ms) {
  try {
    if (Date.now() - statSync(checked).mtimeMs < ms) return;
  } catch {
    // Never checked.
  }
  try {
    mkdirSync(dir, { recursive: true });
    // Stamped before the spawn: every hook in a burst reads this file, and
    // only the first should start npx.
    writeFileSync(checked, `${new Date().toISOString()}\n`);
    // Run from the plugin folder: npx prefers a copy in the current project,
    // and a hook's working directory is whatever the user has open.
    const child = spawn("npx", ["-y", pkg, "plugin-sync"], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: windows
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The next run tries again.
  }
}

/** The plugin's old path: npx in the foreground, with this process's stdio, cwd and exit status. */
function runThroughNpx() {
  const child = spawn("npx", ["-y", pkg, ...args], { stdio: "inherit", windowsHide: true, shell: windows });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`launch.mjs: couldn't run npx (${error.message}).`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
