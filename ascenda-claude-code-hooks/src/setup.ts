import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ascendaHome, createPairingSession, hookRunnerCommand, installHookRunner, terminalStyle, defaultTokenFilePath, describeCollectorVersion, describeHookSetChanges, getPairingStatus, hookSetArgument, hookSetChanges, hookSetOfCommand, initiativesStatusLines, persistEventWriteToken, readTokenFile, renderSetupDisclosure, studyNoticeStatus } from "@ascenda-one/tool-kit";
import type { DisclosureFamily, Tone } from "@ascenda-one/tool-kit";
import { DEFAULT_API_BASE_URL, envOverride, localOnlyInstall } from "./config.js";
import { describeAge, readLastHook, resolveHookNode } from "./hookHealth.js";
import { LAUNCHER_OPTIONS } from "./launcher.js";
import { credentialsFilePath, hookBinPath, selfCommand, hookBundlePath, hookNoNodePath, hookNodeRecordPath, readCredentials, removeCredentials, writeCredentials } from "./paths.js";
import type { MachineCredentials } from "./paths.js";
import { ASCENDA_TOOL_TYPE } from "./types.js";

/**
 * Hook events worth registering.
 *
 * **This list and the mapper are one change, always.** A hook mapped but not
 * registered never fires; a hook registered but not mapped spawns a process to
 * send nothing. Both halves have been wrong here before: `PostToolUseFailure`
 * was mapped and unregistered, so every failed tool call was silently zero
 * until v0.1.24, and `Notification` was unregistered *because* it mapped to
 * nothing — two absences that each justified the other.
 *
 * `Notification` is how Claude Code signals it has stopped and is waiting on
 * the person. That is the interruption leg, and it is not the same event as
 * `AskUserQuestion`, which rides `ai_tool_call_started` and is counted
 * separately. Registering it costs one process per wait — a rate bounded by
 * how often a human is asked, not by tool volume.
 *
 * `PostToolUseFailure` is where Claude Code reports a tool call that failed; a
 * failure never reaches `PostToolUse`. Leaving it out drops every failed call.
 *
 * `StopFailure` fires instead of `Stop` when an API error (a rate limit, an
 * overloaded server, an expired login) ends the turn. It sends nothing to
 * Ascenda: it exists for the live signal alone, which otherwise has no way to
 * learn the turn is over and holds the gauge up until the session goes stale.
 * That makes it the one registered hook the mapper deliberately maps to
 * nothing, and `emitLive` in cli.ts is its other half. Its rate is bounded by
 * API errors, so it costs almost nothing.
 *
 * `SessionEnd` closes the session `SessionStart` opened. It writes the end to
 * the outbox and never waits on the network, so it fits the shared 1.5s
 * Claude Code gives these hooks by default. It gets the same 5s timeout as
 * the rest anyway: Node's startup, or npx resolving the package on the plugin
 * channel, can eat most of 1.5s on a slow machine.
 *
 * `SubagentStart` and `SubagentStop` mark a subagent's span under its parent
 * session. They're registered with no matcher, so every agent type fires them,
 * including the empty type Claude Code's internal agents stop with. Their rate
 * is one pair per subagent run, well below tool volume.
 */
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "StopFailure", "Notification", "SessionEnd", "SubagentStart", "SubagentStop"] as const;

/**
 * The version of {@link HOOK_EVENTS}, written onto every registered command
 * as `--hook-set <n>` and copied onto each live signal, so the desktop app
 * can tell an install that predates `StopFailure` and say how to upgrade it.
 *
 * Set 1 is every registration without the flag. Set 2 added `StopFailure`
 * and `Notification`, eleven events. Set 3 is the thirteen above, adding
 * `SubagentStart` and `SubagentStop`. Bump this whenever the list changes,
 * along with the plugin's `hooks/hooks.json` and `kCurrentHookSets` in the
 * app.
 */
export const HOOK_SET = 3;

/**
 * Claude Code's default timeout for `command` hooks is 600s. Telemetry that
 * cannot complete in a few seconds is not worth waiting for, and a hung request
 * would otherwise stall the user's turn.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/** Identifies our entries so re-running replaces them instead of appending duplicates. */
const HOOK_MARKER = "ascenda-claude-hook";

/**
 * What this adapter sends beyond the families every collector sends.
 *
 * Claude Code is the richest emitter in the repo, and each of these is a key
 * its mapper actually writes: `modelId`/`modelClass` on SessionStart, the
 * `autonomyMode` posture on most events, `gitAction` and `milestoneKind` off a
 * recognised bash command, `linesChangedBucket` and `userModified` on a file
 * write, `interruptionKind` on a Notification, and `subagentId` and
 * `subagentClass` on a subagent's start and stop.
 *
 * It omits `context` deliberately: compaction and pressure events are sent,
 * but no occupancy figure rides them, and the context line would claim one.
 */
export const SENDS: readonly DisclosureFamily[] = ["model", "posture", "git", "edits", "waiting", "subagents"];

type Scope = "project" | "user";

type Options = {
  apiBaseUrl?: string;
  toolInstallationId?: string;
  token?: string;
  scope: Scope;
  projectDir: string;
  dryRun: boolean;
  /** False under `--no-pair`: install the local half and stop there. */
  pair: boolean;
  action: "install" | "status" | "uninstall" | "help";
};

const USAGE = `ascenda-claude-hook setup — wire Claude Code to Ascenda telemetry

  npx @ascenda-one/claude-code-hooks setup [options]
  npx @ascenda-one/claude-code-hooks status [--scope project|user]
  npx @ascenda-one/claude-code-hooks doctor
  npx @ascenda-one/claude-code-hooks pair [--tool-type <type>]
  npx @ascenda-one/claude-code-hooks uninstall
  npx @ascenda-one/claude-code-hooks object <purpose> [--undo]

  doctor  prints the send journal, outbox and one live round trip
  pair    prints a code to paste into the app, then waits for confirmation
  object  stop being counted for a purpose your organisation counts unless
          you object, from the next report; --undo reverses it

Options
  --api-base-url <url>          ingest host (default ${DEFAULT_API_BASE_URL})
  --local [port]                shorthand for the local dev server (default port 4477)
  --tool-installation-id <id>   reuse an existing pairing instead of creating one
  --token <eventWriteToken>     reuse an existing token (stored 0600, never printed)
  --no-pair                     install without pairing: local features on, nothing sent
                                (--no-pairing is accepted too)
  --scope user|project          where hooks are registered (default user: every project)
  --project-dir <path>          project root for --scope project (default cwd)
  --dry-run                     print what would change, write nothing
  -h, --help
`;

export async function runSetup(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.action === "help") {
    console.log(USAGE);
    return 0;
  }
  if (options.action === "status") return await printStatus(options);
  if (options.action === "uninstall") return uninstall(options);

  const apiBaseUrl = (options.apiBaseUrl ?? readCredentials()?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");

  const ui = terminalStyle();
  const row = (tone: Tone, label: string, value: string) => console.log(`  ${ui.mark(tone)} ${label.padEnd(12)} ${value}`);
  const detail = (label: string, value: string) => console.log(ui.dim(`    ${label.padEnd(12)} ${value}`));

  console.log(`${ui.bold("Ascenda setup")} ${ui.dim(`· Claude Code · ${apiBaseUrl}`)}`);

  // Before pairing, not after: pairing is where the consent is given, and a
  // statement printed underneath a completed pairing is a notification rather
  // than a disclosure.
  //
  // A run that will not pair still prints it, because someone choosing to
  // stay local is entitled to know what pairing would cost. But it goes at
  // the end, under "pairing is optional": printed first, its "what this
  // sends" read as what had just been installed, and the install that
  // followed read as a degraded one.
  if (options.pair) console.log(`\n${renderSetupDisclosure({ sends: SENDS, displayName: "Claude Code" })}\n`);
  else console.log("");

  const identity = await resolveIdentity(apiBaseUrl, options);
  const unpaired = identity.pairing === "local-only";
  // Asked for, as against tried and failed. The first is a finished install;
  // the second is a pairing that did not happen and has to say so.
  const chosenLocal = unpaired && !options.pair;

  const binary = installBinary(options.dryRun);
  const node = options.dryRun || process.platform === "win32" ? undefined : resolveHookNode();
  if (node?.problem) row("bad", "hook binary", `${tidyHome(binary)}, but ${node.problem}. Install Node 20 or newer, then run setup again`);
  else row("ok", "hook binary", `${tidyHome(binary)}${node?.version ? ui.dim(` (Node ${node.version})`) : ""}`);

  if (!options.dryRun) {
    const now = new Date().toISOString();
    writeCredentials({
      apiBaseUrl,
      toolInstallationId: identity.toolInstallationId,
      // No fabricated `pairedAt` on an install that has no pairing, and no
      // token file either. The id is the whole record, and it is what `pair`
      // picks up.
      ...(unpaired ? { localOnly: true, installedAt: now } : { pairedAt: now })
    });
  }

  if (isHomeProject(options)) {
    detail("scope", "user (a project install in the home folder only loads when Claude Code starts there)");
    options.scope = "user";
  }
  const settingsFile = settingsPath(options);
  const before = ourHookSets(readSettingsFile(settingsFile));
  const written = writeSettings(settingsFile, binary, options.dryRun);
  if (written === null) return 1;
  const reach = options.scope === "user" ? "every project" : "this project only";
  row("ok", "hooks", `${tidyHome(settingsFile)} ${ui.dim(`(${HOOK_EVENTS.length} events, ${reach}${written ? "" : ", already current"})`)}`);
  const changes = describeHookSetChanges(hookSetChanges(before, HOOK_EVENTS), HOOK_SET);
  if (changes) detail("", changes);
  // Both scopes fire. An install in the other one means every event runs
  // twice and every count doubles, and an older install there may name a
  // binary this run just replaced. Our entries are told apart from anyone
  // else's by the marker, so they are moved rather than reported: this run's
  // file keeps them, the other loses them, and its other hooks are untouched.
  const otherFiles = new Set([
    settingsPath({ ...options, scope: options.scope === "user" ? "project" : "user" }),
    // The home folder's project file, where a project-scope setup run from
    // `~` used to put them.
    path.join(os.homedir(), ".claude", "settings.local.json")
  ]);
  otherFiles.delete(settingsFile);
  for (const otherFile of otherFiles) {
    if (ourHookSets(readSettingsFile(otherFile)).size === 0) continue;
    if (options.dryRun) {
      row("info", "moved", `would remove the copy in ${tidyHome(otherFile)}, so each event runs once`);
    } else if (removeOurHooks(otherFile)) {
      row("ok", "moved", `removed the copy in ${tidyHome(otherFile)}, so each event runs once ${ui.dim("(backup beside it)")}`);
    } else {
      row("warn", "note", `${tidyHome(otherFile)} registers these hooks too, so each event runs twice.`);
      detail("", "Remove the ascenda-claude-hook entries from one of the two files.");
    }
  }

  if (chosenLocal) {
    row("info", "pairing", `none, as asked ${ui.dim("(--no-pair)")}`);
  } else if (unpaired) {
    row("warn", "pairing", `not paired: ${identity.reason}`);
    if (identity.hint) detail("", identity.hint);
  } else {
    row("ok", "pairing", `${identity.toolInstallationId}${ui.dim(identity.pairing === "new" ? " (new)" : " (existing)")}`);
  }
  if (unpaired) detail("installation", `${identity.toolInstallationId} (kept, so pairing later attaches to it)`);
  detail("credentials", tidyHome(credentialsFilePath()));

  if (options.dryRun) {
    console.log("\nDry run. Nothing was written.");
    return 0;
  }

  // Which half is live, spelled out, and in the right key. A failed pairing
  // that reads like a success is how someone comes to believe they paired;
  // a chosen local install that reads like a failure is how someone new
  // decides the install broke. The screen saver needs no pairing at all.
  const self = selfCommand();
  const next = (label: string, value: string) => console.log(`  ${ui.bold(label.padEnd(6))} ${value}`);
  console.log("");
  if (chosenLocal) {
    console.log(`${ui.mark("ok")} ${ui.bold("Ready.")} The screen saver and the Ascenda app's live view work now.`);
    console.log("  They run on this machine and need no account or pairing.");
  } else if (unpaired) {
    console.log(`${ui.mark("warn")} ${ui.bold("Installed, not paired.")} The screen saver and the live view work now.`);
    console.log(`  Your sessions won't reach Ascenda's servers until pairing completes.`);
  } else {
    console.log(`${ui.mark("ok")} ${ui.bold("Done.")} Paired, and the hooks are installed.`);
  }
  console.log("");
  next("Next", `${restartLine(options)} Then type ${ui.cyan("/hooks")}: Ascenda's are under ${options.scope === "user" ? "User" : "Local"}.`);
  next("Check", ui.cyan(`${self} doctor`));
  if (unpaired) next(chosenLocal ? "Pair" : "Retry", `${ui.cyan(`${self} pair`)}${chosenLocal ? ui.dim("  (optional)") : ""}`);

  if (chosenLocal) {
    console.log("");
    console.log(ui.dim("  Pairing sends the details below to Ascenda's servers, under the account the"));
    console.log(ui.dim("  Ascenda app is signed in to when you confirm the code, so your sessions appear"));
    console.log(ui.dim("  in the app. Until you pair, nothing leaves this machine."));
    console.log("");
    console.log(ui.dim(renderSetupDisclosure({ sends: SENDS, displayName: "Claude Code" }).split("\n").map((line) => `  ${line}`).join("\n")));
  }
  return 0;
}


// ------------------------------------------------------------------ args ---

function parseArgs(argv: string[]): Options {
  // User scope by default. The hooks drive surfaces that belong to the whole
  // machine (the screen saver, the desktop app's gauges), so registering them
  // in one project's file left every other project dark. And the common case
  // made it worse: setup run from the home folder wrote
  // ~/.claude/settings.local.json, which Claude Code reads only when it is
  // started in the home folder itself.
  const options: Options = {
    scope: "user",
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    dryRun: false,
    pair: true,
    action: "install"
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "setup":
      case "install":
        options.action = "install";
        break;
      case "status":
        options.action = "status";
        break;
      case "uninstall":
        options.action = "uninstall";
        break;
      case "--api-base-url":
        options.apiBaseUrl = next();
        break;
      case "--local": {
        // Optional positional port, so `--local` and `--local 5000` both work.
        const peek = argv[i + 1];
        const port = peek && /^\d+$/.test(peek) ? argv[++i] : "4477";
        options.apiBaseUrl = `http://localhost:${port}`;
        break;
      }
      case "--tool-installation-id":
        options.toolInstallationId = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--scope": {
        const value = next();
        if (value !== "project" && value !== "user") throw new Error(`--scope must be project or user, got ${value}`);
        options.scope = value;
        break;
      }
      case "--project-dir":
        options.projectDir = path.resolve(next());
        break;
      case "--no-pair":
      // `--no-pairing` is the spelling the CLI agents' setup landed under
      // first, and the one their README still showed for a day. Both parse
      // everywhere, so a person who read either page gets the install rather
      // than "unknown argument".
      case "--no-pairing":
        options.pair = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.action = "help";
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

/**
 * The home folder's `.claude/settings.local.json` is a project file for the
 * project at `~`, not a user file: it loads only when Claude Code is started
 * in the home folder. A project-scope install there looks right in `/hooks`
 * from `~` and is missing everywhere else, so it is treated as user scope.
 */
function isHomeProject(options: Options): boolean {
  return options.scope === "project" && path.resolve(options.projectDir) === path.resolve(os.homedir());
}

// -------------------------------------------------------------- identity ---

/**
 * What the install turned out to be.
 *
 * `local-only` is a finished install with the delivery half dormant: the hook
 * binary, the hook registration and an installation id, and no token. It is
 * reached either on request (`--no-pair`) or because pairing could not
 * complete, and `reason` records which — the summary prints it, because a
 * degrade nobody is told about is how someone comes to believe they paired.
 */
type Identity = {
  toolInstallationId: string;
  pairing: "new" | "existing" | "local-only";
  /** Why there is no pairing. Present on `local-only` only. */
  reason?: string;
  /** Extra advice for this particular reason, when there is any. */
  hint?: string;
};

/**
 * Reuse an existing pairing when one is already on the machine, otherwise
 * create one. The local dev server auto-confirms; a real backend needs the
 * 6-digit code confirmed in the Ascenda app, so we print it and poll.
 *
 * Nothing here fails the install. A backend that cannot be reached, a code
 * nobody confirms, an expired session: each leaves a local-only install
 * rather than an empty one. The hooks' local half needs no pairing at all —
 * the session prompts and the live socket signal run before any of this is
 * consulted — so the person who has not paired yet is precisely the person
 * refusing to install would strand.
 */
async function resolveIdentity(apiBaseUrl: string, options: Options): Promise<Identity> {
  const existingId = options.toolInstallationId ?? readCredentials()?.toolInstallationId;

  if (existingId && options.token) {
    if (!options.dryRun) persistEventWriteToken(defaultTokenFilePath(existingId), options.token);
    return { toolInstallationId: existingId, pairing: "existing" };
  }
  if (existingId && readTokenFile(defaultTokenFilePath(existingId))) {
    return { toolInstallationId: existingId, pairing: "existing" };
  }

  // Minted before pairing is attempted, and recorded either way. `pair` reads
  // the same field, so finishing later attaches to this id instead of minting
  // a second one — which is what would leave the registered hooks naming an
  // installation nothing will ever pair.
  const toolInstallationId = existingId
    ?? (options.dryRun ? `${ASCENDA_TOOL_TYPE}:<minted at run time>` : `${ASCENDA_TOOL_TYPE}:${crypto.randomUUID()}`);

  if (!options.pair) {
    return { toolInstallationId, pairing: "local-only", reason: "asked not to pair (--no-pair)" };
  }
  if (options.dryRun) {
    return { toolInstallationId, pairing: "existing" };
  }

  let session;
  try {
    session = await createPairingSession(apiBaseUrl, toolInstallationId, ASCENDA_TOOL_TYPE, `Claude Code on ${os.hostname()}`);
  } catch (error) {
    return {
      toolInstallationId,
      pairing: "local-only",
      reason: `could not reach ${apiBaseUrl} (${error instanceof Error ? error.message : String(error)})`,
      hint: "for a local dev server use --local, or name your backend with --api-base-url"
    };
  }

  const outcome = await pollForToken(apiBaseUrl, session.pairingSessionId, session.code, session.expiresAt);
  if ("reason" in outcome) return { toolInstallationId, pairing: "local-only", reason: outcome.reason };

  persistEventWriteToken(defaultTokenFilePath(toolInstallationId), outcome.token);
  return { toolInstallationId, pairing: "new" };
}

/** The token, or why the wait ended without one. */
type PairingOutcome = { token: string } | { reason: string };

/** Polls that may fail in a row before the wait is abandoned. */
const POLL_ERROR_TOLERANCE = 3;

async function pollForToken(apiBaseUrl: string, pairingSessionId: string, code: string, expiresAt: string): Promise<PairingOutcome> {
  const deadline = Math.min(Date.parse(expiresAt) || Date.now() + 300_000, Date.now() + 300_000);
  let announced = false;
  let failures = 0;

  while (Date.now() < deadline) {
    // A dropped wifi link mid-wait used to throw straight out of setup, past
    // the binary and the hook registration, leaving nothing installed. A few
    // failed polls are a blip; a run of them is the network, and either way
    // the install still finishes.
    let status;
    try {
      status = await getPairingStatus(apiBaseUrl, pairingSessionId);
      failures = 0;
    } catch (error) {
      if (++failures >= POLL_ERROR_TOLERANCE) {
        return { reason: `lost contact while waiting (${error instanceof Error ? error.message : String(error)})` };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    // Contract: the token is returned once, on the first paired poll.
    if (status.status === "paired" && status.eventWriteToken) return { token: status.eventWriteToken };
    if (status.status === "expired" || status.status === "cancelled") return { reason: `pairing ${status.status}` };
    if (!announced) {
      console.log(`\n  Confirm in the Ascenda app — code ${code}`);
      console.log("  Waiting...");
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return { reason: "no confirmation within 5 minutes" };
}

function tidyHome(file: string): string {
  const home = os.homedir();
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function restartLine(options: Options): string {
  return options.scope === "user"
    ? "Restart Claude Code to load the hooks."
    : "Restart Claude Code in this project to load the hooks.";
}

// ---------------------------------------------------------------- binary ---

/**
 * Copy the running bundle to ~/.ascenda/bin, with the launcher that runs it.
 * `npx` caches its download in a temp directory that is not stable across
 * runs, so hooks must not point at it.
 *
 * The launcher is what the hook commands name; see launcher.ts for why a
 * shell script stands between Claude Code and Node. It is seeded with the
 * Node running this setup, and finds another on its own if that one goes.
 *
 * Windows has no `/bin/sh`, so it keeps the earlier shape: the bundle at the
 * command's path, run by the Node that ran setup.
 */
function installBinary(dryRun: boolean): string {
  return installHookRunner({ ...LAUNCHER_OPTIONS, dryRun });
}

// -------------------------------------------------------------- settings ---

function settingsPath(options: Options): string {
  return options.scope === "user"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(options.projectDir, ".claude", "settings.local.json");
}

type HookEntry = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

/**
 * Merge our hooks into the settings file, preserving everything else. Returns
 * true when the file changed, false when it was already current, null on error.
 */
export function writeSettings(settingsFile: string, binary: string, dryRun: boolean): boolean | null {
  let settings: Settings = {};
  const exists = fs.existsSync(settingsFile);

  if (exists) {
    const raw = fs.readFileSync(settingsFile, "utf8").trim();
    if (raw) {
      try {
        settings = JSON.parse(raw) as Settings;
      } catch {
        // Never overwrite a file we cannot understand — it is the user's
        // Claude Code configuration, not ours.
        console.error(`\n${settingsFile} is not valid JSON. Fix or move it, then run setup again.`);
        return null;
      }
    }
  }

  const command = hookCommand(binary);
  const hooks = { ...(settings.hooks ?? {}) };

  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((group) => !isOurs(group));
    hooks[event] = [...kept, { hooks: [{ type: "command", command: `${command} ${event}${hookSetArgument(HOOK_SET)}`, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }

  const updated: Settings = { ...settings, hooks };
  const serialised = `${JSON.stringify(updated, null, 2)}\n`;
  if (exists && fs.readFileSync(settingsFile, "utf8") === serialised) return false;

  if (dryRun) {
    console.log(`\n--- ${settingsFile} (dry run) ---\n${serialised}`);
    return true;
  }

  // Back up before touching a pre-existing file: hook registration is the
  // highest-blast-radius thing this command does.
  if (exists) fs.copyFileSync(settingsFile, `${settingsFile}.ascenda-backup`);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, serialised, "utf8");
  return true;
}

/**
 * The launcher alone: it finds Node itself (launcher.ts). Naming Node here
 * pinned the exact version that ran setup, and a version manager removes
 * that path long before anyone thinks to re-run setup.
 *
 * Windows keeps the pinned interpreter, having no launcher.
 */
function hookCommand(binary: string): string {
  return hookRunnerCommand(binary);
}

/**
 * Takes our entries out of one settings file, keeping everything else.
 * Returns false when the file could not be read or written.
 */
function removeOurHooks(settingsFile: string): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Settings;
    const hooks = { ...(settings.hooks ?? {}) };
    for (const event of Object.keys(hooks)) {
      const kept = hooks[event].filter((group) => !isOurs(group));
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    const updated: Settings = { ...settings, hooks };
    if (!Object.keys(hooks).length) delete updated.hooks;
    fs.copyFileSync(settingsFile, `${settingsFile}.ascenda-backup`);
    fs.writeFileSync(settingsFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some((entry) => typeof entry.command === "string" && entry.command.includes(HOOK_MARKER));
}

/**
 * Hook commands that look like ours but do not run the installed binary: an
 * abandoned wrapper script, an earlier install, or a binary that has moved.
 * Claude Code swallows hook failures, so such an entry quietly spawns a failing
 * process on every event — `setup` cannot remove it (it is indistinguishable
 * from a hook the user wrote), so `status` has to name it.
 */
export function findStaleHookCommands(settings: Settings, binary: string): string[] {
  const stale = new Set<string>();
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const entry of group.hooks ?? []) {
        const command = entry?.command;
        if (typeof command !== "string") continue;
        if (!/ascenda/i.test(command) || command.includes(binary)) continue;
        stale.add(command);
      }
    }
  }
  return [...stale];
}

// --------------------------------------------------------------- lifecycle ---

/** A settings file, or an empty one when it is missing or unparseable. */
function readSettingsFile(settingsFile: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Settings;
  } catch {
    return {};
  }
}

/** Each event with one of our hooks, mapped to the hook set its command names. */
export function ourHookSets(settings: Settings): Map<string, number> {
  const sets = new Map<string, number>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      if (!isOurs(group)) continue;
      for (const entry of group.hooks ?? []) {
        if (typeof entry?.command !== "string") continue;
        const set = hookSetOfCommand(entry.command);
        sets.set(event, Math.min(set, sets.get(event) ?? set));
      }
    }
  }
  return sets;
}

/** Reads a settings file and counts our hooks in it. Missing or unparseable reads as none. */
function countRegistered(settingsFile: string, binary: string): { settings: Settings; registered: number } {
  const settings = readSettingsFile(settingsFile);
  return { settings, registered: HOOK_EVENTS.filter((event) => (settings.hooks?.[event] ?? []).some(isOurs)).length };
}

/**
 * Where our hooks are registered, for `doctor`: the user file, the project
 * file for `projectDir`, and the home folder's project file, each with a
 * count. Only files that carry at least one of ours are listed.
 */
export function registrationSummary(projectDir: string): { file: string; scope: "user" | "project"; registered: number; homeProject: boolean }[] {
  const binary = hookBinPath();
  const files = new Map<string, "user" | "project">([
    [settingsPath({ scope: "user", projectDir } as Options), "user"],
    [settingsPath({ scope: "project", projectDir } as Options), "project"],
    [path.join(os.homedir(), ".claude", "settings.local.json"), "project"]
  ]);
  const found: { file: string; scope: "user" | "project"; registered: number; homeProject: boolean }[] = [];
  for (const [file, scope] of files) {
    const { registered } = countRegistered(file, binary);
    if (registered === 0) continue;
    found.push({ file, scope, registered, homeProject: path.resolve(file) === path.resolve(os.homedir(), ".claude", "settings.local.json") });
  }
  return found;
}

/** How many events setup registers, for the summary above. */
export const REGISTERED_EVENT_COUNT = HOOK_EVENTS.length;

async function printStatus(options: Options): Promise<number> {
  const credentials = readCredentials();
  const settingsFile = settingsPath(options);
  const binary = hookBinPath();
  const tokenFile = credentials?.toolInstallationId ? defaultTokenFilePath(credentials.toolInstallationId) : undefined;
  const unpaired = localOnlyInstall(credentials);

  const here = countRegistered(settingsFile, binary);
  const settings = here.settings;
  const registered = here.registered;
  // `status` checks one scope — the same default `setup` writes to. A
  // machine set up in the other one used to report a flat `0/7 registered`,
  // which reads as "the install failed" rather than "you are looking in the
  // other place". Look in the other scope before saying nothing is there,
  // and name where it actually is.
  const otherScope: Options = { ...options, scope: options.scope === "user" ? "project" : "user" };
  const otherFile = settingsPath(otherScope);
  const elsewhere = registered === 0 && otherFile !== settingsFile
    ? countRegistered(otherFile, binary)
    : undefined;
  const stale = findStaleHookCommands(settings, binary);

  console.log(`version        ${describeCollectorVersion()}`);
  console.log(`api base url   ${credentials?.apiBaseUrl ?? "— not configured"}`);
  console.log(`pairing        ${describePairing(credentials, unpaired)}`);
  // The environment counts as a token here, the same way it does for a hook.
  // Reading only the file made `delivery` claim nothing could be sent on a
  // machine that was sending perfectly well from an exported token.
  const fileToken = Boolean(tokenFile && readTokenFile(tokenFile));
  const token = fileToken || Boolean(envOverride("ASCENDA_EVENT_WRITE_TOKEN"));
  console.log(`token          ${fileToken ? "present" : token ? "from ASCENDA_EVENT_WRITE_TOKEN (no file)" : unpaired ? "— none until this install is paired" : "— missing"}`);
  console.log(`delivery       ${token ? "active" : unpaired
    ? "inactive — nothing is sent, and nothing is queued for later"
    : "— no token for this pairing, so nothing can be sent"}`);
  console.log("local features active — the session prompts and the live socket signal need no pairing");
  console.log(`hook binary    ${fs.existsSync(binary) ? binary : "— not installed"}`);
  // Registered is not the same as runnable. Claude Code swallows a hook that
  // cannot start, so "13/13 registered" used to sit beside a machine where
  // no hook had ever run. Asked with a bare PATH, the way a Dock-launched
  // Claude Code would ask.
  const node = process.platform === "win32" ? undefined : resolveHookNode();
  if (node) {
    console.log(node.problem
      ? `node           — ${node.problem}. Install Node 20 or newer, then run setup again`
      : `node           ${node.node} (${node.version}, ${node.how === "recorded" ? "recorded at setup" : "found by the launcher"})`);
  }
  const last = readLastHook();
  console.log(last
    ? `last hook      ${last.event}, ${describeAge(Date.now() - Date.parse(last.at))}`
    : "last hook      — none has run yet. Start Claude Code (restart it if it was open during setup), then check /hooks");
  console.log(`hooks          ${registered}/${HOOK_EVENTS.length} registered in ${settingsFile}`);
  if (elsewhere && elsewhere.registered > 0) {
    console.log(`               ${elsewhere.registered}/${HOOK_EVENTS.length} found in ${otherFile} (--scope ${otherScope.scope})`);
  }
  const where = registered > 0 ? { settings, scope: options.scope } : elsewhere && elsewhere.registered > 0 ? { settings: elsewhere.settings, scope: otherScope.scope } : undefined;
  if (where) {
    const oldest = Math.min(...ourHookSets(where.settings).values());
    console.log(oldest < HOOK_SET
      ? `hook set       ${oldest}, this version registers ${HOOK_SET}. Upgrade: npx @ascenda-one/claude-code-hooks setup${where.scope === "user" ? " --scope user" : ""}`
      : `hook set       ${HOOK_SET} (current)`);
  }

  if (stale.length) {
    console.log(`stale hooks    ${stale.length} not pointing at the installed binary — each one fails silently per event:`);
    for (const command of stale) console.log(`               ${command}`);
    console.log(`               Remove them from ${settingsFile} by hand; setup cannot tell them from a hook you wrote.`);
  }

  // For the person at the keyboard only. Nothing here is fetched for an
  // install that isn't paired, and nothing from it reaches a hook or an agent.
  const tokenValue = unpaired ? undefined : (tokenFile ? readTokenFile(tokenFile) : undefined) ?? envOverride("ASCENDA_EVENT_WRITE_TOKEN") ?? undefined;
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? credentials?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const [initiativeLines, notices] = await Promise.all([
    initiativesStatusLines({ apiBaseUrl, eventWriteToken: tokenValue, pairCommand: `${selfCommand()} pair` }),
    studyNoticeStatus({ apiBaseUrl, eventWriteToken: tokenValue, commandPrefix: "npx @ascenda-one/claude-code-hooks" })
  ]);
  console.log("");
  for (const line of initiativeLines) console.log(line);
  for (const line of notices.lines) console.log(line);
  // Only a person at a terminal has been shown the notice; see `markShown`.
  if (process.stdout.isTTY) await notices.markShown();

  if (unpaired) {
    console.log("\nNot paired, which the screen saver and the live view don't need.");
    console.log(`To send your sessions to Ascenda's servers, so they appear in the app:  ${selfCommand()} pair`);
  }

  // User settings apply in every project, so hooks found there answer a
  // project-scope check and the install is not broken. The reverse does not
  // hold: one project's file says nothing about the machine, so a `--scope
  // user` check that finds only project hooks still reports them missing.
  const wired = registered === HOOK_EVENTS.length
    || (options.scope === "project" && elsewhere?.registered === HOOK_EVENTS.length);
  const healthy = credentials?.toolInstallationId && wired && fs.existsSync(binary) && !stale.length && !node?.problem;
  return healthy ? 0 : 1;
}

/**
 * The pairing line. An installation with no pairing is a state this command
 * has to be able to describe as installed, because it is one: the hooks are
 * registered and the local half of them works.
 */
function describePairing(credentials: MachineCredentials | undefined, unpaired: boolean): string {
  if (!credentials?.toolInstallationId) return "— not paired";
  if (!unpaired) return credentials.toolInstallationId;
  const when = credentials.installedAt ? `, installed ${credentials.installedAt}` : "";
  return `${credentials.toolInstallationId} (not paired${when})`;
}

/** Removes our hook entries and the installed binary. Tokens are left alone: revocation is app-side. */
function uninstall(options: Options): number {
  // Read before the record goes: an install that was never paired has no
  // token to revoke, and saying otherwise sends someone looking in the app
  // for a tool that was never there.
  const unpaired = localOnlyInstall();
  const settingsFile = settingsPath(options);

  if (fs.existsSync(settingsFile)) {
    if (!removeOurHooks(settingsFile)) {
      console.error(`could not parse ${settingsFile} — remove the ascenda hook entries by hand`);
      return 1;
    }
    console.log(`hooks removed from ${settingsFile}`);
  }

  for (const file of [hookBinPath(), hookBundlePath(), hookNodeRecordPath(), hookNoNodePath()]) {
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file);
    if (file === hookBinPath() || file === hookBundlePath()) console.log(`removed ${file}`);
  }
  const credentialsFile = credentialsFilePath();
  if (fs.existsSync(credentialsFile)) {
    removeCredentials();
    console.log(fs.existsSync(credentialsFile)
      ? `cleared the Claude Code pairing from ${credentialsFile} (other tools' pairings kept)`
      : `removed ${credentialsFile}`);
  }
  console.log(unpaired
    ? "this install was never paired, so there is no token here and nothing to revoke"
    : `tokens left in ${path.join(ascendaHome(), "tokens")} — revoke in the Ascenda app to invalidate them`);
  return 0;
}
