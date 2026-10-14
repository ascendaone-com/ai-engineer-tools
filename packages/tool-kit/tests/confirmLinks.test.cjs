const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pairingConfirmLines, pairingConfirmUrl, studyJoinConfirmUrl } = require("../out/index.js");

const WEB_QR = "https://api.example.test/p/9b2f0c1e-0000-4000-8000-000000000001#s3cr3t-value";
const LEGACY_QR = "ascenda://pair?session=9b2f0c1e-0000-4000-8000-000000000001&secret=s3cr3t-value";

test("an https qrUrl leads with the link and keeps the app as the second route", () => {
  assert.deepEqual(pairingConfirmLines(WEB_QR, "123456"), [
    `Open this link to confirm: ${WEB_QR}`,
    "Or paste code 123456 in the Ascenda app."
  ]);
});

test("a legacy ascenda:// qrUrl keeps the app wording and never prints the secret", () => {
  const lines = pairingConfirmLines(LEGACY_QR, "123456");
  assert.deepEqual(lines, ["Confirm in the Ascenda app — code 123456"]);
  assert.ok(!lines.join("\n").includes("s3cr3t"));
  assert.equal(pairingConfirmUrl(LEGACY_QR), undefined);
});

test("a missing, empty, plain-http or malformed qrUrl falls back to the app", () => {
  for (const qrUrl of [undefined, null, "", "http://localhost:8787/p/x#y", "not a url"]) {
    assert.deepEqual(pairingConfirmLines(qrUrl, "123456"), ["Confirm in the Ascenda app — code 123456"], String(qrUrl));
  }
});

test("the join link is composed from the configured base, with or without a trailing slash", () => {
  assert.equal(studyJoinConfirmUrl("https://api.example.test", "654321"), "https://api.example.test/join/654321");
  assert.equal(studyJoinConfirmUrl("https://api.example.test/", "654321"), "https://api.example.test/join/654321");
  assert.equal(studyJoinConfirmUrl("https://api.example.test//", "654321"), "https://api.example.test/join/654321");
});

test("no join link for a base that serves no web pages", () => {
  assert.equal(studyJoinConfirmUrl("http://localhost:8787", "654321"), undefined);
  assert.equal(studyJoinConfirmUrl("", "654321"), undefined);
});
