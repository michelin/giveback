import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { percentile, gated, competitionRank } from "../src/utils/percentile.js";
import { PERCENTILE_MIN_SAMPLE } from "../src/utils/constants.js";

describe("a percentile", () => {
  test("is interpolated the way percentile_cont interpolates", () => {
    // The values PostgreSQL answers for the same lists: SELECT percentile_cont(p) WITHIN GROUP
    // (ORDER BY v). A median here and one measured in SQL are then the same statistic.
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([10, 1, 7], 0.5), 7, 'in any order');
    assert.ok(Math.abs(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) - 9.1) < 1e-9);
    assert.equal(percentile([5], 0.9), 5);
  });

  test("of nothing is nothing, and a missing value is not a zero", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([null, NaN], 0.5), null);
    assert.equal(percentile([null, 4, 8], 0.5), 6);
  });
});

describe("a percentile is shown only over the sample it needs", () => {
  const run = (n) => Array.from({ length: n }, (_, i) => i + 1);

  test("a median from its third value, not before", () => {
    assert.equal(gated(run(2), 'p50'), null);
    assert.equal(gated(run(3), 'p50'), 2);
  });

  test("a p90 from its tenth", () => {
    assert.equal(gated(run(9), 'p90'), null);
    assert.ok(Math.abs(gated(run(10), 'p90') - 9.1) < 1e-9);
  });

  test("counting only the values there are", () => {
    assert.equal(gated([1, 2, null], 'p50'), null, 'two values and a gap are two values');
  });

  test("and the thresholds are the ones the page is told", () => {
    assert.deepEqual({ ...PERCENTILE_MIN_SAMPLE }, { p50: 3, p90: 10, p99: 100 });
    assert.ok(Object.isFrozen(PERCENTILE_MIN_SAMPLE), 'shipped to every reader, so nothing may move it');
  });
});

describe("a rank", () => {
  const rows = [
    { who: 'ada', merged: 9 },
    { who: 'bob', merged: 4 },
    { who: 'cyd', merged: 4 },
    { who: 'dee', merged: 1 },
    { who: 'eve', merged: 0 },
  ];
  const merged = (row) => row.merged;

  test("shares a place on a tie, and skips the next one", () => {
    assert.deepEqual(competitionRank(rows, merged, 'ada'), { position: 1, of: 4 });
    assert.deepEqual(competitionRank(rows, merged, 'bob'), { position: 2, of: 4 });
    assert.deepEqual(competitionRank(rows, merged, 'cyd'), { position: 2, of: 4 });
    assert.deepEqual(competitionRank(rows, merged, 'dee'), { position: 4, of: 4 });
  });

  test("is nobody's before their first", () => {
    // Somebody on zero is not fifth of five: they are not in the race.
    assert.equal(competitionRank(rows, merged, 'eve'), null);
    assert.equal(competitionRank(rows, merged, 'nobody'), null);
  });

  test("whatever the case the login is asked in", () => {
    assert.deepEqual(competitionRank(rows, merged, 'ADA'), { position: 1, of: 4 });
  });
});
