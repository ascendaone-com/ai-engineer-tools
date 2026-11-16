// A seeded transcript generator that knows the true figures of what it writes.
//
//   const { files, truth } = generateCorpus({ seed: 1, sessions: 5, store: "codex", shape: ["compaction"] });
//
// `files` are `{ relPath, text }` under a snapshot root, in the layout the
// extractors read: `projects/<slug>/<sessionId>.jsonl` for Claude Code,
// `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` for Codex. `truth` holds, per
// session, what a correct reader must report. It is built while the lines are
// written, from the lines that are meant to count, never from an extractor.
//
// Same seed, same bytes. Every string in a line is a placeholder ("lorem 3",
// "Read", "/Users/example/Dev/repo-1"); nothing here comes from a real store.
//
// Sessions that a shape adds to the ones asked for (a resumed copy, a fork)
// come on top of `sessions`, so `truth.sessions.length` can exceed it.

export const STORES = ["claude_code", "codex"];

/** Shape flags each store understands. Flags a store doesn't list are ignored. */
export const SHAPE_FLAGS = {
  claude_code: [
    "multiLineMessages",
    "subagents",
    "forkedSubagent",
    "resumeReplay",
    "resumeCopy",
    "compaction",
    "truncatedTail",
    "malformedMiddle"
  ],
  codex: [
    "subagents",
    "forkedSubagent",
    "resumeCopy",
    "compaction",
    "tokenUsageRecord",
    "cachedInput",
    "archivedCopy",
    "truncatedTail",
    "malformedMiddle"
  ]
};

/** The truth keys every session carries, in the order they are compared. */
export const TRUTH_KEYS = [
  "promptCount",
  "mainThreadToolCallCount",
  "toolFailureCount",
  "assistantTurns",
  "compactionCount",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "subagentTranscripts",
  "subagentToolCallCount",
  "unparsedLines",
  "unknownLines"
];

/** Claude Code also reports cache writes; the Codex extractor doesn't yet. */
export const CLAUDE_ONLY_TRUTH_KEYS = ["cacheCreationTokens"];

const T0 = Date.parse("2026-03-02T00:00:00.000Z");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n, width) => n.toString(16).padStart(width, "0");
const iso = (ms) => new Date(ms).toISOString();

/** Ids sort in creation order, so a parent's file always walks before its child's. */
function sessionIdOf(seed, n) {
  return `${hex(n, 8)}-${hex(seed & 0xffff, 4)}-4000-8000-${hex(0, 12)}`;
}

class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }
  /** Integer in [lo, hi]. */
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }
  chance(p) {
    return this.next() < p;
  }
}

function toFlagSet(shape) {
  if (!shape) return new Set();
  if (shape instanceof Set) return new Set(shape);
  if (Array.isArray(shape)) return new Set(shape);
  return new Set(Object.keys(shape).filter((key) => shape[key]));
}

function emptyTruth(sessionRef, store) {
  const truth = { sessionRef };
  for (const key of TRUTH_KEYS) truth[key] = 0;
  if (store === "claude_code") for (const key of CLAUDE_ONLY_TRUTH_KEYS) truth[key] = 0;
  return truth;
}

/** A line is an object, or a `{ raw }` wrapper for text that isn't valid JSON. */
function serialise(lines, { endsCut = false } = {}) {
  const text = lines.map((line) => (line.raw !== undefined ? line.raw : JSON.stringify(line))).join("\n");
  return endsCut ? text : `${text}\n`;
}

function cutHalf(object) {
  const text = JSON.stringify(object);
  return text.slice(0, Math.floor(text.length / 2));
}

// ---------------------------------------------------------------------------
// Claude Code

const CLAUDE_VERSION = "2.1.100";
const CLAUDE_MODEL = "claude-fixture-1";
const CLAUDE_TOOLS = ["Read", "Bash", "Edit", "Grep"];

class ClaudeThread {
  /**
   * @param {object} o
   * @param {Rng} o.rng
   * @param {string} o.sessionId
   * @param {number} o.index  numeric part of every uuid, so uuids never repeat across sessions
   * @param {number} o.startMs
   * @param {string} o.cwd
   * @param {boolean} o.multiLine
   * @param {string|null} o.agentId  set for a subagent transcript
   */
  constructor({ rng, sessionId, index, startMs, cwd, multiLine, agentId = null }) {
    this.rng = rng;
    this.sessionId = sessionId;
    this.index = index;
    this.t = startMs;
    this.cwd = cwd;
    this.multiLine = multiLine;
    this.agentId = agentId;
    this.lines = [];
    this.counter = 0;
    this.messages = 0;
    this.prompts = 0;
    this.truth = emptyTruth(sessionId, "claude_code");
  }

  tick() {
    this.t += this.rng.range(4, 60) * 1000;
    return iso(this.t);
  }

  base(type) {
    this.counter += 1;
    const line = {
      type,
      uuid: `${hex(this.index, 8)}-0000-4000-9000-${hex(this.counter, 12)}`,
      sessionId: this.sessionId,
      timestamp: this.tick(),
      version: CLAUDE_VERSION,
      cwd: this.cwd,
      gitBranch: "main"
    };
    if (this.agentId) {
      line.isSidechain = true;
      line.agentId = this.agentId;
    }
    return line;
  }

  prompt(text) {
    this.prompts += 1;
    const line = { ...this.base("user"), message: { role: "user", content: text ?? `lorem ${this.prompts}` } };
    this.lines.push(line);
    if (!this.agentId) this.truth.promptCount += 1;
    return line;
  }

  /**
   * One API message. `calls` are the tool names it issues; the results follow
   * as `user` lines, one per call, `failures` of them failed. Returns the call ids.
   */
  message({ calls = [], failures = 0 }) {
    this.messages += 1;
    const messageId = `msg_${this.index}_${this.messages}`;
    const requestId = `req_${this.index}_${this.messages}`;
    const usage = {
      input_tokens: this.rng.range(3, 40),
      output_tokens: this.rng.range(20, 300),
      cache_read_input_tokens: this.rng.range(0, 5000),
      cache_creation_input_tokens: this.rng.range(0, 2000)
    };
    const callIds = calls.map((_, i) => `toolu_${this.index}_${this.messages}_${i}`);
    const blocks = [{ type: "text", text: "lorem" }];
    calls.forEach((name, i) => blocks.push({ type: "tool_use", id: callIds[i], name, input: {} }));
    if (this.multiLine && blocks.length < 2) blocks.unshift({ type: "thinking", thinking: "lorem" });
    // One API message spread over several `assistant` lines, each repeating
    // `usage`; only the last carries the final `output_tokens`.
    const groups = this.multiLine ? blocks.map((block) => [block]) : [blocks];
    groups.forEach((group, i) => {
      const partial = Math.max(1, Math.floor((usage.output_tokens * (i + 1)) / groups.length));
      this.lines.push({
        ...this.base("assistant"),
        requestId,
        message: {
          id: messageId,
          role: "assistant",
          model: CLAUDE_MODEL,
          content: group,
          usage: { ...usage, output_tokens: i === groups.length - 1 ? usage.output_tokens : partial }
        }
      });
    });
    if (!this.agentId) {
      this.truth.assistantTurns += 1;
      this.truth.inputTokens += usage.input_tokens;
      this.truth.outputTokens += usage.output_tokens;
      this.truth.cacheReadTokens += usage.cache_read_input_tokens;
      this.truth.cacheCreationTokens += usage.cache_creation_input_tokens;
      this.truth.mainThreadToolCallCount += calls.length;
    } else {
      this.truth.subagentToolCallCount += calls.length;
    }
    callIds.forEach((id, i) => {
      const failed = i < failures;
      this.lines.push({
        ...this.base("user"),
        toolUseResult: { ok: !failed },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: failed ? "failed" : "ok", ...(failed ? { is_error: true } : {}) }]
        }
      });
      if (failed && !this.agentId) this.truth.toolFailureCount += 1;
    });
    return callIds;
  }

  compaction() {
    this.lines.push({
      ...this.base("system"),
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto" },
      content: "Conversation compacted"
    });
    if (!this.agentId) this.truth.compactionCount += 1;
  }

  toolNames(count) {
    return Array.from({ length: count }, () => CLAUDE_TOOLS[this.rng.int(CLAUDE_TOOLS.length)]);
  }
}

function claudeTurns(thread, { flags, spawn }) {
  const rng = thread.rng;
  const prompts = rng.range(1, 3);
  let compacted = false;
  let spawnIds = [];
  for (let p = 0; p < prompts; p += 1) {
    thread.prompt();
    const turns = rng.range(1, 3);
    for (let k = 0; k < turns; k += 1) {
      const first = p === 0 && k === 0;
      const calls = thread.toolNames(first && spawn ? 0 : rng.range(0, 2));
      if (first && spawn) calls.unshift(...Array(spawn).fill("Task"));
      const failures = calls.length > 0 && rng.chance(0.3) ? 1 : 0;
      const ids = thread.message({ calls, failures });
      if (first && spawn) spawnIds = ids.slice(0, spawn);
      if (flags.has("compaction") && !compacted && (p > 0 || k === turns - 1)) {
        thread.compaction();
        compacted = true;
      }
    }
  }
  if (flags.has("compaction") && !compacted) thread.compaction();
  return spawnIds;
}

function claudeSubagent({ rng, parent, subId, index, toolUseId, fork, copied }) {
  const sub = new ClaudeThread({
    rng,
    sessionId: parent.sessionId,
    index,
    startMs: parent.t - 120_000,
    cwd: parent.cwd,
    multiLine: parent.multiLine,
    agentId: subId
  });
  // A fork opens with a copy of its parent's conversation, byte for byte.
  if (fork) sub.lines.push(...copied.map((line) => JSON.parse(JSON.stringify(line))));
  sub.prompt("lorem task");
  sub.message({ calls: sub.toolNames(rng.range(1, 3)) });
  sub.message({ calls: [] });
  const meta = { agentType: "general-purpose", toolUseId, ...(fork ? { isFork: true } : {}) };
  return { sub, meta };
}

function generateClaude({ seed, sessions, flags }) {
  const rng = new Rng(seed);
  const files = [];
  const truthSessions = [];
  let nextIndex = 0;

  for (let s = 0; s < sessions; s += 1) {
    const index = nextIndex;
    nextIndex += 1;
    const sessionId = sessionIdOf(seed, index);
    const slug = `-Users-example-Dev-repo-${1 + (s % 3)}`;
    const thread = new ClaudeThread({
      rng,
      sessionId,
      index,
      startMs: T0 + s * 3 * 3600_000 + rng.range(0, 1800) * 1000,
      cwd: `/Users/example/Dev/repo-${1 + (s % 3)}`,
      multiLine: flags.has("multiLineMessages")
    });
    const wantsSubagents = flags.has("subagents") || flags.has("forkedSubagent");
    const spawn = wantsSubagents ? rng.range(1, 2) : 0;
    const spawnIds = claudeTurns(thread, { flags, spawn });
    const original = thread.lines.map((line) => JSON.parse(JSON.stringify(line)));

    const dir = `projects/${slug}`;
    spawnIds.forEach((toolUseId, i) => {
      const subId = `a${hex(index, 4)}${hex(i, 2)}`;
      const fork = flags.has("forkedSubagent") && i === 0;
      const { sub, meta } = claudeSubagent({
        rng,
        parent: thread,
        subId,
        index: nextIndex,
        toolUseId,
        fork,
        copied: original.slice(0, 4)
      });
      nextIndex += 1;
      thread.truth.subagentTranscripts += 1;
      thread.truth.subagentToolCallCount += sub.truth.subagentToolCallCount;
      files.push({ relPath: `${dir}/${sessionId}/subagents/agent-${subId}.jsonl`, text: serialise(sub.lines) });
      files.push({ relPath: `${dir}/${sessionId}/subagents/agent-${subId}.meta.json`, text: `${JSON.stringify(meta)}\n` });
    });

    let lines = thread.lines;
    if (flags.has("resumeReplay") && lines.length >= 4) {
      // A resume that writes the opening of the conversation again into the
      // same file, same uuids and timestamps, then carries on.
      const cut = Math.max(2, Math.floor(lines.length * 0.6));
      lines = [...lines.slice(0, cut), ...lines.slice(0, cut).map((line) => JSON.parse(JSON.stringify(line))), ...lines.slice(cut)];
    }
    let endsCut = false;
    if (flags.has("malformedMiddle")) {
      const at = Math.floor(lines.length / 2);
      lines = [...lines.slice(0, at), { raw: '{"type":"assistant","message":{"id":' }, ...lines.slice(at)];
      thread.truth.unparsedLines += 1;
    }
    if (flags.has("truncatedTail")) {
      const tail = { ...thread.base("user"), message: { role: "user", content: "lorem tail" } };
      lines = [...lines, { raw: cutHalf(tail) }];
      thread.truth.unparsedLines += 1;
      endsCut = true;
    }
    files.push({ relPath: `${dir}/${sessionId}.jsonl`, text: serialise(lines, { endsCut }) });
    truthSessions.push(thread.truth);

    if (flags.has("resumeCopy") && s % 2 === 0) {
      // A new file holding the parent's lines under a rewritten sessionId, then
      // work of its own. Those copied lines belong to the parent.
      const childIndex = nextIndex;
      nextIndex += 1;
      const childId = sessionIdOf(seed, childIndex);
      const child = new ClaudeThread({
        rng,
        sessionId: childId,
        index: childIndex,
        startMs: thread.t + 3600_000,
        cwd: thread.cwd,
        multiLine: thread.multiLine
      });
      child.lines.push(...original.map((line) => ({ ...JSON.parse(JSON.stringify(line)), sessionId: childId })));
      claudeTurns(child, { flags: new Set(), spawn: 0 });
      files.push({ relPath: `${dir}/${childId}.jsonl`, text: serialise(child.lines) });
      truthSessions.push(child.truth);
    }
  }
  return { files, truth: { sessions: truthSessions } };
}

// ---------------------------------------------------------------------------
// Codex

const CODEX_VERSION = "0.100.0";
const CODEX_MODEL = "gpt-fixture";
const CODEX_TOOLS = ["shell", "apply_patch", "read_file"];

function rolloutName(startMs, id, suffix = "") {
  const stamp = iso(startMs).slice(0, 19).replace(/:/g, "-");
  return `rollout-${stamp}-${id}${suffix}.jsonl`;
}

function dateDir(startMs) {
  const [y, m, d] = iso(startMs).slice(0, 10).split("-");
  return `sessions/${y}/${m}/${d}`;
}

class CodexThread {
  /**
   * @param {object} o
   * @param {"count"|"both"|"record"} o.tokenMode  which line types carry the running total
   */
  constructor({ rng, id, startMs, cwd, cachedInput, tokenMode, subagentOf = null, forkedFrom = null }) {
    this.rng = rng;
    this.id = id;
    this.t = startMs;
    this.startMs = startMs;
    this.cwd = cwd;
    this.cachedInput = cachedInput;
    this.tokenMode = tokenMode;
    this.subagentOf = subagentOf;
    this.forkedFrom = forkedFrom;
    this.lines = [];
    this.boundaries = [];
    this.cum = { input: 0, cached: 0, output: 0 };
    this.calls = 0;
    this.prompts = 0;
    this.truth = emptyTruth(id, "codex");
    delete this.truth.cacheCreationTokens;
  }

  tick() {
    this.t += this.rng.range(4, 60) * 1000;
    return iso(this.t);
  }

  push(type, payload) {
    this.lines.push({ timestamp: this.tick(), type, payload });
  }

  meta(extra = {}) {
    const payload = {
      id: this.id,
      timestamp: iso(this.startMs),
      cwd: this.cwd,
      cli_version: CODEX_VERSION,
      originator: "fixture",
      model_provider: "openai",
      git: { branch: "main" },
      ...extra
    };
    if (this.subagentOf) {
      payload.thread_source = "subagent";
      payload.parent_thread_id = this.subagentOf;
    }
    if (this.forkedFrom) payload.forked_from_id = this.forkedFrom;
    this.lines.push({ timestamp: iso(this.startMs), type: "session_meta", payload });
  }

  prompt(text) {
    this.prompts += 1;
    this.push("event_msg", { type: "user_message", message: text ?? `lorem ${this.prompts}`, kind: "plain" });
    if (!this.subagentOf) this.truth.promptCount += 1;
    this.push("turn_context", { cwd: this.cwd, model: CODEX_MODEL, effort: "medium" });
  }

  /** One model turn: its tool calls and their outputs, a reply, then a token reading. */
  turn({ calls = 0, failures = 0 }) {
    for (let i = 0; i < calls; i += 1) {
      this.calls += 1;
      const callId = `call_${this.id.slice(0, 8)}_${this.calls}`;
      const failed = i < failures;
      this.push("response_item", {
        type: "function_call",
        name: CODEX_TOOLS[this.rng.int(CODEX_TOOLS.length)],
        arguments: "{}",
        call_id: callId
      });
      this.push("response_item", {
        type: "function_call_output",
        call_id: callId,
        output: failed ? "Exit code: 1\nfailed" : "Exit code: 0\nok"
      });
      if (this.subagentOf) this.truth.subagentToolCallCount += 1;
      else this.truth.mainThreadToolCallCount += 1;
      if (failed && !this.subagentOf) this.truth.toolFailureCount += 1;
    }
    this.push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "lorem" }] });
    if (!this.subagentOf) this.truth.assistantTurns += 1;
    const dInput = this.rng.range(100, 2100);
    const dCached = this.cachedInput ? Math.floor(dInput * 0.8) : 0;
    const dOutput = this.rng.range(10, 310);
    this.cum.input += dInput;
    this.cum.cached += dCached;
    this.cum.output += dOutput;
    // Truth is the definition every other store uses: input is what was billed
    // at the full rate, and cache reads are counted apart.
    this.truth.inputTokens += dInput - dCached;
    this.truth.cacheReadTokens += dCached;
    this.truth.outputTokens += dOutput;
    const total = {
      input_tokens: this.cum.input,
      cached_input_tokens: this.cum.cached,
      output_tokens: this.cum.output,
      total_tokens: this.cum.input + this.cum.output
    };
    if (this.tokenMode !== "record") {
      this.push("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: { input_tokens: dInput, cached_input_tokens: dCached, output_tokens: dOutput },
          model_context_window: 200000
        }
      });
    }
    if (this.tokenMode !== "count") {
      this.push("token_usage_record", { thread_id: this.id, thread_token_usage: total });
    }
    this.boundaries.push(this.lines.length);
  }

  compaction() {
    this.push("compacted", { message: "" });
    this.push("event_msg", { type: "context_compacted" });
    if (!this.subagentOf) this.truth.compactionCount += 1;
  }
}

function codexTurns(thread, { flags }) {
  const rng = thread.rng;
  const prompts = rng.range(1, 3);
  let compacted = false;
  for (let p = 0; p < prompts; p += 1) {
    thread.prompt();
    const turns = rng.range(1, 3);
    for (let k = 0; k < turns; k += 1) {
      const calls = rng.range(0, 2);
      thread.turn({ calls, failures: calls > 0 && rng.chance(0.3) ? 1 : 0 });
      if (flags.has("compaction") && !compacted && (p > 0 || k === turns - 1)) {
        thread.compaction();
        compacted = true;
      }
    }
  }
  if (flags.has("compaction") && !compacted) thread.compaction();
}

function generateCodex({ seed, sessions, flags }) {
  const rng = new Rng(seed);
  const files = [];
  const truthSessions = [];
  let nextIndex = 0;
  const idOf = () => {
    const id = sessionIdOf(seed, nextIndex);
    nextIndex += 1;
    return id;
  };

  for (let s = 0; s < sessions; s += 1) {
    const id = idOf();
    const startMs = T0 + s * 3 * 3600_000 + rng.range(0, 1800) * 1000;
    const tokenMode = flags.has("tokenUsageRecord") ? (s % 2 === 0 ? "both" : "record") : "count";
    const cachedInput = flags.has("cachedInput");
    const cwd = `/Users/example/Dev/repo-${1 + (s % 3)}`;
    const thread = new CodexThread({ rng, id, startMs, cwd, cachedInput, tokenMode });
    thread.meta();
    codexTurns(thread, { flags });
    const dir = dateDir(startMs);

    if (flags.has("subagents")) {
      const subId = idOf();
      const sub = new CodexThread({ rng, id: subId, startMs: startMs + 60_000, cwd, cachedInput, tokenMode, subagentOf: id });
      sub.meta();
      sub.prompt("lorem task");
      sub.turn({ calls: rng.range(1, 3) });
      thread.truth.subagentTranscripts += 1;
      thread.truth.subagentToolCallCount += sub.truth.subagentToolCallCount;
      thread.truth.inputTokens += sub.truth.inputTokens;
      thread.truth.cacheReadTokens += sub.truth.cacheReadTokens;
      thread.truth.outputTokens += sub.truth.outputTokens;
      files.push({ relPath: `${dir}/${rolloutName(sub.startMs, subId)}`, text: serialise(sub.lines) });
    }

    let lines = thread.lines;
    if (flags.has("malformedMiddle")) {
      const at = Math.floor(lines.length / 2);
      lines = [...lines.slice(0, at), { raw: '{"type":"event_msg","payload":{"type":' }, ...lines.slice(at)];
      thread.truth.unparsedLines += 1;
    }
    let endsCut = false;
    if (flags.has("truncatedTail")) {
      const tail = { timestamp: iso(thread.t + 1000), type: "event_msg", payload: { type: "user_message", message: "lorem tail", kind: "plain" } };
      lines = [...lines, { raw: cutHalf(tail) }];
      thread.truth.unparsedLines += 1;
      endsCut = true;
    }

    const name = rolloutName(startMs, id);
    let firstPage = serialise(lines, { endsCut });
    if (flags.has("resumeCopy") && thread.boundaries.length >= 2 && !flags.has("malformedMiddle") && !flags.has("truncatedTail")) {
      // A long thread continues in a second page of the same rollout.
      const cut = thread.boundaries[Math.floor(thread.boundaries.length / 2) - 1];
      const nextAt = Date.parse(lines[cut].timestamp);
      const page2 = [
        {
          timestamp: iso(nextAt),
          type: "session_meta",
          payload: { id, cwd, cli_version: CODEX_VERSION, history_mode: "paginated", history_base: "page-1" }
        },
        ...lines.slice(cut)
      ];
      firstPage = serialise(lines.slice(0, cut));
      files.push({ relPath: `${dir}/${rolloutName(nextAt, id, "_2")}`, text: serialise(page2) });
    }
    files.push({ relPath: `${dir}/${name}`, text: firstPage });
    if (flags.has("archivedCopy") && s % 3 === 0) {
      // The same rollout in both roots, as when a copy is caught mid-archive.
      files.push({ relPath: `archived_sessions/${name}`, text: firstPage });
    }
    truthSessions.push(thread.truth);

    if (flags.has("forkedSubagent") && s % 2 === 0) {
      // A fork writes the parent's history into its own rollout in one burst,
      // with the parent's own timestamps and running token total, then works.
      const forkId = idOf();
      const forkStart = thread.t + 3600_000;
      const fork = new CodexThread({ rng, id: forkId, startMs: forkStart, cwd, cachedInput, tokenMode, forkedFrom: id });
      fork.cum = { ...thread.cum };
      fork.t = forkStart + 5000;
      fork.meta();
      fork.lines.push(...thread.lines.map((line) => JSON.parse(JSON.stringify(line))));
      fork.t = forkStart + 10_000;
      fork.prompt("lorem fork");
      fork.turn({ calls: rng.range(1, 2) });
      files.push({ relPath: `${dateDir(forkStart)}/${rolloutName(forkStart, forkId)}`, text: serialise(fork.lines) });
      truthSessions.push(fork.truth);
    }
  }
  return { files, truth: { sessions: truthSessions } };
}

/**
 * @param {{ seed: number, sessions: number, store: "claude_code"|"codex", shape?: Iterable<string>|Record<string, boolean> }} options
 */
export function generateCorpus({ seed, sessions, store, shape }) {
  if (!STORES.includes(store)) throw new Error(`unknown store: ${store}`);
  const flags = toFlagSet(shape);
  for (const flag of flags) {
    if (!SHAPE_FLAGS[store].includes(flag)) flags.delete(flag);
  }
  const out = store === "claude_code" ? generateClaude({ seed, sessions, flags }) : generateCodex({ seed, sessions, flags });
  out.files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}
