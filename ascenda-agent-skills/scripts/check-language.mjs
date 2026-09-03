#!/usr/bin/env node
// The language guard for everything this package ships to an agent.
//
// `copy/banned-vocabulary.txt` has been the canonical list for a while, and
// the skill told the model to check its own reasoning against it — but
// nothing checked the *shipped copy*. A skill file is instruction text a
// model reads and paraphrases back at a person, so a banned phrase sitting in
// one is closer to the product saying it than any string in the codebase.
// This closes that: the list now governs the files that carry it.
//
// **What is banned is assertion, not the word existing.** The vocabulary
// file's own header says so, and this package's rule content legitimately
// quotes the phrases it forbids ("report the pattern, not a diagnosis").
// Rather than guess at negation, every allowed occurrence is written down in
// `copy/language-guard-exceptions.txt` with the reason it is not an
// assertion — one reviewable line each. An exception that no longer matches
// anything fails too, so the list cannot quietly rot into a blanket permit.
//
// Run directly, or through `npm test` in this package.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** Directories whose Markdown this guard governs. Everything an agent host
 * loads, plus the README, which is the public face of the same claims. */
const SCANNED_DIRS = ["skills", "cursor", "docs"];
const SCANNED_FILES = ["README.md"];
const SCANNED_EXTENSIONS = [".md", ".mdc"];

function entriesOf(relPath) {
  return fs
    .readFileSync(path.join(root, relPath), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

export function scannedFiles() {
  const out = [];
  for (const dir of SCANNED_DIRS) out.push(...walk(path.join(root, dir)));
  for (const file of SCANNED_FILES) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) out.push(full);
  }
  return out.map((full) => path.relative(root, full)).sort();
}

/** `<file> | <phrase> | <why it is not an assertion>` */
export function exceptions() {
  const relPath = "copy/language-guard-exceptions.txt";
  if (!fs.existsSync(path.join(root, relPath))) return [];
  return entriesOf(relPath).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 3 || parts.some((part) => part.length === 0)) {
      throw new Error(
        `${relPath} line ${index + 1} is not "<file> | <phrase> | <reason>": ${line}`
      );
    }
    return { file: parts[0], phrase: parts[1].toLowerCase(), reason: parts.slice(2).join(" | ") };
  });
}

export function bannedTerms() {
  return entriesOf("copy/banned-vocabulary.txt").map((t) => t.toLowerCase());
}

/** Banned phrases in one piece of text, with their line numbers. Pure, so
 * the matching rule can be tested without writing files into the package. */
export function scanText(text, terms = bannedTerms()) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    const haystack = line.toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term)) found.push({ phrase: term, line: index + 1, text: line.trim() });
    }
  });
  return found;
}

/** Every banned phrase occurring in a scanned file, with its line. */
export function occurrences() {
  const terms = bannedTerms();
  const found = [];
  for (const file of scannedFiles()) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const hit of scanText(text, terms)) found.push({ file, ...hit });
  }
  return found;
}

export function check() {
  const allowed = exceptions();
  const found = occurrences();

  const isAllowed = (hit) =>
    allowed.some((a) => a.file === hit.file && a.phrase === hit.phrase);

  const violations = found.filter((hit) => !isAllowed(hit));
  const unused = allowed.filter(
    (a) => !found.some((hit) => hit.file === a.file && hit.phrase === a.phrase)
  );
  return { violations, unused, scanned: scannedFiles().length };
}

function main() {
  const { violations, unused, scanned } = check();

  for (const hit of violations) {
    console.error(`${hit.file}:${hit.line}  banned phrase "${hit.phrase}"`);
    console.error(`    ${hit.text}`);
  }
  for (const stale of unused) {
    console.error(
      `copy/language-guard-exceptions.txt  "${stale.phrase}" no longer appears in ${stale.file} — delete the exception`
    );
  }

  if (violations.length > 0 || unused.length > 0) {
    console.error(
      `\nlanguage guard: ${violations.length} banned phrase(s), ${unused.length} stale exception(s) across ${scanned} files.\n` +
        "Rephrase around an observable fact, or — if the phrase is being quoted in order to forbid it — add a line to copy/language-guard-exceptions.txt saying so."
    );
    process.exit(1);
  }

  console.log(`language guard: ${scanned} files clean`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
