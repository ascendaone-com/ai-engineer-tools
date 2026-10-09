#!/usr/bin/env node
// Renders the terminal screenshots in docs/images from the real CLI, so they
// can't drift from what `setup` and `doctor` actually print.
//
//   npm run build -w @ascenda-one/claude-code-hooks
//   node scripts/render-cli-shots.mjs            # writes docs/images/cli-*.png
//   node scripts/render-cli-shots.mjs --html     # also keeps the .html beside each
//
// Each shot runs the built CLI against a throwaway home folder, with colour
// forced on, no live listener and no screen saver container, so nothing on
// this machine (a real pairing, a running app, a saver) reaches the picture.
// Paths under your own home are written as `~` before rendering: the repo is
// public, and a screenshot is the easiest place for a username to leak.
//
// The output is drawn as HTML in a terminal frame and captured with headless
// Chrome (set CHROME to use another binary). macOS only, because the hooks'
// launcher is.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "images");
const CLI = path.join(ROOT, "ascenda-claude-code-hooks", "dist", "cli.js");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KEEP_HTML = process.argv.includes("--html");

/** Columns the text is wrapped to. At 2x this keeps an image near 1400px wide. */
const COLS = 84;
const CHAR_PX = 7.83; // Menlo 13px advance
const LINE_PX = 19;
const ANSI = /\u001b\[(\d+)m/g;
const visible = (line) => line.replace(ANSI, "");

if (!fs.existsSync(CLI)) fail(`build the hooks first: npm run build -w @ascenda-one/claude-code-hooks (${CLI} is missing)`);
if (!fs.existsSync(CHROME)) fail(`no Chrome at ${CHROME}; set CHROME to a Chromium binary`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-shots-"));
const project = path.join(home, "my-project");
fs.mkdirSync(project, { recursive: true });
const launcher = path.join(home, ".ascenda", "bin", "ascenda-claude-hook");

// Built from nothing, so no ASCENDA_* setting of yours reaches the run.
const env = (extra = {}) => ({
  HOME: home,
  PATH: process.env.PATH,
  TERM: "xterm-256color",
  FORCE_COLOR: "1",
  ASCENDA_SAVER_CONTAINER: path.join(home, "saver"),
  ASCENDA_LIVE_BUS_SOCKET: path.join(os.tmpdir(), `ascenda-shots-${process.pid}-none.sock`),
  ...extra
});

function run(command, args, extra) {
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", env: env(extra) });
  if (result.error) fail(String(result.error));
  return result.stdout;
}

const shots = [];

shots.push({
  file: "cli-setup-no-pair",
  title: "npx @ascenda-one/claude-code-hooks setup --no-pair",
  text: trimDisclosure(run("node", [CLI, "setup", "--no-pair"]))
});

// What a Dock-launched agent sees: no shell profile, a bare PATH.
shots.push({
  file: "cli-doctor-ready",
  title: "~/.ascenda/bin/ascenda-claude-hook doctor",
  text: run(launcher, ["doctor"], { PATH: "/usr/bin:/bin" })
});

// A broken install, by taking the hooks out of the settings file.
fs.rmSync(path.join(home, ".claude", "settings.json"), { force: true });
shots.push({
  file: "cli-doctor-problem",
  title: "~/.ascenda/bin/ascenda-claude-hook doctor",
  text: run(launcher, ["doctor"], { PATH: "/usr/bin:/bin" })
});

for (const shot of shots) {
  const lines = wrap(scrub(shot.text).replace(/\n+$/, "").split("\n"));
  const html = page(shot.title, lines);
  const htmlFile = path.join(OUT, `${shot.file}.html`);
  fs.writeFileSync(htmlFile, html);
  const width = Math.ceil(COLS * CHAR_PX) + 2 * 14 + 2 * 12 + 2;
  const height = lines.length * LINE_PX + 2 * 12 + 32 + 2 * 12 + 2;
  const png = path.join(OUT, `${shot.file}.png`);
  const shot_ = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${htmlFile}`
  ], { encoding: "utf8" });
  if (shot_.status !== 0 || !fs.existsSync(png)) fail(`Chrome could not capture ${shot.file}: ${shot_.stderr}`);
  if (!KEEP_HTML) fs.rmSync(htmlFile);
  console.log(`wrote ${path.relative(ROOT, png)} (${lines.length} lines)`);
}

fs.rmSync(home, { recursive: true, force: true });

// ------------------------------------------------------------------ text ---

/** Your own home becomes `~`, as the CLI already does for the throwaway one. */
function scrub(text) {
  return text.split(os.homedir()).join("~").split(home).join("~");
}

/**
 * The pairing disclosure is long and is the same text the package READMEs
 * already print in full, so the picture keeps its first line and says so.
 */
function trimDisclosure(text) {
  const start = text.indexOf("What this sends from Claude Code, once paired:");
  if (start < 0) return text;
  const head = text.slice(0, start);
  return `${head}What this sends from Claude Code, once paired:\n    \u001b[2m… (the full list is in the package README)\u001b[22m\n`;
}

/**
 * Word-wraps to COLS, carrying colour across the break and indenting a
 * continuation under the value column of a `doctor` row, so the image's
 * height is known before Chrome draws it.
 */
function wrap(lines) {
  const out = [];
  for (const line of lines) {
    if (visible(line).length <= COLS) { out.push(line); continue; }
    const indent = /^\s{2}\S \S/.test(visible(line)) && visible(line).length > 25 ? 25 : (visible(line).match(/^\s*/)[0].length + 2);
    let rest = line;
    let first = true;
    while (visible(rest).length > (first ? COLS : COLS - indent)) {
      const limit = first ? COLS : COLS - indent;
      const cut = cutAt(rest, limit);
      out.push((first ? "" : " ".repeat(indent)) + rest.slice(0, cut.end).replace(/\s+$/, "") + cut.reset);
      rest = cut.open + rest.slice(cut.end).replace(/^\s+/, "");
      first = false;
    }
    out.push((first ? "" : " ".repeat(indent)) + rest);
  }
  return out;
}

/** The string index to break at, and the codes to close and reopen across it. */
function cutAt(line, limit) {
  let shown = 0;
  let lastSpace = -1;
  let open = [];
  let openAtSpace = [];
  const codeAt = /\u001b\[(\d+)m/y;
  for (let i = 0; i < line.length;) {
    codeAt.lastIndex = i;
    const code = codeAt.exec(line);
    if (code) {
      const n = code[1];
      if (n === "22" || n === "39" || n === "0") open = open.filter((c) => (n === "22" ? c !== "1" && c !== "2" : n === "39" ? !/^3\d$/.test(c) : false));
      else open.push(n);
      i += code[0].length;
      continue;
    }
    if (line[i] === " " && shown <= limit) { lastSpace = i; openAtSpace = [...open]; }
    shown += 1;
    if (shown > limit) break;
    i += 1;
  }
  const end = lastSpace > 0 ? lastSpace : line.length;
  const codes = lastSpace > 0 ? openAtSpace : open;
  return { end, reset: codes.length ? "\u001b[0m" : "", open: codes.map((c) => `\u001b[${c}m`).join("") };
}

// ------------------------------------------------------------------ html ---

function page(title, lines) {
  return `<!doctype html><meta charset=utf-8><style>
html,body{margin:0;background:#141417}
body{padding:12px}
.t{border:1px solid #34343a;border-radius:9px;overflow:hidden;background:#1b1b1f;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.bar{height:32px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#26262b;color:#9a9aa2;font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif}
.dot{width:11px;height:11px;border-radius:50%;background:#4a4a50}
.cmd{margin-left:8px;font:12px/1 Menlo,monospace;color:#b8b8c0}
pre{margin:0;padding:12px 14px;font:13px/${LINE_PX}px Menlo,monospace;color:#d8d8dc;white-space:pre}
.b{font-weight:700}.d{opacity:.55}.c31{color:#ff6b6b}.c32{color:#5fd068}.c33{color:#e8c547}.c36{color:#5cc8e8}
</style><div class="t"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="cmd">$ ${escape(title)}</span></div><pre>${lines.map(toHtml).join("\n")}</pre></div>`;
}

/** One line of ANSI to spans, from the state at each run of text rather than nesting. */
function toHtml(line) {
  let bold = false, dim = false, colour = "";
  let html = "";
  let last = 0;
  const flush = (text) => {
    if (!text) return;
    const classes = [bold && "b", dim && "d", colour && `c${colour}`].filter(Boolean).join(" ");
    html += classes ? `<span class="${classes}">${escape(text)}</span>` : escape(text);
  };
  for (const match of line.matchAll(new RegExp(ANSI.source, "g"))) {
    flush(line.slice(last, match.index));
    const n = match[1];
    if (n === "0") { bold = false; dim = false; colour = ""; }
    else if (n === "1") bold = true;
    else if (n === "2") dim = true;
    else if (n === "22") { bold = false; dim = false; }
    else if (n === "39") colour = "";
    else if (/^3\d$/.test(n)) colour = n;
    last = match.index + match[0].length;
  }
  flush(line.slice(last));
  return html;
}

function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fail(message) {
  console.error(`render-cli-shots: ${message}`);
  process.exit(1);
}
