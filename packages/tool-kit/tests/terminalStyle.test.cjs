const test = require("node:test");
const assert = require("node:assert/strict");
const { colourEnabled, terminalStyle } = require("../out/terminalStyle");

test("colour follows the terminal, NO_COLOR and FORCE_COLOR", () => {
  assert.equal(colourEnabled({ isTTY: true }, {}), true);
  assert.equal(colourEnabled({ isTTY: false }, {}), false, "piped output stays plain");
  assert.equal(colourEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colourEnabled({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" }), false, "NO_COLOR wins");
  assert.equal(colourEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colourEnabled({ isTTY: true }, { FORCE_COLOR: "0" }), false);
  assert.equal(colourEnabled({ isTTY: true }, { TERM: "dumb" }), false);
});

test("marks carry the meaning without colour", () => {
  const plain = terminalStyle(false);
  assert.deepEqual(["ok", "warn", "bad", "info"].map((tone) => plain.mark(tone)), ["✓", "!", "✗", "·"]);
  assert.equal(plain.bold("x"), "x");
  assert.equal(terminalStyle(true).green("x"), "\u001b[32mx\u001b[39m");
});
