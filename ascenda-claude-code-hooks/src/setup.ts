import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ascendaHome, createPairingSession, defaultTokenFilePath, getPairingStatus, persistEventWriteToken, readTokenFile } from "@ascenda-one/tool-kit";
import { DEFAULT_API_BASE_URL } from "./config.js";
import { credentialsFilePath, hookBinPath, readCredentials, writeCredentials } from "./paths.js";
import { ASCENDA_TOOL_TYPE } from "./types.js";

/**
 * Hook events worth registering. `Notification` is deliberately absent: it maps
 * to no catalog event, so registering it would spawn a process per notification
 * and send nothing.
 */
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop"] as const;

/**
 * Claude Code's default timeout for `command` hooks is 600s. Telemetry that
 * cannot complete in a few seconds is not worth waiting for, and a hung request
 * would otherwise stall the user's turn.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/** Identifies our entries so re-running replaces them instead of appending duplicates. */
const HOOK_MARKER = "ascenda-claude-hook";

type Scope = "project" | "user";

type Options = {
  apiBaseUrl?: string;
  toolInstallationId?: string;
  token?: string;
  scope: Scope;
  projectDir: string;
  dryRun: boolean;
  action: "install" | "status" | "uninstall" | "help";
};

const USAGE = `ascenda-claude-hook setup — wire Claude Code to Ascenda telemetry

  npx @ascenda-one/claude-code-hooks setup [options]
  npx @ascenda-one/claude-code-hooks status
  npx @ascenda-one/claude-code-hooks uninstall

Options
  --api-base-url <url>          ingest host (default ${DEFAULT_API_BASE_URL})
  --local [port]                shorthand for the local dev server (default port 4477)
  --tool-installation-id <id>   reuse an existing pairing instead of creating one
  --token <eventWriteToken>     reuse an existing token (stored 0600, never printed)
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

  const identity = await resolveIdentity(apiBaseUrl, options);
  if (!identity) return 1;
  console.log(`  pairing      ${identity.toolInstallationId}${identity.paired ? " (new)" : " (existing)"}`);

  const binary = installBinary(options.dryRun);
  console.log(`  hook binary  ${binary}`);

  if (!options.dryRun) {
    writeCredentials({ apiBaseUrl, toolInstallationId: identity.toolInstallationId, pairedAt: new Date().toISOString() });
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

  console.log("\nDone. Restart Claude Code in this project to load the hooks.");
  console.log(`Check anytime:  npx @ascenda-one/claude-code-hooks status`);
  return 0;
}

// ------------------------------------------------------------------ args ---

function parseArgs(argv: string[]): Options {
  const options: Options = {
    scope: "project",
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    dryRun: false,
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

type Identity = { toolInstallationId: string; paired: boolean };

/**
 * Reuse an existing pairing when one is already on the machine, otherwise
 * create one. The local dev server auto-confirms; a real backend needs the
 * 6-digit code confirmed in the Ascenda app, so we print it and poll.
 */
async function resolveIdentity(apiBaseUrl: string, options: Options): Promise<Identity | undefined> {
  const existingId = options.toolInstallationId ?? readCredentials()?.toolInstallationId;

  if (existingId && options.token) {
    if (!options.dryRun) persistEventWriteToken(defaultTokenFilePath(existingId), options.token);
    return { toolInstallationId: existingId, paired: false };
  }
  if (existingId && readTokenFile(defaultTokenFilePath(existingId))) {
    return { toolInstallationId: existingId, paired: false };
  }
  if (options.dryRun) {
    return { toolInstallationId: existingId ?? `${ASCENDA_TOOL_TYPE}:<paired at run time>`, paired: false };
  }

  const toolInstallationId = existingId ?? `${ASCENDA_TOOL_TYPE}:${crypto.randomUUID()}`;
  let session;
  try {
    session = await createPairingSession(apiBaseUrl, toolInstallationId, ASCENDA_TOOL_TYPE, `Claude Code on ${os.hostname()}`);
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

function printStatus(options: Options): number {
  const credentials = readCredentials();
  const settingsFile = settingsPath(options);
  const binary = hookBinPath();
  const tokenFile = credentials?.toolInstallationId ? defaultTokenFilePath(credentials.toolInstallationId) : undefined;

  const settings = (() => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Settings;
    } catch {
      return {} as Settings;
    }
  })();
  const registered = HOOK_EVENTS.filter((event) => (settings.hooks?.[event] ?? []).some(isOurs)).length;
  const stale = findStaleHookCommands(settings, binary);

  console.log(`api base url   ${credentials?.apiBaseUrl ?? "— not configured"}`);
  console.log(`pairing        ${credentials?.toolInstallationId ?? "— not paired"}`);
  console.log(`token          ${tokenFile && readTokenFile(tokenFile) ? "present" : "— missing"}`);
  console.log(`hook binary    ${fs.existsSync(binary) ? binary : "— not installed"}`);
  console.log(`hooks          ${registered}/${HOOK_EVENTS.length} registered in ${settingsFile}`);

  if (stale.length) {
    console.log(`stale hooks    ${stale.length} not pointing at the installed binary — each one fails silently per event:`);
    for (const command of stale) console.log(`               ${command}`);
    console.log(`               Remove them from ${settingsFile} by hand; setup cannot tell them from a hook you wrote.`);
  }

  const healthy = credentials?.toolInstallationId && registered === HOOK_EVENTS.length && fs.existsSync(binary) && !stale.length;
  return healthy ? 0 : 1;
}

/** Removes our hook entries and the installed binary. Tokens are left alone: revocation is app-side. */
function uninstall(options: Options): number {
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
  const credentials = credentialsFilePath();
  if (fs.existsSync(credentials)) {
    fs.rmSync(credentials);
    console.log(`removed ${credentials}`);
  }
  console.log(`tokens left in ${path.join(ascendaHome(), "tokens")} — revoke in the Ascenda app to invalidate them`);
  return 0;
}
