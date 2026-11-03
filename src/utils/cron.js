import later from "@breejs/later";
import cronValidateModule from "cron-validate";

// cron-validate is transpiled CommonJS carrying an __esModule marker, so a default import
// lands on module.exports and the function sits one level further down. test/utils.test.js
// fails if this resolution ever stops working.
const cronValidate = cronValidateModule.default ?? cronValidateModule;

/**
 * Does a cron expression carry a seconds field?
 *
 * Bree needs `hasSeconds` to match the expression it is given: a 6-field pattern with
 * hasSeconds:false throws "Expected 5 values, but got 6", and Bree swallows the throw — the
 * app starts with no job scheduled at all. Deriving the flag makes that mismatch impossible.
 * @param {string} expression - Cron expression
 * @returns {boolean} True for a 6-field expression
 */
export const hasSecondsField = (expression) =>
  String(expression).trim().split(/\s+/).length === 6;

// The same mode Bree runs in: bree/src/job-builder.js calls this at import time, so the
// scheduler already reads every expression in local time. Idempotent, and stated here rather
// than inherited through import order.
later.date.localTime();

/**
 * Start of the next whole second
 *
 * later works at second granularity and carries the seed's milliseconds through, so seeding
 * it with `new Date()` inside a firing second answers with that firing — a moment already
 * past once the milliseconds are dropped. Measured: every call made during the firing second
 * of `*\/30 * * * * *` returned a date in the past, and the countdown on the dashboard went
 * negative. Seeding on the boundary skips only firings that have already happened.
 * @returns {Date} Now, rounded up to the next second
 */
const nextWholeSecond = () => new Date((Math.floor(Date.now() / 1000) + 1) * 1000);

/**
 * When a cron expression fires next
 *
 * Computed with the library Bree schedules with: the one number an operator trusts blindly on
 * a dashboard is the countdown to the next run, so it must be the real schedule.
 * @param {string} expression - Cron expression, 5 or 6 fields
 * @returns {?Date} Next firing, or null if the expression never fires or cannot be parsed
 */
export const nextRunAt = (expression) => {
  try {
    const hasSeconds = hasSecondsField(expression);

    // later does NOT reject nonsense: later.parse.cron('nonsense') answers with a schedule
    // that fires every minute and leaves schedule.error at -1, so a mistyped cron would read
    // as a confident countdown to a run that never happens. cron-validate is the validator
    // Bree itself accepts expressions with, so "invalid here" means "rejected by the scheduler".
    if (!cronValidate(expression, { override: { useSeconds: hasSeconds } }).isValid()) {
      return null;
    }

    const schedule = later.parse.cron(expression, hasSeconds);

    if (schedule.error > -1) {
      return null;
    }

    const next = later.schedule(schedule).next(1, nextWholeSecond());
    // next(1) answers with a bare Date, next(n>1) with an array — and later.NEVER is 0.
    const date = Array.isArray(next) ? next[0] : next;

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return null;
    }

    // Belt and braces: the seed is already on a whole second, so later carries none through.
    date.setMilliseconds(0);

    return date;
  } catch {
    // A malformed expression must cost the countdown, never the page.
    return null;
  }
};

/**
 * How many times an expression fires in the next hour
 *
 * Counted from the real schedule rather than parsed out of the expression: a five-minute step,
 * a two-minute step written with seconds, and "7 past the hour" have nothing structurally in
 * common, and a regex over the fields would get one of the three wrong. Capped at 240 firings,
 * beyond which the figure stops being useful and the loop stops being cheap.
 * @param {string} expression - Cron expression
 * @returns {?number} Firings per hour, or null if the expression cannot be read
 */
const runsPerHour = (expression) => {
  if (!nextRunAt(expression)) {
    return null;
  }

  try {
    const schedule = later.parse.cron(expression, hasSecondsField(expression));
    // Same seed as nextRunAt, so "the next firing" and "firings this hour" cannot disagree
    // about whether a firing in the current second still counts.
    const from = nextWholeSecond();
    const until = from.getTime() + 3_600_000;

    const firings = [].concat(later.schedule(schedule).next(240, from) ?? []);

    return firings.filter((date) => date instanceof Date && date.getTime() <= until).length;
  } catch {
    return null;
  }
};

/**
 * Minutes between two wake-ups of a schedule
 *
 * Read from the very expression the scheduler was given rather than from a setting of its own: a
 * dispersion smaller than one tick moves nobody, so this is what sizes it, and changing the cron
 * moves both together. See dispersedDelaySeconds().
 * @param {string} expression - Cron expression
 * @returns {?number} Minutes between firings, or null if the expression cannot be read
 */
export const tickMinutes = (expression) => {
  const perHour = runsPerHour(expression);

  return perHour ? 60 / perHour : null;
};
