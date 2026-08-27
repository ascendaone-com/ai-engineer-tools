import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAutonomyMode, mapCodexEvent } from "../dist/mapCodexEvent.js";

test("SessionStart: startup/resume open a focus session, clear/compact do not", () => {
  assert.equal(mapCodexEvent("SessionStart", { source: "startup" })[0].eventType, "create_focus_session");
  assert.equal(mapCodexEvent("SessionStart", { source: "resume" })[0].eventType, "create_focus_session");
  assert.deepEqual(mapCodexEvent("SessionStart", { source: "compact" }), []);
  assert.deepEqual(mapCodexEvent("SessionStart", { source: "clear" }), []);
});

test("UserPromptSubmit: prompt and correction inference, no raw text leaves", () => {
  const plain = mapCodexEvent("UserPromptSubmit", { prompt: "add pagination" });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].eventType, "ai_prompt_submitted");
  const corr = mapCodexEvent("UserPromptSubmit", { prompt: "that is not what I asked, redo it" });
  assert.equal(corr.length, 2);
  assert.equal(corr[1].eventType, "ai_correction_prompt");
  assert.ok(!JSON.stringify(corr).includes("redo it"), "prompt text must never leave the mapper");
});

test("every mapped event carries host=codex metadata", () => {
  const events = mapCodexEvent("PreToolUse", { tool_name: "Bash" });
  assert.equal(events[0].metadata.host, "codex");
});

test("PostToolUse: apply_patch is a file edit", () => {
  const events = mapCodexEvent("PostToolUse", { tool_name: "apply_patch", tool_response: {} });
  assert.equal(events[0].eventType, "ai_file_edit");
});

test("PostToolUse: shell verification success and failure", () => {
  const ok = mapCodexEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } });
  assert.equal(ok[0].eventType, "editor_verification_activity");
  const fail = mapCodexEvent("PostToolUse", { tool_name: "shell", tool_input: { command: "cargo test" }, tool_response: { exit_code: 101 } });
  assert.equal(fail[0].eventType, "compile_error");
});

test("PostToolUse: non-verification failure and generic completion", () => {
  const fail = mapCodexEvent("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { exitCode: 1 } });
  assert.equal(fail[0].eventType, "ai_tool_call_failed");
  const done = mapCodexEvent("PostToolUse", { tool_name: "some_mcp_tool", tool_response: {} });
  assert.equal(done[0].eventType, "ai_tool_call_completed");
});

test("compaction: manual vs auto, and post-compact pressure", () => {
  assert.equal(mapCodexEvent("PreCompact", { trigger: "manual" })[0].eventType, "context_compression_manual");
  const auto = mapCodexEvent("PreCompact", { trigger: "auto" });
  assert.equal(auto[0].eventType, "context_compression_auto");
  assert.equal(auto[0].severity, "high");
  assert.equal(mapCodexEvent("PostCompact", {})[0].eventType, "context_pressure_high");
});

test("Stop: agent_loop_long only for long turns", () => {
  assert.deepEqual(mapCodexEvent("Stop", {}, 5 * 60000), []);
  assert.deepEqual(mapCodexEvent("Stop", {}, undefined), []);
  assert.equal(mapCodexEvent("Stop", {}, 45 * 60000)[0].severity, "medium");
  assert.equal(mapCodexEvent("Stop", {}, 90 * 60000)[0].severity, "high");
});

test("hooks without catalog counterparts map to nothing", () => {
  assert.deepEqual(mapCodexEvent("PermissionRequest", { tool_name: "Bash" }), []);
  assert.deepEqual(mapCodexEvent("SubagentStart", { agent_id: "a" }), []);
  assert.deepEqual(mapCodexEvent("SubagentStop", { agent_id: "a" }), []);
});

// ---------------------------------------------------------------------------
// autonomyMode — the permission posture, from Codex's own `permission_mode`,
// mirrored onto the wire rather than coarsened onto a ladder.
//
// Codex's generated wire schemas (codex-rs/hooks/schema/generated/, read
// 28 Aug 2026) pin the enum to exactly five values and put the field on
// SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop — and
// leave it off PreCompact/PostCompact. `CodexHookInput` is a loose Record, so
// until now it arrived and was discarded with nothing raising anywhere.
//
// Every coarsening happens in a reader (`autonomyBand` in tool-kit), never
// here. The corpus is append-only, so a collapse at capture can never be
// undone, while a collapse at read is a query away from being reconsidered.
//
// The values are spelled out literally rather than imported: the consumer of
// this vocabulary lives in another repository and cannot be typechecked
// against, so a rename has to break a test here to be noticed at all.
// ---------------------------------------------------------------------------

test("autonomyMode: every documented permission_mode mirrors upstream, snake-cased", () => {
  // Claude Code's table minus `auto`, spelled identically — so mirroring
  // lands both collectors on the same tokens with neither translated into the
  // other. Where the runtimes agree the wire shows agreement; where they
  // diverge it shows that too, instead of hiding it inside a shared rung.
  const expected = {
    plan: "plan",
    default: "default",
    acceptEdits: "accept_edits",
    dontAsk: "dont_ask",
    bypassPermissions: "bypass_permissions"
  };

  for (const [permissionMode, autonomyMode] of Object.entries(expected)) {
    const events = mapCodexEvent("PostToolUse", {
      tool_name: "some_mcp_tool",
      permission_mode: permissionMode,
      tool_response: {}
    });
    assert.equal(events[0].metadata.autonomyMode, autonomyMode, `permission_mode "${permissionMode}"`);
  }
});

test("autonomyMode: matching survives case and whitespace drift", () => {
  const events = mapCodexEvent("PostToolUse", { tool_name: "t", permission_mode: "  ACCEPTEDITS  ", tool_response: {} });
  assert.equal(events[0].metadata.autonomyMode, "accept_edits");
});

test("autonomyMode: a mode OpenAI has not shipped yet becomes unknown and is still sent", () => {
  // Including `auto`, which Claude Code has and Codex does not. A shared
  // spelling is not evidence of a shared meaning — Codex's own "Auto" preset
  // still escalates commands — so it lands on `unknown` on purpose, where a
  // rising count makes it visible rather than quietly mismapped. Note this is
  // the one place the two adapters' tables differ, and it differs because the
  // payloads do.
  for (const raw of ["someFutureMode", "auto", "read-only", "danger-full-access", "never"]) {
    const events = mapCodexEvent("PostToolUse", { tool_name: "t", permission_mode: raw, tool_response: {} });
    assert.equal(events[0].metadata.autonomyMode, "unknown", `permission_mode "${raw}"`);
  }
});

test("autonomyMode: the classifier is total — non-strings do not crash and do not vanish", () => {
  for (const raw of [7, true, {}, [], "", "   ", () => {}]) {
    assert.equal(classifyAutonomyMode(raw), "unknown", `raw ${typeof raw}`);
  }
});

test("autonomyMode: a non-string on the wire still produces a sent key, not an absent one", () => {
  // The pair this whole design exists to keep apart: `{ permission_mode: 7 }`
  // is a runtime that HAS the concept and sent something we cannot read, so
  // the key must be present and `unknown` — never dropped back into absence.
  const events = mapCodexEvent("PostToolUse", { tool_name: "t", permission_mode: 7, tool_response: {} });
  assert.equal(events[0].metadata.autonomyMode, "unknown");
});

test("autonomyMode: absent is not unknown — the key is omitted entirely", () => {
  const events = mapCodexEvent("PostToolUse", { tool_name: "t", tool_response: {} });
  assert.ok(!("autonomyMode" in events[0].metadata));
  // `null` is absence too: a payload that says "no mode" is not a payload that
  // said a mode we failed to read.
  const nulled = mapCodexEvent("PostToolUse", { tool_name: "t", permission_mode: null, tool_response: {} });
  assert.ok(!("autonomyMode" in nulled[0].metadata));
});

test("autonomyMode: compaction events carry no posture, because Codex sends none", () => {
  // PreCompact/PostCompact are the two hooks Codex's schemas leave the field
  // out of. Their absence is the payload's, and must not read as a mapping gap.
  for (const events of [mapCodexEvent("PreCompact", { trigger: "auto" }), mapCodexEvent("PostCompact", {})]) {
    assert.ok(!("autonomyMode" in events[0].metadata));
  }
});

test("autonomyMode: PreToolUse stays posture-free, PostToolUse carries it", () => {
  // The pair covers one call under one mode; carrying it once halves the cost
  // on the highest-volume event.
  const pre = mapCodexEvent("PreToolUse", { tool_name: "Bash", permission_mode: "default" });
  assert.ok(!("autonomyMode" in pre[0].metadata));
  const post = mapCodexEvent("PostToolUse", { tool_name: "Bash", permission_mode: "default", tool_input: { command: "ls" }, tool_response: {} });
  assert.equal(post[0].metadata.autonomyMode, "default");
});

test("autonomyMode: posture is NOT gated on success — failures keep it", () => {
  const failed = mapCodexEvent("PostToolUse", { tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "ls" }, tool_response: { exitCode: 1 } });
  assert.equal(failed[0].eventType, "ai_tool_call_failed");
  assert.equal(failed[0].metadata.autonomyMode, "bypass_permissions");

  const broken = mapCodexEvent("PostToolUse", { tool_name: "shell", permission_mode: "plan", tool_input: { command: "cargo test" }, tool_response: { exit_code: 101 } });
  assert.equal(broken[0].eventType, "compile_error");
  assert.equal(broken[0].metadata.autonomyMode, "plan");
});

test("autonomyMode: rides file, verification, prompt, session and long-loop events", () => {
  const edit = mapCodexEvent("PostToolUse", { tool_name: "apply_patch", permission_mode: "acceptEdits", tool_response: {} });
  assert.equal(edit[0].eventType, "ai_file_edit");
  assert.equal(edit[0].metadata.autonomyMode, "accept_edits");

  const verification = mapCodexEvent("PostToolUse", { tool_name: "Bash", permission_mode: "plan", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } });
  assert.equal(verification[0].eventType, "editor_verification_activity");
  assert.equal(verification[0].metadata.autonomyMode, "plan");

  const prompt = mapCodexEvent("UserPromptSubmit", { prompt: "no, that's wrong - try again", permission_mode: "default" });
  assert.equal(prompt.length, 2);
  assert.equal(prompt[0].metadata.autonomyMode, "default");
  assert.equal(prompt[1].metadata.autonomyMode, "default", "the correction event carries the posture too");

  // Unlike Claude Code, Codex DOES send the mode on SessionStart.
  const session = mapCodexEvent("SessionStart", { source: "startup", permission_mode: "dontAsk" });
  assert.equal(session[0].eventType, "create_focus_session");
  assert.equal(session[0].metadata.autonomyMode, "dont_ask");

  const loop = mapCodexEvent("Stop", { permission_mode: "bypassPermissions" }, 90 * 60000);
  assert.equal(loop[0].eventType, "agent_loop_long");
  assert.equal(loop[0].metadata.autonomyMode, "bypass_permissions");
});

test("autonomyMode: alternate spellings and nesting are read", () => {
  const camel = mapCodexEvent("PostToolUse", { tool_name: "t", permissionMode: "plan", tool_response: {} });
  assert.equal(camel[0].metadata.autonomyMode, "plan");
  const nested = mapCodexEvent("PostToolUse", { tool_name: "t", payload: { permission_mode: "dontAsk" }, tool_response: {} });
  assert.equal(nested[0].metadata.autonomyMode, "dont_ask");
});

test("autonomyMode: the posture never displaces host=codex", () => {
  const events = mapCodexEvent("PostToolUse", { tool_name: "t", permission_mode: "default", tool_response: {} });
  assert.equal(events[0].metadata.host, "codex");
  assert.equal(events[0].metadata.autonomyMode, "default");
});

/**
 * The same sweep the Claude adapter carries. The five retired rungs of the
 * posture ladder must not reach the wire from this collector either — the
 * ladder lives in `autonomyBand` in tool-kit now, derived at read time, and
 * a collector emitting one would be a coarsening written permanently into an
 * append-only corpus.
 */
test("autonomyMode: no retired ladder rung reaches the wire from any payload", () => {
  const retired = new Set(["planning", "supervised", "edits_auto", "delegated", "unsupervised"]);
  for (const permissionMode of ["plan", "default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "someFutureMode"]) {
    const emitted = [
      ...mapCodexEvent("PostToolUse", { tool_name: "t", permission_mode: permissionMode, tool_response: {} }),
      ...mapCodexEvent("SessionStart", { source: "startup", permission_mode: permissionMode }),
      ...mapCodexEvent("UserPromptSubmit", { prompt: "go", permission_mode: permissionMode }),
      ...mapCodexEvent("Stop", { permission_mode: permissionMode }, 90 * 60000)
    ];
    for (const event of emitted) {
      assert.ok(!retired.has(event.metadata.autonomyMode), `${permissionMode} → ${event.metadata.autonomyMode}`);
    }
  }
});
