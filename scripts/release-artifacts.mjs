// Single source of truth for what a release ships.
//
// Both scripts/stamp-version.mjs and scripts/release-manifest.mjs read this,
// and .github/workflows/release.yml drives its build matrix from it, so adding
// a shipped tool is a one-line change here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Workspaces whose build output is attached to a GitHub Release.
 * `npm` names the package on the registry for the ones that also publish there;
 * omit it and the package ships as a release asset only.
 */
export const RELEASE_PACKAGES = [
  { dir: "ascenda-vscode-extension-telemetry", name: "ascenda", kind: "vsix" },
  { dir: "ascenda-claude-code-hooks", name: "ascenda-claude-code-hooks", kind: "cli", npm: "@ascenda-one/claude-code-hooks" },
  { dir: "ascenda-codex-hooks", name: "ascenda-codex-hooks", kind: "cli", npm: "@ascenda-one/codex-hooks" },
  { dir: "ascenda-agent-mcp", name: "ascenda-agent-mcp", kind: "cli", npm: "@ascenda-one/agent-mcp" },
];

/**
 * Minimum Node major, derived from the root `engines.node` range so the
 * manifest can never drift from what the repo actually requires.
 */
export function minNode(root = REPO_ROOT) {
  const { engines } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const major = /(\d+)/.exec(engines?.node ?? "");
  if (!major) throw new Error("root package.json has no numeric engines.node");
  return Number(major[1]);
}

/** `v1.2.3` and `1.2.3` both normalise to `1.2.3`. */
export function normaliseVersion(tag) {
  const version = String(tag).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a semver release tag: ${tag}`);
  }
  return version;
}
