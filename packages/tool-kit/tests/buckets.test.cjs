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

/**
 * The duration-bucket vocabulary, pinned against its reader.
 *
 * `bucketDurationMs` is the only producer of `durationBucket` on the wire —
 * every hook adapter and every history-import extractor routes through it. The
 * backend reads that field in `DurationBuckets.ToMinutes`
 * (asc-core-be `Services/DurationBuckets.cs`), and for a long time read a
 * vocabulary this function has never produced: `"0-15" | "15-30" | "30-60" |
 * "60+"`. Zero overlap, so bucket-derived session minutes were 0 for every
 * user and the metric reported "no evidence" rather than a wrong number.
 *
 * Nothing raised. An unrecognised bucket and an absent one are the same 0 on
 * the reading side, and nothing on this side ever learns what the reader
 * understood — so a runtime guard here is the only thing that can catch the
 * drift from the emitting end.
 *
 * READER_VOCABULARY mirrors the C# switch. asc-core-be pins the same set from
 * its side in `AscendaCore.Tests/DurationBucketVocabularyTests.cs`. Changing
 * the union means changing both; either one alone goes red.
 */
const READER_VOCABULARY = new Set(["0-1m", "1-5m", "5-10m", "10-30m", "30-60m", "60m+"]);

test("bucketDurationMs emits nothing the backend cannot read", () => {
  const min = 60000;
  const probes = [0, 1, 999, 30 * 1000, min, min + 1, 3 * min, 5 * min, 5 * min + 1, 10 * min,
    10 * min + 1, 30 * min, 30 * min + 1, 45 * min, 60 * min, 60 * min + 1, 8 * 60 * min,
    24 * 60 * min, 365 * 24 * 60 * min];

  const emitted = new Set();
  for (const ms of probes) {
    const bucket = bucketDurationMs(ms);
    if (bucket === undefined) continue;
    emitted.add(bucket);
    assert.ok(
      READER_VOCABULARY.has(bucket),
      `bucketDurationMs(${ms}) returned "${bucket}", which the backend reader does not understand — ` +
        `it would resolve to 0 minutes and read as "not collected"`
    );
  }

  // The other direction: every bucket the reader knows must be reachable, or
  // the reader is carrying an arm for a value nothing can produce.
  assert.deepEqual(
    [...READER_VOCABULARY].filter((b) => !emitted.has(b)),
    [],
    "the reader understands buckets this function can never emit"
  );
});
