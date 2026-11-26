import { captureReport, captureStatus, runCallCapture, setCaptureEnabled, tidyHomePath, captureDir } from "@ascenda-one/tool-kit";
import type { CaptureOutcome } from "@ascenda-one/tool-kit";
import type { ClaudeHookEventName, ClaudeHookInput } from "./types.js";

/**
 * Claude Code's side of per-call file capture (tool-kit `callCapture.ts`).
 *
 * The hook payload names everything the capture needs: `cwd`, `tool_name`,
 * `tool_use_id`, `session_id`, and for the edit-shaped tools the file in
 * `tool_input.file_path` (`notebook_path` for NotebookEdit), which may sit in
 * a different repository from `cwd`.
 *
 * Local only and off by default. Nothing it computes is put on any event.
 */
export function captureForHook(hookName: ClaudeHookEventName, input: ClaudeHookInput): Promise<CaptureOutcome> {
  const record = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const toolInput = (record.tool_input && typeof record.tool_input === "object" ? record.tool_input : {}) as Record<string, unknown>;
  return runCallCapture({
    hook: hookName,
    agent: "claude_code",
    cwd: str(record.cwd),
    toolName: str(record.tool_name),
    filePath: str(toolInput.file_path) ?? str(toolInput.notebook_path),
    session: str(record.session_id),
    callId: str(record.tool_use_id)
  });
}

const USAGE = `Usage: ascenda-claude-hook capture <on|off|status|report>

  on       Start recording, around each tool call, which lines of which files
           changed in the working tree. Kept on this machine only, as keyed
           hashes: no file contents, no paths in clear. Nothing is sent.
  off      Stop, and delete every capture record and the capture salt.
  status   Say whether capture is on and how much it holds.
  report   --repo <dir> [--repo <dir> ...] --since <date> [--until <date>]
           [--author <email> ...] [--hunks <file>]
           Count, for commits on each repository's default branch, how many
           hunks an agent's call wrote, how many were written outside the
           captured calls, and how many cannot be told. Prints counts only.`;

function takeAll(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) out.push(argv[++i]);
  return out;
}

export async function runCaptureCommand(argv: string[], write: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  const sub = argv[0];
  if (sub === "on") {
    setCaptureEnabled(true);
    write(`Capture is on. Records stay in ${tidyHomePath(captureDir())} and are never sent.\n`);
    return 0;
  }
  if (sub === "off") {
    setCaptureEnabled(false);
    write("Capture is off. Every capture record and the capture salt were deleted.\n");
    return 0;
  }
  if (sub === "status") {
    const s = captureStatus();
    const lines = [
      `capture: ${s.enabled ? "on" : "off"}${s.forcedBy ? " (set by ASCENDA_CALL_CAPTURE)" : ""}`,
      ...(s.enabledSince ? [`on since: ${s.enabledSince}`] : []),
      `records: ${s.records} in ${s.dayFiles} day file(s), ${Math.round(s.bytes / 1024)} KB`,
      ...(s.firstDay ? [`days: ${s.firstDay} to ${s.lastDay}`] : []),
      `pruned day files: ${s.pruned}`
    ];
    write(`${lines.join("\n")}\n`);
    return 0;
  }
  if (sub === "report") {
    const repos = takeAll(argv, "--repo");
    const since = takeAll(argv, "--since")[0];
    if (!repos.length || !since) {
      write(`${USAGE}\n`);
      return 2;
    }
    const report = await captureReport({
      repos,
      since,
      until: takeAll(argv, "--until")[0],
      authors: takeAll(argv, "--author"),
      hunksFile: takeAll(argv, "--hunks")[0]
    });
    write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  write(`${USAGE}\n`);
  return sub === "-h" || sub === "--help" ? 0 : 2;
}
