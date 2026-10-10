import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describeCollectorVersion } from "./collectorVersion";
import { credentialsFilePath, isLocalOnlyHostInstall, readHostCredentials, removeHostCredentials, writeEventLogSetting, writeHostCredentials } from "./credentials";
import { describeEventLog, parseEventLogFlag, resolveEventLog } from "./eventLog";
import { DEFAULT_API_BASE_URL, MissingInstallationIdError, resolveCliAgentInstallationId } from "./hookAdapter";
import { createPairingSession, getPairingStatus, readInitiatives } from "./http";
import { describeHookSetChanges, hookSetArgument, hookSetChanges, hookSetOfCommand } from "./hookSet";
import { initiativesStatusLines } from "./initiatives";
import { renderSetupDisclosure } from "./setupDisclosure";
import type { DisclosureFamily } from "./setupDisclosure";
import { describeAge, hookRunnerCommand, hookRunnerPaths, installHookRunner, readLastHook, removeHookRunner, resolveHookNode, tidyHomePath } from "./hookRunner";
import { liveSignalDoctorLines } from "./liveSignalDoctor";
import type { HookRegistration } from "./liveSignalDoctor";
import { defaultStateFilePath, readCollectorState } from "./stateStore";
import { runStudyJoin } from "./studyJoin";
import { runStudyObjection, studyNoticeStatus } from "./studyNotices";
import { terminalStyle } from "./terminalStyle";
import type { TerminalStyle, Tone } from "./terminalStyle";
import { ascendaHome, defaultTokenFilePath, persistEventWriteToken, readTokenFile } from "./tokenStore";

/**
 * The `setup` / `status` / `uninstall` commands every CLI agent adapter
 * ships, so hooks install without a hand-edited environment — the failure
 * class behind issue #48, where an id that lived only in a shell rc file
 * never reached a Dock-launched editor and twelve hours of events were lost.
 *
 * One implementation, parameterised by what genuinely differs per agent:
 * where its hooks file lives, the shape of one entry in it, and whether the
 * hook name travels on argv or on stdin. Pairing, the binary install, the
 * credentials entry and the merge-don't-clobber settings write are the same
 * for all of them, and are the parts that are expensive to get wrong.
 *
 * The Claude Code adapter has its own `setup` that predates this one and
 * carries its own concerns (a top-level credentials entry, the invites on
 * stdout). The two follow the same rules: start hooks through the launcher
 * (`hookRunner.ts`), register them for every project unless asked not to,
 * back up before touching a file, refuse to overwrite what cannot be parsed.
 */
export type HookSettingsFormat = {
  /** Where the agent reads hooks from, per scope. */
  settingsPath: (scope: SetupScope, projectDir: string) => string;
  /** Top-level keys a freshly created file must carry (Cursor's `version: 1`). */
  scaffold?: Record<string, unknown>;
  /** The element registered under `hooks[event]` for our command. */
  entry: (command: string, event: string) => Record<string, unknown>;
  /** The command string inside an element of `hooks[event]`, whatever its shape. */
  commandOf: (entry: unknown) => string | undefined;
};

export type CliAgentSetupSpec = {
  /** The `metadata.host` value and credentials key, e.g. `cursor`. */
  host: string;
  /** How the agent is named to a person and in the pairing, e.g. `Cursor`. */
  displayName: string;
  /** The pairing's tool type — `cli_agent` for every CLI agent. */
  toolType: string;
  /** The npm package, for the usage text, e.g. `@ascenda-one/cursor-hooks`. */
  packageName: string;
  /** The installed binary's basename, e.g. `ascenda-cursor-hook`. Also the marker that identifies our entries. */
  binaryName: string;
  /** The hook events worth registering — only those that map to a catalog event. */
  hookEvents: readonly string[];
  /**
   * The version of {@link hookEvents}, written onto every registered command
   * as `--hook-set <n>` so the live signal can tell the desktop app an
   * install is out of date. Bump it whenever `hookEvents` changes. Absent for
   * an adapter whose list has never changed since installs went out.
   *
   * The flag ends the command that `settings.entry` receives, so it sits
   * before anything `entry` appends. That suits Gemini, which names the hook
   * on stdin. Cursor and Windsurf append the hook name and read it from
   * `argv[2]`, so giving either one a set means moving the flag first.
   */
  hookSet?: number;
  /** What to do once hooks are registered, e.g. `Restart Cursor to load the hooks.` */
  restartHint: string;
  /**
   * The disclosure families this adapter sends beyond `ALWAYS_SENT`, which
   * decide the sentences `setup` prints before it pairs.
   *
   * Hand-written today, and the thing to widen when a mapper starts sending
   * something new — see the module docblock on `setupDisclosure.ts` for why
   * nothing yet fails when it is not widened.
   */
  sends: readonly DisclosureFamily[];
  settings: HookSettingsFormat;
};

export type SetupScope = "project" | "user";

type SetupAction = "install" | "status" | "uninstall" | "doctor" | "help";

type SetupOptions = {
  apiBaseUrl?: string;
  toolInstallationId?: string;
  token?: string;
  scope: SetupScope;
  projectDir: string;
  dryRun: boolean;
  /** True under `--no-pair`: install the local half and stop there. */
  skipPairing: boolean;
  /** `--event-log`'s value: a path or `off`. Absent leaves the saved setting alone. */
  eventLog?: string;
  action: SetupAction;
};

/**
 * The words on argv that mean "a person is typing", as opposed to a hook
 * name the agent is invoking. Every agent's hook names differ in case from
 * these (`stop`, `Stop`, `post_cascade_response`), so the two cannot collide.
 * Checked before stdin is read: a management command carries no payload, so
 * reading stdin first would hang on a pipe nothing will ever write to.
 */
const MANAGEMENT_COMMANDS = new Set(["setup", "install", "status", "uninstall", "doctor", "join", "object", "-h", "--help"]);

export function isCliAgentManagementCommand(argument: string | undefined): boolean {
  return argument !== undefined && MANAGEMENT_COMMANDS.has(argument);
}

/** Where `setup` places the hook launcher, which the hooks file names. No sudo, no npm -g. */
export function cliAgentHookBinPath(binaryName: string): string {
  return hookRunnerPaths(binaryName).launcher;
}

/**
 * How to run this adapter again from a terminal: the installed launcher, not
 * npx. It needs no Node on PATH, and it is the version that was just
 * installed rather than whatever npm has as latest.
 */
export function cliAgentSelfCommand(spec: CliAgentSetupSpec): string {
  return process.platform === "win32" ? `npx ${spec.packageName}` : tidyHomePath(cliAgentHookBinPath(spec.binaryName), os.homedir());
}

function usage(spec: CliAgentSetupSpec): string {
  return `${spec.binaryName} setup — wire ${spec.displayName} to Ascenda telemetry

  npx ${spec.packageName} setup [options]
  npx ${spec.packageName} status
  npx ${spec.packageName} doctor
  npx ${spec.packageName} uninstall
  npx ${spec.packageName} join <code>
  npx ${spec.packageName} object <purpose> [--undo]

Options
  --api-base-url <url>          ingest host (default ${DEFAULT_API_BASE_URL})
  --local [port]                shorthand for the local dev server (default port 4477)
  --tool-installation-id <id>   reuse an existing pairing instead of creating one
  --token <eventWriteToken>     reuse an existing token (stored 0600, never printed)
  --no-pair                     install without pairing: local features on, nothing sent
  --event-log [path|off]        keep every event in a local JSONL file (default ~/.ascenda/events.jsonl).
                                On by default when not paired; machine-wide, shared by every agent
  --scope user|project          where hooks are registered (default user: every project)
  --project-dir <path>          project root for --scope project (default cwd)
  --dry-run                     print what would change, write nothing
  -h, --help
`;
}

export async function runCliAgentSetup(argv: string[], spec: CliAgentSetupSpec): Promise<number> {
  // `join <code>` takes a positional code, not the flag grammar below, and it
  // is checked here rather than folded into `parseArgs` so an unrecognised
  // join code is never mistaken for "unknown argument" against the setup
  // options. Dispatched before stdin is ever touched, like every other
  // management command.
  if (argv[0] === "join") return runCliAgentStudyJoin(argv.slice(1), spec);
  if (argv[0] === "object") return runCliAgentStudyObjection(argv.slice(1), spec);

  let options: SetupOptions;
  try {
    options = parseArgs(argv, spec);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.action === "help") {
    console.log(usage(spec));
    return 0;
  }
  if (options.action === "status") return await printStatus(options, spec);
  if (options.action === "uninstall") return uninstall(options, spec);
  if (options.action === "doctor") return await runDoctor(options, spec);

  const apiBaseUrl = (options.apiBaseUrl ?? readHostCredentials(spec.host)?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const ui = terminalStyle();
  const row = (tone: Tone, label: string, value: string) => console.log(`  ${ui.mark(tone)} ${label.padEnd(12)} ${value}`);
  const detail = (label: string, value: string) => console.log(ui.dim(`    ${label.padEnd(12)} ${value}`));
  console.log(`${ui.bold("Ascenda setup")} ${ui.dim(`· ${spec.displayName} · ${apiBaseUrl}`)}`);

  // Before pairing, not after: pairing is where the consent is given, and a
  // statement printed underneath a completed pairing is a notification rather
  // than a disclosure.
  //
  // A run that will not pair still prints it, because someone choosing to
  // stay local is entitled to know what pairing would cost. But it goes at
  // the end, under "pairing is optional": printed first, its "what this
  // sends" read as what had just been installed, and the install that
  // followed read as a degraded one.
  if (!options.skipPairing) console.log(`\n${renderSetupDisclosure({ sends: spec.sends, displayName: spec.displayName })}`);
  console.log("");

  // Pairing is the only step that needs a person and a network, and the only
  // one that can be left out: the hook bundle and the agent's hooks file know
  // nothing about a pairing. An install that stops here still runs the local
  // half — the live signal to a socket on this machine — and sends nothing,
  // which is what an unpaired hook already did.
  //
  // Two ways to arrive, told apart on screen: asked for (`--no-pair`), which
  // is a finished install, or a pairing that could not finish (host
  // unreachable, code unconfirmed, session expired), which warns. A degrade
  // nobody is told about is how someone comes to believe they paired; a
  // chosen local install that reads like a failure is how someone new
  // decides the install broke.
  let identity: Identity | undefined;
  if (!options.skipPairing) identity = await resolveIdentity(apiBaseUrl, options, spec);

  const binary = installBinary(spec, options.dryRun);
  const node = options.dryRun || process.platform === "win32" ? undefined : resolveHookNode(binary);
  if (node?.problem) row("bad", "hook binary", `${tidyHomePath(binary, os.homedir())}, but ${node.problem}. Install Node 20 or newer, then run setup again`);
  else row("ok", "hook binary", `${tidyHomePath(binary, os.homedir())}${node?.version ? ui.dim(` (Node ${node.version})`) : ""}`);

  if (!options.dryRun) {
    // An unpaired install still records an id: it is what a later `pair`
    // attaches to, so the hooks registered above end up under the id they
    // were installed with rather than orphaned beside a freshly minted one.
    // `localOnly` is the positive evidence that the missing pairing was
    // chosen, and `pairedAt` replaces it, so the two never appear together.
    const now = new Date().toISOString();
    const toolInstallationId = identity?.toolInstallationId
      ?? options.toolInstallationId
      ?? readHostCredentials(spec.host)?.toolInstallationId
      ?? `${spec.toolType}:${crypto.randomUUID()}`;
    writeHostCredentials(spec.host, {
      apiBaseUrl,
      toolInstallationId,
      ...(identity ? { pairedAt: now } : { localOnly: true, installedAt: now })
    });
    if (options.eventLog !== undefined) writeEventLogSetting(options.eventLog);
  }

  if (isHomeProject(options)) {
    detail("scope", "user (a project install in the home folder only loads when the agent starts there)");
    options.scope = "user";
  }
  const settingsFile = spec.settings.settingsPath(options.scope, options.projectDir);
  const before = registeredHookSets(readSettings(settingsFile), spec);
  const written = writeHookSettings(settingsFile, binary, spec, options.dryRun);
  if (written === null) return 1;
  const reach = options.scope === "user" ? "every project" : "this project only";
  row("ok", "hooks", `${tidyHomePath(settingsFile, os.homedir())} ${ui.dim(`(${spec.hookEvents.length} events, ${reach}${written ? "" : ", already current"})`)}`);
  const changes = spec.hookSet === undefined ? undefined : describeHookSetChanges(hookSetChanges(before, spec.hookEvents), spec.hookSet);
  if (changes) detail("", changes);

  // Both scopes fire. An install in the other one means every event runs
  // twice and every count doubles, and an older install there may name a
  // binary this run just replaced. Our entries are told apart from anyone
  // else's by the marker, so they are moved rather than reported: this run's
  // file keeps them, the other loses them, and its other hooks are untouched.
  const otherFile = spec.settings.settingsPath(options.scope === "user" ? "project" : "user", options.projectDir);
  if (otherFile !== settingsFile && registeredHookSets(readSettings(otherFile), spec).size > 0) {
    if (options.dryRun) {
      row("info", "moved", `would remove the copy in ${tidyHomePath(otherFile, os.homedir())}, so each event runs once`);
    } else if (removeOurHookEntries(otherFile, spec)) {
      row("ok", "moved", `removed the copy in ${tidyHomePath(otherFile, os.homedir())}, so each event runs once ${ui.dim("(backup beside it)")}`);
    } else {
      row("warn", "note", `${tidyHomePath(otherFile, os.homedir())} registers these hooks too, so each event runs twice.`);
      detail("", `Remove the ${spec.binaryName} entries from one of the two files.`);
    }
  }

  const chosenLocal = options.skipPairing;
  if (identity) row("ok", "pairing", `${identity.toolInstallationId}${ui.dim(identity.paired ? " (new)" : " (existing)")}`);
  else if (chosenLocal) row("info", "pairing", `none, as asked ${ui.dim("(--no-pair)")}`);
  else row("warn", "pairing", "not paired: pairing did not finish");
  detail("credentials", `${tidyHomePath(credentialsFilePath(), os.homedir())} (tools.${spec.host})`);
  // Read back after writing, so the row shows what a hook will do. A dry
  // run hasn't written, so it reads what is saved now.
  const eventLog = resolveEventLog({ localOnly: !identity });
  if (eventLog.path) row("ok", "events", `${tidyHomePath(eventLog.path, os.homedir())} ${ui.dim("(on this machine only)")}`);
  else if (options.eventLog !== undefined) row("info", "events", "off");

  if (options.dryRun) {
    console.log("\nDry run. Nothing was written.");
    return 0;
  }

  const self = cliAgentSelfCommand(spec);
  const next = (label: string, value: string) => console.log(`  ${ui.bold(label.padEnd(6))} ${value}`);
  console.log("");
  if (chosenLocal) {
    console.log(`${ui.mark("ok")} ${ui.bold("Ready.")} The screen saver and the Ascenda app's live view work now.`);
    console.log("  They run on this machine and need no account or pairing.");
    if (eventLog.path) console.log(`  Every event is also written to ${tidyHomePath(eventLog.path, os.homedir())}, for you or any tool to read.`);
  } else if (!identity) {
    console.log(`${ui.mark("warn")} ${ui.bold("Installed, not paired.")} The screen saver and the live view work now.`);
    console.log("  Your sessions won't reach Ascenda's servers until pairing completes.");
  } else {
    console.log(`${ui.mark("ok")} ${ui.bold("Done.")} Paired, and the hooks are installed.`);
  }
  console.log("");
  next("Next", spec.restartHint);
  next("Check", ui.cyan(`${self} doctor`));
  // Pairing is part of setup for these adapters, so setup is how to pair.
  if (!identity) next(chosenLocal ? "Pair" : "Retry", `${ui.cyan(`${self} setup`)}${chosenLocal ? ui.dim("  (optional)") : ""}`);

  if (chosenLocal) {
    console.log("");
    console.log(ui.dim("  Pairing sends the details below to Ascenda's servers, under the account the"));
    console.log(ui.dim("  Ascenda app is signed in to when you confirm the code, so your sessions appear"));
    console.log(ui.dim("  in the app. Until you pair, nothing leaves this machine."));
    console.log("");
    console.log(ui.dim(renderSetupDisclosure({ sends: spec.sends, displayName: spec.displayName }).split("\n").map((line) => `  ${line}`).join("\n")));
  }
  return 0;
}

/**
 * A project install aimed at the home folder. The agent reads a project file
 * there only when it starts in the home folder, so it is made a user install.
 */
function isHomeProject(options: SetupOptions): boolean {
  return options.scope === "project" && path.resolve(options.projectDir) === path.resolve(os.homedir());
}

// ------------------------------------------------------------------ args ---

function parseArgs(argv: string[], spec: CliAgentSetupSpec): SetupOptions {
  // User scope by default. The hooks drive surfaces that belong to the whole
  // machine (the screen saver, the desktop app's gauges), so registering them
  // for one folder made them work only when the agent started there.
  const options: SetupOptions = {
    scope: "user",
    projectDir: process.cwd(),
    dryRun: false,
    skipPairing: false,
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
      case "doctor":
        options.action = "doctor";
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
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--event-log": {
        const { value, consumed } = parseEventLogFlag(argv, i);
        options.eventLog = value;
        i += consumed;
        break;
      }
      case "--no-pair":
      // `--no-pairing` is the spelling this landed under first. Both appeared
      // only in an unreleased changelog, so this alias exists to spare anyone
      // reading that draft, and `--no-pair` — the Claude Code adapter's own
      // spelling — is the documented one.
      case "--no-pairing":
        options.skipPairing = true;
        break;
      case "-h":
      case "--help":
        options.action = "help";
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n\n${usage(spec)}`);
    }
  }
  return options;
}

// ------------------------------------------------------------------ join ---

/**
 * Resolves this host's own pairing — the same three sources
 * {@link resolveCliAgentInstallationId} already checks for every hook send —
 * and hands off to the shared interactive flow. `join` needs the tool's own
 * write token, exactly like ingest does, because it is the CLI agent asking
 * on the person's behalf, not a signed-in user; the person's own consent is
 * what the confirmation step in the app still requires.
 */
async function runCliAgentStudyJoin(argv: string[], spec: CliAgentSetupSpec): Promise<number> {
  const joinCode = argv[0];
  if (!joinCode || joinCode.startsWith("-")) {
    console.error(`Usage: npx ${spec.packageName} join <code>`);
    return 1;
  }

  const pairing = resolvePairedToken(spec);
  if (!pairing) return 1;
  return runStudyJoin({ ...pairing, displayName: spec.displayName, joinCode });
}

/**
 * `object <purpose> [--undo]`: object to being counted for one purpose your
 * organisation counts unless you object, or withdraw that. The flow itself is
 * shared; see `runStudyObjection` in `studyNotices.ts`.
 */
async function runCliAgentStudyObjection(argv: string[], spec: CliAgentSetupSpec): Promise<number> {
  const pairing = resolvePairedToken(spec);
  if (!pairing) return 1;
  return runStudyObjection({
    ...pairing,
    commandPrefix: `npx ${spec.packageName}`,
    pairCommand: `npx ${spec.packageName} setup`,
    argv
  });
}

/** This host's API base URL and write token, or `undefined` after saying why there isn't one. */
function resolvePairedToken(spec: CliAgentSetupSpec): { apiBaseUrl: string; eventWriteToken: string } | undefined {
  const setupCommand = `npx ${spec.packageName} setup`;
  let toolInstallationId: string;
  try {
    ({ toolInstallationId } = resolveCliAgentInstallationId(spec.toolType, { host: spec.host, setupCommand }));
  } catch (error) {
    console.error(error instanceof MissingInstallationIdError ? error.message : error instanceof Error ? error.message : String(error));
    return undefined;
  }

  const eventWriteToken = readTokenFile(process.env.ASCENDA_EVENT_WRITE_TOKEN_FILE ?? defaultTokenFilePath(toolInstallationId)) ?? process.env.ASCENDA_EVENT_WRITE_TOKEN;
  if (!eventWriteToken) {
    console.error(`Not paired: no write token for ${toolInstallationId}. Run: ${setupCommand}`);
    return undefined;
  }

  // Env override first, same precedence `pair` and every hook send already use:
  // a host override belongs to the machine, not to one agent's pairing record.
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? readHostCredentials(spec.host)?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  return { apiBaseUrl, eventWriteToken };
}

// -------------------------------------------------------------- identity ---

type Identity = { toolInstallationId: string; paired: boolean };

/**
 * Reuse an existing pairing when this host has one whose token still works,
 * otherwise pair. A lapsed token pairs again under the same installation id,
 * so the hooks keep their identity. The local dev server auto-confirms; a
 * real backend needs the 6-digit code confirmed in the Ascenda app, so it is
 * printed and polled for.
 */
async function resolveIdentity(apiBaseUrl: string, options: SetupOptions, spec: CliAgentSetupSpec): Promise<Identity | undefined> {
  const existingId = options.toolInstallationId ?? readHostCredentials(spec.host)?.toolInstallationId;

  if (existingId && options.token) {
    if (!options.dryRun) persistEventWriteToken(defaultTokenFilePath(existingId), options.token);
    return { toolInstallationId: existingId, paired: false };
  }
  const existingToken = existingId ? readTokenFile(defaultTokenFilePath(existingId)) : undefined;
  if (existingId && existingToken) {
    const check = await checkSavedToken(apiBaseUrl, existingId, existingToken);
    if (check === "keep") return { toolInstallationId: existingId, paired: false };
    console.log(`\n  The saved token for ${existingId} isn't accepted any more. Pairing again.`);
  }
  if (options.dryRun) {
    return { toolInstallationId: existingId ?? `${spec.toolType}:<paired at run time>`, paired: false };
  }

  const toolInstallationId = existingId ?? `${spec.toolType}:${crypto.randomUUID()}`;
  let session;
  try {
    session = await createPairingSession(apiBaseUrl, toolInstallationId, spec.toolType, `${spec.displayName} on ${os.hostname()}`);
  } catch (error) {
    console.error(`\nCould not reach ${apiBaseUrl} to pair: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Start the local dev server and use --local, or pass --api-base-url for your backend.");
    return undefined;
  }

  const token = await pollForToken(apiBaseUrl, session.pairingSessionId, session.code, session.expiresAt);
  if (!token) return undefined;

  persistEventWriteToken(defaultTokenFilePath(toolInstallationId), token);
  return { toolInstallationId, paired: true };
}

/** How long setup waits on the token check before keeping the token unchecked. */
const TOKEN_CHECK_TIMEOUT_MS = 5000;

/**
 * Whether a token already on disk still works. A token on disk can be past
 * its 30 days or revoked, and keeping it would leave setup reporting a
 * pairing that sends nothing. The check is a read: renewing would answer the
 * same question, but it rotates the token.
 *
 * Only a 401 means re-pair. Anything else keeps the token, so setup run
 * offline or against a server without this read leaves the pairing alone.
 * The send journal can't decide it either way (the last send may predate a
 * fix), but when the check can't run and the last send was refused, saying
 * so is the one hint the person gets.
 */
async function checkSavedToken(apiBaseUrl: string, toolInstallationId: string, token: string): Promise<"keep" | "repair"> {
  const read = await readInitiatives(apiBaseUrl, token, AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS));
  if (read.kind === "rejected") return "repair";
  if (read.kind === "failed" && readCollectorState(defaultStateFilePath(toolInstallationId))?.lastOutcome === "auth_failed") {
    console.log(`\n  Couldn't check the saved token (${read.reason}), and the last send was refused.`);
    console.log("  Keeping it for now. Run setup again once the server is reachable.");
  }
  return "keep";
}

async function pollForToken(apiBaseUrl: string, pairingSessionId: string, code: string, expiresAt: string): Promise<string | undefined> {
  const deadline = Math.min(Date.parse(expiresAt) || Date.now() + 300_000, Date.now() + 300_000);
  let announced = false;

  while (Date.now() < deadline) {
    const status = await getPairingStatus(apiBaseUrl, pairingSessionId);
    // Contract: the token is returned once, on the first paired poll.
    if (status.status === "paired" && status.eventWriteToken) return status.eventWriteToken;
    if (status.status === "expired" || status.status === "cancelled") {
      console.error(`\nPairing ${status.status}. Run setup again.`);
      return undefined;
    }
    if (!announced) {
      console.log(`\n  Confirm in the Ascenda app — code ${code}`);
      console.log("  Waiting...");
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.error("\nPairing timed out. Run setup again.");
  return undefined;
}

// ---------------------------------------------------------------- binary ---

/**
 * The launcher, the bundle beside it and the Node record (`hookRunner.ts`).
 * `npx` caches its download in a temp directory that is not stable across
 * runs, so hooks must not point at it.
 */
function installBinary(spec: CliAgentSetupSpec, dryRun: boolean): string {
  return installHookRunner({ binaryName: spec.binaryName, setupCommand: `npx ${spec.packageName} setup`, dryRun });
}

// -------------------------------------------------------------- settings ---

type HookSettings = { hooks?: Record<string, unknown[]> } & Record<string, unknown>;

/**
 * Merge our hooks into the agent's settings file, preserving everything else.
 * Returns true when the file changed, false when it was already current, null
 * on error. Exported so an adapter's tests can prove its format lands in the
 * shape its agent reads.
 */
export function writeHookSettings(settingsFile: string, binary: string, spec: CliAgentSetupSpec, dryRun: boolean): boolean | null {
  let settings: HookSettings = { ...(spec.settings.scaffold ?? {}) };
  const exists = fs.existsSync(settingsFile);

  if (exists) {
    const raw = fs.readFileSync(settingsFile, "utf8").trim();
    if (raw) {
      try {
        settings = JSON.parse(raw) as HookSettings;
      } catch {
        // Never overwrite a file we cannot understand — it is the user's
        // agent configuration, not ours.
        console.error(`\n${settingsFile} is not valid JSON. Fix or move it, then run setup again.`);
        return null;
      }
    }
  }

  const command = hookCommand(binary, spec);
  const hooks: Record<string, unknown[]> = { ...(settings.hooks ?? {}) };

  for (const event of spec.hookEvents) {
    const kept = (hooks[event] ?? []).filter((entry) => !isOurs(entry, spec));
    hooks[event] = [...kept, spec.settings.entry(command, event)];
  }

  const updated: HookSettings = { ...settings, hooks };
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
 * The launcher, which finds Node itself. Agents spawn hooks with the
 * environment they were launched with, which on a GUI launch may not have a
 * version-manager Node on PATH, and a pinned Node path breaks the day that
 * version is uninstalled.
 */
function hookCommand(binary: string, spec: CliAgentSetupSpec): string {
  return `${hookRunnerCommand(binary)}${hookSetArgument(spec.hookSet)}`;
}

/**
 * Each event that has one of our hooks, mapped to the hook set its command
 * names. An unreadable or missing file reads as none registered.
 */
export function registeredHookSets(settings: HookSettings, spec: CliAgentSetupSpec): Map<string, number> {
  const sets = new Map<string, number>();
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      if (!isOurs(entry, spec)) continue;
      const set = hookSetOfCommand(spec.settings.commandOf(entry) as string);
      sets.set(event, Math.min(set, sets.get(event) ?? set));
    }
  }
  return sets;
}

function isOurs(entry: unknown, spec: CliAgentSetupSpec): boolean {
  const command = spec.settings.commandOf(entry);
  return typeof command === "string" && command.includes(spec.binaryName);
}

/**
 * Hook commands that look like ours but do not run the installed binary: an
 * abandoned wrapper script, an earlier install, or a binary that has moved.
 * Agents swallow hook failures, so such an entry quietly spawns a failing
 * process on every event — `setup` cannot remove it (it is indistinguishable
 * from a hook the user wrote), so `status` has to name it.
 */
export function findStaleHookCommands(settings: HookSettings, binary: string, spec: CliAgentSetupSpec): string[] {
  const stale = new Set<string>();
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      const command = spec.settings.commandOf(entry);
      if (typeof command !== "string") continue;
      if (!/ascenda/i.test(command) || command.includes(binary)) continue;
      stale.add(command);
    }
  }
  return [...stale];
}

// --------------------------------------------------------------- lifecycle ---

function readSettings(settingsFile: string): HookSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, "utf8")) as HookSettings;
  } catch {
    return {};
  }
}

async function printStatus(options: SetupOptions, spec: CliAgentSetupSpec): Promise<number> {
  const credentials = readHostCredentials(spec.host);
  const settingsFile = spec.settings.settingsPath(options.scope, options.projectDir);
  const binary = cliAgentHookBinPath(spec.binaryName);
  const tokenFile = credentials?.toolInstallationId ? defaultTokenFilePath(credentials.toolInstallationId) : undefined;

  const settings = readSettings(settingsFile);
  const registered = spec.hookEvents.filter((event) => (settings.hooks?.[event] ?? []).some((entry) => isOurs(entry, spec))).length;
  const stale = findStaleHookCommands(settings, binary, spec);

  // The flag, never "no token": a revoked or deleted token looks the same
  // from here and has to keep being reported.
  const localOnly = isLocalOnlyHostInstall(spec.host, (id) => readTokenFile(defaultTokenFilePath(id)) !== undefined);

  console.log(`version        ${describeCollectorVersion()}`);
  console.log(`api base url   ${credentials?.apiBaseUrl ?? "— not configured"}`);
  console.log(`pairing        ${credentials?.toolInstallationId ?? "— not paired"}${localOnly ? " (installed, not paired — local features active, telemetry inactive)" : ""}`);
  console.log(`token          ${localOnly ? "— none needed until this install is paired" : tokenFile && readTokenFile(tokenFile) ? "present" : "— missing"}`);
  console.log(`event log      ${describeEventLog(resolveEventLog({ localOnly }), `npx ${spec.packageName} setup`)}`);
  console.log(`hook binary    ${fs.existsSync(binary) ? binary : "— not installed"}`);
  // Registered is not the same as runnable. Agents swallow a hook that
  // cannot start, so a full count used to sit beside a machine where no hook
  // had ever run. Asked with a bare PATH, the way a Dock-launched agent asks.
  const node = process.platform === "win32" ? undefined : resolveHookNode(binary);
  if (node) {
    console.log(node.problem
      ? `node           — ${node.problem}. Install Node 20 or newer, then run setup again`
      : `node           ${node.node} (${node.version}, ${node.how === "recorded" ? "recorded at setup" : "found by the launcher"})`);
  }
  const last = readLastHook(spec.host);
  console.log(last
    ? `last hook      ${last.event}, ${describeAge(Date.now() - Date.parse(last.at))}`
    : `last hook      — none has run yet. Start ${spec.displayName} (restart it if it was open during setup)`);
  console.log(`hooks          ${registered}/${spec.hookEvents.length} registered in ${settingsFile}`);
  // Checked before saying nothing is there: "0 registered" in one scope
  // reads as a failed install when the hooks are in the other.
  const otherScope: SetupScope = options.scope === "user" ? "project" : "user";
  const otherFile = spec.settings.settingsPath(otherScope, options.projectDir);
  const elsewhere = registered === 0 && otherFile !== settingsFile ? countRegistered(readSettings(otherFile), spec) : 0;
  if (elsewhere > 0) console.log(`               ${elsewhere}/${spec.hookEvents.length} found in ${otherFile} (--scope ${otherScope})`);
  if (spec.hookSet !== undefined && registered > 0) {
    const sets = [...registeredHookSets(settings, spec).values()];
    const oldest = Math.min(...sets);
    console.log(oldest < spec.hookSet
      ? `hook set       ${oldest}, this version registers ${spec.hookSet}. Upgrade: npx ${spec.packageName} setup${options.scope === "user" ? " --scope user" : ""}`
      : `hook set       ${spec.hookSet} (current)`);
  }

  if (stale.length) {
    console.log(`stale hooks    ${stale.length} not pointing at the installed binary — each one fails silently per event:`);
    for (const command of stale) console.log(`               ${command}`);
    console.log(`               Remove them from ${settingsFile} by hand; setup cannot tell them from a hook you wrote.`);
  }

  // For the person at the keyboard only. Nothing here is fetched for an
  // install that isn't paired, and nothing from it reaches a hook or an agent.
  const tokenValue = localOnly ? undefined : (tokenFile ? readTokenFile(tokenFile) : undefined) ?? (process.env.ASCENDA_EVENT_WRITE_TOKEN?.trim() || undefined);
  const apiBaseUrl = (process.env.ASCENDA_API_BASE_URL ?? credentials?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const [initiativeLines, notices] = await Promise.all([
    initiativesStatusLines({ apiBaseUrl, eventWriteToken: tokenValue, pairCommand: `npx ${spec.packageName} setup` }),
    studyNoticeStatus({ apiBaseUrl, eventWriteToken: tokenValue, commandPrefix: `npx ${spec.packageName}` })
  ]);
  console.log("");
  for (const line of initiativeLines) console.log(line);
  for (const line of notices.lines) console.log(line);
  // Only a person at a terminal has been shown the notice; see `markShown`.
  if (process.stdout.isTTY) await notices.markShown();

  // A local-only install is healthy without a pairing: it was asked for, or
  // was told it degraded, and the hooks it registered do their one job.
  // Anything else still needs an installation id, so a pairing that silently
  // went missing keeps failing the check that gates a CI step. Deliberately
  // not also requiring a token here: an exported ASCENDA_EVENT_WRITE_TOKEN is
  // a supported way to hold one, and this check has never read it.
  const paired = localOnly || credentials?.toolInstallationId !== undefined;
  // User hooks apply in every project, so hooks found there answer a
  // project-scope check. The reverse does not hold.
  const wired = registered === spec.hookEvents.length || (options.scope === "project" && elsewhere === spec.hookEvents.length);
  const healthy = paired && wired && fs.existsSync(binary) && !stale.length && !node?.problem;
  return healthy ? 0 : 1;
}

function countRegistered(settings: HookSettings, spec: CliAgentSetupSpec): number {
  return spec.hookEvents.filter((event) => (settings.hooks?.[event] ?? []).some((entry) => isOurs(entry, spec))).length;
}

/**
 * Where this adapter's hooks are registered, for `doctor`: the user file and
 * this folder's project file, each listed only when it holds some.
 */
export function cliAgentRegistrations(spec: CliAgentSetupSpec, projectDir = process.cwd()): HookRegistration[] {
  const home = os.homedir();
  const userFile = spec.settings.settingsPath("user", projectDir);
  const projectFile = spec.settings.settingsPath("project", projectDir);
  const found: HookRegistration[] = [];
  for (const [scope, file] of [["user", userFile], ["project", projectFile]] as const) {
    if (scope === "project" && file === userFile) continue;
    const registered = countRegistered(readSettings(file), spec);
    if (registered === 0) continue;
    found.push({
      file: tidyHomePath(file, home),
      registered,
      scope,
      homeProject: scope === "project" && path.resolve(projectDir) === path.resolve(home)
    });
  }
  return found;
}

/**
 * `doctor`: the live signal first, which needs no pairing and is the whole
 * story for an install that has none, then the account half.
 */
async function runDoctor(options: SetupOptions, spec: CliAgentSetupSpec): Promise<number> {
  const ui = terminalStyle();
  const lines: string[] = [`${ui.bold("Ascenda doctor")} ${ui.dim(`· ${spec.displayName}`)}`, ""];
  try {
    lines.push(...await liveSignalDoctorLines({
      displayName: spec.displayName,
      tool: spec.host,
      launcher: process.platform === "win32" ? undefined : cliAgentHookBinPath(spec.binaryName),
      registrations: cliAgentRegistrations(spec, options.projectDir),
      eventCount: spec.hookEvents.length,
      selfCommand: cliAgentSelfCommand(spec),
      setupCommand: `npx ${spec.packageName} setup`,
      ui
    }));
  } catch (error) {
    lines.push(`  Live signal           (could not be checked: ${error instanceof Error ? error.message : String(error)})`);
  }
  lines.push("", ...accountLines(ui, spec));
  const localOnly = isLocalOnlyHostInstall(spec.host, (id) => readTokenFile(defaultTokenFilePath(id)) !== undefined);
  lines.push("", `  ${ui.bold("Local events")}  ${describeEventLog(resolveEventLog({ localOnly }), `npx ${spec.packageName} setup`)}`);
  console.log(lines.join("\n"));
  return 0;
}

function accountLines(ui: TerminalStyle, spec: CliAgentSetupSpec): string[] {
  const credentials = readHostCredentials(spec.host);
  const id = credentials?.toolInstallationId;
  const localOnly = isLocalOnlyHostInstall(spec.host, (installationId) => readTokenFile(defaultTokenFilePath(installationId)) !== undefined);
  const row = (tone: Tone, label: string, value: string) => `  ${ui.mark(tone)} ${label.padEnd(20)} ${value}`;
  if (!id || localOnly) {
    return [
      `  ${ui.bold("Account sync")} ${ui.dim("(optional; this install isn't paired)")}`,
      ...(id ? [ui.dim(row("info", "Installation id", id))] : []),
      "",
      "  Not paired, which is fine: the screen saver, the live view and the local",
      "  event log work without it. Nothing leaves this machine and nothing is queued.",
      "  To send your sessions to Ascenda's servers, so they appear in the app:",
      `    ${ui.cyan(`${cliAgentSelfCommand(spec)} setup`)}`
    ];
  }
  const token = readTokenFile(defaultTokenFilePath(id)) ?? process.env.ASCENDA_EVENT_WRITE_TOKEN?.trim();
  const state = readCollectorState(defaultStateFilePath(id));
  const outcome = state?.lastOutcome;
  return [
    `  ${ui.bold("Account sync")}`,
    row("info", "Installation id", id),
    token ? row("ok", "Token", "present") : row("bad", "Token", ui.red(`missing, so nothing can be sent. Run: npx ${spec.packageName} setup`)),
    outcome
      ? row(outcome === "accepted" ? "ok" : "warn", "Last send", `${outcome}${state?.lastAttemptAt ? ui.dim(` (${state.lastAttemptAt})`) : ""}`)
      : row("info", "Last send", "none yet")
  ];
}

/**
 * Takes our entries out of one hooks file, keeping everything else, with a
 * backup beside it. Returns false when the file could not be parsed.
 */
function removeOurHookEntries(settingsFile: string, spec: CliAgentSetupSpec): boolean {
  if (!fs.existsSync(settingsFile)) return true;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as HookSettings;
    const hooks: Record<string, unknown[]> = { ...(settings.hooks ?? {}) };
    for (const event of Object.keys(hooks)) {
      const kept = hooks[event].filter((entry) => !isOurs(entry, spec));
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    const updated: HookSettings = { ...settings, hooks };
    if (!Object.keys(hooks).length) delete updated.hooks;
    fs.copyFileSync(settingsFile, `${settingsFile}.ascenda-backup`);
    fs.writeFileSync(settingsFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Removes our hook entries, the installed launcher and bundle, and this host's credentials. Tokens are left alone: revocation is app-side. */
function uninstall(options: SetupOptions, spec: CliAgentSetupSpec): number {
  const settingsFile = spec.settings.settingsPath(options.scope, options.projectDir);
  if (fs.existsSync(settingsFile)) {
    if (!removeOurHookEntries(settingsFile, spec)) {
      console.error(`could not parse ${settingsFile} — remove the ascenda hook entries by hand`);
      return 1;
    }
    console.log(`hooks removed from ${settingsFile}`);
  }

  for (const file of removeHookRunner(spec.binaryName)) {
    if (!file.endsWith(".node") && !file.endsWith(".no-node")) console.log(`removed ${file}`);
  }
  if (readHostCredentials(spec.host)) {
    removeHostCredentials(spec.host);
    console.log(`removed tools.${spec.host} from ${credentialsFilePath()}`);
  }
  console.log(`tokens left in ${path.join(ascendaHome(), "tokens")} — revoke in the Ascenda app to invalidate them`);
  return 0;
}
