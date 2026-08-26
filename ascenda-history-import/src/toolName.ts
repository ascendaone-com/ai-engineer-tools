/**
 * The one place a tool name is cleaned before it goes on the wire.
 *
 * All three extractors emit `ai_tool_call_started` carrying a `toolName`, and
 * so does the live Claude Code hook (`sanitiseToolName` in
 * `ascenda-claude-code-hooks/src/mapClaudeEvent.ts`). The filter has to be
 * character-for-character the same in every one of them, or a historical
 * `Bash` and a live `Bash` group as two different tools the first time a name
 * contains something one copy strips and another does not.
 *
 * Deliberately NOT imported from the hooks package: that is a separately
 * released sibling CLI, not a dependency of this one. It is also not in
 * `@ascenda-one/tool-kit`, which both could depend on — moving it there is
 * the right end state and is a change to a shared published package, so it
 * belongs in its own commit rather than riding in on this one. What this file
 * fixes is the smaller problem it was actually creating: three copies inside
 * this package.
 */

/**
 * A tool name reduced to `[A-Za-z0-9_-]`, capped at 40 characters, or
 * `"unknown"` when the store recorded no name (or one that survives the
 * filter as an empty string).
 *
 * MCP tool names keep their `mcp__server__tool` shape, which is intentional:
 * the live hook already ships them that way, and a historical import that
 * stripped them would be the one leg of the rail whose tool names disagreed.
 */
export function sanitizeToolName(toolName: string | null | undefined): string {
  if (!toolName) return "unknown";
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}
