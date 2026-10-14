/**
 * A recurring `import --ship`, installed as a per-user job.
 *
 * macOS gets a launchd agent, Linux a systemd user timer. Windows gets the
 * `schtasks` command printed and nothing written: the repo has no Windows
 * scheduling code to build on and a scheduled task is a thing to read before
 * running.
 *
 * Why it exists: Claude Code deletes transcripts older than `cleanupPeriodDays`
 * (30 unless set). A person with no Flow app has nothing else keeping the
 * import current, and a run that comes later than the purge window has lost
 * the days in between for good. So the interval is bounded by the retention.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ClaudeRetentionPlan } from "./retention.js";

/**
 * Two weeks. With the default 30-day purge that leaves room for one missed run
 * (a laptop that was shut for a fortnight) before any transcript is out of
 * reach of the next one. 21 days would leave none, and anything longer than
 * the retention window loses data on a perfectly healthy schedule.
 */
export const DEFAULT_INTERVAL_DAYS = 14;
export const MAX_INTERVAL_DAYS = 90;

/** How many runs in a row may fail before the purge catches up. */
const RUNS_OF_HEADROOM = 2;

export const LAUNCHD_LABEL = "one.ascenda.history-import";
export const SYSTEMD_UNIT = "ascenda-history-import";

export type SchedulePlatform = "darwin" | "linux" | "win32" | "other";

export function platformOf(value: string = process.platform): SchedulePlatform {
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
}

/** `14d` or `14`. Whole days only. */
export function parseInterval(raw: string): number {
  const match = /^(\d{1,3})d?$/i.exec(raw.trim());
  const days = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_INTERVAL_DAYS) {
    throw new Error(`--every needs whole days between 1 and ${MAX_INTERVAL_DAYS}, like 14d (got "${raw}")`);
  }
  return days;
}

export interface RetentionVerdict {
  ok: boolean;
  /** One line, set when `ok` is false. */
  reason?: string;
}

/**
 * Whether Claude Code keeps transcripts long enough for this interval.
 *
 * An unset `cleanupPeriodDays` is the 30-day default, and the check wants room
 * for {@link RUNS_OF_HEADROOM} runs inside the window, so one failed run isn't
 * a hole in the history.
 */
export function checkRetention(plan: ClaudeRetentionPlan, everyDays: number): RetentionVerdict {
  const effective = plan.currentCleanupPeriodDays ?? 30;
  if (effective >= everyDays * RUNS_OF_HEADROOM) return { ok: true };
  const label = plan.currentCleanupPeriodDays === null ? "30 days (the default)" : `${effective} days`;
  return {
    ok: false,
    reason:
      `Claude Code deletes transcripts after ${label} (cleanupPeriodDays), too soon for a run every ${everyDays} days. ` +
      "Run `ascenda-history-import fix-retention --apply` first, or pass --override-retention."
  };
}

export interface ScheduledCommand {
  /** Absolute argv: program first. */
  argv: string[];
  /** Env vars to pin into the job. */
  env: Record<string, string>;
}

/**
 * What the job runs. A global or local install runs the same file this process
 * is running, under the same node. A copy in npx's cache can be swept at any
 * time, so that case runs through `npx` instead and fetches on demand.
 */
export function scheduledCommand(
  entry: string = process.argv[1] ?? "",
  node: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): ScheduledCommand {
  const pinned: Record<string, string> = {};
  if (env.ASCENDA_HOME) pinned.ASCENDA_HOME = env.ASCENDA_HOME;
  if (env.ASCENDA_API_BASE_URL) pinned.ASCENDA_API_BASE_URL = env.ASCENDA_API_BASE_URL;
  const inNpxCache = entry.split(path.sep).includes("_npx");
  if (inNpxCache || !entry) {
    return { argv: [path.join(path.dirname(node), "npx"), "-y", "@ascenda-one/history-import", "import", "--ship"], env: pinned };
  }
  return { argv: [node, entry, "import", "--ship"], env: pinned };
}

const xml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(input: { command: ScheduledCommand; everyDays: number; logFile: string; pathEnv: string }): string {
  const args = input.command.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = { PATH: input.pathEnv, ...input.command.env };
  const envLines = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${input.everyDays * 86400}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(input.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logFile)}</string>
</dict>
</plist>
`;
}

const shellQuote = (value: string): string => (/^[A-Za-z0-9_\/.:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

export function systemdService(input: { command: ScheduledCommand; logFile: string }): string {
  const exec = input.command.argv.map(shellQuote).join(" ");
  const env = Object.entries(input.command.env)
    .map(([k, v]) => `Environment=${k}=${v}\n`)
    .join("");
  return `[Unit]
Description=Ascenda history import (ships new AI-usage history)

[Service]
Type=oneshot
${env}ExecStart=${exec}
StandardOutput=append:${input.logFile}
StandardError=append:${input.logFile}
`;
}

export function systemdTimer(input: { everyDays: number }): string {
  return `[Unit]
Description=Run the Ascenda history import every ${input.everyDays} days

[Timer]
OnBootSec=1h
OnUnitActiveSec=${input.everyDays}d
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function schtasksCommand(command: ScheduledCommand, everyDays: number): string {
  const run = command.argv.map((a) => (/\s/.test(a) ? `\\"${a}\\"` : a)).join(" ");
  return `schtasks /Create /TN "Ascenda history import" /SC DAILY /MO ${everyDays} /ST 09:00 /TR "${run}"`;
}

export interface ScheduleEnv {
  platform: SchedulePlatform;
  home: string;
  uid: number;
  /** Runs a program; injected so tests never touch launchctl or systemctl. */
  run: (argv: string[]) => Promise<{ code: number; stdout: string }>;
}

export function defaultScheduleEnv(): ScheduleEnv {
  return {
    platform: platformOf(),
    home: os.homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    run: (argv) =>
      new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.on("error", () => resolve({ code: 127, stdout }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
      })
  };
}

export function scheduleFiles(env: ScheduleEnv): { files: string[]; log: string } {
  const log = path.join(env.home, ".ascenda", "logs", "history-import.log");
  if (env.platform === "darwin") {
    return { files: [path.join(env.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)], log };
  }
  const dir = path.join(env.home, ".config", "systemd", "user");
  return { files: [path.join(dir, `${SYSTEMD_UNIT}.service`), path.join(dir, `${SYSTEMD_UNIT}.timer`)], log };
}

export interface InstallResult {
  written: string[];
  /** Text to show instead of files, on Windows. */
  printed?: string;
  activated: boolean;
}

export async function installSchedule(
  env: ScheduleEnv,
  options: { everyDays: number; command: ScheduledCommand; pathEnv?: string }
): Promise<InstallResult> {
  if (env.platform === "win32") {
    return { written: [], printed: schtasksCommand(options.command, options.everyDays), activated: false };
  }
  if (env.platform === "other") throw new Error("Scheduling is supported on macOS, Linux and (as a printed command) Windows.");

  const { files, log } = scheduleFiles(env);
  await fs.mkdir(path.dirname(log), { recursive: true });
  for (const file of files) await fs.mkdir(path.dirname(file), { recursive: true });

  if (env.platform === "darwin") {
    await fs.writeFile(
      files[0],
      launchdPlist({ command: options.command, everyDays: options.everyDays, logFile: log, pathEnv: options.pathEnv ?? "/usr/local/bin:/usr/bin:/bin" })
    );
    const domain = `gui/${env.uid}`;
    await env.run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]);
    const loaded = await env.run(["launchctl", "bootstrap", domain, files[0]]);
    return { written: files, activated: loaded.code === 0 };
  }

  await fs.writeFile(files[0], systemdService({ command: options.command, logFile: log }));
  await fs.writeFile(files[1], systemdTimer({ everyDays: options.everyDays }));
  await env.run(["systemctl", "--user", "daemon-reload"]);
  const enabled = await env.run(["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`]);
  return { written: files, activated: enabled.code === 0 };
}

export async function removeSchedule(env: ScheduleEnv): Promise<{ removed: string[] }> {
  if (env.platform === "win32") return { removed: [] };
  const { files } = scheduleFiles(env);
  if (env.platform === "darwin") {
    await env.run(["launchctl", "bootout", `gui/${env.uid}/${LAUNCHD_LABEL}`]);
  } else {
    await env.run(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]);
  }
  const removed: string[] = [];
  for (const file of files) {
    try {
      await fs.rm(file);
      removed.push(file);
    } catch {
      // Not there. Nothing to remove.
    }
  }
  if (env.platform === "linux") await env.run(["systemctl", "--user", "daemon-reload"]);
  return { removed };
}

export interface ScheduleStatus {
  installed: boolean;
  files: string[];
  everyDays: number | null;
  active: boolean | null;
  log: string;
}

export async function scheduleStatus(env: ScheduleEnv): Promise<ScheduleStatus> {
  const { files, log } = scheduleFiles(env);
  const present: string[] = [];
  for (const file of files) {
    try {
      await fs.access(file);
      present.push(file);
    } catch {
      // absent
    }
  }
  if (present.length === 0) return { installed: false, files: [], everyDays: null, active: null, log };

  let everyDays: number | null = null;
  const text = await fs.readFile(present.find((f) => f.endsWith(".plist") || f.endsWith(".timer")) ?? present[0], "utf8");
  const seconds = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
  const timer = /OnUnitActiveSec=(\d+)d/.exec(text);
  if (seconds) everyDays = Number(seconds[1]) / 86400;
  else if (timer) everyDays = Number(timer[1]);

  const probe =
    env.platform === "darwin"
      ? await env.run(["launchctl", "print", `gui/${env.uid}/${LAUNCHD_LABEL}`])
      : await env.run(["systemctl", "--user", "is-active", `${SYSTEMD_UNIT}.timer`]);
  return { installed: true, files: present, everyDays, active: probe.code === 0, log };
}
