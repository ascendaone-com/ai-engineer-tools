// Writes a generated corpus under a temp snapshot, runs the shipped extractor
// over it, and compares what it reports with the corpus's own truth.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractClaudeCode } from "../../dist/extractors/claudeCode.js";
import { extractCodex } from "../../dist/extractors/codex.js";
import { TRUTH_KEYS, CLAUDE_ONLY_TRUTH_KEYS } from "./corpus.mjs";

export async function writeCorpus(files, root) {
  for (const file of files) {
    const target = path.join(root, file.relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.text);
  }
}

export async function extractCorpus(store, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-"));
  try {
    await writeCorpus(files, root);
    const events = [];
    const run = store === "claude_code" ? extractClaudeCode : extractCodex;
    for await (const event of run(root, "corpus-run")) events.push(event);
    return events;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function truthKeysOf(store) {
  return store === "claude_code" ? [...TRUTH_KEYS, ...CLAUDE_ONLY_TRUTH_KEYS] : TRUTH_KEYS;
}

/** What the extractor shipped for each session, on the truth's keys. A key the
 * extractor leaves off (it ships some only when non-zero) reads as 0. */
export function shippedFigures(store, events) {
  const keys = truthKeysOf(store);
  return events
    .filter((e) => e.eventKind === "create_focus_session")
    .map((e) => {
      const out = { sessionRef: e.sessionRef };
      for (const key of keys) out[key] = e.metrics[key] ?? 0;
      return out;
    })
    .sort((a, b) => a.sessionRef.localeCompare(b.sessionRef));
}

export function sortedTruth(truth) {
  return [...truth.sessions].sort((a, b) => a.sessionRef.localeCompare(b.sessionRef));
}
