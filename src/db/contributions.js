import { query } from "./index.js";
import { OWN_GITHUB_ORGS, PERCENTILE_MIN_SAMPLE } from "../utils/constants.js";
import { IS_OWN, BY_A_PERSON } from "./predicates.js";

/**
 * Read-only reads for the contribution report.
 *
 * Separate from dashboard.js because the two answer different questions: that file is the
 * scheduler's own state, these scan the whole pull request table. Every one of them but
 * listContributionsForLogin() is read by buildCache() and kept in its 60-second cache, never
 * read for the five-second snapshot.
 *
 * Every query that reads IS_OWN, directly or through CONTRIBUTIONS, takes the owned-organisation
 * list as `$1`; getOpenAges() reads neither and takes nothing. An empty list is not a special
 * case: `= ANY('{}')` is false for every row, so everything is external and the split simply
 * does not appear.
 *
 * And every query here joins the registry, because a project is a ROW and not a name. Two
 * contributions to one repository that was renamed between them carry two different frozen
 * names on themselves; grouped by name they are two projects, grouped by the link they are one.
 */

/**
 * The join every query here opens with
 *
 * INNER, and that is a claim rather than a habit: `repository_id` is NOT NULL behind a foreign
 * key, so a contribution that could not join cannot exist. A LEFT JOIN returns the same rows
 * while that holds and keeps returning them if it ever stops, with a null where a project
 * should be.
 */
const REGISTRY = 'INNER JOIN github_repositories r ON r.id = p.repository_id';

// Two years is more history than the events feed can ever have collected, so this bounds the
// payload without ever being the reason a month is missing.
const MAX_MONTHS = 24;

// Who is contributing: long enough to see a trend, short enough that every month on it is one
// somebody remembers.
const CONTRIBUTOR_MONTHS = 8;

// A leaderboard is a podium, not a directory: past ten names nobody reads, and the tail is
// where a count of one sits beside a count of forty.
const TOP_PROJECTS = 6;

// The trophies, every contributor of each named: three projects, never a directory of them.
const BIGGEST_FISH = 3;

// The oldest of what is waiting, with their authors: the ten a reader can go and chase, not the
// whole backlog with everybody's name on it.
const OLDEST_PENDING = 10;

const owners = () => [OWN_GITHUB_ORGS];

// What every aggregate below reads: a contribution, tagged with whose repository it landed on.
// Columns are listed rather than `p.*` so the frozen names stay out of reach.
const CONTRIBUTIONS = `
    SELECT p.repository_id, p.opened_by, p.user_type, p.merged, p.merged_at, p.created_at,
           p.state, p.commits_count, ${IS_OWN} AS own
    FROM github_pull_requests p
    ${REGISTRY}`;

/**
 * Whether the poll still reads an open pull request
 *
 * The claim's own predicates (claimPullRequestsForPoll() in polling.js): collected from GitHub
 * rather than typed in, and opened by a login with a verified installation that is neither
 * suspended nor gone. Once its author is suspended, uninstalls or is renamed, a pull request is
 * never read again and stays open here for ever.
 *
 * On the exact login, as the claim joins: a pull request whose author the poll cannot match is
 * one it does not read, whatever the case of the two spellings.
 *
 * A tag, selected `AS followed` and never filtered on: those pull requests are still waiting,
 * and a figure that dropped them would say fewer are.
 */
const FOLLOWED = `(p.origin = 'github' AND EXISTS (
      SELECT 1
      FROM github_installations gi
      WHERE gi.user_login = p.opened_by
        AND gi.verified_at IS NOT NULL
        AND gi.installation_id IS NOT NULL
        AND gi.installation_suspended = false
        AND gi.installation_deleted = false
    ))`;

/**
 * Pull request totals, told three times: the ecosystem, the company's own repositories, and the
 * whole
 *
 * `stillOpen` is deliberately not derived as `opened - merged - closedUnmerged`: a pull request
 * merged and then reopened is real, rare, and would make that subtraction negative.
 * @returns {Promise<{external: Object, own: Object, all: Object}>}
 */
export const getContributionSummary = async () => {
  // GROUPING SETS, so the combined figures come from the same scan as the two halves.
  const queryText = `
    WITH tagged AS (${CONTRIBUTIONS})
    SELECT p.own,
           count(*)::int AS opened,
           count(*) FILTER (WHERE p.merged = true)::int AS merged_count,
           count(*) FILTER (WHERE p.state = 'closed' AND p.merged IS DISTINCT FROM true)::int AS closed_unmerged,
           count(*) FILTER (WHERE p.state IS DISTINCT FROM 'closed')::int AS still_open,
           -- Counted on the link, never on a name. A repository renamed between two
           -- contributions carries two different frozen names, and is one project.
           count(DISTINCT p.repository_id)::int AS repositories
    FROM tagged p
    WHERE ${BY_A_PERSON}
    GROUP BY GROUPING SETS ((p.own), ())
  `;

  const empty = { opened: 0, merged: 0, closedUnmerged: 0, stillOpen: 0, repositories: 0 };

  try {
    const result = await query(queryText, owners());

    const shape = (row) => (row ? {
      opened: row.opened,
      merged: row.merged_count,
      closedUnmerged: row.closed_unmerged,
      stillOpen: row.still_open,
      repositories: row.repositories,
    } : { ...empty });

    return {
      external: shape(result.rows.find((row) => row.own === false)),
      own: shape(result.rows.find((row) => row.own === true)),
      // The grouping set with no key: own is NULL on that row.
      all: shape(result.rows.find((row) => row.own === null)),
    };
  } catch (cause) {
    throw new Error('could not read the contribution summary', { cause });
  }
};

/**
 * How long merged pull requests took to merge, and how many commits they carried
 *
 * Merged only, over the whole: the page draws both bars for every pull request a person got
 * merged, ours and elsewhere together, and nothing reads a half.
 *
 * `timed` is not `merged`: a contribution typed in by hand may have no opening date, and a clock
 * skewed on either side can put a merge before its opening. Neither has a duration, so neither is
 * in the percentiles or the bands, and the page says how many were timed. The same goes for the
 * commit bands, which leave out a count nobody recorded (`counted`) - "1" is at most one, since
 * an entry by hand may say zero.
 *
 * The percentiles are percentile_cont's, and gated here rather than in SQL: PERCENTILE_MIN_SAMPLE
 * applies to the number timed, which the query only knows once it has counted it.
 * @returns {Promise<Object>}
 */
export const getMergeTimes = async () => {
  const queryText = `
    WITH tagged AS (${CONTRIBUTIONS}),
    measured AS (
      SELECT p.commits_count,
             extract(epoch FROM p.merged_at - p.created_at)::float8 AS seconds
      FROM tagged p
      WHERE ${BY_A_PERSON} AND p.merged AND p.merged_at IS NOT NULL
    )
    SELECT count(*)::int AS merged_count,
           count(*) FILTER (WHERE m.seconds >= 0)::int AS timed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY m.seconds) FILTER (WHERE m.seconds >= 0) AS p50_seconds,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY m.seconds) FILTER (WHERE m.seconds >= 0) AS p90_seconds,
           count(*) FILTER (WHERE m.seconds >= 0 AND m.seconds < 86400)::int AS under_1d,
           count(*) FILTER (WHERE m.seconds >= 86400 AND m.seconds < 7 * 86400)::int AS days_1_7,
           count(*) FILTER (WHERE m.seconds >= 7 * 86400 AND m.seconds < 30 * 86400)::int AS days_7_30,
           count(*) FILTER (WHERE m.seconds >= 30 * 86400)::int AS over_30d,
           count(m.commits_count)::int AS with_commits,
           count(*) FILTER (WHERE m.commits_count <= 1)::int AS commits_1,
           count(*) FILTER (WHERE m.commits_count BETWEEN 2 AND 3)::int AS commits_2_3,
           count(*) FILTER (WHERE m.commits_count BETWEEN 4 AND 9)::int AS commits_4_9,
           count(*) FILTER (WHERE m.commits_count >= 10)::int AS commits_10_plus
    FROM measured m
  `;

  const shape = (row) => ({
    merged: row?.merged_count ?? 0,
    timed: row?.timed ?? 0,
    p50Seconds: row?.p50_seconds ?? null,
    p90Seconds: row?.p90_seconds ?? null,
    durations: {
      under1d: row?.under_1d ?? 0,
      days1to7: row?.days_1_7 ?? 0,
      days7to30: row?.days_7_30 ?? 0,
      over30d: row?.over_30d ?? 0,
    },
    commits: {
      counted: row?.with_commits ?? 0,
      one: row?.commits_1 ?? 0,
      twoToThree: row?.commits_2_3 ?? 0,
      fourToNine: row?.commits_4_9 ?? 0,
      tenPlus: row?.commits_10_plus ?? 0,
    },
  });

  try {
    const { rows } = await query(queryText, owners());
    const times = shape(rows[0]);

    return {
      ...times,
      p50Seconds: times.timed >= PERCENTILE_MIN_SAMPLE.p50 ? times.p50Seconds : null,
      p90Seconds: times.timed >= PERCENTILE_MIN_SAMPLE.p90 ? times.p90Seconds : null,
    };
  } catch (cause) {
    throw new Error('could not read the merge times', { cause });
  }
};

/**
 * Opened and merged per calendar month
 *
 * Four series, in two pairs: what was opened and what landed, told once for the wider ecosystem
 * and once for the repositories the company owns. Two pairs rather than one total, because they
 * are two different claims and adding them up makes the smaller one disappear — the internal
 * pair is the larger of the two, and a single curve would read as open-source contribution.
 *
 * Each series is counted on its own date — opened on `created_at`, merged on `merged_at` — so a
 * pull request opened in January and merged in March appears in both, at its place in each. Any
 * other treatment hides the distance between proposing and being accepted, which is the one
 * thing this chart is for.
 *
 * Months with no activity are generated rather than skipped: a gap that closes up turns a
 * quiet month into a missing one and the axis stops being a timeline. They are cut in UTC, the
 * calendar the page labels them with and the standings are cut in, whatever the session's zone.
 * @returns {Promise<Array<{month: string, opened: number, merged: number, ownOpened: number,
 *   ownMerged: number}>>} `opened` and `merged` are the ecosystem half; the `own` pair is ours
 */
export const getMonthlySeries = async () => {
  const queryText = `
    WITH tagged AS (
      SELECT p.created_at, p.merged_at, ${IS_OWN} AS own
      FROM github_pull_requests p
      ${REGISTRY}
      WHERE ${BY_A_PERSON}
    ),
    opened AS (
      SELECT date_trunc('month', created_at AT TIME ZONE 'UTC') AS month,
             count(*) FILTER (WHERE NOT own)::int AS opened,
             count(*) FILTER (WHERE own)::int AS own_opened
      FROM tagged
      WHERE created_at IS NOT NULL
      GROUP BY 1
    ),
    landed AS (
      SELECT date_trunc('month', merged_at AT TIME ZONE 'UTC') AS month,
             count(*) FILTER (WHERE NOT own)::int AS merged,
             count(*) FILTER (WHERE own)::int AS own_merged
      FROM tagged
      WHERE merged_at IS NOT NULL
      GROUP BY 1
    ),
    span AS (
      SELECT min(month) AS first_month
      FROM (SELECT month FROM opened UNION ALL SELECT month FROM landed) every_month
    ),
    months AS (
      SELECT generate_series(
               greatest(first_month, date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - make_interval(months => $2::int - 1)),
               date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
               interval '1 month'
             ) AS month
      FROM span
      WHERE first_month IS NOT NULL
    )
    SELECT to_char(m.month, 'YYYY-MM') AS month,
           coalesce(o.opened, 0) AS opened,
           coalesce(l.merged, 0) AS merged,
           coalesce(o.own_opened, 0) AS own_opened,
           coalesce(l.own_merged, 0) AS own_merged
    FROM months m
    LEFT JOIN opened o ON o.month = m.month
    LEFT JOIN landed l ON l.month = m.month
    ORDER BY m.month
  `;

  try {
    const result = await query(queryText, [...owners(), MAX_MONTHS]);

    return result.rows.map((row) => ({
      month: row.month,
      opened: row.opened,
      merged: row.merged,
      ownOpened: row.own_opened,
      ownMerged: row.own_merged,
    }));
  } catch (cause) {
    throw new Error('could not read the monthly contribution series', { cause });
  }
};

/**
 * How many people opened a pull request in each of the last months, and how many of them for
 * the first time
 *
 * Every month of the window, the one in progress last, generated rather than read off the data:
 * a month nobody opened anything is a zero on the axis, not a gap in it. Cut in UTC, like the
 * month series beside it.
 *
 * A person is `lower(opened_by)`, as everywhere a login is counted, and a first-time contributor
 * is one whose first pull request recorded here was opened that month - so a newcomer counts once,
 * in one month, and a person enrolled after years of open source is new here all the same.
 * Counted, never named: the numbers leave, the logins do not.
 * @param {number} [months] - How many, this one included
 * @returns {Promise<Array<{month: string, contributors: number, firstTime: number}>>} Oldest first
 */
export const getContributorSeries = async (months = CONTRIBUTOR_MONTHS) => {
  const queryText = `
    WITH tagged AS (${CONTRIBUTIONS}),
    months AS (
      SELECT generate_series(
               date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - make_interval(months => $2::int - 1),
               date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
               interval '1 month'
             ) AS month
    ),
    active AS (
      SELECT date_trunc('month', p.created_at AT TIME ZONE 'UTC') AS month,
             count(DISTINCT lower(p.opened_by))::int AS contributors
      FROM tagged p
      WHERE ${BY_A_PERSON}
      GROUP BY 1
    ),
    newcomers AS (
      SELECT first_month AS month, count(*)::int AS first_time
      FROM (
        SELECT min(date_trunc('month', p.created_at AT TIME ZONE 'UTC')) AS first_month
        FROM tagged p
        WHERE ${BY_A_PERSON} AND p.opened_by IS NOT NULL
        GROUP BY lower(p.opened_by)
      ) firsts
      GROUP BY 1
    )
    SELECT to_char(m.month, 'YYYY-MM') AS month,
           coalesce(a.contributors, 0) AS contributors,
           coalesce(n.first_time, 0) AS first_time
    FROM months m
    LEFT JOIN active a ON a.month = m.month
    LEFT JOIN newcomers n ON n.month = m.month
    ORDER BY m.month
  `;

  try {
    const result = await query(queryText, [...owners(), months]);

    return result.rows.map((row) => ({
      month: row.month,
      contributors: row.contributors,
      firstTime: row.first_time,
    }));
  } catch (cause) {
    throw new Error("could not read the contributors' series", { cause });
  }
};

/**
 * How long what is still open has been waiting, and how much of it nobody polls any more
 *
 * Over the whole, ours and elsewhere together: the age bar is one bar, and the list under it
 * splits by scope from its own rows. The ages are bands from the opening, and the pull requests
 * the poll no longer reads (FOLLOWED) are counted in them like any other: they are still waiting.
 * @returns {Promise<Object>}
 */
export const getOpenAges = async () => {
  const queryText = `
    WITH waiting AS (
      SELECT CURRENT_TIMESTAMP - p.created_at AS age,
             ${FOLLOWED} AS followed
      FROM github_pull_requests p
      ${REGISTRY}
      WHERE ${BY_A_PERSON} AND p.state IS DISTINCT FROM 'closed'
    )
    SELECT count(*)::int AS open_count,
           count(*) FILTER (WHERE w.age < interval '7 days')::int AS under_7d,
           count(*) FILTER (WHERE w.age >= interval '7 days' AND w.age < interval '30 days')::int AS days_7_30,
           count(*) FILTER (WHERE w.age >= interval '30 days' AND w.age < interval '90 days')::int AS days_30_90,
           count(*) FILTER (WHERE w.age >= interval '90 days')::int AS over_90d,
           count(*) FILTER (WHERE NOT w.followed)::int AS not_followed
    FROM waiting w
  `;

  const shape = (row) => ({
    open: row?.open_count ?? 0,
    under7d: row?.under_7d ?? 0,
    days7to30: row?.days_7_30 ?? 0,
    days30to90: row?.days_30_90 ?? 0,
    over90d: row?.over_90d ?? 0,
    notFollowed: row?.not_followed ?? 0,
  });

  try {
    const { rows } = await query(queryText);

    return shape(rows[0]);
  } catch (cause) {
    throw new Error('could not read how long the open pull requests have waited', { cause });
  }
};

/**
 * Everybody's standing, one row per person: what they ever got merged, and what they opened
 * this calendar month
 *
 * The whole table, not a podium. It is never served as such - the report keeps it beside itself
 * and names only the top of this month, and the Me tab reads its reader's own two places from it.
 * One read for both, so the rank a person is told and the list they would find themselves in
 * cannot count different things.
 *
 * A person is `lower(opened_by)`, as everywhere a login is matched, and the login shown is the
 * spelling of their newest pull request. No join to the installations: `user_login` is not
 * unique and was matched on its exact case, so the join could split one person in two or drop
 * them. The month is cut in UTC, the same calendar the page labels it with.
 *
 * Both halves, split rather than filtered: a pull request on a repository we publish is still
 * somebody's month.
 * @returns {Promise<Array<{who: string, login: string, mergedEver: number, openedMonth: number,
 *   oursMonth: number, elsewhereMonth: number}>>}
 */
export const getTopContributors = async () => {
  const queryText = `
    WITH tagged AS (${CONTRIBUTIONS}),
    month AS (
      SELECT date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS starts,
             date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 month' AS ends
    )
    SELECT lower(p.opened_by) AS who,
           (array_agg(p.opened_by ORDER BY p.created_at DESC NULLS LAST))[1] AS login,
           count(*) FILTER (WHERE p.merged)::int AS merged_ever,
           count(*) FILTER (WHERE p.created_at AT TIME ZONE 'UTC' >= m.starts
             AND p.created_at AT TIME ZONE 'UTC' < m.ends)::int AS opened_month,
           count(*) FILTER (WHERE p.own AND p.created_at AT TIME ZONE 'UTC' >= m.starts
             AND p.created_at AT TIME ZONE 'UTC' < m.ends)::int AS ours_month,
           count(*) FILTER (WHERE NOT p.own AND p.created_at AT TIME ZONE 'UTC' >= m.starts
             AND p.created_at AT TIME ZONE 'UTC' < m.ends)::int AS elsewhere_month
    FROM tagged p
    CROSS JOIN month m
    WHERE ${BY_A_PERSON}
      AND p.opened_by IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `;

  try {
    const result = await query(queryText, owners());

    return result.rows.map((row) => ({
      who: row.who,
      login: row.login,
      mergedEver: row.merged_ever,
      openedMonth: row.opened_month,
      oursMonth: row.ours_month,
      elsewhereMonth: row.elsewhere_month,
    }));
  } catch (cause) {
    throw new Error("could not read the contributors' standings", { cause });
  }
};

/**
 * The pull requests the report leaves out, because a bot opened them
 *
 * No filter at all, and the one read here without BY_A_PERSON: it exists to count exactly what
 * that predicate drops, so the page can say how much of the table it is not measuring.
 * @returns {Promise<{byABot: number, mergedByABot: number}>}
 */
export const getContributionTotals = async () => {
  const queryText = `
    WITH tagged AS (${CONTRIBUTIONS})
    SELECT count(*) FILTER (WHERE p.user_type IS DISTINCT FROM 'User')::int AS by_a_bot,
           count(*) FILTER (WHERE p.user_type IS DISTINCT FROM 'User' AND p.merged)::int AS merged_by_a_bot
    FROM tagged p
  `;

  try {
    const row = (await query(queryText, owners())).rows[0];

    return {
      byABot: row.by_a_bot,
      mergedByABot: row.merged_by_a_bot,
    };
  } catch (cause) {
    throw new Error('could not read the contribution totals', { cause });
  }
};

/**
 * The repositories our people got the most merged into, ours and the ecosystem alike
 *
 * Only those with a merge: a project where forty pull requests landed is a bigger commitment
 * than one where forty are waiting, and one where nothing landed is not on a ranking of merges.
 * Beside the merges, what is still open there and what was closed without one, so a row says
 * how the rest went too. `people` are the persons with a merge there, counted once whatever the
 * case of their login.
 *
 * The star count is today's, as getBiggestFish() reads it: the repository's own, and the
 * contribution-time snapshot on the pull request only until the first refresh has run.
 * @param {number} [limit] - How many of the top
 * @returns {Promise<Array<{repositoryId: number, repo: string, url: ?string, own: boolean,
 *   stars: ?number, merged: number, stillOpen: number, closedUnmerged: number, people: number,
 *   of: number}>>} `of` is the same on every row: how many projects have a merge
 */
export const getTopProjects = async (limit = TOP_PROJECTS) => {
  const queryText = `
    SELECT r.id AS repository_id,
           r.full_name AS repo,
           -- The address the refresh stored, so the page never builds a link out of a name. Null
           -- for a project no refresh has read yet, or can: the page then names it unlinked.
           r.html_url AS url,
           ${IS_OWN} AS own,
           -- The repository's own value, selected bare inside coalesce(): grouping by its primary
           -- key makes every other column of it functionally dependent.
           coalesce(r.stargazers_count, max(p.stargazers_count))::int AS stars,
           count(*) FILTER (WHERE p.merged)::int AS merged_count,
           count(*) FILTER (WHERE p.state IS DISTINCT FROM 'closed')::int AS still_open,
           count(*) FILTER (WHERE p.state = 'closed' AND p.merged IS DISTINCT FROM true)::int AS closed_unmerged,
           count(DISTINCT lower(p.opened_by)) FILTER (WHERE p.merged)::int AS people,
           -- Every project with a merge, counted before the LIMIT keeps the top of them.
           count(*) OVER ()::int AS ranked
    FROM github_pull_requests p
    ${REGISTRY}
    WHERE ${BY_A_PERSON}
    GROUP BY r.id
    HAVING count(*) FILTER (WHERE p.merged) > 0
    ORDER BY merged_count DESC, repo ASC
    LIMIT $2
  `;

  try {
    const result = await query(queryText, [...owners(), limit]);

    return result.rows.map((row) => ({
      // The project as a row, which is what a reader's own contributions are matched on.
      repositoryId: row.repository_id,
      repo: row.repo,
      url: row.url ?? null,
      own: row.own,
      stars: row.stars,
      merged: row.merged_count,
      stillOpen: row.still_open,
      closedUnmerged: row.closed_unmerged,
      people: row.people,
      of: row.ranked,
    }));
  } catch (cause) {
    throw new Error('could not read the most contributed projects', { cause });
  }
};

/**
 * The most-starred external projects with a merged pull request, and everyone who got one in
 *
 * Merged only. An unmerged pull request on a famous repository is an intention, and a trophy
 * cabinet built on intentions is worth nothing.
 *
 * The star count is today's, read from github_repositories, which the repository refresh keeps
 * current whether or not anyone still has an open pull request there. The contribution-time
 * snapshot on the pull request is only the fallback, until the first refresh has run.
 *
 * Each person once, whatever the case of their login, under the spelling of their newest pull
 * request there.
 * @param {number} [limit] - How many projects
 * @returns {Promise<Array<{repositoryId: number, repo: string, url: ?string, stars: ?number,
 *   merged: number, firstMergedAt: Date, contributors: Array<{login: string, merged: number}>}>>}
 *   Most starred first
 */
export const getBiggestFish = async (limit = BIGGEST_FISH) => {
  const queryText = `
    WITH winners AS (
      SELECT r.id AS repository_id,
             r.full_name AS repo,
             -- The stored address, as getTopProjects() reads it: never a link built from a name.
             r.html_url AS url,
             -- Today's figure, from the repository. Falling back to the contribution-time
             -- snapshot only until the first refresh has run.
             coalesce(r.stargazers_count, max(p.stargazers_count))::int AS stars,
             count(*)::int AS merged_count,
             min(p.merged_at) AS first_merged_at
      FROM github_pull_requests p
      ${REGISTRY}
      WHERE ${BY_A_PERSON} AND p.merged = true AND NOT (${IS_OWN})
      GROUP BY r.id
      ORDER BY stars DESC NULLS LAST, merged_count DESC, repo ASC
      LIMIT $2
    )
    SELECT w.repository_id, w.repo, w.url, w.stars, w.merged_count, w.first_merged_at,
           (array_agg(p.opened_by ORDER BY p.created_at DESC NULLS LAST))[1] AS login,
           count(*)::int AS their_merged
    FROM winners w
    -- On the winner's id, never on its name. Written on a name, this join splits one project in
    -- two the day it is renamed, and each half gets its own trophy.
    JOIN github_pull_requests p
      ON p.repository_id = w.repository_id AND p.merged = true AND ${BY_A_PERSON} AND p.opened_by IS NOT NULL
    GROUP BY w.repository_id, w.repo, w.url, w.stars, w.merged_count, w.first_merged_at, lower(p.opened_by)
    -- The project's id before anything about a person: the fold below takes a project's rows as
    -- the ones in a row.
    ORDER BY w.stars DESC NULLS LAST, w.merged_count DESC, w.repo ASC, w.repository_id, their_merged DESC, login ASC
  `;

  try {
    const { rows } = await query(queryText, [...owners(), limit]);
    const projects = [];

    // One row per person per project, the projects in their order: folded back into one each.
    for (const row of rows) {
      if (projects.at(-1)?.repositoryId !== row.repository_id) {
        projects.push({
          repositoryId: row.repository_id,
          repo: row.repo,
          url: row.url ?? null,
          stars: row.stars,
          merged: row.merged_count,
          firstMergedAt: row.first_merged_at,
          contributors: [],
        });
      }

      projects.at(-1).contributors.push({ login: row.login, merged: row.their_merged });
    }

    return projects;
  } catch (cause) {
    throw new Error('could not read the most starred contributed projects', { cause });
  }
};

/**
 * The pull requests that have waited longest for a verdict
 *
 * Oldest first because the old ones are the information. A list headed by this morning's pull
 * request says the team is active; one headed by a pull request opened in March says nobody
 * went back.
 *
 * Owned repositories are included and flagged rather than filtered out: a pull request rotting
 * on a repository the company publishes is its own kind of problem, and hiding it here would
 * be the one place the split makes things worse. So is what the poll no longer reads (FOLLOWED),
 * which is what rots the longest.
 * @param {number} [limit] - How many of the oldest
 * @returns {Promise<Array<Object>>}
 */
export const listPendingPullRequests = async (limit = OLDEST_PENDING) => {
  const queryText = `
    SELECT p.pull_request_id,
           p.number,
           p.title,
           r.full_name AS repo,
           -- The contribution's own address, stored when it was hydrated. The only read here
           -- that returns individual pull requests, so the only one where the column is worth
           -- selecting - and the reason it exists: a consumer holding a name and a number would
           -- assemble the link itself, and a rename breaks every one it assembled.
           p.html_url,
           p.created_at,
           p.opened_by AS login,
           ${IS_OWN} AS own,
           ${FOLLOWED} AS followed
    FROM github_pull_requests p
    ${REGISTRY}
    WHERE ${BY_A_PERSON} AND p.state IS DISTINCT FROM 'closed'
    ORDER BY p.created_at ASC NULLS LAST
    LIMIT $2
  `;

  try {
    const result = await query(queryText, [...owners(), limit]);

    return result.rows.map((row) => ({
      id: Number(row.pull_request_id),
      number: row.number,
      title: row.title,
      repo: row.repo,
      url: row.html_url ?? null,
      openedAt: row.created_at ?? null,
      login: row.login,
      own: row.own,
      followed: row.followed,
    }));
  } catch (cause) {
    throw new Error('could not list the pull requests awaiting a verdict', { cause });
  }
};

/**
 * Every contribution recorded under one login, for that person to read
 *
 * The only query in this file that is not an aggregate, and the only one answering about ONE
 * person: everything else on the report is the parc. It returns rows rather than figures
 * because the tab draws four things from the same list - the tiles, the curve, the bars and the
 * rows - and four scans of one table to answer one question would be four chances to disagree.
 *
 * Bounded by the person: the busiest account in production has 248 contributions and the median
 * has three, so there is no LIMIT here. A limit would silently truncate the ONE list somebody
 * checks against their own memory.
 *
 * `lower()` on both sides, as everywhere the frozen `opened_by` is joined to a login. The
 * hazard it does not fix is the one this tab will show first: a login GitHub has since renamed
 * matches nothing, and the person sees an empty page. The empty state has to say which of the
 * two it is.
 * @param {string} login - The viewer's own GitHub login, from their session
 */
export const listContributionsForLogin = async (login) => {
  // Newest first by whichever of the three dates says what became of it last: a merge, a close
  // without one, or the opening of one still waiting - so an open pull request sits among the
  // others at the date it was opened, not at the end of the list.
  const queryText = `
    SELECT p.pull_request_id, p.number, p.title, p.html_url, r.full_name AS repo, p.repository_id,
           p.created_at, p.merged_at, p.closed_at, p.merged, p.state,
           p.commits_count, p.origin,
           ${IS_OWN} AS own
    FROM github_pull_requests p
    ${REGISTRY}
    WHERE ${BY_A_PERSON} AND lower(p.opened_by) = lower($2)
    ORDER BY coalesce(p.merged_at, p.closed_at, p.created_at) DESC NULLS LAST, p.number DESC
  `;

  try {
    const result = await query(queryText, [...owners(), login]);

    return result.rows.map((row) => ({
      id: Number(row.pull_request_id),
      number: row.number,
      title: row.title,
      repo: row.repo,
      // The project as a row, which is what two of these are compared on: the name above is
      // today's, and a rename between two contributions must not make them two projects.
      repositoryId: Number(row.repository_id),
      url: row.html_url ?? null,
      openedAt: row.created_at ?? null,
      mergedAt: row.merged_at ?? null,
      closedAt: row.closed_at ?? null,
      merged: row.merged === true,
      state: row.state,
      commits: row.commits_count,
      // The one field that is about HOW it got here rather than what it is: a contribution an
      // operator typed in is still the person's contribution, and it is labelled, not hidden.
      recordedByHand: row.origin === 'manual',
      own: row.own,
      // Read off the address, as listManualContributions() does: there is no forge column. Only
      // an entry by hand can be anywhere else - the sync reads GitHub alone.
      forge: row.origin === 'manual' && !String(row.html_url ?? '').startsWith('https://github.com/') ? 'gitlab' : 'github',
    }));
  } catch (cause) {
    throw new Error(`could not list the contributions of ${login}`, { cause });
  }
};
