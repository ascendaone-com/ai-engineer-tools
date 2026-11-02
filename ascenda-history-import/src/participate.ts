/**
 * `participate <code>`: set a machine up for an organisation's study in one
 * command, with no desktop app.
 *
 *   1. Agents     find every AI agent on the machine, install its hooks for
 *                 every project, and pair it
 *   2. Study      join the study the code names, in Report mode
 *   3. Retention  offer to stop Claude Code deleting transcripts after 30 days
 *   4. Backfill   import the history already on the machine and send it,
 *                 with git commits only when the grant covers git
 *
 * Git is the person's choice on the confirm page, an unticked box. This
 * command never sends that choice. It reads the result: `importStores` on
 * the join's status, which follows the account's active grant. A re-run
 * reads it again from the server, because the grant can change after the
 * join (narrowed by a re-grant, or widened from somewhere else).
 *
 * Why it lives in the importer: this is the one package whose job already
 * spans every agent, and it owns steps 3 and 4. The hook adapters each own a
 * single agent.
 *
 * Each agent is set up by its own adapter's `setup`, run as a child process.
 * That isn't indirection for its own sake: `setup` installs the bundle that
 * is running it as the agent's hook binary (see `installHookRunner`), so only
 * the adapter's own bundle can install the adapter. The child's output is
 * streamed through, indented, so its pairing code and link reach the person
 * exactly as that adapter prints them.
 *
 * Every step is safe to repeat. `setup` keeps a pairing whose saved token
 * still works, a study joined under the same code is remembered in
 * `~/.ascenda/participation.json` and not joined again while its window is
 * open, the retention change is a no-op once made, and the backend dedups
 * the backfill on each event's `importKey`. So the answer to a half-finished
 * run is to run it again.
 *
 * A failure in one agent is reported and the rest carry on. The summary at
 * the end, and the exit code, say what actually happened to each.
 *
 * Browser confirms: one per agent that isn't paired yet, then one for the
 * study. The pairing API has no way for a confirmed person to approve a
 * second installation without its own code, and an installation can't share
 * another's token (renewing rotates it and revokes the old one). Fewer
 * confirms needs a backend change; until then each one is announced on its
 * own line, with a count, before its code appears.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  COLLECTOR_VERSION,
  DEFAULT_API_BASE_URL as TOOL_KIT_DEFAULT_API_BASE_URL,
  UNRELEASED_COLLECTOR_VERSION,
  ascendaHome,
  colourEnabled,
  defaultTokenFilePath,
  PAIR_JOIN_OUTCOME_FILE_ENV,
  PAIR_ORG_JOIN_CODE_ENV,
  describeStudyGrant,
  describeStudyJoinRefusal,
  describeStudyKind,
  formatWindow,
  getStudyJoinStatus,
  readMachineCredentials,
  readTokenFile,
  runStudyJoin,
  terminalStyle,
  tidyHomePath,
  writeAtomically
} from "@ascenda-one/tool-kit";
import type { HostCredentials, PairingJoinOutcome, StudyJoinOutcome } from "@ascenda-one/tool-kit";
import type { StudyJoinGrant } from "@ascenda-one/tool-contract";
import { applyClaudeRetentionFix, planClaudeRetentionFix } from "./retention.js";
import type { ClaudeRetentionPlan } from "./retention.js";
import { claudeConfigDirsOf, codexHomeOf, resolveStorePaths } from "./stores.js";
import type { ImportSummaryFile } from "./cli.js";

/** The grant that lets the backend accept a backfill. */
export const HISTORICAL_IMPORT_GRANT = 507;

export interface ParticipateAgent {
  /** Stable id, as `--agents` takes it. */
  id: string;
  displayName: string;
  packageName: string;
  /** The adapter's folder in this repository, for a run from a checkout. */
  workspaceDir: string;
  /** Its key under `tools` in credentials.json, or null for Claude Code, which owns the top level. */
  credentialsKey: string | null;
  /** Folders whose presence means the agent has run on this machine. */
  configDirs: (home: string, env: NodeJS.ProcessEnv) => string[];
  /** Executables whose presence on PATH means it's installed. */
  binaries: string[];
  /** What the person still has to do in the agent itself before its hooks run. */
  afterPairing?: string;
}

export const PARTICIPATE_AGENTS: readonly ParticipateAgent[] = [
  {
    id: "claude_code",
    displayName: "Claude Code",
    packageName: "@ascenda-one/claude-code-hooks",
    workspaceDir: "ascenda-claude-code-hooks",
    credentialsKey: null,
    configDirs: (home, env) => claudeConfigDirsOf(home, env).map((dirs) => dirs.configDir),
    binaries: ["claude"]
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    packageName: "@ascenda-one/codex-hooks",
    workspaceDir: "ascenda-codex-hooks",
    credentialsKey: "codex",
    configDirs: (home, env) => [codexHomeOf(home, env)],
    binaries: ["codex"],
    afterPairing: "Codex runs them only once you approve them: open /hooks in Codex"
  },
  {
    id: "cursor",
    displayName: "Cursor",
    packageName: "@ascenda-one/cursor-hooks",
    workspaceDir: "ascenda-cursor-hooks",
    credentialsKey: "cursor",
    configDirs: (home) => [path.join(home, ".cursor")],
    binaries: ["cursor", "cursor-agent"]
  },
  {
    id: "windsurf",
    displayName: "Windsurf",
    packageName: "@ascenda-one/windsurf-hooks",
    workspaceDir: "ascenda-windsurf-hooks",
    credentialsKey: "windsurf",
    configDirs: (home) => [path.join(home, ".codeium", "windsurf")],
    binaries: ["windsurf"]
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    packageName: "@ascenda-one/gemini-hooks",
    workspaceDir: "ascenda-gemini-hooks",
    credentialsKey: "gemini_cli",
    configDirs: (home) => [path.join(home, ".gemini")],
    binaries: ["gemini"]
  }
];

/** A command to run: the program and its arguments. */
export interface CommandLine {
  command: string;
  args: string[];
  /** Windows runs `npx.cmd` through a shell. */
  shell?: boolean;
}

export interface ParticipateContext {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /**
   * How to run an adapter. Defaults to `npx -y <package>@<this release>`, or,
   * with `ASCENDA_PARTICIPATE_BUNDLE_ROOT` set to a checkout, the adapter's
   * built bundle in that checkout.
   */
  adapterCommand?: (agent: ParticipateAgent, args: string[]) => CommandLine;
  /** How to run this importer's own `import`. Defaults to the running bundle. */
  importerCommand?: (args: string[]) => CommandLine;
  /** Test-only: passed to `runStudyJoin`. */
  joinPollIntervalMs?: number;
}

interface ParticipateOptions {
  joinCode: string;
  apiBaseUrl?: string;
  agents?: string[];
  retention: "ask" | "apply" | "keep";
  backfill: boolean;
  rejoin: boolean;
}

const USAGE = `ascenda-history-import participate — join your organisation's study from this machine

  npx -y @ascenda-one/history-import participate <code> [options]

Sets up every AI agent found on this machine (hooks for every project, paired
to Ascenda), joins the study <code> names in Report mode, offers to keep
Claude Code's transcripts longer, and sends the history already here.
Safe to run again: anything already done is kept.

Options
  --api-base-url <url>   Ascenda host (default ${TOOL_KIT_DEFAULT_API_BASE_URL})
  --local [port]         the local dev server (default port 4477)
  --agents <ids>         only these, comma-separated: ${PARTICIPATE_AGENTS.map((agent) => agent.id).join(", ")}
  --fix-retention        keep Claude Code transcripts longer without asking
  --keep-retention       leave Claude Code's retention as it is, without asking
  --no-backfill          don't send the history already on this machine
  --rejoin               join again even if this code was joined before
  -h, --help
`;

function parseArgs(argv: string[]): ParticipateOptions | "help" {
  const options: Partial<ParticipateOptions> & Pick<ParticipateOptions, "retention" | "backfill" | "rejoin"> = {
    retention: "ask",
    backfill: true,
    rejoin: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--api-base-url":
        options.apiBaseUrl = value().replace(/\/$/, "");
        break;
      case "--local": {
        const peek = argv[i + 1];
        options.apiBaseUrl = `http://localhost:${peek && /^\d+$/.test(peek) ? argv[++i] : "4477"}`;
        break;
      }
      case "--agents": {
        const ids = value().split(",").map((id) => id.trim()).filter(Boolean);
        const unknown = ids.filter((id) => !PARTICIPATE_AGENTS.some((agent) => agent.id === id));
        if (unknown.length) throw new Error(`unknown agent: ${unknown.join(", ")}. Known: ${PARTICIPATE_AGENTS.map((agent) => agent.id).join(", ")}`);
        options.agents = ids;
        break;
      }
      case "--fix-retention":
        options.retention = "apply";
        break;
      case "--keep-retention":
        options.retention = "keep";
        break;
      case "--no-backfill":
        options.backfill = false;
        break;
      case "--rejoin":
        options.rejoin = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
        if (options.joinCode) throw new Error(`one code only, got ${options.joinCode} and ${arg}`);
        options.joinCode = arg.trim();
    }
  }
  if (!options.joinCode) throw new Error(`participate needs the code your organisation gave you.\n\n${USAGE}`);
  return options as ParticipateOptions;
}

// --------------------------------------------------------------- detection ---

function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, binary + extension.toLowerCase());
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return true;
      } catch {
        // Not here.
      }
    }
  }
  return false;
}

/** Why an agent counts as installed, or undefined when it doesn't. */
export function detectAgent(agent: ParticipateAgent, home: string, env: NodeJS.ProcessEnv): string | undefined {
  const dir = agent.configDirs(home, env).find((candidate) => fs.existsSync(candidate));
  if (dir) return tidyHomePath(dir, home);
  const binary = agent.binaries.find((name) => onPath(name, env));
  return binary ? `${binary} on PATH` : undefined;
}

// ----------------------------------------------------------------- pairing ---

interface Pairing {
  toolInstallationId: string;
  apiBaseUrl: string;
  tokenFile: string;
}

function credentialsOf(agent: ParticipateAgent): HostCredentials | undefined {
  const machine = readMachineCredentials();
  return agent.credentialsKey === null ? machine : machine?.tools?.[agent.credentialsKey];
}

/** The agent's pairing, when it has one with a token on disk. A local-only install has none. */
export function pairingOf(agent: ParticipateAgent): Pairing | undefined {
  const credentials = credentialsOf(agent);
  const id = credentials?.toolInstallationId;
  if (!id || credentials.localOnly) return undefined;
  const tokenFile = defaultTokenFilePath(id);
  if (!readTokenFile(tokenFile)) return undefined;
  return { toolInstallationId: id, apiBaseUrl: (credentials.apiBaseUrl ?? TOOL_KIT_DEFAULT_API_BASE_URL).replace(/\/$/, ""), tokenFile };
}

// ---------------------------------------------------------- participation ---

/** What `participation.json` keeps about a join, so a re-run doesn't ask for a second confirm. */
export interface ParticipationRecord {
  joinCode: string;
  apiBaseUrl: string;
  organisationName: string;
  studyKind: string;
  windowStartUtc: string;
  windowEndUtc: string;
  granted: StudyJoinGrant[];
  joinedAt: string;
  /** The join session, so a re-run can read the grant's stores fresh. Absent in records written before it was kept. */
  joinSessionId?: string;
  /** The stores the grant covered when last read. A fallback only: see {@link readImportStores}. */
  importStores?: string[] | null;
}

export function participationFilePath(): string {
  return path.join(ascendaHome(), "participation.json");
}

export function readParticipation(): ParticipationRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(participationFilePath(), "utf8")) as ParticipationRecord;
    return parsed && typeof parsed.joinCode === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeParticipation(record: ParticipationRecord): void {
  fs.mkdirSync(path.dirname(participationFilePath()), { recursive: true, mode: 0o700 });
  writeAtomically(participationFilePath(), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

// ---------------------------------------------------------------- children ---

/** Pinned to this release, so one run installs one release's adapters. A build from a checkout takes npm's latest. */
function npxCommand(packageName: string, args: string[]): CommandLine {
  const spec = COLLECTOR_VERSION === UNRELEASED_COLLECTOR_VERSION ? packageName : `${packageName}@${COLLECTOR_VERSION}`;
  const win = process.platform === "win32";
  return { command: win ? "npx.cmd" : "npx", args: ["-y", spec, ...args], shell: win };
}

function defaultAdapterCommand(env: NodeJS.ProcessEnv): (agent: ParticipateAgent, args: string[]) => CommandLine {
  const root = env.ASCENDA_PARTICIPATE_BUNDLE_ROOT?.trim();
  if (root) {
    return (agent, args) => ({ command: process.execPath, args: [path.join(root, agent.workspaceDir, "dist", "cli.js"), ...args] });
  }
  return (agent, args) => npxCommand(agent.packageName, args);
}

function defaultImporterCommand(args: string[]): CommandLine {
  return { command: process.execPath, args: [process.argv[1], ...args] };
}

/**
 * Runs a child with its output indented under the current step. Nothing is
 * read from stdin: none of the commands run here asks a question, and the
 * one that does (`join`) runs in this process, on this terminal.
 */
function runChild(line: CommandLine, env: NodeJS.ProcessEnv, out: NodeJS.WritableStream): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(line.command, line.args, { env, stdio: ["ignore", "pipe", "pipe"], shell: line.shell ?? false });
    } catch (error) {
      out.write(`    ${error instanceof Error ? error.message : String(error)}\n`);
      resolve(127);
      return;
    }
    const indent = indenter(out, "    │ ");
    child.stdout?.on("data", indent);
    child.stderr?.on("data", indent);
    child.on("error", (error) => {
      out.write(`    could not start ${line.command}: ${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => {
      indent.flush();
      resolve(code ?? 1);
    });
  });
}

/** Prefixes every line of a stream. `\r` counts as a line start, so a progress counter stays indented. */
function indenter(out: NodeJS.WritableStream, prefix: string): ((chunk: Buffer) => void) & { flush: () => void } {
  let atStart = true;
  const write = (chunk: Buffer) => {
    let text = "";
    for (const char of chunk.toString("utf8")) {
      if (atStart && char !== "\n" && char !== "\r") text += prefix;
      text += char;
      atStart = char === "\n" || char === "\r";
    }
    out.write(text);
  };
  return Object.assign(write, {
    flush: () => {
      if (!atStart) out.write("\n");
      atStart = true;
    }
  });
}

function askYesNo(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    };
    rl.question(question, finish);
    // EOF is "no", never a hang.
    rl.once("close", () => finish(""));
  });
}

// -------------------------------------------------------------------- run ---

type AgentResult = {
  agent: ParticipateAgent;
  foundAt: string;
  state: "collecting" | "unpaired" | "failed";
  detail?: string;
  pairing?: Pairing;
};

type StudyResult =
  | { state: "joined" | "already"; record: ParticipationRecord }
  | { state: "not_joined"; reason: string; granted: StudyJoinGrant[]; importStores?: string[] | null };

/** Where the granted stores came from, and what they were. */
export type ImportStoresRead =
  | { from: "join" | "status" | "record"; stores: string[] | null }
  | { from: "unknown"; stores: null };

/** Whether git went into the backfill, and the sentence that says why. */
type GitDecision = { included: boolean; reason: string };

type RetentionResult =
  | { state: "absent" }
  | { state: "current"; plan: ClaudeRetentionPlan }
  | { state: "changed"; plan: ClaudeRetentionPlan }
  | { state: "kept"; plan: ClaudeRetentionPlan }
  | { state: "failed"; plan: ClaudeRetentionPlan; reason: string };

type BackfillResult =
  | { state: "skipped"; reason: string }
  | { state: "nothing"; git: GitDecision }
  | { state: "ran"; summary: ImportSummaryFile; shippedAs: string; git: GitDecision }
  | { state: "failed"; reason: string; git: GitDecision };

export async function runParticipate(ctx: ParticipateContext): Promise<number> {
  const env = ctx.env ?? process.env;
  const stdin = ctx.stdin ?? process.stdin;
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const print = (line = "") => stdout.write(`${line}\n`);

  let options: ParticipateOptions;
  try {
    const parsed = parseArgs(ctx.argv);
    if (parsed === "help") {
      print(USAGE);
      return 0;
    }
    options = parsed;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const ui = terminalStyle(colourEnabled(stdout, env));
  const home = os.homedir();
  const adapterCommand = ctx.adapterCommand ?? defaultAdapterCommand(env);
  const importerCommand = ctx.importerCommand ?? defaultImporterCommand;
  const step = (n: number, title: string) => print(`\n${ui.bold(`${n}/4  ${title}`)}`);

  print(`${ui.bold("Ascenda participate")} ${ui.dim(`· code ${options.joinCode}${options.apiBaseUrl ? ` · ${options.apiBaseUrl}` : ""}`)}`);

  // ---- 1. agents
  const candidates = PARTICIPATE_AGENTS.filter((agent) => !options.agents || options.agents.includes(agent.id));
  const found = candidates
    .map((agent) => ({ agent, foundAt: detectAgent(agent, home, env) }))
    .filter((entry): entry is { agent: ParticipateAgent; foundAt: string } => entry.foundAt !== undefined);
  if (found.length === 0) {
    print("");
    print(`No AI agent found on this machine (looked for ${candidates.map((agent) => agent.displayName).join(", ")}).`);
    print("Install one, run it once, then run this again.");
    return 1;
  }

  const record = readParticipation();
  const joinRemembered = !options.rejoin && rememberedJoin(record, options);
  const toPair = found.filter((entry) => !pairingOf(entry.agent));
  // The join rides on the first pairing, but only with a person at a terminal
  // to open its link. Otherwise it's left to the join step, which says so.
  const carrier = !joinRemembered && stdin.isTTY && stdout.isTTY ? toPair[0]?.agent : undefined;
  const confirms = toPair.length + (joinRemembered || carrier ? 0 : 1);
  const confirmWhat = (agent: ParticipateAgent) => `pair ${agent.displayName}${agent === carrier ? " and join the study" : ""}`;
  print("");
  print(`Found ${found.map((entry) => entry.agent.displayName).join(", ")}.`);
  print(confirms === 0
    ? "Everything here is paired and the study is joined, so nothing needs confirming."
    : `This needs ${confirms === 1 ? "one confirm" : `${confirms} confirms`} in your browser: ${[
      toPair.length ? `${toPair.length === 1 ? "one" : toPair.length} to pair ${toPair.map((entry) => entry.agent.displayName).join(", ")}${carrier ? `, the first of them also joining the study` : ""}` : "",
      joinRemembered || carrier ? "" : "one to join the study"
    ].filter(Boolean).join(", then ")}. Each is announced below before its link appears.`);

  step(1, "Agents");
  let confirmIndex = 0;
  const agents: AgentResult[] = [];
  let carried: PairingJoinOutcome | undefined;
  for (const { agent, foundAt } of found) {
    const needsConfirm = !pairingOf(agent);
    print("");
    print(`  ${ui.bold(agent.displayName)} ${ui.dim(`(found ${foundAt})`)}`);
    if (needsConfirm) print(`  ${ui.cyan(`Confirm ${++confirmIndex} of ${confirms}:`)} ${confirmWhat(agent)} using the link below.`);
    const args = ["setup", "--scope", "user", ...(options.apiBaseUrl ? ["--api-base-url", options.apiBaseUrl] : [])];
    const outcomeDir = agent === carrier ? fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-participate-join-")) : undefined;
    const outcomeFile = outcomeDir ? path.join(outcomeDir, "pairing-join.json") : undefined;
    // Set for the carrier, and cleared for every other agent, whatever the caller's environment holds.
    const childEnv: NodeJS.ProcessEnv = { ...env };
    delete childEnv[PAIR_ORG_JOIN_CODE_ENV];
    delete childEnv[PAIR_JOIN_OUTCOME_FILE_ENV];
    if (outcomeFile) {
      childEnv[PAIR_ORG_JOIN_CODE_ENV] = options.joinCode;
      childEnv[PAIR_JOIN_OUTCOME_FILE_ENV] = outcomeFile;
    }
    let exit: number;
    try {
      exit = await runChild(adapterCommand(agent, args), childEnv, stdout);
      if (outcomeFile) carried = readPairingJoinOutcome(outcomeFile);
    } finally {
      if (outcomeDir) fs.rmSync(outcomeDir, { recursive: true, force: true });
    }
    const pairing = pairingOf(agent);
    if (exit !== 0) agents.push({ agent, foundAt, state: "failed", detail: `setup exited ${exit}`, pairing });
    else if (!pairing) agents.push({ agent, foundAt, state: "unpaired", detail: carried?.pairing === "cancelled" ? "pairing declined" : "hooks installed, pairing didn't finish" });
    else agents.push({ agent, foundAt, state: "collecting", pairing });
  }

  // Claude Code first: it's the store the backfill reads most from, and the
  // installation the importer has always shipped as.
  const paired = agents.filter((result) => result.pairing);
  const lead = paired.find((result) => result.agent.id === "claude_code") ?? paired[0];

  // ---- 2. study
  step(2, "Study");
  let study: StudyResult;
  if (joinRemembered && record) {
    study = { state: "already", record };
    print(`  Already joined ${record.organisationName} with this code ${ui.dim(`(${formatWindow(record.windowStartUtc, record.windowEndUtc)})`)}. Not asking again.`);
    print(ui.dim("  To join again anyway, add --rejoin."));
  } else if (carried && settledByPairing(carried)) {
    study = studyFromPairing(carried, options, agents.find((result) => result.agent === carrier)?.pairing?.apiBaseUrl ?? lead?.pairing?.apiBaseUrl ?? "");
    if (study.state === "not_joined") print(`  Not joined: ${study.reason}`);
    else {
      writeParticipation(study.record);
      print(`  Joined ${study.record.organisationName} with the pairing confirmed above. No second confirm.`);
    }
  } else if (!lead?.pairing) {
    study = { state: "not_joined", reason: "no agent is paired, and joining needs one", granted: [] };
    print("  Skipped: joining needs a paired agent, and none paired above.");
  } else {
    if (carried?.join === "not_carried") print(ui.dim("  This server didn't take the code on the pairing, so the study is joined separately."));
    print(`  ${ui.cyan(`Confirm ${++confirmIndex} of ${Math.max(confirms, confirmIndex)}:`)} join the study, after you answer the question below.`);
    let outcome: StudyJoinOutcome | undefined;
    await runStudyJoin({
      apiBaseUrl: lead.pairing.apiBaseUrl,
      eventWriteToken: readTokenFile(lead.pairing.tokenFile) ?? "",
      displayName: lead.agent.displayName,
      joinCode: options.joinCode,
      stdin,
      stdout,
      stderr,
      pollIntervalMs: ctx.joinPollIntervalMs,
      onOutcome: (result) => {
        outcome = result;
      }
    });
    if (outcome?.status === "joined" && outcome.start) {
      const joined: ParticipationRecord = {
        joinCode: options.joinCode,
        apiBaseUrl: lead.pairing.apiBaseUrl,
        organisationName: outcome.start.organisationName,
        studyKind: outcome.start.studyKind,
        windowStartUtc: outcome.start.windowStartUtc,
        windowEndUtc: outcome.start.windowEndUtc,
        granted: outcome.granted,
        joinedAt: new Date().toISOString(),
        joinSessionId: outcome.start.joinSessionId,
        importStores: outcome.importStores ?? null
      };
      writeParticipation(joined);
      study = { state: "joined", record: joined };
    } else {
      study = { state: "not_joined", reason: describeJoinMiss(outcome), granted: outcome?.granted ?? [], importStores: outcome?.importStores };
    }
  }

  // ---- 3. retention
  step(3, "Retention");
  const retention = await runRetention(options, home, env, stdin, stdout, print);

  // ---- 4. backfill
  step(4, "Backfill");
  const granted = study.state === "not_joined" ? study.granted : study.record.granted;
  let backfill: BackfillResult;
  if (!options.backfill) {
    backfill = { state: "skipped", reason: "--no-backfill" };
    print("  Skipped, as asked (--no-backfill).");
  } else if (!lead?.pairing) {
    backfill = { state: "skipped", reason: "no agent is paired to send it as" };
    print("  Skipped: no agent is paired to send it as.");
  } else if (!granted.some((grant) => grant.code === HISTORICAL_IMPORT_GRANT)) {
    backfill = { state: "skipped", reason: "the study didn't grant importing your history, so it would be refused" };
    print("  Skipped: importing your history wasn't granted, so the backend would refuse it.");
  } else {
    const stores = await importStoresFor(study, readTokenFile(lead.pairing.tokenFile) ?? "");
    const git = gitDecision(stores);
    print(`  Git history: ${git.included ? "" : "not "}included. ${capitalise(git.reason)}.`);
    backfill = await runBackfill(lead, importerCommand, env, stdout, git);
  }

  // ---- summary
  printSummary({ agents, study, retention, backfill, print, ui, home });

  const ok =
    agents.every((result) => result.state === "collecting") &&
    study.state !== "not_joined" &&
    retention.state !== "failed" &&
    (backfill.state === "ran" ? backfill.summary.exitCode === 0 : backfill.state !== "failed");
  return ok ? 0 : 1;
}

function readPairingJoinOutcome(file: string): PairingJoinOutcome | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PairingJoinOutcome;
    return parsed && typeof parsed.join === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the pairing's own outcome answers the study question, so no separate join is needed. */
function settledByPairing(outcome: PairingJoinOutcome): boolean {
  return outcome.join === "refused" || outcome.join === "carried";
}

/** The study result a pairing that carried the join (or was refused at create) tells us. */
function studyFromPairing(outcome: PairingJoinOutcome, options: ParticipateOptions, apiBaseUrl: string): StudyResult {
  if (outcome.join === "refused") return { state: "not_joined", reason: outcome.message ?? "the code was refused", granted: [] };
  const join = outcome.studyJoin;
  if (!join) {
    const reason = outcome.pairing === "paired" ? "the join didn't finish" : "the pairing wasn't confirmed, so neither was the join";
    return { state: "not_joined", reason, granted: [] };
  }
  const granted = join.granted ?? [];
  if (join.status === "confirmed" && granted.length > 0) {
    return {
      state: "joined",
      record: {
        joinCode: options.joinCode,
        apiBaseUrl,
        organisationName: join.organisationName,
        studyKind: join.studyKind,
        windowStartUtc: join.windowStartUtc,
        windowEndUtc: join.windowEndUtc,
        granted,
        joinedAt: new Date().toISOString(),
        joinSessionId: join.joinSessionId,
        importStores: join.importStores ?? null
      }
    };
  }
  if (join.status === "confirmed") return { state: "not_joined", reason: "nothing was granted", granted: [] };
  if (join.status === "refused") return { state: "not_joined", reason: describeStudyJoinRefusal(join.refusedReason), granted, importStores: join.importStores };
  if (join.status === "expired") return { state: "not_joined", reason: "the link expired before it was confirmed", granted: [] };
  return { state: "not_joined", reason: "the link wasn't confirmed in time", granted: [] };
}

/** A remembered join for this code whose window hasn't closed. */
function rememberedJoin(record: ParticipationRecord | undefined, options: ParticipateOptions): boolean {
  if (!record || record.joinCode !== options.joinCode) return false;
  if (options.apiBaseUrl && options.apiBaseUrl !== record.apiBaseUrl) return false;
  const end = Date.parse(record.windowEndUtc);
  return Number.isFinite(end) && end > Date.now();
}

function describeJoinMiss(outcome: StudyJoinOutcome | undefined): string {
  switch (outcome?.status) {
    case "not_now":
      return "you chose not now";
    case "no_terminal":
      return "joining needs an interactive terminal";
    case "expired":
      return "the code expired before it was confirmed";
    case "refused":
    case "failed":
      return outcome.message ?? "the join didn't go through";
    default:
      return "the join didn't finish";
  }
}

async function runRetention(
  options: ParticipateOptions,
  home: string,
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  print: (line?: string) => void
): Promise<RetentionResult> {
  const paths = resolveStorePaths(home, env);
  if (!fs.existsSync(paths.claudeRoot)) {
    print("  Nothing to change: Claude Code isn't on this machine.");
    return { state: "absent" };
  }
  const plan = await planClaudeRetentionFix(paths);
  const where = tidyHomePath(plan.settingsPath, home);
  if (!plan.changeNeeded) {
    print(`  Claude Code keeps transcripts for ${plan.currentCleanupPeriodDays} days already. Nothing to change.`);
    return { state: "current", plan };
  }
  const before = plan.currentCleanupPeriodDays === null ? "30 days (the default)" : `${plan.currentCleanupPeriodDays} days`;
  print(`  Claude Code deletes transcripts after ${before}, and the backfill can only send what's still there.`);
  print(`  The change: cleanupPeriodDays → ${plan.proposedCleanupPeriodDays} in ${where}. Nothing else in that file changes.`);

  let apply = options.retention === "apply";
  if (options.retention === "ask") {
    if (stdin.isTTY && stdout.isTTY) {
      apply = await askYesNo(stdin, stdout, "  Make this change? [y/N] ");
    } else {
      print("  Not changed: no terminal to ask in. Run with --fix-retention to make it.");
    }
  }
  if (!apply) {
    if (options.retention !== "ask" || (stdin.isTTY && stdout.isTTY)) print("  Left as it is.");
    return { state: "kept", plan };
  }
  try {
    await applyClaudeRetentionFix(plan);
    print(`  Changed. Claude Code now keeps transcripts for ${plan.proposedCleanupPeriodDays} days.`);
    return { state: "changed", plan };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    print(`  Not changed: ${reason}`);
    return { state: "failed", plan, reason };
  }
}

/**
 * The stores the history-import grant covers, for this run.
 *
 * A join made in this run already read them from its status. A join made
 * earlier is read again from the server, since the grant may have changed
 * since; the record's copy is used only when that read fails, and a record
 * with neither a session nor a copy gives "unknown", which leaves git out.
 */
export async function readImportStores(record: ParticipationRecord | undefined, token: string): Promise<ImportStoresRead> {
  if (record?.joinSessionId) {
    try {
      const status = await getStudyJoinStatus(record.apiBaseUrl, token, record.joinSessionId);
      const stores = status.importStores ?? null;
      if (!sameStores(stores, record.importStores)) writeParticipation({ ...record, importStores: stores });
      return { from: "status", stores };
    } catch {
      // Fall through to what the record kept.
    }
  }
  if (record && Array.isArray(record.importStores)) return { from: "record", stores: record.importStores };
  return { from: "unknown", stores: null };
}

function sameStores(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort()) && (a == null) === (b == null);
}

async function importStoresFor(study: StudyResult, token: string): Promise<ImportStoresRead> {
  if (study.state === "joined") return { from: "join", stores: study.record.importStores ?? null };
  if (study.state === "already") return readImportStores(study.record, token);
  if (study.state !== "not_joined" || study.importStores === undefined) return { from: "unknown", stores: null };
  return { from: "join", stores: study.importStores };
}

const GIT_NOT_GRANTED = "your history-import grant doesn't cover git. To add it, run this again with --rejoin and tick the git box on the page";

function gitDecision(read: ImportStoresRead): GitDecision {
  if (read.stores?.includes("git")) return { included: true, reason: "your history-import grant covers git" };
  if (read.from === "unknown") return { included: false, reason: "couldn't read which stores your grant covers, so git was left out" };
  return { included: false, reason: GIT_NOT_GRANTED };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function runBackfill(
  lead: AgentResult & { pairing?: Pairing },
  importerCommand: (args: string[]) => CommandLine,
  env: NodeJS.ProcessEnv,
  stdout: NodeJS.WriteStream,
  git: GitDecision
): Promise<BackfillResult> {
  const pairing = lead.pairing!;
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-participate-"));
  const summaryFile = path.join(summaryDir, "import-summary.json");
  stdout.write(`  Sending as ${lead.agent.displayName}'s pairing ${pairing.toolInstallationId}.\n`);
  try {
    // The importer reads its pairing from these, so it ships as the agent
    // paired above whatever else is set in the environment.
    const args = ["import", "--ship", ...(git.included ? ["--git"] : []), "--summary-json", summaryFile];
    const exit = await runChild(importerCommand(args), {
      ...env,
      ASCENDA_API_BASE_URL: pairing.apiBaseUrl,
      ASCENDA_TOOL_INSTALLATION_ID: pairing.toolInstallationId,
      ASCENDA_EVENT_WRITE_TOKEN_FILE: pairing.tokenFile
    }, stdout);
    let summary: ImportSummaryFile;
    try {
      summary = JSON.parse(fs.readFileSync(summaryFile, "utf8")) as ImportSummaryFile;
    } catch {
      return { state: "failed", reason: `the import exited ${exit} without a summary`, git };
    }
    if (summary.nothingToImport) return { state: "nothing", git };
    return { state: "ran", summary, shippedAs: pairing.toolInstallationId, git };
  } finally {
    fs.rmSync(summaryDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- summary ---

const REJECTION_SENTENCES: Readonly<Record<string, string>> = {
  consent_missing_or_expired: "no history-import consent on the account",
  consent_source_not_granted: "history import isn't granted for this agent's history",
  validation_failed: "the backend didn't accept the event's shape"
};

function printSummary(input: {
  agents: AgentResult[];
  study: StudyResult;
  retention: RetentionResult;
  backfill: BackfillResult;
  print: (line?: string) => void;
  ui: ReturnType<typeof terminalStyle>;
  home: string;
}): void {
  const { agents, study, retention, backfill, print, ui } = input;
  const label = (text: string) => `  ${text.padEnd(11)}`;
  const pad = " ".repeat(13);
  print("");
  print("─".repeat(60));
  print(ui.bold("Summary"));

  agents.forEach((result, i) => {
    const head = i === 0 ? label("Agents") : pad;
    const name = result.agent.displayName.padEnd(12);
    if (result.state === "collecting") {
      print(`${head}${ui.mark("ok")} ${name} collecting ${ui.dim(result.pairing!.toolInstallationId)}`);
      if (result.agent.afterPairing) print(`${pad}  ${" ".repeat(14)}${result.agent.afterPairing}`);
    }
    else if (result.state === "unpaired") print(`${head}${ui.mark("warn")} ${name} not collecting: ${result.detail}`);
    else print(`${head}${ui.mark("bad")} ${name} not collecting: ${result.detail}${result.pairing ? ui.dim(" (an earlier pairing is still saved)") : ""}`);
  });

  if (study.state === "not_joined") {
    print(`${label("Study")}${ui.mark("bad")} not joined: ${study.reason}`);
    if (study.granted.length) print(`${pad}  granted before it stopped: ${study.granted.map(describeStudyGrant).join("; ")}`);
  } else {
    const { record } = study;
    print(`${label("Study")}${ui.mark("ok")} ${record.organisationName}, ${describeStudyKind(record.studyKind)}${study.state === "already" ? ui.dim(" (joined earlier)") : ""}`);
    print(`${pad}  window ${formatWindow(record.windowStartUtc, record.windowEndUtc)}`);
    for (const grant of record.granted) print(`${pad}  granted: ${describeStudyGrant(grant)}`);
  }

  const days = (plan: ClaudeRetentionPlan) => plan.currentCleanupPeriodDays === null ? "30 days (default)" : `${plan.currentCleanupPeriodDays} days`;
  if (retention.state === "absent") print(`${label("Retention")}${ui.mark("info")} Claude Code isn't on this machine`);
  else if (retention.state === "current") print(`${label("Retention")}${ui.mark("ok")} ${days(retention.plan)}, unchanged`);
  else if (retention.state === "changed") print(`${label("Retention")}${ui.mark("ok")} ${days(retention.plan)} → ${retention.plan.proposedCleanupPeriodDays} days`);
  else if (retention.state === "kept") print(`${label("Retention")}${ui.mark("warn")} ${days(retention.plan)}, unchanged. Transcripts older than that are deleted`);
  else print(`${label("Retention")}${ui.mark("bad")} ${days(retention.plan)}, not changed: ${retention.reason}`);

  if (backfill.state === "skipped") print(`${label("Backfill")}${ui.mark("info")} skipped: ${backfill.reason}`);
  else if (backfill.state === "nothing") print(`${label("Backfill")}${ui.mark("info")} no agent history on this machine to send`);
  else if (backfill.state === "failed") print(`${label("Backfill")}${ui.mark("bad")} ${backfill.reason}`);
  else {
    const { summary } = backfill;
    const ship = summary.shipResult;
    const n = (value: number) => value.toLocaleString("en-US");
    if (!ship) {
      print(`${label("Backfill")}${ui.mark("bad")} ${n(summary.totalExtracted)} events read, none sent: ${summary.shipError ?? "the send didn't run"}`);
    } else {
      const tone = summary.exitCode === 0 ? "ok" : "bad";
      print(`${label("Backfill")}${ui.mark(tone)} ${n(ship.sent)} events sent: ${n(ship.accepted)} accepted, ${n(ship.duplicate)} already there, ${n(ship.rejected)} rejected`);
      for (const [store, counts] of Object.entries(ship.perStore)) {
        print(`${pad}  ${store.padEnd(12)} ${n(counts.accepted)} accepted, ${n(counts.duplicate)} already there, ${n(counts.rejected)} rejected`);
      }
      for (const [reason, count] of Object.entries(ship.rejectionReasons)) {
        print(`${pad}  ${n(count)} rejected: ${REJECTION_SENTENCES[reason] ?? reason}`);
      }
      if (ship.consentBlocked) print(`${pad}  stopped early: the account has no consent for a history import, so nothing more was sent`);
      if (ship.storesNotGranted?.length) print(`${pad}  not granted, so skipped: ${ship.storesNotGranted.join(", ")}`);
      if (ship.httpFailures) print(`${pad}  ${n(ship.httpFailures)} batch(es) failed to send. Run this again to fill the gaps`);
    }
    for (const outcome of summary.outcomes.filter((entry) => entry.status === "failed")) {
      print(`${pad}  ${outcome.store} couldn't be read: ${outcome.error}`);
    }
  }
  if (backfill.state !== "skipped") {
    print(`${label("Git")}${ui.mark(backfill.git.included ? "ok" : "info")} ${backfill.git.included ? "included" : "not included"}: ${backfill.git.reason}`);
  }

  print("");
  const unpaired = agents.filter((result) => result.state !== "collecting");
  if (unpaired.length || study.state === "not_joined" || backfill.state === "failed") {
    print("Run the same command again to finish. Anything already done is kept.");
  } else {
    print(`Done. Restart ${agents.map((result) => result.agent.displayName).join(", ")} so ${agents.length === 1 ? "it loads" : "they load"} the hooks.`);
  }
}
