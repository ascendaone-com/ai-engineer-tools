import { describeAge, readLastHook, resolveHookNode } from "./hookRunner";
import { deliverLine, liveBusSocketCandidates } from "./liveBus";
import { heldForSaver, probeSocket, readSaverStatuses } from "./saverHandoff";
import type { SaverStatusReading } from "./saverHandoff";
import { terminalStyle } from "./terminalStyle";
import type { TerminalStyle, Tone } from "./terminalStyle";

/**
 * `doctor`'s first section: the local half, which needs no pairing and is
 * what a new install depends on. Every question that cost an afternoon on a
 * clean account gets one line here:
 *
 *  - can the hooks start (is there a Node the launcher finds without a
 *    shell profile),
 *  - are they registered where the agent will load them,
 *  - has the agent run one yet,
 *  - who is listening on the live bus, and is it the screen saver on screen
 *    or a preview that never listens,
 *  - and does a signal actually arrive (a ping, read back from the saver's
 *    own heartbeat).
 *
 * Reads only this user's files and sockets: no `sudo`, no other users'
 * processes, which is what made the shell diagnostics it replaces wrong.
 */

export interface HookRegistration {
  /** The hooks file, as a person should read it. */
  file: string;
  registered: number;
  scope: "user" | "project";
  /** A project install in the home folder, which loads only when the agent starts there. */
  homeProject?: boolean;
}

export interface LiveSignalDoctorOptions {
  /** The agent, as a person names it: `Claude Code`, `Codex CLI`. */
  displayName: string;
  /** Names `state/<tool>-last-hook.json`. */
  tool: string;
  /** The installed launcher, asked which Node it would run. Omitted on Windows. */
  launcher?: string;
  registrations: HookRegistration[];
  eventCount: number;
  /** How to run this tool again, e.g. `~/.ascenda/bin/ascenda-codex-hook`. */
  selfCommand: string;
  /** What to tell a person whose hooks are missing. */
  setupCommand: string;
  /** Where to look in the agent once it has restarted, e.g. `type /hooks`. */
  lookHint?: string;
  ui?: TerminalStyle;
}

/** Where values start on a `doctor` row, so continuation lines can line up under them. */
export const DOCTOR_VALUE_COLUMN = 25;

/** One `doctor` row: a mark, a label, then the value from {@link DOCTOR_VALUE_COLUMN}. */
export function doctorRow(ui: TerminalStyle, tone: Tone, label: string, value: string): string {
  return `  ${ui.mark(tone)} ${label.padEnd(DOCTOR_VALUE_COLUMN - 5)} ${value}`;
}

export async function liveSignalDoctorLines(options: LiveSignalDoctorOptions): Promise<string[]> {
  const ui = options.ui ?? terminalStyle();
  const lines: string[] = [`  ${ui.bold("Live signal")} ${ui.dim("(this machine; needs no pairing)")}`];
  const now = Date.now();
  let problems = 0;
  const row = (tone: Tone, label: string, value: string) => {
    if (tone === "bad" || tone === "warn") problems += 1;
    lines.push(doctorRow(ui, tone, label, tone === "bad" ? ui.red(value) : value));
  };
  const more = (value: string) => lines.push(`${" ".repeat(DOCTOR_VALUE_COLUMN)}${value}`);

  if (options.launcher && process.platform !== "win32") {
    const node = resolveHookNode(options.launcher);
    if (node.problem) row("bad", "Node", `${node.problem}. Install Node 20 or newer, then run setup again`);
    else row("ok", "Node", `${node.node} ${ui.dim(`(${node.version}, ${node.how === "recorded" ? "recorded at setup" : "found by the launcher"})`)}`);
  }

  if (options.registrations.length === 0) row("bad", "Hooks", `not registered. Run: ${options.setupCommand}`);
  for (const entry of options.registrations) {
    const where = entry.homeProject
      ? `loads only when ${options.displayName} starts in the home folder. Run setup again to move it to every project`
      : entry.scope === "user" ? "every project" : "this project only";
    const complete = entry.registered === options.eventCount;
    row(entry.homeProject || !complete ? "warn" : entry.scope === "user" ? "ok" : "info", "Hooks",
      `${entry.registered}/${options.eventCount} in ${entry.file} ${ui.dim(`(${where})`)}`);
  }
  if (options.registrations.length > 1) {
    problems += 1;
    more(ui.yellow("Registered in more than one file, so each event runs more than once. Run setup again to fix."));
  }

  // None yet is where every install starts, so it is not a fault: the hooks
  // load when the agent next starts.
  const last = readLastHook(options.tool);
  if (last) row("ok", "Last hook", `${last.event}, ${describeAge(now - Date.parse(last.at))}`);
  else row("info", "Last hook", `none yet. Start ${options.displayName} (restart it if it was open during setup)${options.lookHint ? `, then ${options.lookHint}` : ""}`);

  const [appSocket, appContainerSocket, saverSocket] = liveBusSocketCandidates();
  const appState = await probeSocket(appSocket);
  const legacyState = appContainerSocket ? await probeSocket(appContainerSocket) : "absent";
  if (appState === "listening" || legacyState === "listening") row("ok", "Desktop app", "listening. It takes every signal, and the saver mirrors it");
  else row("info", "Desktop app", "not listening");

  const saverState = saverSocket ? await probeSocket(saverSocket) : "absent";
  const live = readSaverStatuses(now).filter((status) => status.alive);
  const holder = live.find((status) => status.ownsBus);
  const saver = describeSaver(saverState, holder, live);
  row(saver.tone, "Screen saver", saver.text);
  for (const status of live) more(ui.dim(describeProcess(status, now)));

  const held = heldForSaver(now);
  if (held.count > 0) {
    row("info", "Held for the saver", `${held.count} session${held.count === 1 ? "" : "s"}, newest ${describeAge(held.newestAgeMs ?? 0)}. Replayed when the saver starts`);
  }

  const trip = await pingRoundTrip(saverSocket, options.selfCommand);
  row(trip.tone, "Round trip", trip.text);

  lines.push("");
  lines.push(problems === 0
    ? `  ${ui.mark("ok")} ${ui.bold("Ready.")} The hooks can run, and the screen saver hears them while it's on screen.`
    : `  ${ui.mark("bad")} ${ui.bold(`${problems} problem${problems === 1 ? "" : "s"} above.`)} Each line says how to fix it.`);
  return lines;
}

function describeSaver(state: string, holder: SaverStatusReading | undefined, live: SaverStatusReading[]): { tone: Tone; text: string } {
  if (state === "listening") {
    if (!holder) return { tone: "warn", text: "listening, from a process that isn't reporting. Restart it: killall legacyScreenSaver" };
    if (holder.saverViews === 0) {
      return { tone: "bad", text: `pid ${holder.pid} holds the socket but isn't drawing the saver, so signals go nowhere you can see. Fix: killall legacyScreenSaver` };
    }
    return { tone: "ok", text: `listening, pid ${holder.pid}, on screen` };
  }
  if (state === "stale") return { tone: "info", text: "not running (a socket file was left behind, which is harmless)" };
  if (live.some((status) => status.previewViews > 0)) {
    return { tone: "info", text: "not running. The System Settings preview never listens, so it stays still; the water goes live once the saver itself runs" };
  }
  return { tone: "info", text: "not running. That's normal: it listens only while it's on screen" };
}

function describeProcess(status: SaverStatusReading, now: number): string {
  const what = [
    status.saverViews > 0 ? `saver on ${status.saverViews} display${status.saverViews === 1 ? "" : "s"}` : undefined,
    status.previewViews > 0 ? "preview" : undefined
  ].filter(Boolean).join(" + ") || "not drawing";
  const heard = status.lastSignalAt
    ? `last signal ${status.lastSignalEvent ?? ""} ${describeAge(now - Date.parse(status.lastSignalAt))}`.replace(/\s+/g, " ")
    : "no signal yet";
  // The count belongs to the process, and macOS keeps one saver process
  // across many saver runs, so it is a running total rather than this run's.
  const replay = status.replayed > 0 ? `, replayed ${status.replayed} since this process started` : "";
  const beat = status.ageMs > 10_000 ? `, heartbeat ${describeAge(status.ageMs)} (not animating)` : "";
  return `pid ${status.pid} ${status.version ?? ""}: ${what}, ${status.mode ?? "?"}${status.ownsBus ? ", owns the socket" : ""}, ${heard}${replay}${beat}`.replace(/\s+:/, ":");
}

/**
 * Sends a `ping` the way a hook sends a signal, to whoever takes it first,
 * and when that is the saver reads its heartbeat back for proof. Listeners
 * that don't know `ping` drop it as they drop any unknown event, so it never
 * moves a gauge.
 */
async function pingRoundTrip(saverSocket: string | undefined, selfCommand: string): Promise<{ tone: Tone; text: string }> {
  const session = `doctor-${process.pid}-${Date.now()}`;
  const accepted = await deliverLine(`${JSON.stringify({ tool: "doctor", session, event: "ping" })}\n`);
  if (!accepted) {
    return { tone: "info", text: `nobody is listening right now, so there is nothing to test. To test the saver: open -a ScreenSaverEngine; sleep 5; ${selfCommand} doctor` };
  }
  if (accepted !== saverSocket) return { tone: "ok", text: `the desktop app took it (${accepted})` };
  for (let waited = 0; waited < 2000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answered = readSaverStatuses().find((status) => status.lastPingSession === session);
    if (answered) return { tone: "ok", text: `OK. The screen saver (pid ${answered.pid}) received it` };
  }
  return { tone: "bad", text: "the saver's socket took the ping but no saver reported it. It may be a version from before 0.8.1, or stuck. Fix: killall legacyScreenSaver" };
}
