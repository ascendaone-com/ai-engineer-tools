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
  { dir: "ascenda-cursor-hooks", name: "ascenda-cursor-hooks", kind: "cli", npm: "@ascenda-one/cursor-hooks" },
  { dir: "ascenda-windsurf-hooks", name: "ascenda-windsurf-hooks", kind: "cli", npm: "@ascenda-one/windsurf-hooks" },
  { dir: "ascenda-gemini-hooks", name: "ascenda-gemini-hooks", kind: "cli", npm: "@ascenda-one/gemini-hooks" },
  { dir: "ascenda-agent-mcp", name: "ascenda-agent-mcp", kind: "cli", npm: "@ascenda-one/agent-mcp" },
  { dir: "ascenda-github-collector", name: "ascenda-github-collector", kind: "cli", npm: "@ascenda-one/github-collector" },
  { dir: "ascenda-history-import", name: "ascenda-history-import", kind: "cli", npm: "@ascenda-one/history-import" },
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

/**
 * The compatibility floors a release declares, for consumers that cannot see
 * this repo: `doctor`, the macOS Connections row, and the Sparkle appcast.
 *
 * `contractVersion` is **derived** from packages/tool-contract rather than
 * restated in compatibility.json, because two hand-authored copies of one fact
 * drift, and the drift is invisible precisely where it matters. The floors that
 * cannot be derived — they encode a judgement about what is still supported —
 * are read from compatibility.json, where each carries the consumer that acts
 * on it.
 *
 * Throws rather than defaulting. A manifest that silently ships without its
 * compatibility block is the failure this whole line of work exists to stop:
 * the consumer reads "no floor declared" as "everything is fine".
 */
export function compatibility(root = REPO_ROOT) {
  const contractPath = path.join(root, "packages", "tool-contract", "package.json");
  const { version: contractVersion } = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  if (!contractVersion) throw new Error(`no version in ${contractPath}`);

  const declared = JSON.parse(fs.readFileSync(path.join(root, "compatibility.json"), "utf8"));
  const floors = ["minCollectorVersion", "minMacosAppVersion"];
  for (const key of floors) {
    if (!declared[key]) throw new Error(`compatibility.json is missing ${key}`);
    normaliseVersion(declared[key]); // rejects a typo'd floor at build time, not at a user's
  }

  return {
    contractVersion,
    ...Object.fromEntries(floors.map((key) => [key, declared[key]])),
  };
}

/** `v1.2.3` and `1.2.3` both normalise to `1.2.3`. */
export function normaliseVersion(tag) {
  const version = String(tag).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a semver release tag: ${tag}`);
  }
  return version;
}
