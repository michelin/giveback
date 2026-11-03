import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { disableReasonFor } from "../src/utils/backoff.js";
import { missedEventsWindow } from "../src/utils/github.js";
import { SCHEDULING } from "../src/utils/constants.js";
import { fn } from "../test-support/sources.js";

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const THRESHOLDS = { after404: 3, afterFailures: 50 };

describe("disableReasonFor", () => {
  test("a run of 404s below the threshold keeps retrying", () => {
    assert.equal(disableReasonFor(1, 1, THRESHOLDS), null);
    assert.equal(disableReasonFor(2, 2, THRESHOLDS), null);
  });

  test("a run of 404s at the threshold retires the row", () => {
    assert.equal(disableReasonFor(3, 3, THRESHOLDS), 'account gone');
    assert.equal(disableReasonFor(9, 9, THRESHOLDS), 'account gone');
  });

  test("an outage never retires anyone, however long it lasts", () => {
    // The reason the 404s are counted apart. A GitHub incident fails every subject in the same
    // run, repeatedly: counting failures alone would retire the whole population somewhere in
    // the middle of it.
    for (const failures of [1, 3, 10, 49]) {
      assert.equal(
        disableReasonFor(failures, 0, THRESHOLDS),
        null,
        `${failures} failure(s) without a 404 must not retire anyone`
      );
    }
  });

  test("404s interrupted by other failures are not a run", () => {
    // Nine failures, the last two of them 404s: a timeout in between reset the run, so this is
    // two 404s and not nine. Counting every failure as one was how an outage with the odd 404 in
    // it could retire an account that exists.
    assert.equal(disableReasonFor(9, 2, THRESHOLDS), null);
  });

  test("the catch-all still fires for what never recovers and is not a 404", () => {
    assert.equal(disableReasonFor(50, 0, THRESHOLDS), 'repeated failures');
    assert.equal(disableReasonFor(50, 1, THRESHOLDS), 'repeated failures');
  });

  test("a nonsensical count is never grounds for retirement", () => {
    for (const count of [0, -1, NaN, undefined]) {
      assert.equal(disableReasonFor(count, count, THRESHOLDS), null);
    }
  });

  test("a 404 threshold of zero does not turn every failure into 'account gone'", () => {
    assert.equal(disableReasonFor(1, 0, { after404: 0, afterFailures: 50 }), null);
  });

  test("the shipped thresholds keep the two failures far apart", () => {
    // Not a style preference: the 404 threshold is small ONLY because a wrong verdict is
    // undone by the hourly login refresh. The catch-all has no such repair, so it must sit
    // far higher - beyond any plausible outage at the backoff ceiling.
    assert.ok(SCHEDULING.SYNC_DISABLE_AFTER_404 <= 5, 'a 404 is conclusive, act on it quickly');
    assert.ok(
      SCHEDULING.SYNC_DISABLE_AFTER_FAILURES >= SCHEDULING.SYNC_DISABLE_AFTER_404 * 10,
      'the catch-all must be an order of magnitude slower than the conclusive case'
    );

    const daysToRetire =
      (SCHEDULING.SYNC_DISABLE_AFTER_FAILURES * SCHEDULING.MAX_ERROR_BACKOFF_MINUTES) / 60 / 24;

    assert.ok(daysToRetire >= 7, `the catch-all fires after ${daysToRetire.toFixed(1)} days, too soon to outlast an incident`);
  });
});

describe("missedEventsWindow", () => {
  const feed = (truncated, ...isoDates) => ({
    truncated,
    // The feed is newest-first, as GitHub serves it.
    events: isoDates.map((created_at) => ({ created_at })),
  });

  test("a feed that ended lost nothing", () => {
    assert.equal(missedEventsWindow(feed(false, '2026-08-20T00:00:00Z'), new Date('2026-01-01')), null);
  });

  test("a full feed that still reaches past the last sync lost nothing", () => {
    // The case that decides whether this is a signal or noise. Any active contributor
    // fills the feed on every single sync; only a feed that no longer reaches back to the
    // previous read has actually dropped something.
    const window = missedEventsWindow(
      feed(true, '2026-08-20T00:00:00Z', '2026-08-10T00:00:00Z'),
      new Date('2026-08-15T00:00:00Z')
    );

    assert.equal(window, null);
  });

  test("a gap is reported with both of its edges", () => {
    const window = missedEventsWindow(
      feed(true, '2026-08-20T00:00:00Z', '2026-08-10T00:00:00Z'),
      new Date('2026-08-01T00:00:00Z')
    );

    assert.equal(window.since.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(window.until.toISOString(), '2026-08-10T00:00:00.000Z');
  });

  test("a first sync reports an open-ended window", () => {
    // Nothing to compare against, so the honest statement is "everything before this is
    // unknowable", not silence.
    const window = missedEventsWindow(feed(true, '2026-08-20T00:00:00Z', '2026-08-10T00:00:00Z'), null);

    assert.equal(window.since, null);
    assert.equal(window.until.toISOString(), '2026-08-10T00:00:00.000Z');
  });

  test("an empty or unreadable feed says nothing rather than something wrong", () => {
    assert.equal(missedEventsWindow(feed(true), null), null);
    assert.equal(missedEventsWindow(feed(true, 'not a date'), null), null);
    assert.equal(missedEventsWindow(undefined, null), null);
  });

  test("an unreadable stored timestamp fails towards the warning, not away from it", () => {
    // Silence is the dangerous direction here: this function exists to break one.
    const window = missedEventsWindow(feed(true, '2026-08-10T00:00:00Z'), 'not a date');

    assert.ok(window, 'an unusable last-sync time must not be read as "nothing was missed"');
  });

  test("a sync accepts the timestamp shape the driver actually returns", () => {
    // pg hands back a Date; a hand-written call might pass the ISO string. Both are real.
    const asDate = missedEventsWindow(feed(true, '2026-08-10T00:00:00Z'), new Date('2026-08-01'));
    const asString = missedEventsWindow(feed(true, '2026-08-10T00:00:00Z'), '2026-08-01T00:00:00Z');

    assert.deepEqual(asDate, asString);
  });
});

describe("retirement cannot be fought by the reconciliation", () => {
  const INSTALLATIONS = read("../src/db/installations.js");
  const INIT_SQL = read("../init.sql");

  test("the reconciliation forces installation_deleted back to false every hour", () => {
    // The fact the whole design turns on. Anything the sync job wrote into that column
    // would be reverted within the hour - and next_sync_at reset to now along with it,
    // promoting the broken row to the front of the queue instead of retiring it.
    const reconcile = fn(INSTALLATIONS, 'reconcileInstallationStates');

    assert.match(reconcile, /installation_deleted = false/);
    // A row genuinely coming back from suspended or deleted is still promoted to the front of
    // the queue. Asserted on the two predicates rather than on one literal line, because the
    // assignment is now conditional - see the backfill test below for why.
    assert.match(reconcile, /gi\.installation_suspended IS DISTINCT FROM false\s+OR gi\.installation_deleted IS DISTINCT FROM false THEN CURRENT_TIMESTAMP/);
    // A still-suspended row keeps the schedule it had.
    assert.match(reconcile, /WHEN live\.suspended THEN gi\.next_sync_at/);
  });

  test("a timestamp backfill does not reset the whole queue", () => {
    // installation_created_at starts null on every row, so the WHERE predicate matches the
    // entire parc on the first run after those columns land. Assigning next_sync_at
    // unconditionally there would date all of them now - the aligned herd that
    // docs/architecture.md#dispersion exists to prevent, and the reason the CASE has an ELSE
    // that leaves the schedule alone.
    const reconcile = fn(INSTALLATIONS, 'reconcileInstallationStates');

    assert.match(reconcile, /installation_created_at IS DISTINCT FROM/);
    assert.match(reconcile, /ELSE gi\.next_sync_at\s+END/);
    assert.doesNotMatch(reconcile, /ELSE CURRENT_TIMESTAMP/);
  });

  test("so the sync job writes neither of the two columns GitHub owns", () => {
    const failed = fn(INSTALLATIONS, 'markSyncFailed');

    assert.doesNotMatch(failed, /installation_deleted/);
    assert.doesNotMatch(failed, /installation_suspended/);
    assert.match(failed, /sync_disabled_at/);
  });

  test("a retired row is excluded from the queue", () => {
    assert.match(fn(INSTALLATIONS, 'claimInstallationsForSync'), /AND sync_disabled_at IS NULL/);
  });

  test("the dashboard draws the same queue the job drains", () => {
    // Not cosmetic. A predicate missing here draws retired rows in a queue no run will ever
    // drain, and stops the predicate matching idx_installations_due_for_sync - measured on
    // 5000 rows, the index scan becomes a sequential one on a page that polls every 5s.
    const syncable = /const SYNCABLE = `([\s\S]*?)`;/.exec(read("../src/db/dashboard.js"))[1];

    for (const predicate of [
      'verified_at IS NOT NULL',
      'installation_suspended = false',
      'installation_deleted = false',
      'installation_id IS NOT NULL',
      'sync_disabled_at IS NULL',
    ]) {
      assert.ok(syncable.includes(predicate), `SYNCABLE is missing "${predicate}"`);
    }
  });

  test("the partial index carries every predicate the claim query does", () => {
    // A predicate in the query and not in the index makes the index unusable for it, and
    // nothing fails - the scan just quietly becomes sequential.
    const index = INIT_SQL.slice(INIT_SQL.indexOf('idx_installations_due_for_sync'));
    const definition = index.slice(0, index.indexOf(';'));

    for (const predicate of [
      'installation_suspended = false',
      'installation_deleted = false',
      'verified_at IS NOT NULL',
      'sync_disabled_at IS NULL',
    ]) {
      assert.match(definition, new RegExp(predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test("only two things bring a retired user back", () => {
    // Re-enrollment, because the person answered for themselves; and a rename, because the
    // 404 that condemned them had a cause that has just been disproved.
    assert.match(fn(INSTALLATIONS, 'verifyInstallation'), /sync_disabled_at = NULL/);

    const refresh = fn(INSTALLATIONS, 'refreshStaleLogins');

    assert.match(refresh, /WHEN gi\.sync_disabled_reason = 'account gone' THEN NULL ELSE gi\.sync_disabled_at END/);
  });

  test("a rename lifts only the verdict it disproves", () => {
    // 'repeated failures' says nothing about the login, so a rename must leave it standing.
    const refresh = fn(INSTALLATIONS, 'refreshStaleLogins');

    assert.doesNotMatch(refresh, /sync_disabled_at = NULL(?!.*CASE)/);
    assert.match(refresh, /ELSE gi\.sync_disabled_reason END/);
  });

  test("the reason the sync job records is one the repair path recognises", () => {
    // Two literals in two files: a typo in either would make the rename repair silently
    // stop lifting anything.
    const reasons = [...read("../src/utils/backoff.js").matchAll(/return '([a-z ]+)';/g)].map((m) => m[1]);

    assert.deepEqual(reasons, ['account gone', 'repeated failures']);
    assert.match(fn(INSTALLATIONS, 'refreshStaleLogins'), /'account gone'/);
  });
});
