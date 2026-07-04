import { CommandOutcome, DurationBucket } from "./types.js";

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

export function inferOutcome(input: Record<string, unknown>): CommandOutcome {
  const exitCode = getNumber(input, ["exitCode", "exit_code", "status"]) ?? getNestedNumber(input, [["tool_response", "exitCode"], ["tool_response", "exit_code"], ["result", "exitCode"], ["result", "exit_code"]]);
  if (typeof exitCode === "number") return exitCode === 0 ? "success" : "failure";

  const error = getString(input, ["error", "errorMessage"]) ?? getNestedString(input, [["tool_response", "error"], ["result", "error"]]);
  if (error) return "failure";
  return "unknown";
}

export function bucketDurationMs(durationMs: number | undefined): DurationBucket | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const minutes = durationMs / 60000;
  if (minutes <= 1) return "0-1m";
  if (minutes <= 5) return "1-5m";
  if (minutes <= 10) return "5-10m";
  if (minutes <= 30) return "10-30m";
  if (minutes <= 60) return "30-60m";
  return "60m+";
}

export function looksLikeCorrection(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(wrong|incorrect|try again|fix|not what i asked|that's not|that is not|redo|regenerate|you missed|doesn't work|does not work)\b/i.test(text);
}
