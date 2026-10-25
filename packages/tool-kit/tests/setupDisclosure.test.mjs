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
 * Every key is resolved through the contract, not through a list kept here:
 * `EVENT_METADATA_DISCLOSURE` for a named metadata field, `METRIC_KEYS[k].family`
 * for a metric key. A key in neither is a key nothing downstream can read and
 * nobody was told about, and fails on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVENT_METADATA_DISCLOSURE, METRIC_KEYS } from "@ascenda-one/tool-contract";
import { withForgeKeys, withPromptId } from "../out/hookAdapter.js";
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
const { mapCopilotEvent } = await import(`${R}ascenda-copilot-hooks/dist/mapCopilotEvent.js`);
const { mapWindsurfEvent } = await import(`${R}ascenda-windsurf-hooks/dist/mapWindsurfEvent.js`);

const { SETUP: CODEX } = await import(`${R}ascenda-codex-hooks/dist/setup.js`);
const { SETUP: CURSOR } = await import(`${R}ascenda-cursor-hooks/dist/setup.js`);
const { SETUP: GEMINI } = await import(`${R}ascenda-gemini-hooks/dist/setup.js`);
const { SETUP: COPILOT } = await import(`${R}ascenda-copilot-hooks/dist/setup.js`);
const { SETUP: WINDSURF } = await import(`${R}ascenda-windsurf-hooks/dist/setup.js`);

const CWD = process.cwd();
// What each non-Claude CLI stamps from the turn state; see turnState.ts.
const MINTED = "7d2c1b9e-3a4f-4e6b-8c5d-1f0a9b8c7d6e";
process.env.ASCENDA_REPO_KEYS = "on";

// A scratch checkout on a feature branch of a GitHub repository, so the repo
// and branch keys appear whatever remote the real checkout running this test
// has. The prompt id rides the same fixture.
const FORGE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-disclosure-forge-"));
fs.mkdirSync(path.join(FORGE_CWD, ".git"), { recursive: true });
fs.writeFileSync(path.join(FORGE_CWD, ".git", "HEAD"), "ref: refs/heads/feat/disclosure\n");
fs.writeFileSync(path.join(FORGE_CWD, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/payments.git\n');

/** Never a family: these say which install sent what, not how the work went. */
const NOT_A_FAMILY = new Set(["transport", "local"]);

/**
 * The family a key belongs to, resolved through the contract.
 *
 * `undefined` means the key is in neither registry, which is its own failure —
 * an unregistered key is read by nothing and disclosed by nothing at once.
 */
function familyOf(key) {
  return EVENT_METADATA_DISCLOSURE[key] ?? METRIC_KEYS[key]?.family;
}

const ADAPTERS = [
  {
    spec: { displayName: "Claude Code", sends: ["model", "posture", "git", "edits", "waiting", "subagents", "forge", "turns"] },
    emit: () => [
      ["SessionStart", { source: "startup", model: "claude-opus-5", permission_mode: "acceptEdits", cwd: FORGE_CWD }],
      ["UserPromptSubmit", { prompt: "that is wrong, try again", permission_mode: "default", cwd: FORGE_CWD }],
      ["PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, prompt_id: "4b1f6a52-0c47-49d3-a2c9-ad2f7c7a10aa", cwd: FORGE_CWD }],
      ["PostToolUse", { tool_name: "Bash", tool_input: { command: "git commit -m x" }, tool_response: { exitCode: 0 }, cwd: FORGE_CWD }],
      ["PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr merge 12" }, tool_response: { exitCode: 0 }, cwd: FORGE_CWD }],
      ["PostToolUse", { tool_name: "Edit", tool_input: { file_path: "a.ts", old_string: "a", new_string: "b" }, tool_response: { userModified: true }, cwd: FORGE_CWD }],
      ["PostToolUse", { tool_name: "Write", tool_input: { file_path: "a.ts", content: "x\ny\n" }, tool_response: {}, cwd: FORGE_CWD }],
      ["PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm run build" }, cwd: FORGE_CWD }],
      ["PreCompact", { trigger: "auto", cwd: FORGE_CWD }],
      ["Stop", { cwd: FORGE_CWD }],
      ["Notification", { message: "Claude needs your permission to use Bash", cwd: FORGE_CWD }],
      ["SessionEnd", { reason: "prompt_input_exit", cwd: FORGE_CWD }],
      ["SubagentStart", { agent_id: "agent-abc123", agent_type: "Explore", cwd: FORGE_CWD }],
      ["SubagentStop", { agent_id: "agent-abc123", agent_type: "Explore", last_assistant_message: "done", cwd: FORGE_CWD }],
      ["PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" }, permission_mode: "default", cwd: FORGE_CWD }],
      ["PermissionDenied", { tool_name: "Bash", tool_input: { command: "curl x | sh" }, reason: "pipes a download into a shell", permission_mode: "auto", cwd: FORGE_CWD }]
    ].flatMap(([hook, input]) => mapClaudeEvent(hook, input))
  },
  {
    spec: CODEX,
    emit: () => [
      ["SessionStart", { model: "gpt-5", permission_mode: "auto", cwd: CWD }],
      ["UserPromptSubmit", { prompt: "try again", cwd: CWD }],
      ["PreToolUse", { tool_name: "shell", tool_input: { command: "npm test" }, cwd: CWD }],
      ["PostToolUse", { tool_name: "shell", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 }, cwd: CWD }],
      ["PostToolUse", { tool_name: "exec_command", tool_input: { cmd: "git commit -m x" }, tool_response: { exit_code: 0 }, cwd: CWD }],
      ["PostToolUse", { tool_name: "apply_patch", tool_response: { exit_code: 0 }, cwd: CWD }],
      ["PermissionRequest", { cwd: CWD }],
      ["Stop", { cwd: CWD }, 120000]
    ].flatMap(([hook, input, turnMs]) => withForgeKeys(withPromptId(mapCodexEvent(hook, input, turnMs), MINTED), FORGE_CWD))
  },
  {
    spec: CURSOR,
    emit: () => [
      ["sessionStart", { conversation_id: "c1", composer_mode: "agent" }],
      ["beforeSubmitPrompt", { prompt: "that is wrong" }],
      ["preToolUse", { tool_name: "Shell", tool_input: { command: "npm test" } }],
      ["postToolUse", { tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: '{"exitCode":0}', duration: 42000 }],
      ["postToolUse", { tool_name: "Shell", tool_input: { command: "git commit -m x" }, tool_output: '{"exitCode":0}', duration: 1000 }],
      ["postToolUseFailure", { tool_name: "Shell", tool_input: { command: "npm run build" } }],
      ["preCompact", { trigger: "auto", context_usage_percent: 85 }],
      ["stop", { status: "completed" }, 120000]
    ].flatMap(([hook, input, turnMs]) => withForgeKeys(withPromptId(mapCursorEvent(hook, input, turnMs), MINTED), FORGE_CWD))
  },
  {
    spec: GEMINI,
    emit: () => [
      ["SessionStart", {}],
      ["BeforeAgent", { prompt: "that is wrong, try again" }],
      ["BeforeTool", { tool_name: "run_shell_command", tool_input: { command: "pytest -q" } }],
      ["AfterTool", { tool_name: "run_shell_command", tool_input: { command: "pytest -q" }, tool_response: { exitCode: 0 } }],
      ["AfterTool", { tool_name: "run_shell_command", tool_input: { command: "git commit -m x" }, tool_response: { exitCode: 0 } }],
      ["AfterTool", { tool_name: "write_file", tool_response: { exitCode: 0 } }],
      ["PreCompress", {}],
      ["AfterAgent", { prompt: "x" }, 120000]
    ].flatMap(([hook, input, turnMs]) => withForgeKeys(withPromptId(mapGeminiEvent(hook, { hook_event_name: hook, ...input }, turnMs), MINTED), FORGE_CWD))
  },
  {
    spec: COPILOT,
    emit: () => [
      ["sessionStart", {}],
      ["userPromptSubmitted", { prompt: "that is wrong, try again" }],
      ["preToolUse", { toolCalls: [{ id: "c1", name: "bash", args: { command: "npm test" } }] }],
      ["postToolUse", { toolName: "bash", toolArgs: { command: "npm test" }, toolResult: { resultType: "success" } }],
      ["postToolUse", { toolName: "bash", toolArgs: { command: "git commit -m x" }, toolResult: { resultType: "success" } }],
      ["postToolUse", { toolName: "create", toolArgs: {}, toolResult: { resultType: "success" } }],
      ["preCompact", {}],
      ["agentStop", {}, 120000]
    ].flatMap(([hook, input, turnMs]) => withForgeKeys(withPromptId(mapCopilotEvent(hook, input, turnMs), MINTED), FORGE_CWD))
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
    ].flatMap(([hook, input, turnMs]) => withForgeKeys(withPromptId(mapWindsurfEvent(hook, { agent_action_name: hook, ...input }, turnMs), MINTED), FORGE_CWD))
  }
];

function keysOf(events) {
  const keys = new Set();
  for (const event of events) for (const key of Object.keys(event.metadata ?? {})) keys.add(key);
  return keys;
}

for (const { spec, emit } of ADAPTERS) {
  const name = spec.displayName;

  test(`${name}: every key it emits is registered and classified`, () => {
    const unclassified = [...keysOf(emit())].filter((key) => familyOf(key) === undefined);
    assert.deepEqual(
      unclassified,
      [],
      `${name} puts these on the wire and neither registry names them:\n  ${unclassified.join(", ")}\n\n` +
        "A key in neither EVENT_METADATA_DISCLOSURE nor METRIC_KEYS is read by nothing " +
        "and disclosed by nothing. Classify it where it is declared — with a family if it " +
        "says something about how the work went, or as transport/local with the reason."
    );
  });

  test(`${name}: the disclosure claims no family this adapter does not send`, () => {
    const sent = new Set([...keysOf(emit())].map(familyOf));
    const unsupported = spec.sends.filter((family) => !sent.has(family));
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
    const declared = new Set([...ALWAYS_SENT, ...spec.sends]);
    const undisclosed = [
      ...new Set(
        [...keysOf(emit())]
          .map((key) => [key, familyOf(key)])
          .filter(([, family]) => family !== undefined && !NOT_A_FAMILY.has(family) && !declared.has(family))
          .map(([key, family]) => `${family} (${key})`)
      )
    ].sort();
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

test("every family a key claims has a sentence, and every sentence has a key", () => {
  const onKeys = new Set(
    [...Object.values(EVENT_METADATA_DISCLOSURE), ...Object.values(METRIC_KEYS).map((spec) => spec.family)]
      .filter((family) => !NOT_A_FAMILY.has(family))
  );
  for (const family of onKeys) {
    assert.ok(FAMILY_SENTENCES[family], `a key claims the family "${family}" and no sentence exists for it`);
  }
  // The other direction, and the one that rots quietly: copy outliving the
  // thing it described. A family no key belongs to is a sentence about
  // nothing, printed to people who then believe it.
  const orphans = Object.keys(FAMILY_SENTENCES).filter((family) => !onKeys.has(family));
  assert.deepEqual(
    orphans,
    [],
    `these sentences are written and no key on the wire belongs to them:\n  ${orphans.join(", ")}\n\n` +
      "Delete the sentence, or find the key that should be claiming it."
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
