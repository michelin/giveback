/**
 * Adaptive interval: double on quiet, back to the floor as soon as something changed
 * @param {?number} currentMinutes - Interval used for the run that just finished
 * @param {boolean} foundSomethingNew - Whether that run saw a change
 * @param {{min: number, max: number}} bounds - Interval floor and ceiling, in minutes
 * @returns {number} Interval to use next, in minutes
 */
export const nextIntervalMinutes = (currentMinutes, foundSomethingNew, { min, max }) => {
  if (foundSomethingNew) {
    return min;
  }

  const current = Number.isFinite(currentMinutes) && currentMinutes > 0 ? currentMinutes : min;

  return Math.min(current * 2, max);
};

/**
 * Delay before retrying a subject whose sync failed
 * @param {number} errorCount - Consecutive failures, including the one just recorded
 * @param {{min: number, max: number}} bounds - Floor and ceiling, in minutes
 * @returns {number} Delay in minutes
 */
export const errorBackoffMinutes = (errorCount, { min, max }) => {
  const failures = Number.isFinite(errorCount) && errorCount > 0 ? errorCount : 1;

  // Cap the exponent so the multiplication cannot reach Infinity before Math.min clamps it.
  const factor = 2 ** Math.min(failures, 20);

  return Math.min(min * factor, max);
};

/**
 * Every interval nextIntervalMinutes() can settle on, floor first
 *
 * The floor doubling up to the ceiling, which is the last rung whether or not a doubling lands
 * on it: the ladder the dashboard's track is drawn on and its tiers are named by, derived rather
 * than listed, so moving either bound moves the page with it. A floor at or above the ceiling is
 * a ladder of one.
 * @param {{min: number, max: number}} bounds - Interval floor and ceiling, in minutes
 * @returns {Array<number>} Minutes, ascending
 */
export const intervalLadder = ({ min, max }) => {
  const ladder = [min];

  while (ladder.at(-1) * 2 < max) {
    ladder.push(ladder.at(-1) * 2);
  }

  if (max > ladder.at(-1)) {
    ladder.push(max);
  }

  return ladder;
};

/**
 * The rung an interval is named by
 *
 * A value off the ladder - written under other bounds, or below a floor raised since - is
 * named by the rung under it, and by the floor when there is none: the tier names it, the
 * track's tooltip gives its real value. A subject never scheduled yet has no interval, and the
 * next run uses the floor.
 * @param {?number} minutes - The interval
 * @param {Array<number>} ladder - As intervalLadder() builds it
 * @returns {number} One of the rungs
 */
export const tierOf = (minutes, ladder) => ladder.findLast((rung) => rung <= minutes) ?? ladder[0];

/**
 * How long a failing subject can wait above the ceiling, or null when it cannot
 *
 * errorBackoffMinutes() is capped by MAX_ERROR_BACKOFF_MINUTES rather than by the interval's
 * ceiling, so from some failure in a row on a subject waits longer than any rung of the ladder:
 * 360 minutes against 240 with the shipped values, from the fifth. Only then is there a band
 * above the ladder to name.
 * @param {{min: number, max: number, backoffMax: number}} bounds - Interval floor and ceiling,
 *   and the error backoff's own ceiling, in minutes
 * @returns {?number} The longest wait, when it is past the ceiling
 */
export const backoffBand = ({ min, max, backoffMax }) => {
  const longest = errorBackoffMinutes(Number.MAX_SAFE_INTEGER, { min, max: backoffMax });

  return longest > max ? longest : null;
};

/**
 * Delay before a subject next falls due, spread across ticks
 *
 * The scheduler claims everything due on one tick, so sub-tick spread is destroyed on first
 * contact — measured in production, a group dispersed over 292 seconds came back out of one
 * run 8 seconds wide. Nothing else creates spread either: groups merge when two land on the
 * same tick, and none ever splits, since a group's members share both a tick and an interval.
 *
 * Two bounds, and the second always wins: at least two ticks of spread (a four-tick window, so
 * the group cannot land back where it started) and at most half the interval, which keeps every
 * due time inside [0.5x, 1.5x] of it and the freshness guarantee with it. A cron slower than
 * half the interval therefore gets less than a tick — see docs/architecture.md#dispersion.
 * @param {number} intervalMinutes - Adaptive interval for this subject
 * @param {?number} tickMinutes - Minutes between two wake-ups, derived from the cron; null
 *   falls back to a proportion of the interval alone
 * @param {function(): number} [random] - Injectable for tests
 * @returns {number} Delay in seconds, never negative
 */
export const dispersedDelaySeconds = (intervalMinutes, tickMinutes, random = Math.random) => {
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 0;
  const tick = Number.isFinite(tickMinutes) && tickMinutes > 0 ? tickMinutes : 0;

  const spread = Math.min(interval / 2, Math.max(interval * 0.1, tick * 2));

  return Math.max(0, Math.round((interval + ((random() * 2) - 1) * spread) * 60));
};

/**
 * Whether to stop syncing a subject altogether, and why
 *
 * Backing off caps the waste of a permanently broken subject but never ends it, so there has
 * to be a verdict. Two counts feed it, because the two failures that matter are opposite in
 * nature: a 404 on the events feed is GitHub saying that login does not exist, so a handful in a
 * row is proof, while a 500 or a timeout says only that GitHub is having a bad hour and must
 * never retire anyone however often it repeats. Any other outcome resets the 404 run, so an
 * outage with the odd 404 in it never adds up to "account gone".
 *
 * A 404 has one benign cause, a login renamed by its owner, and reconcile_installations
 * repairs that hourly and lifts the retirement it caused. Being wrong is therefore temporary,
 * which is what lets SYNC_DISABLE_AFTER_404 be as low as three.
 * @param {number} failures - Consecutive failures of any kind, including the one just recorded
 * @param {number} notFound - Consecutive 404s, including the one just recorded; 0 when this
 *   failure was anything else
 * @param {{after404: number, afterFailures: number}} thresholds - Counts to act on
 * @returns {?string} Reason to record, or null to keep retrying
 */
export const disableReasonFor = (failures, notFound, { after404, afterFailures }) => {
  const count = Number.isFinite(failures) && failures > 0 ? failures : 0;
  const run404 = Number.isFinite(notFound) && notFound > 0 ? notFound : 0;

  if (run404 > 0 && Number.isFinite(after404) && run404 >= after404) {
    return 'account gone';
  }

  if (Number.isFinite(afterFailures) && count >= afterFailures) {
    return 'repeated failures';
  }

  return null;
};
