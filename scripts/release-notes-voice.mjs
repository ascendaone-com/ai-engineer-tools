// House style checks on a CHANGELOG section, run before a release builds.
//
// A section that goes out unedited drifts towards one shape: every point
// framed as a contrast ("rather than", "no longer"), an em dash carrying
// every second clause, the same three words opening bullet after bullet, and
// not one short sentence anywhere. Each habit is fine alone. Together they
// make a release note nobody finishes reading, which is the one thing a
// release note cannot afford.
//
// These are density rules, not word bans. One "rather than" is how anyone
// writes; six in four hundred words is a tic. So each rule allows a budget
// proportional to the section's length and reports only what exceeds it. A
// rule nobody can satisfy is a rule everybody routes around.
//
// The rules, in short: lead with what the thing does now, name it rather than
// describe it, use contractions, let one sentence be short, and vary the way
// into each bullet.
//
//   node scripts/release-notes-voice.mjs --tag v1.2.3

import { fileURLToPath } from "node:url";
import { releaseNotes } from "./release-notes.mjs";

/** Prose only: fenced code, inline code and link targets are not writing. */
function prose(body) {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ");
}

const countOf = (text, re) => (text.match(re) ?? []).length;

/** A budget scaled to length, but never below `min` — short sections get one. */
const budget = (words, per, min = 1) => Math.max(min, Math.floor(words / per));

const CONTRAST = /\b(?:rather than|instead of|no longer|not merely|not simply|not just)\b/gi;
// Tier 1A of the humanizer catalogue plus the ones this repo actually reaches
// for. Bans, not budgets: none of these has a use here a plainer word lacks.
const VOCAB = /\b(?:delve[sd]?|delving|tapestry|multifaceted|realm|interplay|underscore[sd]?|leverage[sd]?|seamless(?:ly)?|robust|pivotal|crucial|foster(?:s|ed|ing)?|garner(?:s|ed|ing)?|bolster(?:s|ed|ing)?|utilise[sd]?|utilize[sd]?)\b/gi;

function bullets(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) out.push(m[1]);
    else if (out.length && line.trim() && !/^\s*#/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/** The first three words of a bullet, stripped of bold and punctuation. */
function opener(bullet) {
  return bullet
    .replace(/\*+/g, "")
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * Every voice finding in a changelog section, worst first. `level` is "error"
 * (the release stops) or "warn" (printed, builds anyway) — the split is by how
 * mechanical the rule is, not by how badly the prose reads.
 */
export function voiceFindings(body) {
  const text = prose(body);
  const words = text.split(/\s+/).filter(Boolean).length;
  const found = [];

  const contrast = countOf(text, CONTRAST);
  const contrastMax = budget(words, 200);
  if (contrast > contrastMax) {
    found.push({
      level: "error",
      rule: "contrast-frames",
      message: `${contrast} of "rather than"/"instead of"/"no longer" in ${words} words (at most ${contrastMax} here). Say what it does now; the thing it replaced is worth naming once, not once per point.`,
    });
  }

  const dashes = countOf(text, /—/g);
  const dashMax = budget(words, 200, 2);
  if (dashes > dashMax) {
    found.push({
      level: "error",
      rule: "em-dashes",
      message: `${dashes} em dashes in ${words} words (at most ${dashMax} here). A comma, a colon or a full stop carries most of them.`,
    });
  }

  const openers = new Map();
  for (const bullet of bullets(text)) {
    const key = opener(bullet);
    if (key) openers.set(key, (openers.get(key) ?? 0) + 1);
  }
  for (const [key, n] of openers) {
    if (n >= 3) {
      found.push({
        level: "error",
        rule: "repeated-opener",
        message: `${n} bullets open "${key}…". Vary the way in, or the list reads as a template someone filled.`,
      });
    }
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[*_#>-]/g, " ").trim())
    .filter(Boolean);
  if (sentences.length >= 4 && !sentences.some((s) => s.split(/\s+/).length <= 9)) {
    found.push({
      level: "error",
      rule: "no-short-sentence",
      message: `Every sentence runs 10 words or longer. One short one lets the reader breathe and stops the section reading as generated.`,
    });
  }

  const vocab = [...new Set((text.match(VOCAB) ?? []).map((w) => w.toLowerCase()))];
  if (vocab.length) {
    found.push({
      level: "warn",
      rule: "ai-vocabulary",
      message: `${vocab.join(", ")} — plainer words exist and read as ours.`,
    });
  }

  const stiff = countOf(text, /\b(?:does not|do not|is not|are not|it is|that is|cannot)\b/gi);
  const stiffMax = budget(words, 120);
  if (stiff > stiffMax) {
    found.push({
      level: "warn",
      rule: "no-contractions",
      message: `${stiff} spelled-out negations and copulas in ${words} words (about ${stiffMax} reads naturally). "doesn't", "isn't" and "can't" are how the CLIs' own output talks.`,
    });
  }

  const longest = bullets(text)
    .map((b) => ({ b, n: b.split(/\s+/).length }))
    .filter(({ n }) => n > 90);
  for (const { b, n } of longest) {
    found.push({
      level: "warn",
      rule: "long-bullet",
      message: `${n}-word bullet: "${b.replace(/\*+/g, "").slice(0, 60)}…". Split it, or cut to the part a user acts on.`,
    });
  }

  return found.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

/** Findings printed for a human, and whether any of them stops a release. */
export function reportFindings(findings, { tag, log = console.error } = {}) {
  for (const f of findings) log(`${f.level === "error" ? "ERROR" : "warn "}  [${f.rule}] ${f.message}`);
  const errors = findings.filter((f) => f.level === "error").length;
  if (errors) log(`\n${errors} voice ${errors === 1 ? "rule" : "rules"} failed for ${tag}. See the rules at the top of scripts/release-notes-voice.mjs.`);
  return errors === 0;
}

function main(argv) {
  const tag = argv[argv.indexOf("--tag") + 1];
  if (!argv.includes("--tag") || !tag) {
    console.error("usage: release-notes-voice.mjs --tag <v1.2.3>");
    process.exit(2);
  }
  const findings = voiceFindings(releaseNotes({ tag }));
  if (!findings.length) console.error(`${tag}: release notes read clean.`);
  if (!reportFindings(findings, { tag })) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
