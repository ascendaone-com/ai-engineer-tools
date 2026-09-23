import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { credentialsFilePath, isLocalOnlyHostInstall, readHostCredentials, removeHostCredentials, writeHostCredentials } from "./credentials";
import { DEFAULT_API_BASE_URL } from "./hookAdapter";
import { createPairingSession, getPairingStatus } from "./http";
import { renderSetupDisclosure } from "./setupDisclosure";
import type { DisclosureFamily } from "./setupDisclosure";
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
 * stdout). The two follow the same rules: pin the interpreter, back up
 * before touching a file, refuse to overwrite what cannot be parsed.
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

type SetupAction = "install" | "status" | "uninstall" | "help";

type SetupOptions = {
  apiBaseUrl?: string;
  toolInstallationId?: string;
  token?: string;
  scope: SetupScope;
  projectDir: string;
  dryRun: boolean;
  /** True under `--no-pair`: install the local half and stop there. */
  skipPairing: boolean;
  action: SetupAction;
};

/**
 * The words on argv that mean "a person is typing", as opposed to a hook
 * name the agent is invoking. Every agent's hook names differ in case from
 * these (`stop`, `Stop`, `post_cascade_response`), so the two cannot collide.
 * Checked before stdin is read: a management command carries no payload, so
 * reading stdin first would hang on a pipe nothing will ever write to.
 */
const MANAGEMENT_COMMANDS = new Set(["setup", "install", "status", "uninstall", "-h", "--help"]);

export function isCliAgentManagementCommand(argument: string | undefined): boolean {
  return argument !== undefined && MANAGEMENT_COMMANDS.has(argument);
}

/** Where `setup` places the self-contained hook bundle. No sudo, no npm -g. */
export function cliAgentHookBinPath(binaryName: string): string {
  return path.join(ascendaHome(), "bin", binaryName);
}

function usage(spec: CliAgentSetupSpec): string {
  return `${spec.binaryName} setup — wire ${spec.displayName} to Ascenda telemetry

  npx ${spec.packageName} setup [options]
  npx ${spec.packageName} status
  npx ${spec.packageName} uninstall

Options
  --api-base-url <url>          ingest host (default ${DEFAULT_API_BASE_URL})
  --local [port]                shorthand for the local dev server (default port 4477)
  --tool-installation-id <id>   reuse an existing pairing instead of creating one
  --token <eventWriteToken>     reuse an existing token (stored 0600, never printed)
  --no-pair                     install without pairing: local features on, nothing sent
  --scope project|user          where hooks are registered (default project)
  --project-dir <path>          project root for --scope project (default cwd)
  --dry-run                     print what would change, write nothing
  -h, --help
`;
}

export async function runCliAgentSetup(argv: string[], spec: CliAgentSetupSpec): Promise<number> {
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
  if (options.action === "status") return printStatus(options, spec);
  if (options.action === "uninstall") return uninstall(options, spec);

  const apiBaseUrl = (options.apiBaseUrl ?? readHostCredentials(spec.host)?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  console.log(`Ascenda setup for ${spec.displayName} — ${apiBaseUrl}`);

  // Before pairing, not after: pairing is where the consent is given, and a
  // statement printed underneath a completed pairing is a notification rather
  // than a disclosure.
  //
  // Printed on an unpaired install too, and the heading carries it: "once
  // paired" is the true tense for an install that sends nothing yet, whether
  // that was asked for (`--no-pair`) or a pairing that could not finish. The
  // lines below say what is true now.
  console.log(`\n${renderSetupDisclosure({ sends: spec.sends, displayName: spec.displayName })}\n`);

  // Pairing is the only step that needs a person and a network, and the only
  // one that can be left out: the hook bundle and the agent's hooks file know
  // nothing about a pairing. An install that stops here still runs the local
  // half — the live signal to a socket on this machine — and sends nothing,
  // which is what an unpaired hook already did.
  //
  // Two ways to arrive, and both say so: asked for (`--no-pair`), or a
  // pairing that could not finish (host unreachable, code unconfirmed,
  // session expired). A degrade nobody is told about is how someone comes to
  // believe they paired.
  let identity: Identity | undefined;
  let unpairedReason: string | undefined;
  if (options.skipPairing) {
    unpairedReason = "asked not to pair (--no-pair)";
  } else {
    identity = await resolveIdentity(apiBaseUrl, options, spec);
    if (identity) {
      console.log(`  pairing      ${identity.toolInstallationId}${identity.paired ? " (new)" : " (existing)"}`);
    } else {
      unpairedReason = "pairing did not finish — installing the local half anyway";
    }
  }
  if (unpairedReason) {
    console.log(`  pairing      none: ${unpairedReason}`);
    console.log("               local features on, nothing is sent");
  }

  const binary = installBinary(spec, options.dryRun);
  console.log(`  hook binary  ${binary}`);

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
  }
  console.log(`  credentials  ${credentialsFilePath()} (tools.${spec.host})`);

  const settingsFile = spec.settings.settingsPath(options.scope, options.projectDir);
  const written = writeHookSettings(settingsFile, binary, spec, options.dryRun);
  if (written === null) return 1;
  console.log(`  hooks        ${settingsFile} (${spec.hookEvents.length} events${written ? "" : ", already current"})`);

  if (options.dryRun) {
    console.log("\nDry run — nothing was written.");
    return 0;
  }

  console.log(`\nDone. ${spec.restartHint}`);
  if (!identity) {
    console.log(`Pair later:     npx ${spec.packageName} setup`);
  }
  console.log(`Check anytime:  npx ${spec.packageName} status`);
  return 0;
}

// ------------------------------------------------------------------ args ---

function parseArgs(argv: string[], spec: CliAgentSetupSpec): SetupOptions {
  const options: SetupOptions = {
    scope: "project",
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

// -------------------------------------------------------------- identity ---

type Identity = { toolInstallationId: string; paired: boolean };

/**
 * Reuse an existing pairing when this host already has one, otherwise create
 * one. The local dev server auto-confirms; a real backend needs the 6-digit
 * code confirmed in the Ascenda app, so it is printed and polled for.
 */
async function resolveIdentity(apiBaseUrl: string, options: SetupOptions, spec: CliAgentSetupSpec): Promise<Identity | undefined> {
  const existingId = options.toolInstallationId ?? readHostCredentials(spec.host)?.toolInstallationId;

  if (existingId && options.token) {
    if (!options.dryRun) persistEventWriteToken(defaultTokenFilePath(existingId), options.token);
    return { toolInstallationId: existingId, paired: false };
  }
  if (existingId && readTokenFile(defaultTokenFilePath(existingId))) {
    return { toolInstallationId: existingId, paired: false };
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
function installBinary(spec: CliAgentSetupSpec, dryRun: boolean): string {
  const target = cliAgentHookBinPath(spec.binaryName);
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

  const command = hookCommand(binary);
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
 * Pin the interpreter to the Node running setup. Agents spawn hooks with the
 * environment they were launched with, which on a GUI launch may not have a
 * version-manager Node on PATH.
 */
function hookCommand(binary: string): string {
  return `"${process.execPath}" "${binary}"`;
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

function printStatus(options: SetupOptions, spec: CliAgentSetupSpec): number {
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

  console.log(`api base url   ${credentials?.apiBaseUrl ?? "— not configured"}`);
  console.log(`pairing        ${credentials?.toolInstallationId ?? "— not paired"}${localOnly ? " (installed, not paired — local features active, telemetry inactive)" : ""}`);
  console.log(`token          ${localOnly ? "— none needed until this install is paired" : tokenFile && readTokenFile(tokenFile) ? "present" : "— missing"}`);
  console.log(`hook binary    ${fs.existsSync(binary) ? binary : "— not installed"}`);
  console.log(`hooks          ${registered}/${spec.hookEvents.length} registered in ${settingsFile}`);

  if (stale.length) {
    console.log(`stale hooks    ${stale.length} not pointing at the installed binary — each one fails silently per event:`);
    for (const command of stale) console.log(`               ${command}`);
    console.log(`               Remove them from ${settingsFile} by hand; setup cannot tell them from a hook you wrote.`);
  }

  // A local-only install is healthy without a pairing: it was asked for, or
  // was told it degraded, and the hooks it registered do their one job.
  // Anything else still needs an installation id, so a pairing that silently
  // went missing keeps failing the check that gates a CI step. Deliberately
  // not also requiring a token here: an exported ASCENDA_EVENT_WRITE_TOKEN is
  // a supported way to hold one, and this check has never read it.
  const paired = localOnly || credentials?.toolInstallationId !== undefined;
  const healthy = paired && registered === spec.hookEvents.length && fs.existsSync(binary) && !stale.length;
  return healthy ? 0 : 1;
}

/** Removes our hook entries, the installed binary and this host's credentials. Tokens are left alone: revocation is app-side. */
function uninstall(options: SetupOptions, spec: CliAgentSetupSpec): number {
  const settingsFile = spec.settings.settingsPath(options.scope, options.projectDir);

  if (fs.existsSync(settingsFile)) {
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
      console.log(`hooks removed from ${settingsFile}`);
    } catch {
      console.error(`could not parse ${settingsFile} — remove the ascenda hook entries by hand`);
      return 1;
    }
  }

  const binary = cliAgentHookBinPath(spec.binaryName);
  if (fs.existsSync(binary)) {
    fs.rmSync(binary);
    console.log(`removed ${binary}`);
  }
  if (readHostCredentials(spec.host)) {
    removeHostCredentials(spec.host);
    console.log(`removed tools.${spec.host} from ${credentialsFilePath()}`);
  }
  console.log(`tokens left in ${path.join(ascendaHome(), "tokens")} — revoke in the Ascenda app to invalidate them`);
  return 0;
}
