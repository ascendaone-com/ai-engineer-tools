import * as fs from "fs";
import * as path from "path";
import { COLLECTOR_VERSION } from "./collectorVersion";
import { isDowngrade, writeAtomically } from "./hookRunner";
import { ascendaHome } from "./tokenStore";

/**
 * The copy of a bundle the Claude Code plugin runs, kept on disk so a plugin
 * hook never waits on npm.
 *
 * The plugin's commands name `bin/launch.mjs` inside the plugin, which imports
 * `~/.ascenda/plugin/<name>.mjs` when it's there and falls back to
 * `npx -y <package>` when it isn't. Once a day the launcher starts
 * `npx -y <package> plugin-sync` in the background, and that run copies
 * itself here with {@link installPluginBundle}. The spec is name-only, so
 * the plugin keeps following npm `latest`, a day behind at most.
 *
 * Why not run npx every time: npx asks the registry before every run, even
 * for an exact version it has cached. That costs about half a second online,
 * and on a network that hangs it outlasts the 5 s Claude Code gives a hook,
 * which then kills it and the event is gone.
 *
 * Its own folder, not `~/.ascenda/bin`. That one belongs to `setup`: a bundle
 * there counts as the `setup` install, which `uninstall` removes and whose
 * update note tells the user to run `setup`, registering every hook twice.
 *
 * The launcher reads these paths without this module (it can't import
 * anything), so a change here needs the same change in
 * `ascenda-agent-skills/bin/launch.mjs`.
 */

export interface PluginBundlePaths {
  bundle: string;
  /** The release the bundle came from. */
  version: string;
  /** Touched by the launcher each time it starts a `plugin-sync`. */
  checked: string;
}

export function pluginBundlePaths(name: string): PluginBundlePaths {
  const base = path.join(ascendaHome(), "plugin", name);
  return { bundle: `${base}.mjs`, version: `${base}.version`, checked: `${base}.checked` };
}

export type PluginBundleOutcome =
  | { kind: "installed"; version: string; replaced?: string }
  | { kind: "current"; version: string }
  | { kind: "kept-newer"; installed: string; incoming: string };

/**
 * Copies the running bundle into place, write-then-rename, so a hook that
 * starts mid-copy runs the old file or the new one. A newer bundle stays: a
 * `plugin-sync` from an older npx cache, or from a checkout pinned to an old
 * tag, would otherwise undo an update.
 */
export function installPluginBundle(options: { name: string; source?: string; version?: string }): PluginBundleOutcome {
  const paths = pluginBundlePaths(options.name);
  const source = path.resolve(options.source ?? process.argv[1]);
  const incoming = options.version ?? COLLECTOR_VERSION;
  const installed = readVersion(paths.version);
  const present = fs.existsSync(paths.bundle);

  // Run through the launcher, the source is the installed file itself.
  if (source === path.resolve(paths.bundle)) return { kind: "current", version: installed ?? incoming };
  if (present && installed && isDowngrade(installed, incoming)) return { kind: "kept-newer", installed, incoming };

  const contents = fs.readFileSync(source);
  if (present && installed === incoming && contents.equals(fs.readFileSync(paths.bundle))) {
    return { kind: "current", version: incoming };
  }

  fs.mkdirSync(path.dirname(paths.bundle), { recursive: true });
  writeAtomically(paths.bundle, contents, 0o644);
  // Last, so a bundle that failed to land never has its version recorded.
  writeAtomically(paths.version, `${incoming}\n`, 0o644);
  return present && installed ? { kind: "installed", version: incoming, replaced: installed } : { kind: "installed", version: incoming };
}

/** The line `plugin-sync` prints. */
export function describePluginBundleOutcome(outcome: PluginBundleOutcome, bundle: string): string {
  switch (outcome.kind) {
    case "installed":
      return outcome.replaced && outcome.replaced !== outcome.version
        ? `Updated the plugin's bundle from ${outcome.replaced} to ${outcome.version}: ${bundle}`
        : `Installed the plugin's bundle (${outcome.version}): ${bundle}`;
    case "current":
      return `The plugin's bundle is already ${outcome.version}: ${bundle}`;
    case "kept-newer":
      return `Kept the plugin's bundle at ${outcome.installed}. This copy is the older ${outcome.incoming}.`;
  }
}

function readVersion(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
