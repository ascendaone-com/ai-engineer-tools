/**
 * The sentence `setup` prints before it pairs.
 *
 * Two properties, and they pull in opposite directions. A disclosure has to
 * cover what the collector sends, and it has to stop covering it when the
 * collector stops — an adapter that prints "which model served the session"
 * while sending no model is as wrong as one that sends a model silently, and
 * is the easier of the two to ship, because nothing about it looks odd.
 *
 * So the families are checked against the mappers' own output rather than
 * against a second list written by hand. Each adapter's spec declares what it
 * sends; this file runs its mapper and asserts the declaration is neither
 * short nor long.
 *
 * What it does NOT yet check: that every *key* is covered by some family.
 * Family membership is asserted here for the handful of keys that make a
 * family true — the binding of the whole key vocabulary to families is the
 * `family` field on the metric-key registry, and is the next change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_SENT,
  FAMILY_SENTENCES,
  FREE_TEXT_KEYS,
  REFUSALS,
  renderSetupDisclosure
} from "../out/setupDisclosure.js";

const R = new URL("../../../", import.meta.url).pathname;

const { mapClaudeEvent } = await import(`${R}ascenda-claude-code-hooks/dist/mapClaudeEvent.js`);
const { mapCodexEvent } = await import(`${R}ascenda-codex-hooks/dist/mapCodexEvent.js`);
const { mapCursorEvent } = await import(`${R}ascenda-cursor-hooks/dist/mapCursorEvent.js`);
const { mapGeminiEvent } = await import(`${R}ascenda-gemini-hooks/dist/mapGeminiEvent.js`);
const { mapWindsurfEvent } = await import(`${R}ascenda-windsurf-hooks/dist/mapWindsurfEvent.js`);

const { SETUP: CODEX } = await import(`${R}ascenda-codex-hooks/dist/setup.js`);
const { SETUP: CURSOR } = await import(`${R}ascenda-cursor-hooks/dist/setup.js`);
const { SETUP: GEMINI } = await import(`${R}ascenda-gemini-hooks/dist/setup.js`);
const { SETUP: WINDSURF } = await import(`${R}ascenda-windsurf-hooks/dist/setup.js`);

const CWD = process.cwd();

/**
 * The key that makes each optional family true on the wire.
 *
 * One key per family is enough: the question a declaration answers is "does
 * this adapter send this kind of thing at all", and a family with none of its
 * keys present is a sentence about nothing.
 */
const FAMILY_EVIDENCE = {
  model: ["modelId", "modelClass"],
  posture: ["autonomyMode"],
  git: ["gitAction", "milestoneKind"],
  edits: ["linesChangedBucket", "userModified"],
  context: ["contextWindowPeakPct", "contextUsagePercent", "tokenPressureBucket"],
  waiting: ["interruptionKind"]
};

const ADAPTERS = [
  {
    spec: { displayName: "Claude Code", sends: ["model", "posture", "git", "edits", "waiting"] },
    emit: () => [
      ["SessionStart", { source: "startup", model: "claude-opus-5", permission_mode: "acceptEdits", cwd: CWD }],
      ["UserPromptSubmit", { prompt: "that is wrong, try again", permission_mode: "default", cwd: CWD }],
      ["PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, cwd: CWD }],
      ["PostToolUse", { tool_name: "Bash", tool_input: { command: "git commit -m x" }, tool_response: { exitCode: 0 }, cwd: CWD }],
      ["PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr merge 12" }, tool_response: { exitCode: 0 }, cwd: CWD }],
      ["PostToolUse", { tool_name: "Edit", tool_input: { file_path: "a.ts", old_string: "a", new_string: "b" }, tool_response: { userModified: true }, cwd: CWD }],
      ["PostToolUse", { tool_name: "Write", tool_input: { file_path: "a.ts", content: "x\ny\n" }, tool_response: {}, cwd: CWD }],
      ["PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm run build" }, cwd: CWD }],
      ["PreCompact", { trigger: "auto", cwd: CWD }],
      ["Stop", { cwd: CWD }],
      ["Notification", { message: "Claude needs your permission to use Bash", cwd: CWD }]
    ].flatMap(([hook, input]) => mapClaudeEvent(hook, input))
  },
  {
    spec: CODEX,
    emit: () => [
      ["SessionStart", { model: "gpt-5", permission_mode: "auto", cwd: CWD }],
      ["UserPromptSubmit", { prompt: "try again", cwd: CWD }],
      ["PreToolUse", { tool_name: "shell", tool_input: { command: "npm test" }, cwd: CWD }],
      ["PostToolUse", { tool_name: "shell", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 }, cwd: CWD }],
      ["PostToolUse", { tool_name: "apply_patch", tool_response: { exit_code: 0 }, cwd: CWD }],
      ["PermissionRequest", { cwd: CWD }],
      ["Stop", { cwd: CWD }, 120000]
    ].flatMap(([hook, input, turnMs]) => mapCodexEvent(hook, input, turnMs))
  },
  {
    spec: CURSOR,
    emit: () => [
      ["sessionStart", { conversation_id: "c1", composer_mode: "agent" }],
      ["beforeSubmitPrompt", { prompt: "that is wrong" }],
      ["preToolUse", { tool_name: "Shell", tool_input: { command: "npm test" } }],
      ["postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":0}', duration: 42000 }],
      ["postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm run build" } }],
      ["preCompact", { trigger: "auto", context_usage_percent: 85 }],
      ["stop", { status: "completed" }, 120000]
    ].flatMap(([hook, input, turnMs]) => mapCursorEvent(hook, input, turnMs))
  },
  {
    spec: GEMINI,
    emit: () => [
      ["SessionStart", {}],
      ["BeforeAgent", { prompt: "that is wrong, try again" }],
      ["BeforeTool", { tool_name: "run_shell_command", tool_input: { command: "pytest -q" } }],
      ["AfterTool", { tool_name: "run_shell_command", tool_input: { command: "pytest -q" }, tool_response: { exitCode: 0 } }],
      ["AfterTool", { tool_name: "write_file", tool_response: { exitCode: 0 } }],
      ["PreCompress", {}],
      ["AfterAgent", { prompt: "x" }, 120000]
    ].flatMap(([hook, input, turnMs]) => mapGeminiEvent(hook, { hook_event_name: hook, ...input }, turnMs))
  },
  {
    spec: WINDSURF,
    emit: () => [
      ["pre_user_prompt", { tool_info: { user_prompt: "that is wrong, try again" } }],
      ["pre_write_code", { tool_info: { file_path: "/p/a.ts" } }],
      ["post_write_code", { tool_info: { file_path: "/p/a.ts" } }],
      ["pre_run_command", { tool_info: { command_line: "npm test", cwd: "/p" } }],
      ["post_run_command", { tool_info: { command_line: "npm test", cwd: "/p" } }],
      ["post_cascade_response", {}, 120000]
    ].flatMap(([hook, input, turnMs]) => mapWindsurfEvent(hook, { agent_action_name: hook, ...input }, turnMs))
  }
];

function keysOf(events) {
  const keys = new Set();
  for (const event of events) for (const key of Object.keys(event.metadata ?? {})) keys.add(key);
  return keys;
}

for (const { spec, emit } of ADAPTERS) {
  const name = spec.displayName;

  test(`${name}: the disclosure claims no family this adapter does not send`, () => {
    const keys = keysOf(emit());
    const unsupported = spec.sends.filter((family) => {
      const evidence = FAMILY_EVIDENCE[family];
      return evidence && !evidence.some((key) => keys.has(key));
    });
    assert.deepEqual(
      unsupported,
      [],
      `${name}'s setup prints these families and its mapper emits no key behind them:\n  ${unsupported.join(", ")}\n\n` +
        "A sentence about something that is not sent is the same defect as a key that is sent unsaid, " +
        "pointed the other way. Either the mapper stopped sending it — drop the family from `sends` — " +
        "or the fixtures above no longer reach the branch that does."
    );
  });

  test(`${name}: the disclosure omits no family this adapter does send`, () => {
    const keys = keysOf(emit());
    const declared = new Set([...ALWAYS_SENT, ...spec.sends]);
    const undisclosed = Object.entries(FAMILY_EVIDENCE)
      .filter(([family, evidence]) => !declared.has(family) && evidence.some((key) => keys.has(key)))
      .map(([family]) => family);
    assert.deepEqual(
      undisclosed,
      [],
      `${name} puts these on the wire and its setup says nothing about them:\n  ${undisclosed.join(", ")}\n\n` +
        "Add the family to `sends` in that adapter's SETUP spec. If the sentence in FAMILY_SENTENCES " +
        "does not fit what is actually sent, widen the sentence — it is what the person was told."
    );
  });

  test(`${name}: no mapper writes free text into an event`, () => {
    // The third refusal line, which is only worth printing while this holds.
    const offenders = [...keysOf(emit())].filter((key) => FREE_TEXT_KEYS.includes(key));
    assert.deepEqual(
      offenders,
      [],
      `${name} writes ${offenders.join(", ")} — a field that accepts a string of any shape. ` +
        "The setup block tells people no mapper does this."
    );
  });
}

test("every declared family has a sentence, and every sentence is reachable", () => {
  const declared = new Set(ADAPTERS.flatMap(({ spec }) => [...ALWAYS_SENT, ...spec.sends]));
  for (const family of declared) {
    assert.ok(FAMILY_SENTENCES[family], `${family} is declared by an adapter and has no sentence`);
  }
  const orphans = Object.keys(FAMILY_SENTENCES).filter((family) => !declared.has(family));
  assert.deepEqual(
    orphans,
    [],
    `these sentences are written and no adapter prints them:\n  ${orphans.join(", ")}\n\n` +
      "A family nobody declares is copy nobody reads. Delete it, or find the adapter that should be declaring it."
  );
});

test("the rendered block states what is sent, what is refused, and how to stop it", () => {
  const block = renderSetupDisclosure({ sends: ["model"], displayName: "Claude Code" });
  assert.match(block, /What this sends from Claude Code/);
  for (const family of ALWAYS_SENT) assert.ok(block.includes(FAMILY_SENTENCES[family]), `${family} is missing`);
  assert.ok(block.includes(FAMILY_SENTENCES.model), "a declared family is missing");
  assert.ok(!block.includes(FAMILY_SENTENCES.posture), "an undeclared family was printed");
  for (const line of REFUSALS) assert.ok(block.includes(line), "a refusal line is missing");
  assert.match(block, /revoking this tool in the Ascenda app/);
});

test("the families print in one order, whatever order an adapter declares them", () => {
  const a = renderSetupDisclosure({ sends: ["waiting", "model"], displayName: "X" });
  const b = renderSetupDisclosure({ sends: ["model", "waiting"], displayName: "X" });
  assert.equal(a, b, "two adapters sharing a family must print it in the same place");
});
