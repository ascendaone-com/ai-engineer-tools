/**
 * The route key: who served a model, as one word from a closed list. Every
 * case here checks the same promise from a different side: the value is a
 * word from the list, read from a fixed prefix, a built-in provider id or
 * whether a setting is present, and never any part of a URL, host or name.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelRouteFromSlug, modelRouteFromCodexProvider, claudeCodeModelRoute, modelFieldsFor, withModelOnChange } = require("../out/index.js");

const ROUTES = new Set(["direct", "bedrock", "vertex", "azure", "gateway", "custom_endpoint", "local"]);

test("slug prefixes name a route; a plain slug names none", () => {
  const cases = [
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "bedrock"],
    ["anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock"],
    ["us.deepseek.r1-v1:0", "bedrock"],
    ["meta.llama3-1-70b-instruct-v1:0", "bedrock"],
    ["bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0", "bedrock"],
    ["arn:aws:bedrock:us-east-1:000000000000:inference-profile/x", "bedrock"],
    ["vertex_ai/deepseek-ai/deepseek-r1-0528-maas", "vertex"],
    ["projects/p/locations/l/publishers/anthropic/models/claude-opus-4-1", "vertex"],
    ["azure/gpt-5", "azure"],
    ["openrouter/moonshotai/kimi-k2", "gateway"],
    ["openrouter/auto", "gateway"],
    ["groq/llama-3.3-70b-versatile", "gateway"],
    ["ollama/gpt-oss", "local"],
    ["lmstudio/qwen3-coder-30b", "local"],
    ["claude-opus-5", undefined],
    ["gpt-5-codex", undefined],
    ["deepseek-chat", undefined],
    ["moonshotai/kimi-k2", undefined],
    ["", undefined],
    [undefined, undefined],
    [5, undefined]
  ];
  for (const [slug, expected] of cases) {
    assert.equal(modelRouteFromSlug(slug), expected, String(slug));
  }
});

test("Codex providers: built-in ids map, anything else is custom_endpoint and never its name", () => {
  assert.equal(modelRouteFromCodexProvider("openai"), "direct");
  assert.equal(modelRouteFromCodexProvider("azure"), "azure");
  assert.equal(modelRouteFromCodexProvider("oss"), "local");
  assert.equal(modelRouteFromCodexProvider("ollama"), "local");
  assert.equal(modelRouteFromCodexProvider("lmstudio"), "local");
  assert.equal(modelRouteFromCodexProvider("openrouter"), "gateway");
  assert.equal(modelRouteFromCodexProvider("  OpenAI "), "direct");
  // A provider someone defined in their own config.
  assert.equal(modelRouteFromCodexProvider("acme-internal-gateway"), "custom_endpoint");
  assert.equal(modelRouteFromCodexProvider(""), undefined);
  assert.equal(modelRouteFromCodexProvider(undefined), undefined);
  assert.equal(modelRouteFromCodexProvider(3), undefined);
});

test("Claude Code: the cloud switches win, then the slug, then a base URL's presence", () => {
  assert.equal(claudeCodeModelRoute({}, "claude-opus-5"), "direct");
  assert.equal(claudeCodeModelRoute({ CLAUDE_CODE_USE_BEDROCK: "1" }, "claude-opus-5"), "bedrock");
  assert.equal(claudeCodeModelRoute({ CLAUDE_CODE_USE_VERTEX: "1" }, "claude-opus-5"), "vertex");
  assert.equal(claudeCodeModelRoute({ CLAUDE_CODE_USE_FOUNDRY: "1" }, "claude-opus-5"), "azure");
  assert.equal(claudeCodeModelRoute({ CLAUDE_CODE_USE_BEDROCK: "0" }, "claude-opus-5"), "direct");
  assert.equal(claudeCodeModelRoute({ CLAUDE_CODE_USE_BEDROCK: "false" }, "claude-opus-5"), "direct");
  assert.equal(claudeCodeModelRoute({}, "us.anthropic.claude-opus-4-5-v1:0"), "bedrock");
  assert.equal(claudeCodeModelRoute({ ANTHROPIC_BASE_URL: "https://llm.example.internal" }, "claude-opus-5"), "custom_endpoint");
  assert.equal(claudeCodeModelRoute({ ANTHROPIC_BASE_URL: "https://llm.example.internal" }, "openrouter/moonshotai/kimi-k2"), "gateway");
  assert.equal(claudeCodeModelRoute({ ANTHROPIC_BASE_URL: "   " }, "claude-opus-5"), "direct");
});

test("no reader ever returns anything but a word from the list", () => {
  const host = "https://llm.example.internal/v1";
  const values = [
    modelRouteFromSlug(host),
    modelRouteFromCodexProvider(host),
    claudeCodeModelRoute({ ANTHROPIC_BASE_URL: host }, host),
    claudeCodeModelRoute({ ANTHROPIC_BASE_URL: host }, "claude-opus-5")
  ].filter((v) => v !== undefined);
  for (const v of values) {
    assert.ok(ROUTES.has(v), `${v} is not a route word`);
    assert.ok(!v.includes("example"), "a host leaked into the route");
  }
});

test("modelFieldsFor: both id and class or neither, route only when given", () => {
  assert.deepEqual(modelFieldsFor(" kimi-k2 "), { modelId: "kimi-k2", modelClass: "moonshot:unknown" });
  assert.deepEqual(modelFieldsFor("gpt-5", "direct"), { modelId: "gpt-5", modelClass: "openai:gpt", modelRoute: "direct" });
  assert.equal(modelFieldsFor(""), undefined);
  assert.equal(modelFieldsFor(undefined), undefined);
  assert.equal(modelFieldsFor(7), undefined);
  assert.equal(modelFieldsFor("x".repeat(201)), undefined);
});

test("withModelOnChange: first event only, and only on a change or when forced", () => {
  const events = () => [{ metadata: { a: 1 } }, { metadata: { b: 2 } }];
  const fields = modelFieldsFor("gpt-5");
  const fresh = withModelOnChange(events(), fields, undefined);
  assert.equal(fresh.sent, "gpt-5");
  assert.equal(fresh.events[0].metadata.modelId, "gpt-5");
  assert.equal("modelId" in fresh.events[1].metadata, false);
  const same = withModelOnChange(events(), fields, "gpt-5");
  assert.equal(same.sent, undefined);
  assert.equal("modelId" in same.events[0].metadata, false);
  const forced = withModelOnChange(events(), fields, "gpt-5", true);
  assert.equal(forced.sent, "gpt-5");
  const changed = withModelOnChange(events(), modelFieldsFor("gpt-5-mini"), "gpt-5");
  assert.equal(changed.events[0].metadata.modelId, "gpt-5-mini");
  assert.deepEqual(withModelOnChange([], fields, undefined), { events: [] });
  assert.equal(withModelOnChange(events(), undefined, "gpt-5").sent, undefined);
});
