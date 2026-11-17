import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ascendaHome } from "@ascenda-one/tool-kit";
import { quotaFromStatusline, recordQuota } from "./quotaSnapshot.js";

/**
 * `ascenda-claude-hook statusline`: the opt-in status line wrapper.
 *
 * Claude Code runs the configured status line command with a JSON document
 * on stdin and shows what it prints. This wrapper reads that document, keeps
 * the quota numbers (quotaSnapshot.ts), then runs whatever status line the
 * person had before setup with the same input and passes its output
 * through, so the bar looks exactly as it did. With no previous status line
 * it prints nothing.
 *
 * Recording comes first and never throws: a failure in the wrapper must not
 * cost someone their status line.
 */

/** A status line setting as Claude Code stores it. Unknown keys ride along. */
export type StatusLineSetting = { type?: string; command?: string } & Record<string, unknown>;

/** Where setup keeps the status line it replaced. */
export function statuslineChainPath(): string {
  return path.join(ascendaHome(), "claude-statusline-chain.json");
}

export function readChain(file: string = statuslineChainPath()): StatusLineSetting | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as StatusLineSetting).command === "string") {
      return parsed as StatusLineSetting;
    }
  } catch {
    // No chain: there was no status line before.
  }
  return undefined;
}

export async function runStatusline(): Promise<number> {
  const raw = await readStdin();
  try {
    const quota = quotaFromStatusline(JSON.parse(raw));
    if (quota) recordQuota(quota);
  } catch {
    // Not JSON, or nothing to keep.
  }
  const chain = readChain();
  if (!chain?.command) return 0;
  return await new Promise<number>((resolve) => {
    const child = spawn(chain.command as string, { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(0));
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.on("error", () => undefined);
    child.stdin.end(raw);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
