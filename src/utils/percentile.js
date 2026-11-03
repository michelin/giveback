import { PERCENTILE_MIN_SAMPLE } from "./constants.js";

/**
 * The p-th percentile of a list, interpolated the way PostgreSQL's percentile_cont does
 *
 * h = (n - 1)·p, then linearly between the two values either side of it. The same rule as the
 * SQL the report measures with, so a median computed here from one person's rows and one
 * measured there over everybody's are the same statistic and can stand side by side.
 * @param {Array<?number>} values - In any order; null and NaN are not values
 * @param {number} p - Between 0 and 1
 * @returns {?number} null for an empty list
 */
export const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);

  if (sorted.length === 0) {
    return null;
  }

  const h = (sorted.length - 1) * p;
  const below = Math.floor(h);

  return sorted[below] + (h - below) * (sorted[Math.ceil(h)] - sorted[below]);
};

/**
 * A percentile, or null below the sample PERCENTILE_MIN_SAMPLE sets for it
 * @param {Array<?number>} values - In any order; null and NaN are not values
 * @param {'p50'|'p90'|'p99'} key - Which percentile, named as the threshold is
 * @returns {?number}
 */
export const gated = (values, key) => {
  const measured = values.filter(Number.isFinite);

  return measured.length >= PERCENTILE_MIN_SAMPLE[key] ? percentile(measured, Number(key.slice(1)) / 100) : null;
};

/**
 * Where one person stands, ranked the way a race is: a tie shares its place and the next place
 * is skipped - 1, 2, 2, 4
 *
 * Only among the people who scored. Somebody on zero is not last, they are not in the race, so
 * they get no place at all rather than the one after everybody else.
 * @param {Array<{who: string}>} rows - One per person, `who` their lower-cased login
 * @param {function(Object): number} score - What the race is run on
 * @param {string} who - The login asked about, in any case
 * @returns {?{position: number, of: number}} null when that person has not scored
 */
export const competitionRank = (rows, score, who) => {
  const scored = rows.filter((row) => score(row) > 0);
  const theirs = scored.find((row) => row.who === who.toLowerCase());

  if (!theirs) {
    return null;
  }

  return { position: 1 + scored.filter((row) => score(row) > score(theirs)).length, of: scored.length };
};
