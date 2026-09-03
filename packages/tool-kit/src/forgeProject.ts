import * as fs from "fs";
import * as path from "path";
import { recordWorkContextAlias } from "./contextRegistry";
import type { WorkContext } from "./workContext";

// The forge identity of a repository, and how it gets tied to the local one.
//
// A code-forge collector runs where no machine salt exists — a CI step reads a
// webhook payload and knows only `owner/repo` — so it identifies a repository
// with an UNSALTED FNV-1a of that string. The hooks on a developer's machine
// identify the SAME repository with a salted digest of the repository
// basename. Two different digests for one repository, and neither side can
// compute the other's: the forge step has no salt (giving it one, via a
// repository secret, would hand the salt to everyone who can read the repo's
// settings and defeat the point of salting at all), and the salted side cannot
// invent the forge's input from a basename alone.
//
// Except that it can. The machine holds BOTH halves: the canonical repository
// basename that feeds the salted digest, and the `owner/repo` string sitting
// in its own `.git/config` remote. So the machine computes the forge digest
// locally and registers it as an ALIAS beside its own — the same mechanism the
// historical importer uses for the legacy full-path digests it can no longer
// re-key (see contextRegistry.ts and ascenda-history-import/src/ship.ts).
//
// WHAT THIS DOES AND DOES NOT BUY. The registry is a machine-local hash→name
// dictionary; it is never transmitted, and nothing on the wire carries an
// alias. So this makes the forge digest NAMEABLE on this machine — a surface
// reading the dictionary can see that both digests are "asc-core-be" — and it
// does NOT merge the two keys anywhere they are counted apart from this
// machine. Grouping happens by shared label, which is why the alias is
// deliberately recorded under the project's own label rather than under
// `owner/repo`.
//
// The salted derivation in workContext.ts is untouched by any of this: what
// goes into that digest is a frozen contract, and nothing here changes it.

/**
 * FNV-1a, 32-bit, lowercase hex, zero-padded to 8 characters.
 *
 * Not a security boundary and not pretending to be one — a repository name is
 * low-entropy and a determined holder of the data could guess it. Its job is
 * to keep names out of the payload and stay stable across events.
 *
 * BYTE-FROZEN. This is the digest a forge collector has already put on stored
 * rows; changing a single operation here orphans every one of them. Pinned by
 * `tests/forgeProject.test.cjs` against both a frozen reference implementation
 * and literal expected digests.
 */
export function forgeProjectHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * `owner/repo` from a git remote URL, or null when the remote is not a
 * github.com remote.
 *
 * Accepts the forms git itself writes: `https://github.com/owner/repo.git`,
 * `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`,
 * `git://github.com/owner/repo.git`, with or without credentials, a `.git`
 * suffix or a trailing slash.
 *
 * Deliberately narrow on the host: only `github.com` (and its `www.` form).
 * A self-hosted forge sends the same `owner/repo` shape but from a different
 * installation, and guessing that two hosts are one forge would fabricate a
 * link this module cannot verify. An unrecognised host is simply not a forge
 * identity we can name, and returns null.
 */
export function parseForgeFullName(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  // scp-like: [user@]host:path — no scheme, and the colon is not a port.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);

  let host: string;
  let repoPath: string;
  if (scheme) {
    host = scheme[2];
    repoPath = scheme[3];
  } else if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    return null;
  }

  const normalizedHost = host.toLowerCase().replace(/^www\./, "");
  if (normalizedHost !== "github.com") return null;

  const segments = repoPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * The `owner/repo` this checkout pushes to, read from `<repoRoot>/.git/config`.
 *
 * Reads the config file rather than shelling out to `git remote`, for the same
 * reason workContext.ts walks the filesystem instead of spawning git: this sits
 * on the hook hot path, between a person and their agent, and a subprocess per
 * event is not a cost worth paying for a name.
 *
 * With several remotes configured, `origin` wins, then `upstream`, then the
 * first github.com remote in file order — a fork's `origin` is the person's own
 * copy, which is also the repository their forge events come from.
 *
 * Returns null, never throws, for: no config file, an unreadable one, no
 * remotes, and remotes this module cannot recognise as github.com.
 */
export function readForgeFullName(repositoryRoot: string | null | undefined): string | null {
  if (!repositoryRoot) return null;
  let config: string;
  try {
    config = fs.readFileSync(path.join(repositoryRoot, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  return forgeFullNameFromConfig(config);
}

/** Exported for tests: the INI half of {@link readForgeFullName}. */
export function forgeFullNameFromConfig(config: string): string | null {
  const remotes = new Map<string, string>();
  let currentRemote: string | null = null;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const section = /^\[([^\]]*)\]$/.exec(line);
    if (section) {
      const remote = /^remote\s+"(.*)"$/.exec(section[1].trim());
      currentRemote = remote ? remote[1] : null;
      continue;
    }

    if (!currentRemote) continue;
    const entry = /^url\s*=\s*(.*)$/.exec(line);
    // First url wins within a remote; git honours the last, but a remote with
    // two urls is a push-fanout and they name the same repository in practice.
    if (entry && !remotes.has(currentRemote)) remotes.set(currentRemote, entry[1].trim());
  }

  const ordered = [
    ...(remotes.has("origin") ? ["origin"] : []),
    ...(remotes.has("upstream") ? ["upstream"] : []),
    ...[...remotes.keys()].filter((name) => name !== "origin" && name !== "upstream")
  ];
  for (const name of ordered) {
    const fullName = parseForgeFullName(remotes.get(name));
    if (fullName) return fullName;
  }
  return null;
}

/**
 * Registers this checkout's forge digest(s) as aliases of its project digest.
 *
 * Two digests can be registered, not one. A forge names a repository in its own
 * canonical casing, while a remote URL carries whatever casing was typed when
 * the repository was cloned, and FNV-1a is case-sensitive — so the literal
 * `owner/repo` from the remote is registered, and its lowercased form as well
 * when the two differ. Both are cheap local dictionary rows, and between them
 * they cover the divergence that actually occurs.
 *
 * Never throws: every failure path — no git root, no remote, an unparseable or
 * non-github remote, an unwritable registry — returns false and leaves the hook
 * that called it untouched.
 */
export function recordForgeProjectAlias(
  context: WorkContext | null,
  options?: { registryFilePath?: string; now?: Date }
): boolean {
  try {
    if (!context?.projectHash || !context.projectLabel || !context.projectPath) return false;
    const fullName = readForgeFullName(context.projectPath);
    if (!fullName) return false;

    const variants = [fullName, fullName.toLowerCase()].filter(
      (value, index, all) => all.indexOf(value) === index
    );

    let wrote = false;
    for (const variant of variants) {
      const hash = forgeProjectHash(variant);
      if (hash === context.projectHash || hash === context.workspaceHash) continue;
      // Recorded under the PROJECT's label, not under `owner/repo`: the
      // registry links an alias to its canonical entry by shared label and by
      // nothing else, so a different label here would be a row that reads
      // nicely and groups with nothing.
      if (recordWorkContextAlias(hash, context.projectLabel, context.projectPath, options)) wrote = true;
    }
    return wrote;
  } catch {
    return false;
  }
}
