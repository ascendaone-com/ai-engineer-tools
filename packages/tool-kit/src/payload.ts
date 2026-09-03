/**
 * Defensive extraction helpers for agent hook payloads (Claude Code, Codex).
 * Hook payload shapes drift across agent versions; these probe multiple
 * spellings and nestings so version drift degrades events gracefully.
 */
import { randomUUID } from "node:crypto";
import { CommandOutcome, IDEMPOTENCY_KEY_MAX_LENGTH } from "@ascenda-one/tool-contract";

/**
 * Mints an `idempotencyKey` for a tool-event payload: a v4 UUID, well inside
 * the {@link IDEMPOTENCY_KEY_MAX_LENGTH} the ingest doors accept.
 *
 * Call this exactly once per event, at the moment the payload object is
 * built — never inside a send or retry loop. The key only does its job if the
 * same value rides along on every attempt to deliver the same event: the
 * in-process retry in `AscendaEventSender`, the IDE's re-queued batch, and any
 * later outbox drain must all resend the payload object this was stamped on.
 * The single choke point for that stamping is the payload constructor, which
 * is why every collector that builds a payload (the Claude Code hooks, the
 * Codex hooks, the GitHub collector, the MCP server, the IDE extension) gets
 * its key from here rather than minting its own.
 */
export function mintIdempotencyKey(): string {
  const key = randomUUID();
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new Error("idempotency key exceeds the wire limit");
  return key;
}

export function getString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function getNumber(input: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function getNested(input: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function getNestedString(input: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = getNested(input, path);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function getNestedNumber(input: Record<string, unknown>, paths: string[][]): number | undefined {
  for (const path of paths) {
    const value = getNested(input, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Payload-shape outcome inference, for adapters whose runtime reports the
 * outcome *inside* the payload.
 *
 * **Not for Claude Code.** Claude Code reports outcome through the *event*,
 * not the payload — a failed call fires `PostToolUseFailure`, a successful
 * one fires `PostToolUse`, and neither payload carries an exit code or
 * status field (verified against a live session, 27 Jul 2026). Feeding a
 * Claude payload through this function returns "unknown" every time, which
 * is exactly the bug that silently disabled compile_error, every
 * `outcome: "success"` marker, and the backend's verification and commit
 * boundaries. Claude adapters must use {@link outcomeForHook}.
 *
 * The Codex adapter still routes through here; its payload shapes have not
 * been captured from a live run yet, so this stays as its best available
 * inference until they are.
 */
export function inferOutcome(input: Record<string, unknown>): CommandOutcome {
  const exitCode = getNumber(input, ["exitCode", "exit_code", "status"]) ?? getNestedNumber(input, [["tool_response", "exitCode"], ["tool_response", "exit_code"], ["result", "exitCode"], ["result", "exit_code"]]);
  if (typeof exitCode === "number") return exitCode === 0 ? "success" : "failure";

  const error = getString(input, ["error", "errorMessage"]) ?? getNestedString(input, [["tool_response", "error"], ["result", "error"]]);
  if (error) return "failure";
  return "unknown";
}

/**
 * Outcome for runtimes that split success and failure into separate hook
 * events — Claude Code's model, verified empirically (27 Jul 2026):
 *
 *  - **success** fires `PostToolUse`: `tool_response`
 *    (`stdout`/`stderr`/`interrupted`/`isImage`/`noOutputExpected`) plus a
 *    top-level `duration_ms`, and no exit code of any kind. Its arrival *is*
 *    the success signal, because a failed call never reaches it.
 *  - **failure** fires `PostToolUseFailure`: `error` (a string beginning
 *    `"Exit code N\n…"`) and `is_interrupt`, with no `tool_response` at all.
 *
 * Two deliberate judgements: `stderr` is not failure (successful calls
 * routinely carry it — shell notices, tool progress), and an interrupt is
 * `cancelled`, not `failure` — stopped work is not wrong work.
 */
export function outcomeForHook(hookName: string, input: Record<string, unknown>): CommandOutcome {
  if (hookName === "PostToolUseFailure") {
    const interrupted = input["is_interrupt"] === true ||
      getNested(input, ["tool_response", "interrupted"]) === true;
    return interrupted ? "cancelled" : "failure";
  }

  if (hookName === "PostToolUse") {
    if (getNested(input, ["tool_response", "interrupted"]) === true) return "cancelled";
    return "success";
  }

  return "unknown";
}

/** Local-only heuristic; callers must transmit the classification, never the text. */
export function looksLikeCorrection(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(wrong|incorrect|try again|fix|not what i asked|that's not|that is not|redo|regenerate|you missed|doesn't work|does not work)\b/i.test(text);
}
