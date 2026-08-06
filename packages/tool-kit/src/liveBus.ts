import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The live presence bus — a local, best-effort side-channel telling the
 * Ascenda desktop app that agent work is happening *right now*.
 *
 * This is deliberately NOT the telemetry path. `AscendaEventSender` posts
 * to the backend, where events land in daily buckets read hours later.
 * The app's waterline gauges need sub-second latency, so the adapters
 * additionally whisper to a Unix domain socket on the same machine.
 *
 * Design constraints, all load-bearing (docs/MACOS_LIVE_DEMAND_WATERLINE.md
 * in the app repo):
 *
 *  - **A Unix socket, not a TCP port.** Nothing on the network can reach
 *    it, and no other local process can post spoofed presence data just by
 *    knowing a port number. Filesystem permissions are the access control.
 *  - **Fire and forget.** A hook must never block, slow, or fail a user's
 *    agent turn for the sake of a cosmetic gauge. Every error — no socket,
 *    no listener, a full buffer, a slow write — is swallowed, and the
 *    write is abandoned after {@link WRITE_TIMEOUT_MS}.
 *  - **Metadata only.** The same rule the backend path follows, kept even
 *    though nothing leaves the machine: a size *bucket* crosses the
 *    socket, never prompt text, file names, or output.
 *  - **Nothing is stored.** The app holds this in memory to drive a
 *    display; it is not a wellbeing record and does not need consent.
 *    Ingest consent governs the backend path and is unaffected either way.
 */

/** Abandon a write that hasn't completed this fast. Cosmetic data is not worth a stall. */
const WRITE_TIMEOUT_MS = 50;

/** Coarse size of the work a prompt kicked off — drives the waterline's attack height. */
export type PromptSizeBucket = "s" | "m" | "l" | "xl";

/** The lifecycle moments the waterline reacts to. */
export type LiveBusEvent =
  | "prompt_submitted"
  | "tool_call"
  | "compaction"
  | "tool_failure"
  | "stop";

export interface LiveBusSignal {
  /** Which surface — `claude_code`, `vscode_extension`, `cursor_mcp`, `cli_agent`. */
  tool: string;
  /** Opaque per-session id, so concurrent sessions count as separate streams. */
  session: string;
  event: LiveBusEvent;
  /** Only meaningful on `prompt_submitted`. */
  sizeBucket?: PromptSizeBucket;
}

/** The desktop app's bundle id, for the sandbox container path below. */
const APP_BUNDLE_ID = "one.ascenda.ascendaMissionControl";

/**
 * Every place the app might be listening, in preference order.
 *
 * The wrinkle: **the macOS app is sandboxed**, so its `HOME` is redirected
 * into `~/Library/Containers/<bundle-id>/Data/` and it cannot create a
 * socket at the real `~/.ascenda/` at all. Hooks are ordinary unsandboxed
 * processes, so they see the true home and would never find it.
 *
 * The sandbox constrains the *sandboxed* process, not everyone else: a hook
 * can happily connect into the container, which is owned by the same user.
 * So we look in the plain location first (an unsandboxed or future build,
 * and the nicer home) and fall back to the container.
 *
 * The tidier long-term fix is an App Group container shared by both, but
 * that needs the entitlement provisioned against the signing identity —
 * a deployment change, not a code one.
 */
export function liveBusSocketCandidates(): string[] {
  const override = process.env.ASCENDA_LIVE_BUS_SOCKET;
  if (override) return [override];
  const home = os.homedir();
  return [
    path.join(home, ".ascenda", "live.sock"),
    path.join(home, "Library", "Containers", APP_BUNDLE_ID, "Data", ".ascenda", "live.sock")
  ];
}

/**
 * The first candidate that actually exists, or the preferred one when none
 * do — connecting to a missing socket is already a silent no-op, so there
 * is no need for a distinct "nowhere to send" branch.
 */
export function liveBusSocketPath(): string {
  const candidates = liveBusSocketCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch {
      // Not there; try the next.
    }
  }
  return candidates[0];
}

/**
 * Buckets a prompt by character length, computed **in this process** so
 * only the bucket ever crosses the socket.
 *
 * The thresholds are rough on purpose. This drives how high a gauge jumps,
 * not a metric anyone reasons over, and a prompt's character count is only
 * loosely related to the work it unleashes — a one-line "fix the build" can
 * outrun a long paste. Four buckets is as much precision as that deserves.
 */
export function bucketPromptSize(text: string | undefined): PromptSizeBucket {
  const length = typeof text === "string" ? text.length : 0;
  if (length <= 280) return "s";
  if (length <= 2000) return "m";
  if (length <= 8000) return "l";
  return "xl";
}

/**
 * Whisper one signal to the app. Never throws, never rejects, and resolves
 * as soon as the write lands or is abandoned — callers may ignore the
 * promise entirely.
 *
 * A fresh connection per signal is deliberate: hook processes are
 * short-lived (one per lifecycle event), so there is no long-lived process
 * to hold a socket open, and at these rates — a handful of signals a second
 * at worst — connection setup on a Unix socket is negligible.
 */
export function emitLiveSignal(signal: LiveBusSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Already gone. Nothing to do, and nothing worth reporting.
      }
      resolve();
    };

    let socket: net.Socket;
    try {
      socket = net.createConnection(liveBusSocketPath());
    } catch {
      // No socket file, wrong permissions, malformed path — the app simply
      // isn't listening. That is the ordinary case for anyone who doesn't
      // run the desktop app, and it is not an error.
      resolve();
      return;
    }

    const timer = setTimeout(done, WRITE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    if (typeof socket.unref === "function") socket.unref();

    socket.on("error", done);
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(signal)}\n`, () => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        done();
      }
    });
  });
}
