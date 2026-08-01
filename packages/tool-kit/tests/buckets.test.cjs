const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bucketLinesChanged, bucketDurationMs } = require("../out/index.js");

test("bucketLinesChanged boundaries", () => {
  assert.equal(bucketLinesChanged(0), "0");
  assert.equal(bucketLinesChanged(-3), "0");
  assert.equal(bucketLinesChanged(1), "1-10");
  assert.equal(bucketLinesChanged(10), "1-10");
  assert.equal(bucketLinesChanged(11), "10-50");
  assert.equal(bucketLinesChanged(50), "10-50");
  assert.equal(bucketLinesChanged(51), "50-200");
  assert.equal(bucketLinesChanged(200), "50-200");
  assert.equal(bucketLinesChanged(201), "200+");
});

test("bucketDurationMs boundaries", () => {
  const min = 60000;
  assert.equal(bucketDurationMs(30 * 1000), "0-1m");
  assert.equal(bucketDurationMs(1 * min), "0-1m");
  assert.equal(bucketDurationMs(1 * min + 1), "1-5m");
  assert.equal(bucketDurationMs(5 * min), "1-5m");
  assert.equal(bucketDurationMs(10 * min), "5-10m");
  assert.equal(bucketDurationMs(30 * min), "10-30m");
  assert.equal(bucketDurationMs(60 * min), "30-60m");
  assert.equal(bucketDurationMs(60 * min + 1), "60m+");
});

test("bucketDurationMs rejects non-durations", () => {
  assert.equal(bucketDurationMs(undefined), undefined);
  assert.equal(bucketDurationMs(-1), undefined);
  assert.equal(bucketDurationMs(NaN), undefined);
  assert.equal(bucketDurationMs(Infinity), undefined);
});
