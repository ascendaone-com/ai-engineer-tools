import * as fs from "fs";
import * as path from "path";
import { COLLECTOR_VERSION, UNRELEASED_COLLECTOR_VERSION } from "./collectorVersion";
import { describeAge, writeAtomically } from "./hookRunner";
import { ascendaHome } from "./tokenStore";

/**
 * Whether a newer release of these tools is out, for a user who ran `setup`
 * once and has no other way to find out.
 *
 * `setup` copies the bundle to `~/.ascenda/bin` and the hooks run that copy
 * from then on, so an install stays on the release that ran `setup` until a
 * person runs it again. Nothing about that is visible in the agent.
 *
 * Two halves, so the network never sits on a hook's path:
 *
 * - The background flusher calls {@link refreshReleaseCheck} after it drains.
 *   At most once a day it fetches the release manifest from GitHub (no auth,
 *   nothing about the user in the request) and writes what it found to
 *   `~/.ascenda/state/release-check.json`.
 * - A hook reads that file with {@link pendingReleaseNotice}, which can't
 *   throw and makes no request, and `status` prints {@link describeReleaseCheck}.
 *
 * An unpaired install never starts a flusher, so it never fetches. Callers
 * also skip the notice and the status line for one, so the whole check is
 * absent from an install that was set up to keep everything on the machine.
 *
 * `ASCENDA_DISABLE_UPDATE_CHECK=true` turns off both halves. A build with no
 * release stamped into it has nothing to compare and does neither.
 */

export const RELEASE_MANIFEST_URL =
  "https://github.com/ascendaone-com/ai-engineer-tools/releases/latest/download/manifest.json";

export const RELEASE_CHECK_ENV_VAR = "ASCENDA_DISABLE_UPDATE_CHECK";

/** How long a successful check stands before the flusher fetches again. */
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long after a failed fetch before the flusher tries again. Every hook can start a flusher. */
export const RELEASE_CHECK_RETRY_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 3000;

export interface ReleaseCheck {
  /** When a fetch last succeeded. */
  checkedAt?: string;
  /** When a fetch was last tried, whatever came of it. */
  attemptedAt?: string;
  latestVersion?: string;
  minCollectorVersion?: string;
  /** Major version of Node the latest release needs. */
  minNode?: number;
  /** The latest release a "newer release" note was shown for, so it's shown once. */
  notifiedFor?: string;
}

export type ReleaseStanding =
  | { kind: "current"; latest: string }
  | { kind: "behind"; latest: string }
  | { kind: "unsupported"; latest: string; floor: string };

export function releaseCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RELEASE_CHECK_ENV_VAR]?.trim().toLowerCase() === "true";
}

export function releaseCheckPath(): string {
  return path.join(ascendaHome(), "state", "release-check.json");
}

export function readReleaseCheck(file: string = releaseCheckPath()): ReleaseCheck | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as ReleaseCheck : undefined;
  } catch {
    return undefined;
  }
}

function writeReleaseCheck(file: string, check: ReleaseCheck): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeAtomically(file, `${JSON.stringify(check, null, 2)}\n`, 0o600);
  } catch {
    // A home directory we can't write to costs the notice, nothing else.
  }
}

type Release = { core: [number, number, number]; pre: string | undefined };

function parseRelease(version: string | undefined): Release | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec((version ?? "").trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

/**
 * Negative when `a` is the older release, positive when it's the newer one,
 * zero when they're the same. A prerelease sorts before its release. Undefined
 * when either side isn't a release, so a caller can't mistake "can't tell"
 * for "behind".
 */
export function compareReleases(a: string | undefined, b: string | undefined): number | undefined {
  const left = parseRelease(a);
  const right = parseRelease(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Where `installed` stands against the last check, or undefined when there's nothing to compare. */
export function releaseStanding(installed: string, check: ReleaseCheck | undefined): ReleaseStanding | undefined {
  const latest = check?.latestVersion;
  if (!latest) return undefined;
  const floor = check.minCollectorVersion;
  const belowFloor = floor !== undefined && (compareReleases(installed, floor) ?? 0) < 0;
  if (belowFloor) return { kind: "unsupported", latest, floor };
  const behind = compareReleases(installed, latest);
  if (behind === undefined) return undefined;
  return behind < 0 ? { kind: "behind", latest } : { kind: "current", latest };
}

export interface RefreshReleaseCheckOptions {
  file?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** The release this build is. A build with none stamped doesn't check. */
  installed?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches the release manifest if the last check is stale, and records what
 * it says. What the background flusher runs after it drains. Never throws,
 * and returns the check as it stands afterwards.
 */
export async function refreshReleaseCheck(options: RefreshReleaseCheckOptions = {}): Promise<ReleaseCheck | undefined> {
  const file = options.file ?? releaseCheckPath();
  const now = options.now ?? Date.now();
  const installed = options.installed ?? COLLECTOR_VERSION;
  const previous = readReleaseCheck(file);
  if (releaseCheckDisabled(options.env) || installed === UNRELEASED_COLLECTOR_VERSION) return previous;

  const since = (stamp: string | undefined) => {
    const at = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(at) ? now - at : Infinity;
  };
  if (since(previous?.checkedAt) < RELEASE_CHECK_INTERVAL_MS) return previous;
  if (since(previous?.attemptedAt) < RELEASE_CHECK_RETRY_MS) return previous;

  const attemptedAt = new Date(now).toISOString();
  const fetched = await fetchManifest(options.fetchImpl ?? fetch);
  const next: ReleaseCheck = fetched
    ? { ...previous, ...fetched, checkedAt: attemptedAt, attemptedAt }
    : { ...previous, attemptedAt };
  writeReleaseCheck(file, next);
  return next;
}

async function fetchManifest(fetchImpl: typeof fetch): Promise<Pick<ReleaseCheck, "latestVersion" | "minCollectorVersion" | "minNode"> | undefined> {
  try {
    const response = await fetchImpl(RELEASE_MANIFEST_URL, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return undefined;
    const manifest = await response.json() as { version?: unknown; minNode?: unknown; compatibility?: { minCollectorVersion?: unknown } };
    const latestVersion = typeof manifest.version === "string" && parseRelease(manifest.version) ? manifest.version : undefined;
    if (!latestVersion) return undefined;
    const floor = manifest.compatibility?.minCollectorVersion;
    return {
      latestVersion,
      ...(typeof floor === "string" && parseRelease(floor) ? { minCollectorVersion: floor } : {}),
      ...(typeof manifest.minNode === "number" ? { minNode: manifest.minNode } : {})
    };
  } catch {
    return undefined;
  }
}

/**
 * True when this process is the bundle `setup` installed, as against a run
 * through `npx` or the Claude Code plugin. Only that install stays put until
 * `setup` runs again, so only it gets the note.
 */
export function runsFromInstalledBundle(script: string | undefined = process.argv[1]): boolean {
  if (!script) return false;
  return path.dirname(path.resolve(script)) === path.join(ascendaHome(), "bin");
}

export interface ReleaseNoticeOptions {
  /** The command that updates this install, such as `npx -y @ascenda-one/claude-code-hooks setup`. */
  setupCommand: string;
  /** The agent to restart afterwards, such as `Claude Code`. */
  agentName: string;
  installed?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
  /** Major version of the Node running the hooks. */
  nodeMajor?: number;
}

/**
 * The note to show at the start of a session, if any, and a function that
 * records it as shown. Call that only once the note has actually been written.
 *
 * Below the oldest supported release the note repeats every session until the
 * install is updated. Merely behind, it's shown once per release.
 */
export function pendingReleaseNotice(options: ReleaseNoticeOptions): { text: string; markShown: () => void } | undefined {
  if (releaseCheckDisabled(options.env)) return undefined;
  const installed = options.installed ?? COLLECTOR_VERSION;
  if (installed === UNRELEASED_COLLECTOR_VERSION) return undefined;
  const file = options.file ?? releaseCheckPath();
  const check = readReleaseCheck(file);
  const standing = releaseStanding(installed, check);
  if (!check || !standing || standing.kind === "current") return undefined;
  if (standing.kind === "behind" && check.notifiedFor === standing.latest) return undefined;

  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  const node = check.minNode !== undefined && nodeMajor < check.minNode
    ? ` ${standing.latest} needs Node ${check.minNode} or newer and these hooks run on Node ${nodeMajor}, so update Node first.`
    : "";
  const run = `Run \`${options.setupCommand}\`, then restart ${options.agentName}.`;
  const text = standing.kind === "unsupported"
    ? `Ascenda note: the Ascenda hooks here are ${installed}, older than the oldest supported release (${standing.floor}). ${run}${node} This note repeats each session until they're updated.`
    : `Ascenda note: the Ascenda hooks here are ${installed}, and ${standing.latest} is out. ${run}${node} This note appears once per release.`;

  return {
    text,
    markShown: () => {
      if (standing.kind !== "behind") return;
      writeReleaseCheck(file, { ...readReleaseCheck(file), notifiedFor: standing.latest });
    }
  };
}

/** The value `status` prints on its `latest` line. Reads the last check and never fetches. */
export function describeReleaseCheck(options: { installed: string; setupCommand: string; localOnly: boolean; now?: number; file?: string; env?: NodeJS.ProcessEnv }): string {
  if (options.localOnly) return "— not checked: an unpaired install makes no network requests";
  if (releaseCheckDisabled(options.env)) return `— not checked: ${RELEASE_CHECK_ENV_VAR} is set`;
  const check = readReleaseCheck(options.file);
  if (!check?.latestVersion || !check.checkedAt) return "— not checked yet; the background sender checks once a day";
  const age = describeAge((options.now ?? Date.now()) - Date.parse(check.checkedAt));
  const standing = releaseStanding(options.installed, check);
  if (!standing) return `${check.latestVersion} (checked ${age})`;
  if (standing.kind === "current") return `${check.latestVersion}, up to date (checked ${age})`;
  const below = standing.kind === "unsupported" ? `, and ${options.installed} is below the oldest supported release (${standing.floor})` : "";
  return `${check.latestVersion} (checked ${age})${below}. Update: ${options.setupCommand}`;
}

/** The release of the bundle `setup` installed under this name, or undefined when there isn't one. */
export function installedBundleVersion(versionFile: string): string | undefined {
  try {
    return fs.readFileSync(versionFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
