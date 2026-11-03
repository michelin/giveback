import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseRepoFullname } from "../src/utils/github.js";
import { hasSecondsField, nextRunAt, tickMinutes } from "../src/utils/cron.js";

describe("parseRepoFullname", () => {
  test("splits owner and repository name", () => {
    assert.deepEqual(parseRepoFullname("michelin/oss-bot"), { owner: "michelin", name: "oss-bot" });
  });

  test("rejects anything that is not exactly owner/repo", () => {
    for (const bad of ["", "owner", "owner/", "/repo", "a/b/c", null, undefined, 42]) {
      assert.throws(() => parseRepoFullname(bad), /invalid repository fullname/);
    }
  });
});

describe("hasSecondsField", () => {
  test("detects the 6-field form", () => {
    // The values that were sitting in .env.local, which a hardcoded hasSeconds:false
    // turned into "app starts, schedules nothing, says nothing".
    assert.equal(hasSecondsField("*/30 * * * * *"), true);
    assert.equal(hasSecondsField("0 */2 * * * *"), true);
  });

  test("detects the standard 5-field form", () => {
    assert.equal(hasSecondsField("*/1 * * * *"), false);
    assert.equal(hasSecondsField("0 * * * *"), false);
    assert.equal(hasSecondsField("17 4,16 * * *"), false);
  });

  test("is insensitive to surrounding and repeated whitespace", () => {
    assert.equal(hasSecondsField("  */30   *  * * *   *  "), true);
    assert.equal(hasSecondsField("  0 *   * * *  "), false);
  });
});

describe("nextRunAt", () => {
  test("answers with the next firing of a valid expression", () => {
    // `*/1 * * * * *` is the case that matters and it is deterministic: every call lands
    // inside a firing second. later carries the seed's milliseconds through, so seeding it
    // with `new Date()` answered with the firing already in progress - a date in the past
    // once the milliseconds were dropped, and a negative countdown on the dashboard. The
    // same defect hit `*/30 * * * * *` one second in thirty, which made this test flaky.
    for (const expression of ['*/1 * * * * *', '*/5 * * * *', '*/30 * * * * *', '0 */2 * * * *', '7 * * * *', '0 4 * * *']) {
      const next = nextRunAt(expression);

      assert.ok(next instanceof Date, `${expression} produced no date`);
      assert.ok(next.getTime() > Date.now(), `${expression} produced a date in the past`);
      assert.equal(next.getMilliseconds(), 0, 'the seed milliseconds must not leak into the countdown');
    }
  });

  test("refuses an expression the scheduler would refuse", () => {
    // This is also the interop guard. cron-validate is transpiled CommonJS with a doubled
    // default export, and if that resolution ever breaks, validation silently stops
    // happening and 'nonsense' starts returning a confident countdown — because later
    // answers 'every minute' for it rather than reporting an error.
    for (const bad of ['nonsense', '', '99 * * * *', '* * * *', null, undefined, 42]) {
      assert.equal(nextRunAt(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test("the next firing is never further out than the interval itself", () => {
    // A cheap sanity check on the local-time mode: a five-minute cron must fire within five
    // minutes, whatever the timezone, and would not if the schedule were being read in UTC
    // against a local clock.
    const next = nextRunAt('*/5 * * * *');

    assert.ok(next.getTime() - Date.now() <= 5 * 60_000 + 1000);
  });
});

describe("tickMinutes", () => {
  test("reads the minutes between wake-ups off the schedule itself", () => {
    // Bounded rather than exact on purpose: runsPerHour counts the firings in the next hour
    // from the next whole second, so a call landing exactly on a firing counts 13 of a
    // five-minute schedule rather than 12. The tick only has to size a dispersion.
    for (const [expression, minutes] of [['*/5 * * * *', 5], ['*/3 * * * *', 3], ['0 * * * *', 60]]) {
      const tick = tickMinutes(expression);

      assert.ok(tick >= minutes / 2 && tick <= minutes, `${expression} produced a ${tick}min tick`);
    }
  });

  test("carries runsPerHour's cap, so a per-second schedule stays cheap to read", () => {
    // 240 firings is where the figure stops being useful and the loop stops being cheap.
    assert.equal(tickMinutes('*/1 * * * * *'), 0.25);
  });

  test("an unreadable expression costs the tick, never a throw", () => {
    // dispersedDelaySeconds falls back to the interval alone for a null tick, so losing the
    // cron must not mean losing the dispersion - see test/backoff.test.js.
    for (const bad of ['nonsense', '', '99 * * * *', null, undefined, 42]) {
      assert.equal(tickMinutes(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});
