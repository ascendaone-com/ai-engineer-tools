import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * What the collectors and the Waterline screen saver tell each other
 * outside the live socket.
 *
 * The saver listens on the bus only while it is on screen. That is the right
 * discipline for the socket (an app launched on wake must find it free), and
 * it leaves two gaps this file closes:
 *
 *  - **Signals sent before the saver starts.** The normal sequence is:
 *    submit a prompt, walk away, and the saver starts minutes later. Every
 *    signal in between finds no listener and is gone, so a permission prompt
 *    the agent raised after the person left never reaches the screen that
 *    exists to say so. {@link holdForSaver} keeps the last signal of each
 *    session in a small file inside the saver's container, and the saver
 *    replays it when it binds.
 *  - **No way to tell, from outside, what the saver is doing.** The saver
 *    writes a heartbeat per process (pid, preview or not, which mode, when it
 *    last heard a signal). {@link readSaverStatuses} reads them, so `doctor`
 *    can answer "is the saver listening, and is it the one on screen?" with
 *    a line instead of `lsof`.
 *
 * Both files carry what the socket carries and nothing more: tool, session
 * id, event name, size bucket, a timestamp. No prompt text, no paths. Both
 * live in the saver's container, which only this user can read.
 *
 * The shapes are pinned on the saver side in its state contract; change them
 * there and here together.
 */

const SAVER_HOST_BUNDLE_ID = "com.apple.ScreenSaver.Engine.legacyScreenSaver";

/** The saver host's container data directory: what HOME is, inside the sandbox. */
export function saverContainerDir(): string {
  return process.env.ASCENDA_SAVER_CONTAINER
    ?? path.join(os.homedir(), "Library", "Containers", SAVER_HOST_BUNDLE_ID, "Data");
}

/** Where the saver keeps its own state, inside its container. */
export function saverSupportDir(): string {
  return path.join(saverContainerDir(), "Library", "Application Support", "AscendaWaterlineSaver");
}

/** Signals held for a saver that was not listening when they were sent. */
export function saverReplayPath(): string {
  return path.join(saverContainerDir(), "l.replay.json");
}

/** One heartbeat file per saver process. */
export function saverStatusDir(): string {
  return path.join(saverSupportDir(), "status");
}

/**
 * How long a held signal stays worth replaying. Matches the longest state a
 * listener holds without a fresh beat: a session waiting on the person, which
 * the app and the saver both keep for 30 minutes.
 */
export const SAVER_REPLAY_WINDOW_MS = 30 * 60 * 1000;

/** Sessions kept at most. A machine with more concurrent agents than this is not the case to plan for. */
const SAVER_REPLAY_MAX = 32;

export const SAVER_REPLAY_SCHEMA = 1;

type HeldSignal = Record<string, unknown> & { tool: string; session: string; event: string; at: number };

/**
 * Keeps `signal` as its session's latest word for a saver that isn't
 * listening yet. Best effort, never throws.
 *
 * Only on a machine where the Waterline saver has run: its support folder
 * inside Apple's container is the evidence. Anyone without the saver gets no
 * file, and nothing is ever created inside a container that does not
 * already exist.
 *
 * One entry per tool and session, because the latest beat is what decides a
 * session's state (working, waiting, stopped). Older than
 * {@link SAVER_REPLAY_WINDOW_MS} is dropped on every write.
 */
export function holdForSaver(signal: object, now = Date.now()): void {
  try {
    if (process.env.ASCENDA_LIVE_BUS_SOCKET && !process.env.ASCENDA_SAVER_CONTAINER) return;
    if (!fs.existsSync(saverSupportDir())) return;
    const wire = signal as Record<string, unknown>;
    const tool = wire.tool;
    const session = wire.session;
    const event = wire.event;
    if (typeof tool !== "string" || typeof session !== "string" || typeof event !== "string") return;

    const file = saverReplayPath();
    const kept = readHeld(file).filter((held) =>
      now - held.at <= SAVER_REPLAY_WINDOW_MS && !(held.tool === tool && held.session === session));
    // The whole signal, process id included: listeners key a stream by its
    // process when it has one, so a replay without it would open a second
    // stream beside the live one the next hook speaks on.
    kept.push({ ...wire, tool, session, event, at: now });
    kept.sort((a, b) => a.at - b.at);
    const body = JSON.stringify({ schema: SAVER_REPLAY_SCHEMA, signals: kept.slice(-SAVER_REPLAY_MAX) });

    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A cosmetic replay is never worth a word in the user's transcript.
  }
}

function readHeld(file: string): HeldSignal[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; signals?: unknown };
    if (parsed.schema !== SAVER_REPLAY_SCHEMA || !Array.isArray(parsed.signals)) return [];
    return parsed.signals.filter((held): held is HeldSignal =>
      typeof held === "object" && held !== null
      && typeof (held as HeldSignal).tool === "string"
      && typeof (held as HeldSignal).session === "string"
      && typeof (held as HeldSignal).event === "string"
      && typeof (held as HeldSignal).at === "number");
  } catch {
    return [];
  }
}

/** How many signals are waiting for the saver, and how old the newest is. */
export function heldForSaver(now = Date.now()): { count: number; newestAgeMs?: number } {
  const held = readHeld(saverReplayPath()).filter((entry) => now - entry.at <= SAVER_REPLAY_WINDOW_MS);
  if (held.length === 0) return { count: 0 };
  return { count: held.length, newestAgeMs: now - Math.max(...held.map((entry) => entry.at)) };
}

/** One saver process's heartbeat, as the saver writes it. */
export interface SaverStatus {
  pid: number;
  version?: string;
  updatedAt: string;
  /** Preview views this process is drawing (System Settings). */
  previewViews: number;
  /** Full screen saver views this process is drawing. */
  saverViews: number;
  /** `paired`, `live` or `ambient`, for this process's shared feed. */
  mode?: string;
  ownsBus: boolean;
  socketPath?: string;
  boundAt?: string;
  /** Last time a bind was refused because something else answered on the socket. */
  bindRefusedAt?: string;
  signals: number;
  lastSignalAt?: string;
  lastSignalEvent?: string;
  /** Lines that parsed as JSON but named an event this saver doesn't know. */
  unknownEvents: number;
  lastPingAt?: string;
  lastPingSession?: string;
  /** Signals replayed from the held file at the last bind. */
  replayed: number;
}

export interface SaverStatusReading extends SaverStatus {
  /** Whether the process named by `pid` is still running. */
  alive: boolean;
  /** Milliseconds since the heartbeat was written. */
  ageMs: number;
}

/**
 * Every heartbeat file the saver has left, newest first. A file whose
 * process is gone is reported as such rather than hidden: a dead process
 * that still owns the socket file is one of the things `doctor` must say.
 */
export function readSaverStatuses(now = Date.now()): SaverStatusReading[] {
  let names: string[];
  try {
    names = fs.readdirSync(saverStatusDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const readings: SaverStatusReading[] = [];
  for (const name of names) {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(saverStatusDir(), name), "utf8")) as SaverStatus;
      if (typeof status.pid !== "number" || typeof status.updatedAt !== "string") continue;
      readings.push({ ...status, alive: processAlive(status.pid), ageMs: now - Date.parse(status.updatedAt) });
    } catch {
      // Half-written or foreign. Skipped, never fatal.
    }
  }
  return readings.sort((a, b) => a.ageMs - b.ageMs);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What answers at one socket candidate. */
export type SocketState = "absent" | "stale" | "listening" | "unreachable";

/**
 * Connects to `socketPath` and hangs up without writing. Tells a live
 * listener from a socket file a crashed one left behind. Never rejects.
 */
export function probeSocket(socketPath: string, timeoutMs = 300): Promise<SocketState> {
  return new Promise((resolve) => {
    try {
      if (!fs.statSync(socketPath).isSocket()) {
        resolve("absent");
        return;
      }
    } catch {
      resolve("absent");
      return;
    }
    let settled = false;
    const finish = (state: SocketState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish("unreachable"), timeoutMs);
    socket.on("connect", () => finish("listening"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "unreachable"));
  });
}
