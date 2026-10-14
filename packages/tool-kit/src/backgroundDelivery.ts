import * as fs from "fs";
import { spawn } from "child_process";
import type { AscendaEventSender, OutboxDrainReport } from "./eventSender";
import { outboxDrainEnabled } from "./outbox";
import { refreshReleaseCheck } from "./releaseCheck";

/**
 * Hook delivery off the agent's critical path.
 *
 * Every agent we collect from waits for a command hook to exit before it goes
 * on. A hook that sends its event over HTTPS holds the agent for a full round
 * trip on every event: about 200 ms on a good connection, two of them per tool
 * call, and up to the hook's whole timeout on a network that hangs (a captive
 * portal, a stalled DNS lookup). On that last one the agent kills the hook
 * before the event reaches the outbox, so the user waits and the event is lost
 * anyway.
 *
 * So a hook writes its events to the outbox, which takes a few milliseconds and
 * survives the hook's exit, starts a detached flusher, and returns. The flusher
 * is this same binary run with {@link OUTBOX_FLUSH_COMMAND}: it loads the same
 * pairing, drains the outbox through the batch door, and exits. Nothing about
 * an event changes on the way. `occurredAt` and the `idempotencyKey` are set
 * when the hook builds the payload, so an event delivered a second later keeps
 * its time, and one delivered twice comes back `duplicate`.
 *
 * Only Claude Code has a native `async` hook flag. This works for every agent,
 * and it keeps one delivery path for all of them.
 *
 * `ASCENDA_HOOK_DELIVERY=inline` sends from the hook itself, as before. It's an
 * escape hatch, and what tests that read the single door use. So does
 * `ASCENDA_OUTBOX_DRAIN=0`; see {@link hookDeliveryInline}.
 */
export const HOOK_DELIVERY_ENV_VAR = "ASCENDA_HOOK_DELIVERY";

/** The hidden argument a hook binary answers by flushing its outbox. Lowercase and prefixed, so no agent's hook name can collide with it. */
export const OUTBOX_FLUSH_COMMAND = "__flush-outbox";

/**
 * How long a flusher's lock counts as live. A flusher touches it before every
 * batch, and a batch is bounded by the HTTP timeout, so a lock older than this
 * belongs to a flusher that died.
 */
export const FLUSH_LOCK_FRESH_MS = 20_000;

/** Upper bounds on one flusher's run. It is off the critical path, but it shouldn't linger. */
const FLUSH_MAX_PASSES = 20;
const FLUSH_MAX_RUN_MS = 60_000;

/**
 * Whether a hook should send its events itself. Yes when asked to, and yes
 * when `ASCENDA_OUTBOX_DRAIN` is off: that switch holds the outbox without
 * sending it, so an event queued for a flusher would never leave.
 */
export function hookDeliveryInline(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOOK_DELIVERY_ENV_VAR]?.trim().toLowerCase() === "inline" || !outboxDrainEnabled(env);
}

export function flushLockPath(outboxFilePath: string): string {
  return `${outboxFilePath}.flushing`;
}

function lockIsFresh(lockPath: string, now: number): boolean {
  try {
    return now - fs.statSync(lockPath).mtimeMs < FLUSH_LOCK_FRESH_MS;
  } catch {
    return false;
  }
}

function touchLock(lockPath: string): void {
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A flusher without a lock is still a flusher. The worst case is a second
    // one, and claim-by-rename keeps two from sending the same entry.
  }
}

function removeLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

function outboxHasEntries(outboxFilePath: string): boolean {
  try {
    return fs.statSync(outboxFilePath).size > 0;
  } catch {
    return false;
  }
}

export type BackgroundFlushOptions = {
  outboxFilePath: string;
  /** The hook binary to run. Defaults to this process's own script. */
  script?: string;
  now?: number;
};

/**
 * Starts a detached flusher unless a live one already holds the lock. Call it
 * after the events are in the outbox: the flusher clears the lock and then
 * looks at the outbox once more, so between that look and this check, one of
 * the two always sees a new event.
 *
 * Returns whether a flusher was started. Never throws: a failed spawn leaves
 * the events in the outbox for the next hook.
 */
export function startBackgroundFlush(options: BackgroundFlushOptions): boolean {
  const lockPath = flushLockPath(options.outboxFilePath);
  const now = options.now ?? Date.now();
  if (lockIsFresh(lockPath, now)) return false;
  const script = options.script ?? process.argv[1];
  if (!script) return false;
  try {
    touchLock(lockPath);
    const child = spawn(process.execPath, [script, OUTBOX_FLUSH_COMMAND], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env
    });
    child.on("error", () => removeLock(lockPath));
    child.unref();
    return true;
  } catch {
    removeLock(lockPath);
    return false;
  }
}

/**
 * The flusher's whole job: drain until the outbox is empty, the door refuses,
 * or a bound is reached. Then release the lock and look once more, so an event
 * queued by a hook that saw the lock still held isn't left waiting for the
 * next hook.
 */
export async function runOutboxFlush(sender: AscendaEventSender, now: () => number = Date.now): Promise<OutboxDrainReport | undefined> {
  const outboxFilePath = sender.outboxFilePath();
  const lockPath = flushLockPath(outboxFilePath);
  const started = now();
  let last: OutboxDrainReport | undefined;
  let passes = 0;

  // One pass per iteration, until there's nothing left to claim, the door
  // refuses, sending is off, or a pass makes no progress.
  const drain = async (): Promise<void> => {
    while (passes < FLUSH_MAX_PASSES && now() - started < FLUSH_MAX_RUN_MS) {
      passes += 1;
      touchLock(lockPath);
      last = await sender.flushOutbox();
      if (!last || last.found === 0 || last.halted || !last.sendEnabled) return;
      if (last.delivered === 0 && last.discarded === 0) return;
    }
  };

  try {
    await drain();
    removeLock(lockPath);
    if (!last?.halted && last?.sendEnabled !== false && outboxHasEntries(outboxFilePath)) {
      touchLock(lockPath);
      await drain();
      removeLock(lockPath);
    }
  } catch {
    removeLock(lockPath);
  }
  // After the events, never before them, and only from a flusher, which only
  // a paired install starts. Once a day at most; see releaseCheck.ts.
  await refreshReleaseCheck();
  return last;
}
