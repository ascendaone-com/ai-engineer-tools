#!/usr/bin/env node
// Measures the figures the importer's design comments quote, on this
// machine's own stores. Read-only, and it prints counts: no transcript text,
// no path, no id, no file name.
//
//   npm run build            # the paths come from dist/stores.js
//   node scripts/measure-store.mjs [--home <dir>]
//
// Not run in CI: it reads a real home directory. A comment that quotes one of
// these figures names this script and the month it was measured, so the
// figure can be refreshed by running it again.
//
// The five measurements:
//
//   1. repeatedUuids        lines whose uuid an earlier line of the same
//                           top-level transcript already carried
//   2. contestedIds         uuids that two transcripts each claim as written
//                           in them (sessionId equal to the file's own name)
//   3. linesPerMessage      assistant lines against distinct API messages
//   4. rolloutsInBothRoots  Codex rollouts under sessions/ and archived_sessions/
//   5. forkSidecars         subagent sidecars that set isFork
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { resolveStorePaths } from "../dist/stores.js";

async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walk(dir, keep) {
  const out = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, keep)));
    else if (entry.isFile() && keep(entry.name)) out.push(full);
  }
  return out;
}

async function eachRecord(file, onRecord) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record === "object" && record !== null && !Array.isArray(record)) onRecord(record);
    }
  } catch {
    // Unreadable since it was listed: it contributes nothing.
  }
}

function messageKey(record) {
  const id = record.message?.id;
  if (typeof id !== "string" || id === "") return null;
  return typeof record.requestId === "string" && record.requestId !== "" ? `${id}|${record.requestId}` : id;
}

/** Measurements 1 to 3 and 5, over every Claude Code projects dir given. */
export async function measureClaude(projectsDirs) {
  let mainTranscripts = 0;
  let transcriptsWithRepeats = 0;
  let repeatedUuids = 0;
  const homeClaims = new Map(); // uuid -> first transcript index, then -1 once contested
  const contestedFiles = new Set();
  const claimingFiles = [];
  let homeClaimedLines = 0;
  let assistantLines = 0;
  let messages = 0;
  let sidecars = 0;
  let forkSidecars = 0;
  let transcripts = 0;

  for (const projectsDir of projectsDirs) {
    for (const slug of (await listDir(projectsDir)).filter((e) => e.isDirectory())) {
      const dir = path.join(projectsDir, slug.name);
      const entries = await listDir(dir);
      const topLevel = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name)).sort();
      const nested = [];
      for (const entry of entries.filter((e) => e.isDirectory())) nested.push(...(await walk(path.join(dir, entry.name), () => true)));

      for (const file of topLevel) {
        mainTranscripts += 1;
        transcripts += 1;
        const fileId = path.basename(file, ".jsonl");
        const index = claimingFiles.length;
        claimingFiles.push(file);
        const seen = new Set();
        const keys = new Set();
        let repeats = 0;
        await eachRecord(file, (record) => {
          if (typeof record.uuid === "string") {
            if (seen.has(record.uuid)) repeats += 1;
            else seen.add(record.uuid);
            if (record.sessionId === fileId) {
              homeClaimedLines += 1;
              const first = homeClaims.get(record.uuid);
              if (first === undefined) homeClaims.set(record.uuid, index);
              else if (first !== index) {
                homeClaims.set(record.uuid, -1);
              }
            }
          }
          if (record.type === "assistant") {
            assistantLines += 1;
            const key = messageKey(record);
            if (key === null) messages += 1;
            else keys.add(key);
          }
        });
        messages += keys.size;
        repeatedUuids += repeats;
        if (repeats > 0) transcriptsWithRepeats += 1;
      }

      for (const file of nested) {
        if (file.endsWith(".meta.json")) {
          sidecars += 1;
          try {
            if (JSON.parse(await fsp.readFile(file, "utf8")).isFork === true) forkSidecars += 1;
          } catch {
            // An unreadable sidecar is not a fork we can name.
          }
        } else if (file.endsWith(".jsonl")) {
          transcripts += 1;
          const keys = new Set();
          await eachRecord(file, (record) => {
            if (record.type !== "assistant") return;
            assistantLines += 1;
            const key = messageKey(record);
            if (key === null) messages += 1;
            else keys.add(key);
          });
          messages += keys.size;
        }
      }
    }
  }

  let contestedIds = 0;
  for (const value of homeClaims.values()) if (value === -1) contestedIds += 1;
  // Second pass over the files holding a contested id, to count how many
  // claims and transcripts they account for. Only the ids are kept.
  const contested = new Set([...homeClaims].filter(([, v]) => v === -1).map(([id]) => id));
  let contestedInstances = 0;
  if (contested.size > 0) {
    for (const file of claimingFiles) {
      const fileId = path.basename(file, ".jsonl");
      let holds = 0;
      await eachRecord(file, (record) => {
        if (typeof record.uuid === "string" && record.sessionId === fileId && contested.has(record.uuid)) holds += 1;
      });
      if (holds > 0) {
        contestedInstances += holds;
        contestedFiles.add(file);
      }
    }
  }

  return {
    transcripts,
    mainTranscripts,
    repeatedUuids: { repeatedLines: repeatedUuids, transcriptsAffected: transcriptsWithRepeats },
    contestedIds: {
      contestedIds,
      claimInstances: contestedInstances,
      transcriptsHoldingOne: contestedFiles.size,
      homeClaimedLines
    },
    linesPerMessage: {
      assistantLines,
      messages,
      ratio: messages === 0 ? 0 : Math.round((assistantLines / messages) * 100) / 100
    },
    forkSidecars: { sidecars, isFork: forkSidecars }
  };
}

/** Measurement 4: rollouts whose file name sits in both Codex roots. */
export async function measureCodex(sessionsDir, archivedDir) {
  const base = (name) => name.replace(/\.jsonl(\.zst)?$/, "");
  const keep = (name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zst");
  const live = new Set((await walk(sessionsDir, keep)).map((f) => base(path.basename(f))));
  const archived = new Set((await walk(archivedDir, keep)).map((f) => base(path.basename(f))));
  let both = 0;
  for (const name of archived) if (live.has(name)) both += 1;
  return { sessions: live.size, archived: archived.size, inBothRoots: both };
}

export async function measureStore(paths) {
  const claude = await measureClaude(paths.claudeProjectsDirs);
  const codex = await measureCodex(paths.codexSessions, paths.codexArchivedSessions);
  return { claude, codex };
}

export function formatMeasurements({ claude, codex }, measuredOn) {
  const r = claude.repeatedUuids;
  const c = claude.contestedIds;
  const m = claude.linesPerMessage;
  return [
    `measured ${measuredOn}, counts only`,
    `claude transcripts: ${claude.transcripts} (${claude.mainTranscripts} top-level)`,
    `1 repeatedUuids: ${r.repeatedLines} repeated lines in ${r.transcriptsAffected} of ${claude.mainTranscripts} top-level transcripts`,
    `2 contestedIds: ${c.contestedIds} ids claimed by two or more transcripts, ${c.claimInstances} claims across ${c.transcriptsHoldingOne} transcripts, of ${c.homeClaimedLines} home-claimed lines`,
    `3 linesPerMessage: ${m.assistantLines} assistant lines, ${m.messages} messages, ${m.ratio} lines per message`,
    `4 rolloutsInBothRoots: ${codex.inBothRoots} of ${codex.sessions} sessions rollouts and ${codex.archived} archived rollouts`,
    `5 forkSidecars: ${claude.forkSidecars.isFork} of ${claude.forkSidecars.sidecars} subagent sidecars set isFork`
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--home");
  const paths = at > 0 ? resolveStorePaths(process.argv[at + 1], {}) : resolveStorePaths();
  const result = await measureStore(paths);
  process.stdout.write(`${formatMeasurements(result, new Date().toISOString().slice(0, 10))}\n`);
}
