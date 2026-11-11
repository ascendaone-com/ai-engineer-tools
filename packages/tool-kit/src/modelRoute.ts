import type { ModelRoute } from "@ascenda-one/tool-contract";

/**
 * Who served a model, as one coarse word. The vendor (who trained it) is
 * `modelClass`; this is the other half, and the two are read apart on purpose:
 * `vertex_ai/deepseek-r1` is a DeepSeek model that came through Vertex.
 *
 * **Only ever a word from a closed list.** Nothing here returns, stores or
 * logs a URL, a host, a region, an account, a deployment name or a provider
 * name someone typed. Each reader below looks at whether a setting is
 * present, or at a fixed prefix the client itself writes in front of the
 * slug, and maps that onto {@link ModelRoute}. A provider name that isn't on
 * a fixed list becomes `custom_endpoint`, never itself, because a name
 * someone chose for their own endpoint can say whose endpoint it is.
 *
 * `undefined` means the route couldn't be read, and the key is then left
 * off. It never defaults to `direct`: an imported Claude Code transcript
 * doesn't record which endpoint served it, and guessing `direct` there would
 * put every gateway user in the wrong bucket.
 */

/**
 * The route a slug's own prefix names, or `undefined` when it names none.
 *
 * The prefixes are the ones clients and gateways write in front of a model
 * id: Bedrock's region and vendor dots (`us.anthropic.…`, `meta.llama3…`) and
 * its ARNs, LiteLLM-style provider prefixes (`bedrock/`, `vertex_ai/`,
 * `azure/`), Vertex resource paths (`publishers/…/models/…`), OpenRouter, and
 * the local runtimes. A plain `claude-opus-5` or `gpt-5-codex` names no route.
 */
export function modelRouteFromSlug(raw: unknown): ModelRoute | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  for (const [pattern, route] of SLUG_ROUTES) {
    if (pattern.test(value)) return route;
  }
  return undefined;
}

const BEDROCK_VENDORS = "anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|openai|writer|moonshot|minimax|stability";

const SLUG_ROUTES: readonly (readonly [RegExp, ModelRoute])[] = [
  // Local runtimes first: `ollama/…` says where the weights ran whatever the
  // rest of the id says.
  [/^(ollama|ollama_chat|lmstudio|lm_studio|lm-studio|llamacpp|llama\.cpp)\//, "local"],
  [/\b(ollama|llamacpp|lmstudio)\b/, "local"],
  [/^(bedrock|bedrock_converse|amazon-bedrock|aws-bedrock)\//, "bedrock"],
  [/^arn:aws[a-z-]*:bedrock:/, "bedrock"],
  // `us.anthropic.claude-…-v1:0`, `eu.meta.llama3-…`, `anthropic.claude-…`.
  // The vendor dot is what makes it Bedrock's form: no other surface writes
  // `vendor.model`.
  [new RegExp(`^(?:(?:us|eu|apac|us-gov|global|jp|au|ca)\\.)?(?:${BEDROCK_VENDORS})\\.[a-z0-9]`), "bedrock"],
  [/^(vertex_ai|vertex|vertex_ai_beta|google-vertex|vertexai)\//, "vertex"],
  [/(^|\/)publishers\/[a-z0-9-]+\/models\//, "vertex"],
  [/^(azure|azure_ai|azure-openai|azureai)\//, "azure"],
  [/^(openrouter|litellm|litellm_proxy|portkey|helicone|together_ai|together|fireworks_ai|fireworks|groq|deepinfra|cloudflare)\//, "gateway"]
];

/**
 * Codex's `model_provider` (the rollout's `session_meta`, and the
 * `model_provider` setting) onto a route. Codex ships a few built-in provider
 * ids; anything else is a provider someone defined in their own config, and
 * its name is theirs, so it reads as `custom_endpoint` and the name goes
 * nowhere.
 *
 * `openai` reads as `direct`. Codex lets an environment variable point the
 * built-in provider at another base URL, and the rollout doesn't record
 * that, so a redirected built-in provider is filed as `direct`. That's the
 * one known blind spot here.
 */
export function modelRouteFromCodexProvider(raw: unknown): ModelRoute | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  return CODEX_PROVIDER_ROUTES[value] ?? "custom_endpoint";
}

const CODEX_PROVIDER_ROUTES: Readonly<Record<string, ModelRoute>> = {
  openai: "direct",
  azure: "azure",
  "azure-openai": "azure",
  oss: "local",
  ollama: "local",
  lmstudio: "local",
  "lm-studio": "local",
  bedrock: "bedrock",
  "amazon-bedrock": "bedrock",
  vertex: "vertex",
  vertexai: "vertex",
  openrouter: "gateway",
  litellm: "gateway",
  portkey: "gateway"
};

/**
 * Claude Code's route from its own settings, read only for presence. Claude
 * Code documents `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and
 * `CLAUDE_CODE_USE_FOUNDRY` (Azure) as switches, and `ANTHROPIC_BASE_URL` as
 * the setting that points it at a proxy or gateway. The base URL's value is
 * never read past "is it set": a host would name the employer's
 * infrastructure.
 *
 * The slug can be more specific than the base URL (a gateway that writes
 * `openrouter/…` in front of the model), so a slug route beats a bare
 * `custom_endpoint`. The cloud switches beat both: they decide which API
 * Claude Code calls.
 *
 * With none of them set, Claude Code talks to Anthropic's own API, so this is
 * `direct`.
 */
export function claudeCodeModelRoute(env: NodeJS.ProcessEnv, slug: unknown): ModelRoute {
  if (isTruthySetting(env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (isTruthySetting(env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (isTruthySetting(env.CLAUDE_CODE_USE_FOUNDRY)) return "azure";
  const fromSlug = modelRouteFromSlug(slug);
  if (fromSlug) return fromSlug;
  if (typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL.trim() !== "") return "custom_endpoint";
  return "direct";
}

function isTruthySetting(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}
