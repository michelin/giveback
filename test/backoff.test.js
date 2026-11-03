import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  nextIntervalMinutes, errorBackoffMinutes, dispersedDelaySeconds, intervalLadder, tierOf, backoffBand,
} from "../src/utils/backoff.js";

const BOUNDS = { min: 15, max: 24 * 60 };

describe("nextIntervalMinutes", () => {
  test("drops back to the floor as soon as something changed", () => {
    assert.equal(nextIntervalMinutes(960, true, BOUNDS), 15);
    assert.equal(nextIntervalMinutes(15, true, BOUNDS), 15);
  });

  test("doubles while nothing changes", () => {
    assert.equal(nextIntervalMinutes(15, false, BOUNDS), 30);
    assert.equal(nextIntervalMinutes(30, false, BOUNDS), 60);
    assert.equal(nextIntervalMinutes(60, false, BOUNDS), 120);
  });

  test("never exceeds the ceiling", () => {
    assert.equal(nextIntervalMinutes(720, false, BOUNDS), 1440);
    assert.equal(nextIntervalMinutes(1440, false, BOUNDS), 1440);
    assert.equal(nextIntervalMinutes(999999, false, BOUNDS), 1440);
  });

  test("reaches the ceiling in a bounded number of quiet runs", () => {
    let interval = BOUNDS.min;
    let steps = 0;

    while (interval < BOUNDS.max && steps < 100) {
      interval = nextIntervalMinutes(interval, false, BOUNDS);
      steps++;
    }

    assert.equal(interval, BOUNDS.max);
    assert.ok(steps <= 7, `expected the ceiling within 7 quiet runs, took ${steps}`);
  });

  test("treats a missing or absurd current interval as the floor", () => {
    for (const bad of [null, undefined, 0, -5, Number.NaN]) {
      assert.equal(nextIntervalMinutes(bad, false, BOUNDS), 30);
      assert.equal(nextIntervalMinutes(bad, true, BOUNDS), 15);
    }
  });

  test("the ceiling stays far below GitHub's 90-day events window", async () => {
    // The events feed is the only hard correctness deadline: an event polled later than
    // ~90 days after it happened is simply gone.
    //
    // Against the SHIPPED bounds, not BOUNDS above: that one is a fixture for exercising the
    // ladder, and asserting `BOUNDS.max * 30 < ninetyDaysInMinutes` was arithmetic on two
    // literals declared in this file - true for ever, whatever src/ contained.
    const { SCHEDULING } = await import("../src/utils/constants.js");
    const shipped = { min: SCHEDULING.SYNC_MIN_INTERVAL_MINUTES, max: SCHEDULING.SYNC_MAX_INTERVAL_MINUTES };
    const ninetyDaysInMinutes = 90 * 24 * 60;

    // Where a quiet subject actually ends up, rather than where the setting says it should:
    // a ladder that stopped clamping would climb past the ceiling this test is about.
    let settled = shipped.min;

    for (let quiet = 0; quiet < 100; quiet++) {
      settled = nextIntervalMinutes(settled, false, shipped);
    }

    assert.equal(settled, shipped.max, 'a quiet subject must settle on the configured ceiling');
    assert.ok(settled * 100 < ninetyDaysInMinutes,
      `a ceiling of ${settled} minutes leaves too little slack against the 90-day window`);
  });
});

describe("errorBackoffMinutes", () => {
  test("grows exponentially with consecutive failures", () => {
    const bounds = { min: 15, max: 360 };

    assert.equal(errorBackoffMinutes(1, bounds), 30);
    assert.equal(errorBackoffMinutes(2, bounds), 60);
    assert.equal(errorBackoffMinutes(3, bounds), 120);
    assert.equal(errorBackoffMinutes(4, bounds), 240);
  });

  test("clamps to the ceiling instead of overflowing", () => {
    const bounds = { min: 15, max: 360 };

    assert.equal(errorBackoffMinutes(10, bounds), 360);
    assert.equal(errorBackoffMinutes(1000, bounds), 360);
    assert.ok(Number.isFinite(errorBackoffMinutes(100000, bounds)));
  });

  test("treats a missing count as the first failure", () => {
    const bounds = { min: 15, max: 360 };

    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      assert.equal(errorBackoffMinutes(bad, bounds), 30);
    }
  });
});

describe("the ladder the queue is drawn on", () => {
  test("is every interval nextIntervalMinutes() can settle on, floor first", () => {
    const bounds = { min: 15, max: 240 };
    const reached = new Set([bounds.min]);

    // Walked rather than trusted: every interval a quiet subject climbs through, from the floor.
    for (let interval = bounds.min; interval < bounds.max;) {
      interval = nextIntervalMinutes(interval, false, bounds);
      reached.add(interval);
    }

    assert.deepEqual(intervalLadder(bounds), [...reached]);
    assert.deepEqual(intervalLadder(bounds), [15, 30, 60, 120, 240]);
  });

  test("ends on the ceiling whether or not a doubling lands on it", () => {
    assert.deepEqual(intervalLadder({ min: 15, max: 100 }), [15, 30, 60, 100]);
    assert.equal(nextIntervalMinutes(60, false, { min: 15, max: 100 }), 100);
  });

  test("is a single rung when the floor is at or above the ceiling", () => {
    // validateEnv does not tie the bounds together, so a floor above the ceiling is a state the
    // page has to draw rather than loop on.
    assert.deepEqual(intervalLadder({ min: 30, max: 30 }), [30]);
    assert.deepEqual(intervalLadder({ min: 60, max: 20 }), [60]);
  });

  test("places a value on the rung under it, and one below the floor on the floor", () => {
    const ladder = [15, 30, 60, 120, 240];

    assert.equal(tierOf(60, ladder), 60);
    assert.equal(tierOf(90, ladder), 60, 'written under other bounds: the rung under it');
    assert.equal(tierOf(900, ladder), 240);
    assert.equal(tierOf(5, ladder), 15);
    // Never scheduled yet: the next run uses the floor.
    assert.equal(tierOf(null, ladder), 15);
    // A floor above the ceiling: quiet runs settle below the one rung, and are drawn on it.
    assert.equal(tierOf(nextIntervalMinutes(60, false, { min: 60, max: 20 }), intervalLadder({ min: 60, max: 20 })), 60);
  });
});

describe("the backoff band", () => {
  test("is drawn when the error backoff outwaits the ceiling, as it does with the shipped values", async () => {
    const { SCHEDULING } = await import("../src/utils/constants.js");
    const bounds = { min: SCHEDULING.SYNC_MIN_INTERVAL_MINUTES, max: SCHEDULING.SYNC_MAX_INTERVAL_MINUTES };

    assert.equal(backoffBand({ ...bounds, backoffMax: SCHEDULING.MAX_ERROR_BACKOFF_MINUTES }), 360);
    // From the fifth failure in a row, and not before: the first four land on rungs.
    assert.deepEqual([1, 2, 3, 4, 5].map((failures) => errorBackoffMinutes(failures, { min: bounds.min, max: 360 })),
      [30, 60, 120, 240, 360]);
  });

  test("and absent when the backoff cannot pass the ceiling", () => {
    assert.equal(backoffBand({ min: 15, max: 240, backoffMax: 240 }), null);
    assert.equal(backoffBand({ min: 15, max: 240, backoffMax: 120 }), null);
  });
});

describe("shipped scheduling defaults", () => {
  test("the ceiling is the freshness guarantee, and it is 4 hours", async () => {
    const { SCHEDULING } = await import("../src/utils/constants.js");

    assert.equal(SCHEDULING.SYNC_MIN_INTERVAL_MINUTES, 15);
    assert.equal(SCHEDULING.SYNC_MAX_INTERVAL_MINUTES, 240);
    assert.equal(SCHEDULING.POLL_MAX_INTERVAL_MINUTES, 240);

    // Better than the twice-a-day batch this replaced, for every user.
    assert.ok(SCHEDULING.SYNC_MAX_INTERVAL_MINUTES < 12 * 60);

    // And still far short of GitHub's ~90-day public events window, the only hard
    // correctness deadline.
    assert.ok(SCHEDULING.SYNC_MAX_INTERVAL_MINUTES * 100 < 90 * 24 * 60);
  });

  test("a batch cannot outlast the tick that starts it", async () => {
    // Was `assert.ok(200 * 0.5 < 5 * 60)` - two literals, in a test named after a setting it
    // never read. SYNC_BATCH_SIZE is intFromEnv, so it ships configurable and 5000 left this
    // green.
    //
    // The bound is not the tick. Under the DEVELOPMENT crons the sync ticks every minute and
    // overlap is deliberate - breeService refuses to start a job already running, so an
    // over-running batch costs a skipped tick, not a corrupt one. What actually kills a batch
    // mid-flight is closeWorkerAfterMs, and that figure is the same in every environment.
    const { SCHEDULING } = await import("../src/utils/constants.js");
    const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    const SECONDS_PER_SUBJECT = 0.5;       // measured; see the SCHEDULING comment
    const WORKER_TIMEOUT_SECONDS = 4 * 60; // breeService closeWorkerAfterMs: the hard kill

    for (const [name, size] of [['SYNC', SCHEDULING.SYNC_BATCH_SIZE], ['POLL', SCHEDULING.POLL_BATCH_SIZE]]) {
      assert.ok(
        size * SECONDS_PER_SUBJECT < WORKER_TIMEOUT_SECONDS,
        `${name}_BATCH_SIZE=${size} is ~${size * SECONDS_PER_SUBJECT}s of work, past the ${WORKER_TIMEOUT_SECONDS}s worker timeout`
      );
    }

    // The two figures the arithmetic above assumes, pinned where they actually live - otherwise
    // the budget is another literal in this file.
    assert.match(read("../src/services/breeService.js"), /closeWorkerAfterMs: 4 \* 60 \* 1000/,
      'the worker timeout moved - this budget is no longer the one that kills a batch');
    assert.match(read("../src/utils/constants.js"), /SYNC: process\.env\.EVENTS_CRON \|\| \(isProduction \? '\*\/5 \* \* \* \*'/,
      'the production sync tick moved');
    assert.ok(read("../src/utils/constants.js").includes("POLL: process.env.EVENTS_CRON_POLL || '*/5 * * * *'"),
      'the poll tick moved');
  });
});

describe("dispersedDelaySeconds", () => {
  const spreadOf = (interval, tick) =>
    Math.min(interval / 2, Math.max(interval * 0.1, tick * 2));

  test("is centred on the interval, so average freshness is unchanged", () => {
    // A dispersion that only ever pushed later would trade freshness for smoothness. This
    // one is symmetric: the mean delay is exactly the interval.
    assert.equal(dispersedDelaySeconds(30, 5, () => 0.5), 30 * 60);
    assert.equal(dispersedDelaySeconds(240, 5, () => 0.5), 240 * 60);
  });

  test("reaches exactly the spread at each end", () => {
    for (const [interval, tick] of [[15, 5], [30, 5], [240, 5], [15, 1]]) {
      const spread = spreadOf(interval, tick);

      assert.equal(dispersedDelaySeconds(interval, tick, () => 0), Math.round((interval - spread) * 60));
      assert.equal(dispersedDelaySeconds(interval, tick, () => 1), Math.round((interval + spread) * 60));
    }
  });

  test("never drifts more than half the interval, whatever the cron", () => {
    // The freshness guarantee is the interval ceiling; a dispersion able to double a delay
    // would quietly move it. An hourly cron with a 15-minute floor is the extreme case.
    for (const [interval, tick] of [[15, 60], [30, 240], [240, 60]]) {
      const latest = dispersedDelaySeconds(interval, tick, () => 1) / 60;

      assert.ok(latest <= interval * 1.5, `${interval}min/${tick}min drifted to ${latest}min`);
    }
  });

  test("three regimes decide the spread, and the tick is what makes two of them", () => {
    // Everything claimed by one tick is rewritten within the same second, so a proportional
    // dispersion alone would be decorative: 10% of a 15-minute interval is 90 seconds,
    // invisible against a 5-minute tick. Which of the three bounds binds depends on the
    // interval and the cron, and all three are load-bearing.

    // Capped by half the interval: the floor of two ticks would drift it further than the
    // freshness guarantee allows.
    assert.equal(spreadOf(15, 5), 7.5);
    assert.ok(7.5 > 15 * 0.1, "still far wider than the proportional 10%");

    // The two-tick floor binds: 10% of 30 minutes is 3 minutes, under one tick.
    assert.equal(spreadOf(30, 5), 10);

    // Proportional binds: at the ceiling the interval is large enough on its own.
    assert.equal(spreadOf(240, 5), 24);

    // And a one-minute cron needs far less to cross a tick, and asks for far less.
    assert.equal(spreadOf(15, 1), 2);
  });

  test("covers several ticks in every realistic configuration", () => {
    // The table that matters: if a change to the formula stops crossing tick boundaries,
    // the dispersion is decorative and the herd comes back.
    for (const [interval, tick] of [[15, 5], [30, 5], [60, 5], [240, 5], [15, 1], [240, 60]]) {
      const earliest = dispersedDelaySeconds(interval, tick, () => 0) / 60;
      const latest = dispersedDelaySeconds(interval, tick, () => 1) / 60;
      const ticks = (latest - earliest) / tick;

      assert.ok(ticks >= 2, `${interval}min interval on a ${tick}min tick spans only ${ticks.toFixed(1)} tick(s)`);
    }
  });

  test("an unreadable cron still disperses, on the interval alone", () => {
    // runsPerHour answers null for an expression it cannot parse. Losing the tick must not
    // mean losing the dispersion.
    assert.equal(dispersedDelaySeconds(30, null, () => 0) / 60, 27);
    assert.equal(dispersedDelaySeconds(30, null, () => 1) / 60, 33);
  });

  test("degenerate inputs produce no delay rather than a negative one", () => {
    for (const bad of [0, -5, Number.NaN, undefined, null]) {
      assert.equal(dispersedDelaySeconds(bad, 5, () => 0), 0);
    }
  });

  test("returns whole seconds, because make_interval takes an int", () => {
    assert.equal(Number.isInteger(dispersedDelaySeconds(15, 5, () => 0.3137)), true);
  });
});

describe("the dispersion reaches the database without contaminating the interval", () => {
  const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const INSTALLATIONS = read("../src/db/installations.js");
  const PULL_REQUESTS = read("../src/db/polling.js");
  const REPOSITORIES = read("../src/db/repositories.js");

  test("every due-time write takes seconds, so a fractional dispersion is not truncated", () => {
    // make_interval(mins => ...) takes an integer, so a dispersion of 7.5 minutes would
    // land as 7 - and every subject sharing an interval would round to the same value,
    // which is the herd again.
    for (const [name, source] of [["installations", INSTALLATIONS], ["pull_requests", PULL_REQUESTS]]) {
      const dueWrites = source.match(/next_(sync|poll)_at = CURRENT_TIMESTAMP \+ make_interval\(([a-z]+)/g) ?? [];

      assert.equal(dueWrites.length, 2, `${name} should write a due time on the success and failure paths`);

      for (const write of dueWrites) {
        assert.match(write, /make_interval\(secs/, `${name}: ${write}`);
      }
    }
  });

  test("the stored interval is the un-jittered one", () => {
    // The adaptive ladder doubles from the stored interval. Storing the jittered delay
    // would compound the dispersion into the interval itself, and a few quiet rounds would
    // walk a subject off the ceiling.
    //
    // The two facts, asserted separately inside one statement rather than as one regex over
    // both lines: pinning them adjacent and in that order made a reordered SET list a failure
    // with no behaviour change, and matching the interval over the whole file would be
    // satisfied by the reset paths that also write `sync_interval_minutes = $`.
    const setList = (source, dueColumn) => {
      const at = source.indexOf(`${dueColumn} = CURRENT_TIMESTAMP + make_interval(secs => $2::int)`);

      assert.notEqual(at, -1, `${dueColumn} no longer takes the dispersed seconds - this guard is asserting nothing`);

      const end = source.indexOf('WHERE', at);

      assert.notEqual(end, -1, `the statement writing ${dueColumn} has no WHERE - the slice is wrong`);

      return source.slice(at, end);
    };

    assert.match(setList(INSTALLATIONS, 'next_sync_at'), /sync_interval_minutes = \$3\b/,
      'the stored ladder must take its own placeholder, not the jittered one');
    assert.match(setList(PULL_REQUESTS, 'next_poll_at'), /poll_interval_minutes = \$3\b/,
      'the stored ladder must take its own placeholder, not the jittered one');
  });

  test("the repository refresh disperses too, on all three of its paths", () => {
    // It has three, not two: a 304 moves the cursor without writing anything else, and a
    // refresh that skipped the dispersion would re-align every repository on one tick.
    const dueWrites = REPOSITORIES.match(/next_refresh_at = CURRENT_TIMESTAMP \+ make_interval\(([a-z]+)/g) ?? [];

    assert.equal(dueWrites.length, 3, 'succeeded, unchanged and failed each write a due time');

    for (const write of dueWrites) {
      assert.match(write, /make_interval\(secs/, write);
    }
  });

  test("the repository interval is fixed, and no ladder is stored for it", () => {
    // The one subject that does not climb the adaptive ladder: a star count changes constantly
    // on an active repository, so halving on change would pin every popular one to the floor.
    // There is deliberately no refresh_interval_minutes column to keep in step.
    assert.doesNotMatch(REPOSITORIES, /refresh_interval_minutes/);
    assert.doesNotMatch(read("../jobs/sync_repositories.js"), /nextIntervalMinutes/);
    assert.match(read("../jobs/sync_repositories.js"), /SCHEDULING\.REPO_REFRESH_INTERVAL_MINUTES/);
  });

  test("the claim lease stays in minutes, because it is not a due time", () => {
    // CLAIM_LEASE_MINUTES bounds how long a worker's claim is honoured. It has nothing to
    // do with dispersion and must not follow it.
    for (const source of [INSTALLATIONS, PULL_REQUESTS, REPOSITORIES]) {
      assert.match(source, /claimed_at < CURRENT_TIMESTAMP - make_interval\(mins => \$2::int\)/);
    }
  });

  test("all three jobs derive the tick from the cron rather than a setting of their own", () => {
    // A DISPERSION_MINUTES setting would be a second knob to keep aligned with EVENTS_CRON.
    // This codebase already lived that with hasSeconds, and derives it now.
    for (const path of ["../jobs/sync_contributions.js", "../jobs/poll_non_closed_pull_requests.js", "../jobs/sync_repositories.js"]) {
      const source = read(path);

      assert.match(source, /tickMinutes\(CRON\.(SYNC|POLL|SYNC_REPOS)\)/, `${path} must read its own cron`);
      assert.match(source, /dispersedDelaySeconds\(/, `${path} must disperse its due times`);
      assert.doesNotMatch(source, /process\.env\.[A-Z_]*(DISPERSION|JITTER)/, `${path} must not add a dispersion setting`);
    }

    // The derivation moved into src/utils/cron.js, and without this the assertions above would
    // still pass if tickMinutes stopped reading the cron at all.
    assert.match(read("../src/utils/cron.js"), /runsPerHour\(/, 'tickMinutes must derive the tick from the schedule itself');
  });
});
