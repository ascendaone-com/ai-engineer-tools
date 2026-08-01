import { CommandOutcome } from "./types.js";

export { bucketDurationMs } from "@ascenda-one/tool-kit";

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

export function looksLikeCorrection(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(wrong|incorrect|try again|fix|not what i asked|that's not|that is not|redo|regenerate|you missed|doesn't work|does not work)\b/i.test(text);
}
