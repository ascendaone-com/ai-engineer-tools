import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { isHookSet } from "./hookSet";
import { holdForSaver } from "./saverHandoff";

/**
 * The live presence bus — a local, best-effort side-channel telling the
 * Ascenda desktop app that agent work is happening *right now*.
 *
 * This is deliberately NOT the telemetry path. `AscendaEventSender` posts
 * to the backend, where events land in daily buckets read hours later.
 * The app's waterline gauges need sub-second latency, so the adapters
 * additionally whisper to a Unix domain socket on the same machine.
 *
 * Design constraints, all load-bearing:
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

/**
 * The lifecycle moments the waterline reacts to.
 *
 * Note what is *not* here: there is no "queued" event. Nothing fires when a
 * user queues a message — the only trace queueing leaves is a label on the
 * turn that eventually runs (see {@link LiveBusSignal.queued}).
 *
 * `awaiting` is the one beat that is not work: the agent has stopped and is
 * waiting on the person — a permission dialog, a question it asked, or an
 * MCP server's form. The idle "waiting for your input" is not one of these:
 * it follows a turn that already ended, so it is `halted`. It exists
 * because every other beat reads as load, and a parked tool call was
 * indistinguishable from a running one until the stale window ran out.
 *
 * It is a **state, not a moment**: it holds until that session's next beat
 * of any kind, which is the only evidence an adapter ever gets that the
 * person answered. The app caps it (`awaitingTtl` in
 * `apps/macos/lib/src/flow/live_demand.dart`) because no host tells the bus
 * that a session closed. Emit it only where the host itself says it is
 * waiting; never infer it from silence, which is what stale already means.
 */
export type LiveBusEvent =
  | "prompt_submitted"
  | "tool_call"
  | "compaction"
  | "tool_failure"
  | "stop"
  | "awaiting"
  /**
   * The turn ended without completing: the agent hit an API error, or it is
   * sitting at an idle prompt after a turn that never sent `stop`. The app
   * mainly needs to know the work is no longer running, so it can drain the
   * gauge now rather than wait for the session to go stale. An API error
   * also says which kind in {@link LiveBusSignal.errorKind}, so a usage limit
   * can read as one. An idle prompt carries no kind.
   *
   * Never a `stop`. A stop means the agent finished its turn, and the app
   * celebrates that differently. A halted turn didn't finish.
   *
   * Listeners that predate this value drop it, so emitting it is safe
   * against any app version.
   */
  | "halted";

/**
 * Why a `halted` from `StopFailure` ended the turn on an API error. Two
 * values, because the display has two things to say: a usage limit is something the person
 * waits out, and anything else is something they look at.
 */
export type LiveBusStopFailureKind = "rate_limit" | "error";

/**
 * How long a listener may trust a non-zero {@link LiveBusSignal.backgroundTasks}
 * with no further word from the session. A count is a snapshot taken at the
 * stop; nothing fires when the last background task exits, so a session that
 * is closed, killed or forgotten leaves its last count standing. Past this,
 * the session is treated as gone quiet. Listeners hold the same figure.
 */
export const LIVE_BUS_BACKGROUND_TRUST_MS = 60 * 60 * 1000;

export interface LiveBusSignal {
  /**
   * Which surface is speaking: `claude_code`, `vscode_extension`,
   * `cursor_mcp`, and the CLI adapters under their own host names —
   * `codex`, `windsurf`, `gemini_cli`.
   *
   * **Finer-grained than the backend tool type on purpose.** Those three
   * adapters all file cloud events under the shared `cli_agent` type, but
   * the app keys one decaying envelope per `tool`/`session` pair, so
   * reporting the shared value here would fuse three different agents into
   * one stream and make the concurrency gauge under-count. Free-form by
   * contract — the app groups by whatever string arrives and validates
   * nothing but non-emptiness.
   */
  tool: string;
  /** Opaque per-session id, so concurrent sessions count as separate streams. */
  session: string;
  /**
   * The agent CLI process this hook ran under, when it could be found (see
   * `findAgentPid`). The app keys the stream by `tool`/`pid` when present
   * and by `tool`/`session` when not, and checks that the process is still
   * alive.
   *
   * Present only for agents whose process hosts one conversation at a time:
   * Claude Code, Gemini CLI outside ACP mode, and Codex outside
   * `app-server`. Claude Code changes
   * `session` on `/clear`, `/compact` and resume, so without this one
   * terminal reads as several concurrent streams. Every other emitter leaves
   * it out, because their host process (an editor window, an extension host,
   * a multi-thread server) can run several conversations at once and naming
   * it would fuse them.
   *
   * Optional and additive: an app that predates it ignores the field, and an
   * app that reads it falls back to `session` when it's missing.
   */
  pid?: number;
  /**
   * How {@link pid} was found, so the app can check it the same way. Absent
   * means `executable`: the PID runs an agent CLI binary, and the app checks
   * the executable path. `path` means it runs a script runtime (`node`,
   * `bun`, `deno`) whose arguments contain {@link pidMarker}, and the app
   * checks the arguments for it too. That's the only way to tell an npm
   * install of Claude Code or Gemini CLI from any other node process.
   *
   * An app that reads `pid` but not this field would check the executable,
   * find `node` and retire the stream on every liveness pass. No released
   * app reads `pid` yet, so the two ship together.
   *
   * **Identity only.** This and {@link pidMarker} say which process
   * {@link pid} names, and nothing else. They ride with `pid` on every
   * event of a stream, `halted` included, and never vary by event. They
   * don't enter the stream key and say nothing about why a turn ended, so
   * a guard on a signal's keys sets them aside with `pid` (register
   * v1.47, P-D64.1 clause 4). The app drops `pid` when it can't check one
   * of these, and the stream falls back to its session.
   */
  pidMatch?: "path";
  /** The install-path marker a `path` match found, e.g. `@google/gemini-cli`. */
  pidMarker?: string;
  event: LiveBusEvent;
  /** Only meaningful on `prompt_submitted`. */
  sizeBucket?: PromptSizeBucket;
  /**
   * This turn came out of the user's queue rather than being typed live.
   * Only meaningful on `prompt_submitted`, and **only some tools can know
   * it** — absent means "not known", never "not queued".
   *
   * Read carefully: this is stamped when the queued message is *dequeued
   * and processed*, so it says "the turn starting now was waiting" — it is
   * not a queue *depth*, and nothing anywhere emits at the moment a message
   * is queued. It is therefore evidence that the user stacks work up, never
   * a guarantee that more is pending, and the app must not treat it as one.
   */
  queued?: boolean;
  /**
   * Background tasks still running when the turn stopped. Only meaningful on
   * `stop`, and only some tools can know it: absent means "not known", which
   * listeners read as zero. Non-zero means the session isn't finished, so a
   * listener must not treat this stop as the work being done. A count is
   * trusted for {@link LIVE_BUS_BACKGROUND_TRUST_MS} at most.
   */
  backgroundTasks?: number;
  /**
   * The hook set the registration that fired this signal names on its
   * command line (see `hookSet.ts`). Absent when the registration names
   * none: an install from before hook sets, or an adapter that has no set.
   * The app reads absence as set 1 for the tools it knows a set for, and as
   * nothing at all for the rest.
   *
   * Install provenance (P-D64.3, register v1.48): a positive integer, read
   * from the hook's own argv only. {@link emitLiveSignal} drops any other
   * value rather than send it.
   */
  hookSet?: number;
  /**
   * The hook ran from the Claude Code plugin rather than a `setup` install.
   * Claude Code exports `CLAUDE_PLUGIN_ROOT` to plugin hooks and to no
   * others. The app needs it to name the right upgrade: a plugin install
   * updates the plugin, and running `setup` beside it registers every hook
   * twice. Absent means a `setup` install, or a hook too old to say.
   *
   * Install provenance, like {@link hookSet} (P-D64.3, register v1.48):
   * `true` or absent, never `false`, and set only from the hook's own
   * environment (`readViaPlugin`). {@link emitLiveSignal} drops any other
   * value rather than send it.
   */
  viaPlugin?: true;
  /**
   * P-D64.1. Only meaningful on `halted`, and only when the host said the
   * turn ended on an API error (Claude Code's `StopFailure`). A `halted` without it
   * means the turn was interrupted or ended without a `stop`.
   */
  errorKind?: LiveBusStopFailureKind;
  /**
   * P-D64.2. When a usage limit lifts and the agent will carry on by
   * itself, in epoch seconds on the minute. Only on a `halted` whose
   * `errorKind` is `rate_limit`, only when the agent is set to continue at
   * the reset, and only for a reset within six hours. Absent means the app
   * has no reset to wait for. Display and keep-awake state only.
   */
  resumesAt?: number;
}

/** The desktop app's bundle id, for the sandbox container path below. */
const APP_BUNDLE_ID = "one.ascenda.ascendaMissionControl";

/**
 * Apple's screen saver host. Third-party screen savers run inside this
 * appex, whose sandbox redirects HOME into its container — so a listener
 * there binds inside the container rather than at the real home.
 */
export const SAVER_HOST_BUNDLE_ID = "com.apple.ScreenSaver.Engine.legacyScreenSaver";

/**
 * Every place a listener might be, in preference order.
 *
 * The wrinkle: **sandboxed listeners have their HOME redirected** into
 * `~/Library/Containers/<bundle-id>/Data/`, so "~/.ascenda/live.sock"
 * means a different directory to each of them. Hooks are ordinary
 * unsandboxed processes, so they see the true home and would never find a
 * container socket on their own. The sandbox constrains the *sandboxed*
 * process, not everyone else: a hook can happily connect into a container,
 * which is owned by the same user.
 *
 * Preference order is authority order:
 *
 *  1. The real `~/.ascenda` — the unsandboxed desktop app, the product.
 *  2. The app's own container — legacy sandboxed app builds.
 *  3. The screen-saver host's container — a listener running inside
 *     Apple's screen saver appex, for machines with the hooks but no
 *     desktop app. Such a listener binds only while the screen is
 *     actually saving and releases on stop, so this candidate is
 *     naturally absent whenever the app could claim its own.
 *     **`l.sock` at the container root, not `.ascenda/live.sock`**:
 *     `sockaddr_un` caps socket paths at ~104 bytes and the container
 *     prefix alone is ~80 plus the username — the conventional name
 *     simply does not fit down there, so the shortest workable spelling
 *     is the contract.
 *
 * The tidier long-term fix is an App Group container shared by all three,
 * but that needs the entitlement provisioned against the signing identity —
 * a deployment change, not a code one.
 */
export function liveBusSocketCandidates(): string[] {
  const override = process.env.ASCENDA_LIVE_BUS_SOCKET;
  if (override) return [override];
  const home = os.homedir();
  return [
    path.join(home, ".ascenda", "live.sock"),
    path.join(home, "Library", "Containers", APP_BUNDLE_ID, "Data", ".ascenda", "live.sock"),
    path.join(home, "Library", "Containers", SAVER_HOST_BUNDLE_ID, "Data", "l.sock")
  ];
}

/**
 * The candidates that currently exist as socket files, in authority order —
 * or, under the override, the override alone whether or not it exists.
 *
 * Existence is all this can say. A socket file outlives its listener when
 * the listener is killed, crashes or is uninstalled without unlinking, so a
 * candidate on this list may refuse every connection. {@link emitLiveSignal}
 * therefore treats the list as an order to try, never as the answer.
 */
export function existingSocketCandidates(): string[] {
  const candidates = liveBusSocketCandidates();
  if (process.env.ASCENDA_LIVE_BUS_SOCKET) return candidates;
  return candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isSocket();
    } catch {
      return false; // Not there.
    }
  });
}

/**
 * The first candidate that exists as a socket file, or the preferred one
 * when none do.
 *
 * Kept for callers that want to show where the bus probably is. It checks
 * that a file exists, not that anything is listening on it, so it can name
 * a stale socket; {@link emitLiveSignal} does not use it, and falls through
 * past a candidate that refuses the connection.
 */
export function liveBusSocketPath(): string {
  return existingSocketCandidates()[0] ?? liveBusSocketCandidates()[0];
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
 * Connection errors that mean "nobody is listening at this path", so the
 * next candidate may still be. Anything else, or any error once a
 * connection is up, ends the emit: a listener that accepted has the signal
 * or has lost it, and sending it again elsewhere would count it twice.
 */
const NOBODY_LISTENING = new Set(["ECONNREFUSED", "ENOENT"]);

/**
 * Whisper one signal to the app. Never throws, never rejects, and resolves
 * as soon as the write lands or is abandoned — callers may ignore the
 * promise entirely.
 *
 * Candidates are tried in authority order and the first one that accepts
 * the connection gets the signal; nothing fans out to the rest. A candidate
 * that refuses (a stale socket file) or has vanished since it was listed is
 * skipped. All of it shares one {@link WRITE_TIMEOUT_MS} budget: the
 * deadline is for the whole emit, not for each candidate.
 *
 * A fresh connection per signal is deliberate: hook processes are
 * short-lived (one per lifecycle event), so there is no long-lived process
 * to hold a socket open, and at these rates — a handful of signals a second
 * at worst — connection setup on a Unix socket is negligible.
 *
 * When no candidate takes it, the signal is held for the screen saver
 * ({@link holdForSaver}), which replays it when it next binds.
 */
/**
 * The signal as it may go out. P-D64.3 closes install provenance at two
 * fields with fixed types, so a `hookSet` that isn't a positive integer, or a
 * `viaPlugin` that isn't `true`, is left off rather than sent. Absent is
 * always a true reading; a wrong value never is.
 */
function onTheWire(signal: LiveBusSignal): LiveBusSignal {
  const out: Record<string, unknown> = { ...signal };
  if ("hookSet" in out && !isHookSet(out.hookSet)) delete out.hookSet;
  if ("viaPlugin" in out && out.viaPlugin !== true) delete out.viaPlugin;
  return out as unknown as LiveBusSignal;
}

export function emitLiveSignal(signal: LiveBusSignal): Promise<void> {
  const wire = onTheWire(signal);
  return deliverLine(`${JSON.stringify(wire)}\n`).then((delivered) => {
    // Nobody took it. If the screen saver has ever run on this account, it
    // is the listener most likely to want this later: the person submits,
    // walks away, and the saver starts minutes afterwards. The note lets it
    // start from the state the work is in, not from nothing.
    if (!delivered) holdForSaver(wire);
  });
}

/**
 * Sends one line to the first candidate that accepts it, and resolves with
 * that candidate's path, or undefined when nobody took it. Never rejects.
 *
 * A candidate that accepts and then fails the write still counts as
 * delivered: it has the signal or has lost it, and sending the line again
 * elsewhere would count it twice.
 */
export function deliverLine(line: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    // No socket file anywhere: the app simply isn't running. That is the
    // ordinary case for anyone who doesn't use it, and it is not an error.
    const candidates = existingSocketCandidates();
    if (candidates.length === 0) {
      resolve(undefined);
      return;
    }

    let settled = false;
    let accepted: string | undefined;
    let socket: net.Socket | undefined;
    const drop = () => {
      try {
        socket?.destroy();
      } catch {
        // Already gone. Nothing to do, and nothing worth reporting.
      }
      socket = undefined;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drop();
      resolve(accepted);
    };

    // Deliberately NOT unref'd. The socket is, so a slow listener can't
    // hold the process up, which leaves this timer as the one handle
    // keeping a hook alive until the write lands or the budget runs out.
    // Unref both and Node may exit mid-connect with nothing written and a
    // clean exit code.
    const timer = setTimeout(done, WRITE_TIMEOUT_MS);

    const tryFrom = (index: number) => {
      if (settled) return;
      if (index >= candidates.length) {
        done();
        return;
      }
      let attempt: net.Socket;
      try {
        attempt = net.createConnection(candidates[index]);
      } catch {
        // Wrong permissions, malformed path: this one can't be reached.
        tryFrom(index + 1);
        return;
      }
      socket = attempt;
      if (typeof attempt.unref === "function") attempt.unref();

      let connected = false;
      attempt.on("error", (error: NodeJS.ErrnoException) => {
        if (settled || socket !== attempt) return;
        if (!connected && error.code && NOBODY_LISTENING.has(error.code)) {
          drop();
          tryFrom(index + 1);
          return;
        }
        done();
      });
      attempt.on("connect", () => {
        if (settled || socket !== attempt) return;
        connected = true;
        accepted = candidates[index];
        try {
          attempt.write(line, done);
        } catch {
          done();
        }
      });
    };

    tryFrom(0);
  });
}
