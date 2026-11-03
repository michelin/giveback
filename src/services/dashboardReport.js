import {
  getContributionSummary,
  getContributionTotals,
  getMergeTimes,
  getMonthlySeries,
  getContributorSeries,
  getTopContributors,
  getOpenAges,
  getTopProjects,
  getBiggestFish,
  listPendingPullRequests,
} from "../db/contributions.js";
import { countInstallationStates } from "../db/installations.js";
import { getLogger, fields } from "../utils/logger.js";

const logger = getLogger("dashboardReport");

/**
 * How long a built report is served before it is built again
 *
 * The report answers a question about months, from a page that refreshes every five seconds.
 * Without this, opening the tab would put ten reads of the pull request table on that loop,
 * for figures that cannot have moved: the sync jobs run at most every five minutes.
 */
export const REPORT_TTL_MS = 60_000;

// How many of this month's contributors the report names: four logins, never the whole table it
// is cut from.
const MONTH_CONTRIBUTORS = 4;

/** The last built report and the standings beside it. Process-local, so a restart simply rebuilds. */
let cache = null;

/** The build under way: readers arriving together wait on that one instead of each starting their own. */
let building = null;

/**
 * This month's contributors, as the report names them: ranked on the pull requests they OPENED
 * this month, the same measure the Me tab ranks its reader's month on - so the list and the rank
 * count the same people, and `of` is one number on both.
 * @param {Array<Object>} standings - From getTopContributors()
 * @param {string} month - `2026-09`, the calendar month the standings were cut on
 */
const monthContributors = (standings, month) => {
  const active = standings
    .filter((row) => row.openedMonth > 0)
    .sort((a, b) => b.openedMonth - a.openedMonth || a.who.localeCompare(b.who));

  return {
    month,
    of: active.length,
    rows: active.slice(0, MONTH_CONTRIBUTORS).map((row) => ({
      login: row.login,
      opened: row.openedMonth,
      ours: row.oursMonth,
      elsewhere: row.elsewhereMonth,
    })),
  };
};

/**
 * Everything the contribution report draws, and the standings it is cut from
 *
 * Cached whole and shared by every reader: nothing in it depends on who asks. The standings
 * ride beside the report rather than in it, because they name every contributor and the page
 * names four.
 * @returns {Promise<{report: Object, standings: Array<Object>}>}
 */
const buildCache = async () => {
  const [
    summary, bots, mergeTimes, months, contributorSeries, standings, openAges, projects, biggestFish, pending, installations,
  ] = await Promise.all([
    getContributionSummary(),
    getContributionTotals(),
    getMergeTimes(),
    getMonthlySeries(),
    getContributorSeries(),
    getTopContributors(),
    getOpenAges(),
    getTopProjects(),
    getBiggestFish(),
    listPendingPullRequests(),
    countInstallationStates(),
  ]);

  const builtAt = new Date().toISOString();

  return {
    report: {
      builtAt,
      summary,
      // What the report leaves out: the pull requests a bot opened. Only the footnote reads it.
      bots,
      mergeTimes,
      months,
      contributorSeries,
      contributors: monthContributors(standings, builtAt.slice(0, 7)),
      openAges,
      projects,
      biggestFish,
      pending,
      // The accounts the sync reads, as countInstallationStates() has it: verified, installed,
      // not retired.
      installedAccounts: installations.active,
    },
    standings,
  };
};

/**
 * The cache, built at most once per REPORT_TTL_MS whoever asks
 * @returns {Promise<{report: Object, standings: Array<Object>}>}
 */
const current = async () => {
  if (cache && Date.now() - Date.parse(cache.report.builtAt) < REPORT_TTL_MS) {
    return cache;
  }

  building ??= buildCache()
    .then((built) => {
      cache = built;
      return built;
    })
    .finally(() => {
      building = null;
    });

  return building;
};

/**
 * The report
 *
 * The route and the page itself both read it: the page embeds it when it opens on this tab, and
 * its footnote counts from it on every tab.
 * @returns {Promise<Object>}
 */
export const getReport = async () => (await current()).report;

/**
 * Every contributor's standing, from the same build as the report
 *
 * For the server only - a reader's own rank is read off it. Never served: it names everybody
 * who ever opened a pull request here.
 * @returns {Promise<Array<Object>>} getTopContributors() rows
 */
export const getStandings = async () => (await current()).standings;

/**
 * Serve the contribution report
 *
 * Its own route rather than a section of the five-second snapshot, and its own cache: it
 * answers a question about months from a page that refreshes every five seconds. Served whole
 * to every reader: the pull requests it names are public, and the one thing it tells of the
 * machinery - whether the poll still reads a waiting one - is what that row says in words.
 */
export async function handleGetDashboardContributions(req, res) {
  try {
    const report = await getReport();

    res.set('Cache-Control', 'no-store');
    res.json({ ...report, now: new Date().toISOString() });
  } catch (error) {
    logger.error(
      { err: error, ...fields.user(req.dashboardLogin) },
      `could not build the contribution report: ${error.message}`
    );

    res.status(503).json({ error: 'the contribution report could not be read', now: new Date().toISOString() });
  }
}
