// The whole extension is `@ascenda-one/ide-extension-core`: one implementation
// shared by the VS Code, Cursor and Antigravity installs, with the host
// detected at runtime (packages/ide-extension-core/src/host.ts).
//
// If you came here looking for `autonomyMode` — the permission posture the
// Claude Code and Codex hook adapters attach to their events — it is not here,
// and its absence is deliberate rather than a gap. This extension observes file
// saves, editor switches and terminal executions: things a person did, or
// things a terminal reported with no record of who started them. None is an
// agent action taken under an approval posture, no API on the VS Code baseline
// this targets reports one, and borrowing a host's chat auto-approve setting
// would describe a different agent's configuration than the events on this
// wire. See README.md, "No permission posture (`autonomyMode`) — on purpose".
export { activate, deactivate } from "@ascenda-one/ide-extension-core";
