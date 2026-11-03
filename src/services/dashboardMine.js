import { listContributionsForLogin } from "../db/contributions.js";
import { getReport, getStandings } from "./dashboardReport.js";
import { competitionRank, gated } from "../utils/percentile.js";
import { getLogger, format, fields } from "../utils/logger.js";

const logger = getLogger("dashboardMine");

/** The months a personal curve may span. Longer than anyone has been enrolled, and bounded. */
const MINE_MONTHS = 24;

/**
 * A timestamp as text, whichever of the two shapes it arrives in
 *
 * pg hands back a `Date` for a timestamptz; the same row read back out of this route's own JSON
 * is a string. Everything below sorts and slices text, and `String(new Date())` is
 * `Wed Aug 29 2026 ...` - which slices to `Wed Aug` and sorts after every digit. Measured
 * against production data: the curve came back empty and the last contribution was the wrong
 * one, while every unit test passed, because the tests fed it strings.
 */
const asIso = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  return typeof value === 'string' && value !== '' ? value : null;
};

/** `2026-08`, in UTC, so the same contribution never lands in two different months. */
const monthKey = (value) => (asIso(value) ?? '').slice(0, 7);

/** Milliseconds since the epoch, or NaN for a date that is not there. */
const msOf = (value) => Date.parse(asIso(value) ?? '');

/** ISO timestamps sort as strings, which is the whole reason this is one line. */
const earliest = (dates) => dates.map(asIso).filter(Boolean).sort()[0] ?? null;

/** How many of each month a list of month keys holds. */
const tally = (months) => months.reduce((counts, month) => counts.set(month, (counts.get(month) ?? 0) + 1), new Map());

/** One side of the Where bar: its pull requests, and the projects they went to, counted by the row. */
const side = (rows) => ({ prs: rows.length, repositories: new Set(rows.map((row) => row.repositoryId)).size });

/**
 * One person's own contributions, read off the list rather than counted again
 *
 * Pure, and everything the tab shows about the rows comes from here - the tiles, the two bars
 * and the curve. One list, one set of answers: a second query for the figures would be a second
 * chance for them to disagree with the rows printed underneath them.
 *
 * The curve is two running totals, month by month: what was opened and what was merged, from the
 * month of the first pull request. Cumulative because the alternative measured badly: of the 43
 * people who have ever landed one, 19 have three contributions or fewer and the median is active
 * in fewer than four months, so a per-month chart is an empty frame with one bar in it for nearly
 * half the parc. A running total is never empty after the first, and it is drawn as a STEP -
 * nothing grew during a month with nothing in it, and a line sloping between two points would
 * claim it did.
 *
 * @param {Array<Object>} rows - From listContributionsForLogin(), newest first
 * @param {Date} [now] - Injected so the series has a deterministic last month under test
 */
export const summariseMine = (rows, now = new Date()) => {
  const merged = rows.filter((row) => row.merged);
  const open = rows.filter((row) => row.state !== 'closed');
  const closedUnmerged = rows.filter((row) => row.state === 'closed' && !row.merged).length;

  // Only what can be timed: an entry by hand may have no opening date, and a clock skewed on
  // either side can put a merge before its opening. NaN fails the comparison as well.
  const seconds = merged.map((row) => (msOf(row.mergedAt) - msOf(row.openedAt)) / 1000).filter((value) => value >= 0);

  const openedMonths = rows.map((row) => monthKey(row.openedAt)).filter(Boolean);
  const landedMonths = merged.map((row) => monthKey(row.mergedAt)).filter(Boolean);
  // Each pull request's first month, by whichever date it has: a merge typed in by hand with no
  // opening date may be older than anything opened.
  const starts = rows.map((row) => monthKey(row.openedAt) || monthKey(row.mergedAt)).filter(Boolean).sort();
  const first = starts[0];
  const months = Array.from({ length: MINE_MONTHS }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MINE_MONTHS - 1 - i), 1)).toISOString().slice(0, 7));

  // What the window does not show. A curve starting at the 24-month mark must not start at
  // zero for somebody who had already landed work - the total would be wrong for its whole
  // length, by exactly the part that is not drawn.
  const before = landedMonths.filter((month) => month < months[0]).length;
  const beforeOpened = openedMonths.filter((month) => month < months[0]).length;
  const opened = tally(openedMonths);
  const landed = tally(landedMonths);
  const series = [];
  let openedTotal = beforeOpened;
  let total = before;

  // Nothing is drawn before somebody's first: a run of months at zero reads as idleness, where
  // in fact they had not arrived yet.
  for (const month of first ? months.filter((key) => key >= first) : []) {
    openedTotal += opened.get(month) ?? 0;
    total += landed.get(month) ?? 0;
    series.push({ month, opened: opened.get(month) ?? 0, landed: landed.get(month) ?? 0, openedTotal, total });
  }

  return {
    merged: merged.length,
    open: open.length,
    closedUnmerged,
    // Judged: what got a verdict. A pull request still open has none, and counting it as a
    // refusal would read as one.
    decided: merged.length + closedUnmerged,
    // Measured over the rows, never read off their order. They arrive sorted by whichever of
    // merged_at, closed_at and created_at exists, so the last one is not the oldest.
    oldestOpenAt: earliest(open.map((row) => row.openedAt)),
    // The shape of the report's own merge times, so the tile can set one beside the other.
    timeToMerge: { merged: merged.length, timed: seconds.length, p50Seconds: gated(seconds, 'p50'), p90Seconds: gated(seconds, 'p90') },
    // Every pull request, the base the outcome bar is drawn over too. A project is counted on
    // the row, never on a name: a repository renamed between two contributions is still one.
    where: { ours: side(rows.filter((row) => row.own)), elsewhere: side(rows.filter((row) => !row.own)) },
    series,
    // Named under the curve: the pull requests counted in at its start, each by its first date -
    // an undated merge before the window among them, in the merged total and not the opened one.
    earlier: starts.filter((month) => month < months[0]).length,
    // In the merged curve and not in the opened one: nothing says which month they were opened in.
    undated: rows.filter((row) => asIso(row.openedAt) === null).length,
  };
};

/**
 * Where one person stands: since day one on what they got merged, and this month on what they
 * opened in it - the measure the report ranks this month's contributors on, so the rank and the
 * list cannot count different people
 *
 * Pure, from the standings getTopContributors() reads. A place only once there is something to
 * be placed on: no merge yet is no rank since day one, and nothing opened this month is no rank
 * in it.
 * @param {Array<Object>} standings - One row per person, from getStandings()
 * @param {string} login - Whose, in any case
 * @param {string} month - `2026-09`, the calendar month the standings were cut on
 * @returns {{ever: ?{position: number, of: number}, month: ?{position: number, of: number, month: string}}}
 */
export const rankOf = (standings, login, month) => {
  const inMonth = competitionRank(standings, (row) => row.openedMonth, login);

  return {
    ever: competitionRank(standings, (row) => row.mergedEver, login),
    month: inMonth && { ...inMonth, month },
  };
};

/**
 * What the Me tab draws: the reader's rows, the figures read off them, and where they stand
 *
 * Also what decides where a reader lands: the same query as the list, so the page can neither
 * open on an empty Me nor send somebody with rows to another tab. The rank and everyone's median
 * come from the report's cached build, and are never a reason to refuse the rows: without them
 * the rank reads "—" and the time to merge stands alone.
 * @param {string} login - The session's own login, never one the caller can name
 */
export const buildMine = async (login) => {
  const [contributions, parc] = await Promise.all([
    listContributionsForLogin(login),
    Promise.all([getStandings(), getReport()]).catch((error) => {
      logger.warn(
        { err: error, ...fields.user(login) },
        `the contributions of ${format.user(login)} are served without the contribution report: ${error.message}`
      );

      return null;
    }),
  ]);

  // Everyone's time to merge in the shape of the reader's own: its four figures, and not the
  // report's buckets beside them, which nothing on this tab draws.
  const [standings, report] = parc ?? [];
  const { merged, timed, p50Seconds, p90Seconds } = report?.mergeTimes ?? {};

  return {
    login,
    contributions,
    summary: summariseMine(contributions),
    rank: parc && rankOf(standings, login, report.contributors.month),
    everyone: parc && { merged, timed, p50Seconds, p90Seconds },
  };
};

/**
 * Serve the reader their own contributions
 *
 * The one route on this page whose answer differs per reader, and the reason it is not part of
 * the snapshot or of the report: both are shared, and this is not shareable - it is scoped to
 * the login in the session and to nothing the caller can name. There is no id in the path
 * precisely so that there is nothing to change to somebody else's.
 *
 * Reader tier. Your own contributions are the least privileged thing on this dashboard, and
 * the report already publishes the same pull requests in aggregate to everybody.
 *
 * Uncached, unlike the report: a per-reader answer has nobody to share a cache with. The query
 * filters on lower(opened_by), which idx_pull_requests_opened_by (on the raw column) cannot
 * serve, so it is one pass over the pull request table - paid on every reader's page load by the
 * landing rule, and by this route once per report window while Me or Overall is showing.
 */
export async function handleGetMyContributions(req, res) {
  try {
    const mine = await buildMine(req.dashboardLogin);

    res.set('Cache-Control', 'no-store');
    res.json({ ...mine, now: new Date().toISOString() });
  } catch (error) {
    logger.error(
      { err: error, ...fields.user(req.dashboardLogin) },
      `could not read the contributions of ${format.user(req.dashboardLogin)}: ${error.message}`
    );

    res.status(503).json({ error: 'your contributions could not be read', now: new Date().toISOString() });
  }
}
