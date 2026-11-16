import * as fs from "fs";

/**
 * The provider's usage-limit reading at the end of a turn.
 *
 * No hook payload carries `rate_limits`, but every one carries
 * `transcript_path`, which is the session's rollout. By `Stop` the rollout's
 * last line is the turn's closing `token_count`, and on current builds that
 * line has a `rate_limits` object. So `Stop` reads the file's tail, takes the
 * last line that has one, and keeps two numbers: `used_percent` of the short
 * (primary) and long (secondary) windows, rounded.
 *
 * Nothing else on that object is read. It names the account's limit and plan
 * and carries a credit balance, and none of that leaves the machine.
 *
 * Every failure is `undefined`: no path, not a rollout, unreadable, no
 * reading in the tail. A hook never waits on this beyond one bounded read.
 */

export interface UsageLimitReading {
  shortPct?: number;
  longPct?: number;
}

/** How much of the rollout's end is read. The closing `token_count` is a few
 * hundred bytes and comes last; a long tool output ahead of it is why this
 * isn't smaller. */
const TAIL_BYTES = 64 * 1024;

const ROLLOUT_FILE = /(^|[\\/])rollout-[^\\/]+\.jsonl$/;

function percentOf(window: unknown): number | undefined {
  if (!window || typeof window !== "object") return undefined;
  const raw = (window as Record<string, unknown>).used_percent;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

/** The reading on one rollout line, or `undefined` if it has none. */
export function usageLimitReadingOfLine(line: string): UsageLimitReading | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = (parsed as { payload?: unknown } | null)?.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== "token_count") return undefined;
  const limits = payload.rate_limits as Record<string, unknown> | null | undefined;
  if (!limits || typeof limits !== "object") return undefined;
  const shortPct = percentOf(limits.primary);
  const longPct = percentOf(limits.secondary);
  if (shortPct === undefined && longPct === undefined) return undefined;
  return { ...(shortPct !== undefined ? { shortPct } : {}), ...(longPct !== undefined ? { longPct } : {}) };
}

/** The last reading in the rollout's tail, or `undefined`. */
export function readLastUsageLimitReading(transcriptPath: unknown): UsageLimitReading | undefined {
  if (typeof transcriptPath !== "string" || !ROLLOUT_FILE.test(transcriptPath)) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    // The first line may be cut in half by the window; it fails to parse.
    for (let i = lines.length - 1; i >= 0; i--) {
      const reading = usageLimitReadingOfLine(lines[i]);
      if (reading) return reading;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to do.
      }
    }
  }
}

/** The metadata fragment for `ai_turn_completed`, ready to spread. */
export function usageLimitMetadata(reading: UsageLimitReading | undefined): Record<string, number> {
  if (!reading) return {};
  return {
    ...(reading.shortPct !== undefined ? { usageLimitShortPeakPct: reading.shortPct } : {}),
    ...(reading.longPct !== undefined ? { usageLimitLongPeakPct: reading.longPct } : {})
  };
}
