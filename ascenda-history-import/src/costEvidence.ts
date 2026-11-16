/**
 * The evidence a cost finding rests on, folded per Claude Code session: which
 * skills and MCP servers were loaded into context and which were used, how
 * many API messages ran in fast mode, and how many ran with a deep context.
 *
 * **Counts leave, names don't.** A skill or MCP server name can carry a
 * project's or a client's vocabulary, so the sets below exist only while a
 * session is folded and only their sizes reach `metrics`. The same rule
 * `subagentReceipts.ts` follows for agent names.
 *
 * **Absent is not zero.** A session whose transcript never listed its skills
 * ships no skill keys at all, so nobody can read "none used" off a session
 * that was never measured. The MCP and speed keys follow the same rule, each
 * with its own `…Seen` flag.
 *
 * Who calls what is decided in `claudeCode.ts`, which owns the line ownership
 * rules: a listing is context, so it is read from every main-thread line that
 * isn't a repeat, copied history included; a use, a fast message or a deep
 * message is something this session did, so only owned lines count.
 */
import type { MetricKey } from "@ascenda-one/tool-contract";

/** Context size past which a main-thread message counts as deep. Fixed cut
 * points, so sessions compare without shipping the raw series. */
export const DEEP_TURN_THRESHOLDS = { deepTurns200k: 200_000, deepTurns400k: 400_000 } as const;

export interface CostEvidence {
  /** Skill names in context, from `skill_listing`. An initial listing
   * replaces the set; a later one adds to it. */
  listedSkills: Set<string>;
  skillListingSeen: boolean;
  /** Skill names used: `invoked_skills` attachments and `Skill` calls. */
  invokedSkills: Set<string>;
  /** Servers whose instructions are in context (`mcp_instructions_delta`). */
  mcpInstructionServers: Set<string>;
  /** Deferred `mcp__<server>__<tool>` names in context, by server
   * (`deferred_tools_delta`). A server is loaded while it has one. */
  mcpDeferredTools: Map<string, Set<string>>;
  mcpFailedServers: Set<string>;
  mcpListingSeen: boolean;
  /** Servers whose tools were called. */
  mcpUsedServers: Set<string>;
  speedSeen: boolean;
  /** Fast API messages already counted, by message key. */
  fastMessages: Set<string>;
  fastTurns: number;
  subagentFastTurns: number;
  deepTurns200k: number;
  deepTurns400k: number;
}

export function newCostEvidence(): CostEvidence {
  return {
    listedSkills: new Set(),
    skillListingSeen: false,
    invokedSkills: new Set(),
    mcpInstructionServers: new Set(),
    mcpDeferredTools: new Map(),
    mcpFailedServers: new Set(),
    mcpListingSeen: false,
    mcpUsedServers: new Set(),
    speedSeen: false,
    fastMessages: new Set(),
    fastTurns: 0,
    subagentFastTurns: 0,
    deepTurns200k: 0,
    deepTurns400k: 0
  };
}

/** Attachment types read here. `claudeCode.ts` checks a line for one of these
 * before parsing it, so the store's other attachments cost nothing. */
export const LISTING_ATTACHMENT_TYPES = ["skill_listing", "mcp_instructions_delta", "deferred_tools_delta"] as const;
export const USE_ATTACHMENT_TYPES = ["invoked_skills"] as const;

/**
 * A server name as it appears inside a tool name. The runtime writes a
 * plugin's server as `plugin:<plugin>:<server>` in its listings and as
 * `plugin_<plugin>_<server>` inside `mcp__…__` tool names, so both sides are
 * put in the second form before they're compared.
 */
export function normalizeMcpServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The server part of a raw `mcp__<server>__<tool>` name, or null. Read from
 * the raw name: `sanitizeToolName` cuts names at 40 characters, which can cut
 * into the server. */
export function mcpServerOfToolName(raw: string): string | null {
  const match = /^mcp__(.+?)__./.exec(raw);
  return match ? match[1] : null;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

/** Fold a listing attachment: context the session carried. */
export function foldListingAttachment(ev: CostEvidence, attachment: Record<string, unknown>): void {
  switch (attachment.type) {
    case "skill_listing": {
      ev.skillListingSeen = true;
      if (attachment.isInitial === true) ev.listedSkills.clear();
      for (const name of stringsOf(attachment.names)) ev.listedSkills.add(name);
      break;
    }
    case "mcp_instructions_delta": {
      ev.mcpListingSeen = true;
      for (const name of stringsOf(attachment.addedNames)) ev.mcpInstructionServers.add(normalizeMcpServerName(name));
      for (const name of stringsOf(attachment.removedNames)) ev.mcpInstructionServers.delete(normalizeMcpServerName(name));
      break;
    }
    case "deferred_tools_delta": {
      ev.mcpListingSeen = true;
      for (const tool of stringsOf(attachment.addedNames)) {
        const server = mcpServerOfToolName(tool);
        if (!server) continue;
        let tools = ev.mcpDeferredTools.get(server);
        if (!tools) ev.mcpDeferredTools.set(server, (tools = new Set()));
        tools.add(tool);
      }
      for (const tool of stringsOf(attachment.removedNames)) {
        const server = mcpServerOfToolName(tool);
        const tools = server ? ev.mcpDeferredTools.get(server) : undefined;
        if (!tools) continue;
        tools.delete(tool);
        if (tools.size === 0) ev.mcpDeferredTools.delete(server!);
      }
      if (Array.isArray(attachment.failedMcpServers)) {
        for (const item of attachment.failedMcpServers) {
          const name =
            typeof item === "string"
              ? item
              : typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).name === "string"
                ? ((item as Record<string, unknown>).name as string)
                : null;
          if (name) ev.mcpFailedServers.add(normalizeMcpServerName(name));
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Fold an `invoked_skills` attachment: skills this session loaded. */
export function foldUseAttachment(ev: CostEvidence, attachment: Record<string, unknown>): void {
  if (attachment.type !== "invoked_skills" || !Array.isArray(attachment.skills)) return;
  for (const item of attachment.skills) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === "string" && name !== "") ev.invokedSkills.add(name);
  }
}

/** Fold one owned assistant line's `tool_use` items: MCP servers called and
 * skills loaded through the `Skill` tool. Reads `input.skill` and nothing
 * else of the input. */
export function foldToolUses(ev: CostEvidence, record: Record<string, unknown>): void {
  const content = (record.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_use" || typeof entry.name !== "string") continue;
    const server = mcpServerOfToolName(entry.name);
    if (server) ev.mcpUsedServers.add(server);
    if (entry.name === "Skill") {
      const input = entry.input as Record<string, unknown> | undefined;
      if (input && typeof input.skill === "string" && input.skill !== "") ev.invokedSkills.add(input.skill);
    }
  }
}

/**
 * Fold one owned assistant line's `usage.speed`. A message is written over
 * several lines that repeat its usage, so a fast message counts once by its
 * key; a line with no key is a message of its own.
 */
export function foldSpeed(ev: CostEvidence, messageKey: string | null, speed: unknown, isSidechain: boolean): void {
  if (typeof speed !== "string") return;
  ev.speedSeen = true;
  if (speed !== "fast") return;
  if (messageKey !== null) {
    if (ev.fastMessages.has(messageKey)) return;
    ev.fastMessages.add(messageKey);
  }
  if (isSidechain) ev.subagentFastTurns += 1;
  else ev.fastTurns += 1;
}

/** Fold one main-thread API message's context size, once per message. */
export function foldDepth(ev: CostEvidence, contextTokens: number): void {
  if (contextTokens > DEEP_TURN_THRESHOLDS.deepTurns200k) ev.deepTurns200k += 1;
  if (contextTokens > DEEP_TURN_THRESHOLDS.deepTurns400k) ev.deepTurns400k += 1;
}

/** The counts that ship. Names never do. */
export function costEvidenceMetrics(ev: CostEvidence): Partial<Record<MetricKey, number | boolean>> {
  const out: Partial<Record<MetricKey, number | boolean>> = {
    deepTurns200k: ev.deepTurns200k,
    deepTurns400k: ev.deepTurns400k
  };
  if (ev.skillListingSeen) {
    out.skillListingSeen = true;
    out.skillsListed = ev.listedSkills.size;
    let invoked = 0;
    for (const name of ev.invokedSkills) if (ev.listedSkills.has(name)) invoked += 1;
    out.skillsInvoked = invoked;
  }
  if (ev.mcpListingSeen) {
    // A server whose tool was called was loaded, whether or not a listing
    // said so: tools that aren't deferred never appear in one.
    const loaded = new Set<string>([...ev.mcpInstructionServers, ...ev.mcpDeferredTools.keys(), ...ev.mcpUsedServers]);
    let failed = 0;
    for (const name of ev.mcpFailedServers) if (!loaded.has(name)) failed += 1;
    out.mcpListingSeen = true;
    out.mcpServersLoaded = loaded.size;
    out.mcpServersUsed = ev.mcpUsedServers.size;
    out.mcpServersFailed = failed;
  }
  if (ev.speedSeen) {
    out.speedSeen = true;
    out.fastTurns = ev.fastTurns;
    out.subagentFastTurns = ev.subagentFastTurns;
  }
  return out;
}
