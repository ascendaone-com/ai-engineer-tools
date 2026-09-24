import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ascendaHome, createPairingSession, defaultTokenFilePath, describeCollectorVersion, getPairingStatus, persistEventWriteToken, readTokenFile, renderSetupDisclosure } from "@ascenda-one/tool-kit";
import type { DisclosureFamily } from "@ascenda-one/tool-kit";
import { DEFAULT_API_BASE_URL, envOverride, localOnlyInstall } from "./config.js";
import { credentialsFilePath, hookBinPath, readCredentials, removeCredentials, writeCredentials } from "./paths.js";
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
 * `SessionEnd` closes the session `SessionStart` opened. Claude Code gives
 * these hooks a shared 1.5s budget unless a hook asks for longer, so the 5s
 * timeout below is what gives the send room to finish as the agent exits.
 */
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "Notification", "SessionEnd"] as const;

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
 * write, and `interruptionKind` on a Notification.
 *
 * It omits `context` deliberately: compaction and pressure events are sent,
 * but no occupancy figure rides them, and the context line would claim one.
 */
export const SENDS: readonly DisclosureFamily[] = ["model", "posture", "git", "edits", "waiting"];

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

  doctor  prints the send journal, outbox and one live round trip
  pair    prints a code to paste into the app, then waits for confirmation

Options
  --api-base-url <url>          ingest host (default ${DEFAULT_API_BASE_URL})
  --local [port]                shorthand for the local dev server (default port 4477)
  --tool-installation-id <id>   reuse an existing pairing instead of creating one
  --token <eventWriteToken>     reuse an existing token (stored 0600, never printed)
  --no-pair                     install without pairing: local features on, nothing sent
                                (--no-pairing is accepted too)
  --scope project|user          where hooks are registered (default project)
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
  if (options.action === "status") return printStatus(options);
  if (options.action === "uninstall") return uninstall(options);

  const apiBaseUrl = (options.apiBaseUrl ?? readCredentials()?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");

  console.log(`Ascenda setup — ${apiBaseUrl}`);

  // Before pairing, not after: pairing is where the consent is given, and a
  // statement printed underneath a completed pairing is a notification rather
  // than a disclosure.
  //
  // On a run that will not pair, the same sentences are true of nothing yet, so
  // they are introduced as what pairing would start rather than as a statement
  // about this install. Suppressing them instead would be worse: someone
  // choosing to stay local is entitled to know what pairing costs.
  if (!options.pair) console.log("\n  Nothing is sent from an install with no pairing. What pairing would start sending:");
  console.log(`\n${renderSetupDisclosure({ sends: SENDS, displayName: "Claude Code" })}\n`);

  const identity = await resolveIdentity(apiBaseUrl, options);
  const unpaired = identity.pairing === "local-only";

  console.log(`  pairing      ${unpaired ? `none — ${identity.reason}` : `${identity.toolInstallationId}${identity.pairing === "new" ? " (new)" : " (existing)"}`}`);
  if (unpaired) console.log(`  installation ${identity.toolInstallationId} (recorded, so a later pair attaches to it)`);

  const binary = installBinary(options.dryRun);
  console.log(`  hook binary  ${binary}`);

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
  console.log(`  credentials  ${credentialsFilePath()}`);

  const settingsFile = settingsPath(options);
  const written = writeSettings(settingsFile, binary, options.dryRun);
  if (written === null) return 1;
  console.log(`  hooks        ${settingsFile} (${HOOK_EVENTS.length} events${written ? "" : ", already current"})`);

  if (options.dryRun) {
    console.log("\nDry run — nothing was written.");
    return 0;
  }

  // Which half is live, spelled out. A degrade that reads like a success is
  // worse than a failed install: someone who believes they paired stops
  // looking for the reason their work is not arriving.
  if (unpaired) {
    console.log("\nInstalled, not paired.");
    console.log("  active       the session prompts, and the live signal to a socket on this machine");
    console.log(`  inactive     delivery to ${apiBaseUrl}. Nothing is sent, and nothing is queued for later.`);
    if (identity.hint) console.log(`  note         ${identity.hint}`);
    console.log("  pair later   npx @ascenda-one/claude-code-hooks pair");
    console.log("\nRestart Claude Code in this project to load the hooks.");
  } else {
    console.log("\nDone. Restart Claude Code in this project to load the hooks.");
  }
  console.log(`Check anytime:  npx @ascenda-one/claude-code-hooks status`);
  return 0;
}

// ------------------------------------------------------------------ args ---

function parseArgs(argv: string[]): Options {
  const options: Options = {
    scope: "project",
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

// ---------------------------------------------------------------- binary ---

/**
 * Copy the running bundle to ~/.ascenda/bin. `npx` caches its download in a
 * temp directory that is not stable across runs, so hooks must not point at it.
 */
function installBinary(dryRun: boolean): string {
  const target = hookBinPath();
  if (dryRun) return target;

  const source = process.argv[1];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Same file when re-running an already-installed binary; copying it onto
  // itself would truncate it.
  if (path.resolve(source) !== path.resolve(target)) {
    fs.copyFileSync(source, target);
  }
  if (process.platform !== "win32") fs.chmodSync(target, 0o755);
  return target;
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
    hooks[event] = [...kept, { hooks: [{ type: "command", command: `${command} ${event}`, timeout: HOOK_TIMEOUT_SECONDS }] }];
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
 * Pin the interpreter to the Node running setup. Claude Code hooks inherit the
 * environment the editor was launched with, which on a GUI launch may not have
 * a version-manager Node on PATH.
 */
function hookCommand(binary: string): string {
  return `"${process.execPath}" "${binary}"`;
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

/** Reads a settings file and counts our hooks in it. Missing or unparseable reads as none. */
function countRegistered(settingsFile: string, binary: string): { settings: Settings; registered: number } {
  const settings = (() => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Settings;
    } catch {
      return {} as Settings;
    }
  })();
  return { settings, registered: HOOK_EVENTS.filter((event) => (settings.hooks?.[event] ?? []).some(isOurs)).length };
}

function printStatus(options: Options): number {
  const credentials = readCredentials();
  const settingsFile = settingsPath(options);
  const binary = hookBinPath();
  const tokenFile = credentials?.toolInstallationId ? defaultTokenFilePath(credentials.toolInstallationId) : undefined;
  const unpaired = localOnlyInstall(credentials);

  const here = countRegistered(settingsFile, binary);
  const settings = here.settings;
  const registered = here.registered;
  // `status` checks one scope — the same default `setup` writes to, which is
  // `project`. A machine set up with `--scope user` therefore reported a flat
  // `0/7 registered` from a project directory, which reads as "the install
  // failed" rather than "you are looking in the other place". Look in the
  // other scope before saying nothing is there, and name where it actually is.
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
  console.log(`hooks          ${registered}/${HOOK_EVENTS.length} registered in ${settingsFile}`);
  if (elsewhere && elsewhere.registered > 0) {
    console.log(`               ${elsewhere.registered}/${HOOK_EVENTS.length} found in ${otherFile} (--scope ${otherScope.scope})`);
  }

  if (stale.length) {
    console.log(`stale hooks    ${stale.length} not pointing at the installed binary — each one fails silently per event:`);
    for (const command of stale) console.log(`               ${command}`);
    console.log(`               Remove them from ${settingsFile} by hand; setup cannot tell them from a hook you wrote.`);
  }

  if (unpaired) {
    console.log("\nInstalled, not paired. Pair when you want the telemetry half:");
    console.log("  npx @ascenda-one/claude-code-hooks pair");
  }

  // User settings apply in every project, so hooks found there answer a
  // project-scope check and the install is not broken. The reverse does not
  // hold: one project's file says nothing about the machine, so a `--scope
  // user` check that finds only project hooks still reports them missing.
  const wired = registered === HOOK_EVENTS.length
    || (options.scope === "project" && elsewhere?.registered === HOOK_EVENTS.length);
  const healthy = credentials?.toolInstallationId && wired && fs.existsSync(binary) && !stale.length;
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
      console.log(`hooks removed from ${settingsFile}`);
    } catch {
      console.error(`could not parse ${settingsFile} — remove the ascenda hook entries by hand`);
      return 1;
    }
  }

  const binary = hookBinPath();
  if (fs.existsSync(binary)) {
    fs.rmSync(binary);
    console.log(`removed ${binary}`);
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
