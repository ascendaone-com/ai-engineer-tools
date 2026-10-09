import * as os from "os";
import { liveSignalDoctorLines } from "@ascenda-one/tool-kit";
import { hookBinPath, selfCommand } from "./paths.js";

export { doctorRow } from "@ascenda-one/tool-kit";

/**
 * `doctor`'s first section for Claude Code: the local half, which needs no
 * pairing. The checks are shared with every adapter (`liveSignalDoctor.ts`
 * in tool-kit); what is Claude Code's own is where its hooks are registered.
 */
export async function localSignalLines(projectDir = process.cwd()): Promise<string[]> {
  const { registrationSummary, REGISTERED_EVENT_COUNT } = await import("./setup.js");
  return liveSignalDoctorLines({
    displayName: "Claude Code",
    tool: "claude_code",
    launcher: process.platform === "win32" ? undefined : hookBinPath(),
    registrations: registrationSummary(projectDir).map((entry) => ({ ...entry, file: tidy(entry.file) })),
    eventCount: REGISTERED_EVENT_COUNT,
    selfCommand: selfCommand(),
    setupCommand: "npx @ascenda-one/claude-code-hooks setup",
    lookHint: "type /hooks"
  });
}

function tidy(file: string): string {
  const home = os.homedir();
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}
