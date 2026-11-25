import * as fs from "fs";
import * as path from "path";
import { COLLECTOR_VERSION, UNRELEASED_COLLECTOR_VERSION } from "./collectorVersion";
import { readMachineCredentials } from "./credentials";
import { describeAge, isDowngrade, writeAtomically } from "./hookRunner";
import { compareReleases } from "./releaseCheck";
import { ascendaHome } from "./tokenStore";

/**
 * Keeps a `setup` install's hook registration in step with the hook bundle
 * it runs.
 *
 * `setup` does two things: it copies a bundle to `~/.ascenda/bin`, and it
 * writes a list of events into the agent's settings file. Until now nothing
 * touched the second half again. A bundle that learned a new event (a failed
 * tool call, a permission prompt) kept being started only for the events the
 * first `setup` listed, so the new one read as zero for as long as nobody ran
 * `setup` by hand, and a zero like that can't be told from a real one.
 *
 * Three pieces:
 *
 * - **A record.** Each `setup` notes, per settings file, which release wrote
 *   the registration, its hook set and the events it listed, in
 *   `~/.ascenda/state/hook-registrations.json`. Registered commands also
 *   carry `--hook-set <n>` where the adapter has one (`hookSet.ts`).
 * - **A refresh.** A hook run from the installed bundle calls
 *   {@link refreshHookRegistrations}. It costs one `stat` per hook, and at
 *   most once a day it compares each registration with what this bundle
 *   registers and re-applies ours when the registration is older or is
 *   missing an event this release added. It reads and writes local files
 *   only. It never downloads anything and never changes which bundle runs:
 *   it brings the registration up to the code already installed.
 * - **A report.** `doctor` prints {@link hookRegistrationDoctorLines}.
 *
 * What it never does:
 *
 * - Touch a hook that isn't ours. It writes through the adapter's own
 *   `setup` merge, which keeps everyone else's entries where they were.
 * - Register in a file that holds none of ours. Taking every one of our
 *   hooks out of a file is how a person uninstalls by hand, so it stays out.
 * - Put back an event a person took out. Only events that weren't in the
 *   recorded registration are added, so a hook someone deleted stays deleted.
 * - Let an older bundle rewrite a registration a newer release wrote.
 *
 * Off with `ASCENDA_DISABLE_HOOK_REFRESH=true`, or machine-wide with
 * `setup --no-hook-refresh` (which `--hook-refresh` undoes). The setting is
 * the one that matters for an agent started from the Dock, which never sees
 * a shell's environment.
 */

export const HOOK_REFRESH_ENV_VAR = "ASCENDA_DISABLE_HOOK_REFRESH";

/** How long a check stands before the next hook looks again. */
export const HOOK_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type HookRegistrationScope = "user" | "project";

/** What one `setup` (or refresh) wrote into one settings file. */
export interface HookRegistrationRecord {
  settingsFile: string;
  scope: HookRegistrationScope;
  /** The release that wrote it. `unreleased` for a build from a checkout. */
  collectorVersion: string;
  hookSet?: number;
  events: string[];
  registeredAt: string;
  /** `setup` or `refresh`. */
  by: "setup" | "refresh";
}

/** What the last refresh found, for `doctor`. */
export interface HookRefreshOutcome {
  checkedAt: string;
  collectorVersion: string;
  updated: string[];
  failed: string[];
}

interface HookRegistrationsFile {
  tools?: Record<string, { registrations?: HookRegistrationRecord[]; lastRefresh?: HookRefreshOutcome }>;
}

export function hookRegistrationsPath(): string {
  return path.join(ascendaHome(), "state", "hook-registrations.json");
}

/** Touched before each check, so a burst of hooks starts one check, not one each. */
export function hookRefreshStampPath(tool: string): string {
  return path.join(ascendaHome(), "state", `hook-refresh-${tool.replace(/[^A-Za-z0-9_-]/g, "_")}.stamp`);
}

function readFile(): HookRegistrationsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(hookRegistrationsPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as HookRegistrationsFile : {};
  } catch {
    return {};
  }
}

function writeFile(contents: HookRegistrationsFile): void {
  const file = hookRegistrationsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomically(file, `${JSON.stringify(contents, null, 2)}\n`, 0o600);
}

function sameFile(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function readHookRegistrations(tool: string): HookRegistrationRecord[] {
  const records = readFile().tools?.[tool]?.registrations;
  return Array.isArray(records) ? records.filter((record) => record && typeof record.settingsFile === "string") : [];
}

export function readLastHookRefresh(tool: string): HookRefreshOutcome | undefined {
  return readFile().tools?.[tool]?.lastRefresh;
}

function updateTool(tool: string, change: (entry: { registrations: HookRegistrationRecord[]; lastRefresh?: HookRefreshOutcome }) => void): void {
  const contents = readFile();
  const tools = { ...(contents.tools ?? {}) };
  const entry = { registrations: readHookRegistrations(tool), ...(tools[tool]?.lastRefresh ? { lastRefresh: tools[tool]!.lastRefresh } : {}) };
  change(entry);
  tools[tool] = entry;
  writeFile({ ...contents, tools });
}

/**
 * Notes what was just registered in `record.settingsFile`, replacing any
 * earlier note for the same file. Never throws: a home directory we can't
 * write to costs the refresh its record, not the install.
 */
export function recordHookRegistration(
  tool: string,
  record: Omit<HookRegistrationRecord, "registeredAt" | "by" | "collectorVersion" | "events"> & Partial<Pick<HookRegistrationRecord, "registeredAt" | "by" | "collectorVersion">> & { events: readonly string[] }
): void {
  try {
    const full: HookRegistrationRecord = {
      collectorVersion: COLLECTOR_VERSION,
      registeredAt: new Date().toISOString(),
      by: "setup",
      ...record,
      settingsFile: path.resolve(record.settingsFile),
      events: [...record.events]
    };
    updateTool(tool, (entry) => {
      entry.registrations = [...entry.registrations.filter((existing) => !sameFile(existing.settingsFile, full.settingsFile)), full];
    });
  } catch {
    // See above.
  }
}

/** Drops the note for one settings file, or every note for the tool when none is named. */
export function forgetHookRegistration(tool: string, settingsFile?: string): void {
  try {
    updateTool(tool, (entry) => {
      entry.registrations = settingsFile === undefined ? [] : entry.registrations.filter((existing) => !sameFile(existing.settingsFile, settingsFile));
      if (settingsFile === undefined) delete entry.lastRefresh;
    });
  } catch {
    // Nothing to keep in step with.
  }
}

/** Off by the environment variable, or by the machine-wide setting `setup --no-hook-refresh` writes. */
export function hookRefreshDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[HOOK_REFRESH_ENV_VAR]?.trim().toLowerCase() === "true") return true;
  return readMachineCredentials()?.hookRefresh === false;
}

/** Why the refresh is off, or undefined when it's on. */
export function hookRefreshOffReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[HOOK_REFRESH_ENV_VAR]?.trim().toLowerCase() === "true") return `${HOOK_REFRESH_ENV_VAR} is set`;
  if (readMachineCredentials()?.hookRefresh === false) return "turned off with setup --no-hook-refresh";
  return undefined;
}

/**
 * What a refresh needs from an adapter: its events, where it registers, and
 * its own `setup` merge. Every adapter already has all three.
 */
export interface HookRefreshAdapter {
  /** The key the record is kept under: `claude_code`, or the CLI agent's host. */
  tool: string;
  /** Every event this release registers. */
  events: readonly string[];
  hookSet?: number;
  /**
   * Each event that has one of our hooks in the file, mapped to the hook set
   * its command names. Undefined when the file is missing or can't be parsed,
   * so a file nobody can read is left alone.
   */
  registered: (settingsFile: string) => Map<string, number> | undefined;
  /**
   * Re-applies our registration for `events` with the adapter's `setup`
   * merge: true when the file changed, false when it was current, null when
   * it couldn't be written. Must print nothing: an agent may read a hook's
   * stdout as its answer.
   */
  reapply: (settingsFile: string, events: readonly string[]) => boolean | null;
  /** Files to look in besides the recorded ones, for installs from before the record existed. */
  candidates: () => { settingsFile: string; scope: HookRegistrationScope }[];
}

/** Where one settings file stands against this release. */
export interface HookRegistrationAssessment {
  settingsFile: string;
  scope: HookRegistrationScope;
  record?: HookRegistrationRecord;
  /** Events this release registers that the file doesn't. */
  missing: string[];
  /** The subset of {@link missing} the refresh would add: new since the recorded registration. */
  toAdd: string[];
  /** Events in the recorded registration that someone has since taken out. Left out. */
  removedByPerson: string[];
  /** The lowest hook set among our commands, when the adapter has sets. */
  registeredSet?: number;
  /** True when the registration is older than this release or misses an event it would add. */
  stale: boolean;
  /** Set when a newer release wrote it, so this bundle mustn't rewrite it. */
  newerThanThis?: string;
}

/**
 * Every settings file that holds at least one of our hooks (the recorded ones
 * and the adapter's candidates), with what a refresh would do to it.
 */
export function assessHookRegistrations(adapter: HookRefreshAdapter, version: string = COLLECTOR_VERSION): HookRegistrationAssessment[] {
  const records = readHookRegistrations(adapter.tool);
  const files: { settingsFile: string; scope: HookRegistrationScope }[] = [];
  for (const candidate of [...records.map(({ settingsFile, scope }) => ({ settingsFile, scope })), ...adapter.candidates()]) {
    if (!files.some((seen) => sameFile(seen.settingsFile, candidate.settingsFile))) files.push(candidate);
  }

  const found: HookRegistrationAssessment[] = [];
  for (const { settingsFile, scope } of files) {
    const sets = adapter.registered(settingsFile);
    if (!sets || sets.size === 0) continue;
    const record = records.find((existing) => sameFile(existing.settingsFile, settingsFile));
    const missing = adapter.events.filter((event) => !sets.has(event));
    const removedByPerson = record ? missing.filter((event) => record.events.includes(event)) : [];
    const toAdd = missing.filter((event) => !removedByPerson.includes(event));
    const registeredSet = adapter.hookSet === undefined ? undefined : Math.min(...sets.values());
    const newerThanThis = record && isDowngrade(record.collectorVersion, version) ? record.collectorVersion : undefined;
    const olderRelease = !record || (compareReleases(record.collectorVersion, version) ?? 0) < 0;
    const behindSet = adapter.hookSet !== undefined && registeredSet !== undefined && registeredSet < adapter.hookSet;
    found.push({
      settingsFile,
      scope: record?.scope ?? scope,
      ...(record ? { record } : {}),
      missing,
      toAdd,
      removedByPerson,
      ...(registeredSet !== undefined ? { registeredSet } : {}),
      stale: !newerThanThis && (toAdd.length > 0 || behindSet || olderRelease),
      ...(newerThanThis ? { newerThanThis } : {})
    });
  }
  return found;
}

export type HookRefreshResult =
  | { kind: "off"; reason: string }
  | { kind: "not-due" }
  | { kind: "skipped"; reason: string }
  | { kind: "checked"; updated: string[]; failed: string[] };

export interface RefreshHookRegistrationsOptions {
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** The release doing the refresh. Defaults to this build's own. */
  version?: string;
  /** Ignore the once-a-day gate (tests, and `doctor --refresh` if it ever exists). */
  force?: boolean;
}

/**
 * The check a hook runs. One `stat` when it isn't due; otherwise a read of
 * each registered settings file and a write of the stale ones. Never throws
 * and never prints.
 *
 * The caller decides it's a `setup` install (the hook runs from
 * `~/.ascenda/bin`): a plugin or `npx` run has its registration managed
 * elsewhere, and writing a second one would run every hook twice.
 */
export function refreshHookRegistrations(adapter: HookRefreshAdapter, options: RefreshHookRegistrationsOptions = {}): HookRefreshResult {
  try {
    const env = options.env ?? process.env;
    const off = hookRefreshOffReason(env);
    if (off) return { kind: "off", reason: off };
    const version = options.version ?? COLLECTOR_VERSION;
    // A checkout build has no release to compare, and a registration it
    // wrote would claim a version nobody can install.
    if (version === UNRELEASED_COLLECTOR_VERSION) return { kind: "skipped", reason: "a build from a checkout doesn't refresh" };

    const now = options.now ?? Date.now();
    const stamp = hookRefreshStampPath(adapter.tool);
    if (!options.force) {
      try {
        if (now - fs.statSync(stamp).mtimeMs < HOOK_REFRESH_INTERVAL_MS) return { kind: "not-due" };
      } catch {
        // Never checked.
      }
    }
    // Before the work, so the other hooks in this burst see it and skip.
    fs.mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
    const at = new Date(now);
    fs.utimesSync(stamp, at, at);

    const updated: string[] = [];
    const failed: string[] = [];
    for (const assessment of assessHookRegistrations(adapter, version)) {
      if (!assessment.stale) continue;
      const events = adapter.events.filter((event) => !assessment.removedByPerson.includes(event));
      let outcome: boolean | null;
      try {
        outcome = adapter.reapply(assessment.settingsFile, events);
      } catch {
        outcome = null;
      }
      if (outcome === null) {
        failed.push(assessment.settingsFile);
        continue;
      }
      if (outcome) updated.push(assessment.settingsFile);
      recordHookRegistration(adapter.tool, {
        settingsFile: assessment.settingsFile,
        scope: assessment.scope,
        collectorVersion: version,
        ...(adapter.hookSet !== undefined ? { hookSet: adapter.hookSet } : {}),
        events,
        registeredAt: at.toISOString(),
        by: "refresh"
      });
    }
    updateTool(adapter.tool, (entry) => {
      entry.lastRefresh = { checkedAt: at.toISOString(), collectorVersion: version, updated, failed };
    });
    return { kind: "checked", updated, failed };
  } catch {
    return { kind: "skipped", reason: "the check could not run" };
  }
}

export interface HookRegistrationDoctorOptions {
  adapter: HookRefreshAdapter;
  /** The release of the bundle in `~/.ascenda/bin`, when there is one. */
  installedBundleVersion?: string;
  /** What updates the bundle, e.g. `npx -y @ascenda-one/codex-hooks setup`. */
  setupCommand: string;
  /** How a path should be shown (home folder as `~`). */
  tidy?: (file: string) => string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** The release running `doctor`. Defaults to this build's own. */
  version?: string;
}

/**
 * `doctor`'s "Hook versions" section: the installed bundle against this
 * CLI, each registration against the bundle, and whether the daily refresh
 * is on and what it last did.
 */
export function hookRegistrationDoctorLines(options: HookRegistrationDoctorOptions): string[] {
  const { adapter, setupCommand } = options;
  const tidy = options.tidy ?? ((file: string) => file);
  const version = options.version ?? COLLECTOR_VERSION;
  const now = options.now ?? Date.now();
  const bundle = options.installedBundleVersion;
  const lines: string[] = ["  Hook versions"];

  if (!bundle) {
    lines.push(`    Installed bundle    none in ${tidy(path.join(ascendaHome(), "bin"))}`);
  } else {
    const order = compareReleases(bundle, version);
    const against = order === undefined || order === 0
      ? ""
      : order < 0
        ? `, older than this CLI (${version}). Update it with: ${setupCommand}`
        : `, newer than this CLI (${version})`;
    lines.push(`    Installed bundle    ${bundle}${against}`);
  }

  // Judged against the bundle the hooks run, not this CLI: that is what a
  // refresh would bring the registration up to.
  const against = bundle ?? version;
  const assessments = assessHookRegistrations(adapter, against);
  if (assessments.length === 0) {
    lines.push("    Registrations       none found");
  }
  for (const assessment of assessments) {
    const registered = adapter.events.length - assessment.missing.length;
    const parts = [`${registered}/${adapter.events.length} events`];
    if (assessment.registeredSet !== undefined) parts.push(`hook set ${assessment.registeredSet}${adapter.hookSet !== undefined && assessment.registeredSet < adapter.hookSet ? ` of ${adapter.hookSet}` : ""}`);
    parts.push(assessment.record
      ? `written by ${assessment.record.collectorVersion} (${assessment.record.by}, ${describeAge(now - Date.parse(assessment.record.registeredAt))})`
      : "written before versions were recorded");
    lines.push(`    ${tidy(assessment.settingsFile)} (${assessment.scope})`);
    lines.push(`      ${parts.join(", ")}`);
    if (assessment.toAdd.length) lines.push(`      Missing: ${assessment.toAdd.join(", ")}`);
    if (assessment.removedByPerson.length) lines.push(`      Taken out by hand, left out: ${assessment.removedByPerson.join(", ")}`);
    if (assessment.newerThanThis) lines.push(`      A newer release (${assessment.newerThanThis}) wrote this; the installed bundle leaves it alone.`);
  }

  const off = hookRefreshOffReason(options.env ?? process.env);
  const last = readLastHookRefresh(adapter.tool);
  const stale = assessments.filter((assessment) => assessment.stale).length;
  let refresh: string;
  if (off) {
    refresh = `off (${off})${stale ? `. Bring them up to date with: ${setupCommand}` : ""}`;
  } else if (bundle === UNRELEASED_COLLECTOR_VERSION) {
    refresh = "on, but a bundle built from a checkout doesn't refresh";
  } else {
    const when = last ? `last checked ${describeAge(now - Date.parse(last.checkedAt))}` : "not checked yet";
    const what = last && last.updated.length ? `, updated ${last.updated.map(tidy).join(", ")}` : "";
    const failed = last && last.failed.length ? `, could not write ${last.failed.map(tidy).join(", ")}` : "";
    const pending = stale ? `. ${stale === 1 ? "One registration is" : `${stale} registrations are`} behind; the next hook to run after the daily check brings ${stale === 1 ? "it" : "them"} up` : "";
    refresh = `on, once a day from the installed bundle (${when}${what}${failed})${pending}`;
  }
  lines.push(`    Daily refresh       ${refresh}`);
  return lines;
}
