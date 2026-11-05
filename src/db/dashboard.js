import { query } from "./index.js";
import { CRON, OWN_GITHUB_ORGS, SCHEDULING } from "../utils/constants.js";
import { tickMinutes } from "../utils/cron.js";
import { intervalLadder } from "../utils/backoff.js";
import { IS_OWN, BY_A_PERSON } from "./predicates.js";

/**
 * Read-only reads for the dashboard.
 *
 * Read for the Operations tab, which only the operator tier is sent — see isOperator().
 * listUsers() is the one read that carries an enrollment address.
 */

const owners = () => [OWN_GITHUB_ORGS];

/**
 * How long a due subject waits for the next run of its queue, by construction: overdue is due
 * before the last tick. An unreadable cron has no tick to wait for, and late is then late at once.
 */
export const TICK_MINUTES = Object.freeze({ sync: tickMinutes(CRON.SYNC) ?? 0, poll: tickMinutes(CRON.POLL) ?? 0 });

/**
 * The track's axis past NOW, and the windows its lanes are counted in: the ladder the adaptive
 * interval climbs, from the lower of the two floors to the higher of the two ceilings, so the
 * histogram and the scheduler describe the same thing. Derived rather than listed, so moving a
 * bound moves the axis with it.
 */
export const QUEUE_EDGES_MINUTES = Object.freeze(intervalLadder({
  min: Math.min(SCHEDULING.SYNC_MIN_INTERVAL_MINUTES, SCHEDULING.POLL_MIN_INTERVAL_MINUTES),
  max: Math.max(SCHEDULING.SYNC_MAX_INTERVAL_MINUTES, SCHEDULING.POLL_MAX_INTERVAL_MINUTES),
}));

// Above this the histogram still describes the whole parc and the page says how many it is not
// showing - four thousand dots on a canvas is not more informative than three hundred.
const TRACK_SUBJECTS = 300;

// Exactly the rows claimInstallationsForSync() considers. One string, so a drift between the
// queue the page draws and the queue the job drains is a one-line fix.
//
// sync_disabled_at and installation_id are load-bearing: without them the page draws retired
// rows no run will drain, and the predicate stops matching idx_installations_due_for_sync -
// a sequential scan, on a page that polls every five seconds.
const SYNCABLE = `verified_at IS NOT NULL
    AND installation_suspended = false
    AND installation_deleted = false
    AND installation_id IS NOT NULL
    AND sync_disabled_at IS NULL`;

// Exactly the rows claimPullRequestsForPoll() considers, minus the join on the installation:
// a pull request whose author has left is not in the queue, and the count below would
// otherwise show a backlog that no job will ever drain. No BY_A_PERSON beside it: an enrolled
// author is already required, and no bot has an installation.
const POLLABLE = `state IS DISTINCT FROM 'closed'
    -- Both predicates of claimPullRequestsForPoll(), or this page reports a queue depth the
    -- poller will never work through: a hand-entered contribution has nothing to fetch.
    AND origin = 'github'
    AND EXISTS (
      SELECT 1 FROM github_installations gi
      WHERE gi.user_login = github_pull_requests.opened_by
        AND gi.verified_at IS NOT NULL
        AND gi.installation_id IS NOT NULL
        AND gi.installation_suspended = false
        AND gi.installation_deleted = false
    )`;

/**
 * Every subject the two claims consider, one row each, in one shape - the sync queue and the
 * poll queue side by side, on one clock
 *
 * `due` is the claim's own due time or, for a subject never scheduled yet, when this application
 * recorded it: the claim reads a NULL as due, so a subject nobody has synchronised or polled has
 * been waiting since it appeared, and that is how late it is. `claimed` honours the lease the
 * way the claims do: a claim older than CLAIM_LEASE_MINUTES is a dead worker's, and the next run
 * takes the row again. $1 is the lease.
 *
 * The pull request table is not aliased: POLLABLE spells out `github_pull_requests.opened_by`,
 * which an alias would stop resolving. The registry is what names the subject - its current
 * name, the one frozen on the contribution being what it was called then.
 */
const SUBJECTS = `
  WITH listed AS (
    SELECT 'sync' AS kind, id, user_login AS label, next_sync_at AS due_at,
           created_timestamp AS recorded_at, sync_claimed_at AS claimed_at,
           sync_interval_minutes AS interval_minutes, sync_error_count AS errors
    FROM github_installations
    WHERE ${SYNCABLE}
    UNION ALL
    SELECT 'poll', github_pull_requests.id, r.full_name || '#' || github_pull_requests.number, next_poll_at,
           github_pull_requests.created_timestamp, poll_claimed_at,
           poll_interval_minutes, poll_error_count
    FROM github_pull_requests
    INNER JOIN github_repositories r ON r.id = github_pull_requests.repository_id
    WHERE ${POLLABLE}
  ),
  subjects AS (
    SELECT listed.*,
           coalesce(due_at, recorded_at) AS due,
           coalesce(claimed_at >= CURRENT_TIMESTAMP - make_interval(mins => $1::int), false) AS claimed
    FROM listed
  )`;

/** One subject as the page draws it. */
const subjectOf = (row) => ({
  kind: row.kind,
  id: Number(row.id),
  label: row.label,
  dueAt: row.due,
  claimed: row.claimed,
  errors: row.errors,
  interval: row.interval_minutes,
});

/**
 * What state every subject of both queues is in, and the one that has waited longest
 *
 * One pass, and one state per subject, in the order that decides it: claimed, then overdue,
 * then in error backoff, then on schedule. So the four add up to what is tracked, and a claimed
 * subject is never also counted late. Overdue means due before the last tick: a subject that
 * fell due since is waiting for the next one by construction, and is on schedule.
 * @returns {Promise<{sync: Object, poll: Object, oldestLate: ?Object}>} Per queue: tracked,
 *   overdue, overdueOnFloor, claimed, oldestClaimAt, backoff, onSchedule
 */
export const getSubjectStates = async () => {
  const queryText = `
    ${SUBJECTS},
    placed AS (
      SELECT subjects.*,
             CASE
               WHEN claimed THEN 'claimed'
               WHEN due < CURRENT_TIMESTAMP - make_interval(secs => 60 * CASE kind WHEN 'sync' THEN $2::float8 ELSE $3::float8 END)
                 THEN 'overdue'
               WHEN errors > 0 THEN 'backoff'
               ELSE 'ontime'
             END AS state,
             -- A failing subject waits its error backoff, never the floor, whatever interval it
             -- kept: the queue draws it on the rung of that wait.
             errors = 0 AND coalesce(interval_minutes, 0) <= CASE kind WHEN 'sync' THEN $4::int ELSE $5::int END AS on_floor
      FROM subjects
    ),
    oldest AS (
      SELECT kind, id, label, due, interval_minutes, errors
      FROM placed
      WHERE state = 'overdue'
      ORDER BY due, kind, id
      LIMIT 1
    )
    SELECT k.kind,
           count(p.kind)::int AS tracked,
           count(*) FILTER (WHERE p.state = 'overdue')::int AS overdue,
           count(*) FILTER (WHERE p.state = 'overdue' AND p.on_floor)::int AS overdue_on_floor,
           count(*) FILTER (WHERE p.state = 'claimed')::int AS claimed,
           min(p.claimed_at) FILTER (WHERE p.state = 'claimed') AS oldest_claim_at,
           count(*) FILTER (WHERE p.state = 'backoff')::int AS backoff,
           count(*) FILTER (WHERE p.state = 'ontime')::int AS on_schedule,
           -- On its own queue's row only, and on neither when nothing is late.
           o.id AS late_id, o.label AS late_label, o.due AS late_due,
           o.interval_minutes AS late_interval, o.errors AS late_errors
    FROM (VALUES ('sync'), ('poll')) AS k(kind)
    LEFT JOIN placed p ON p.kind = k.kind
    LEFT JOIN oldest o ON o.kind = k.kind
    GROUP BY k.kind, o.id, o.label, o.due, o.interval_minutes, o.errors
  `;

  try {
    const { rows } = await query(queryText, [
      SCHEDULING.CLAIM_LEASE_MINUTES,
      TICK_MINUTES.sync,
      TICK_MINUTES.poll,
      SCHEDULING.SYNC_MIN_INTERVAL_MINUTES,
      SCHEDULING.POLL_MIN_INTERVAL_MINUTES,
    ]);
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
    const late = rows.find((row) => row.late_id !== null);

    return {
      ...Object.fromEntries(['sync', 'poll'].map((kind) => {
        const row = byKind[kind];

        return [kind, {
          tracked: row.tracked,
          overdue: row.overdue,
          overdueOnFloor: row.overdue_on_floor,
          claimed: row.claimed,
          oldestClaimAt: row.oldest_claim_at,
          backoff: row.backoff,
          onSchedule: row.on_schedule,
        }];
      })),
      oldestLate: late
        ? subjectOf({ kind: late.kind, id: late.late_id, label: late.late_label, due: late.late_due,
          claimed: false, errors: late.late_errors, interval_minutes: late.late_interval })
        : null,
    };
  } catch (cause) {
    throw new Error('could not read the state of the work queues', { cause });
  }
};

/**
 * Bucket due times into "due now", the QUEUE_EDGES_MINUTES windows, and "later"
 *
 * In SQL rather than by shipping every due time to the browser: that payload would be
 * proportional to the parc, every five seconds, to draw seven numbers.
 * @param {string} table - The queue's table
 * @param {string} column - Its due-time column, interpolated into the NULL test and the ladder
 * @param {string} predicate - SQL predicate restricting which rows are in the queue
 * @returns {Promise<number[]>} Counts of length QUEUE_EDGES_MINUTES.length + 2; index 0 is
 *   due-or-overdue (a NULL due time is due, as the claim queries read it), the last is beyond
 */
const bucketDueTimes = async (table, column, predicate) => {
  // The edges are a module constant, not a parameter: interpolating them builds a CASE the
  // planner can read, where a bound array would force a per-row lateral lookup.
  const ladder = QUEUE_EDGES_MINUTES
    .map((minutes, i) => `WHEN ${column} <= CURRENT_TIMESTAMP + make_interval(mins => ${minutes}) THEN ${i + 1}`)
    .join('\n        ');

  const queryText = `
    WITH bucketed AS (
      SELECT CASE
        WHEN ${column} IS NULL OR ${column} <= CURRENT_TIMESTAMP THEN 0
        ${ladder}
        ELSE ${QUEUE_EDGES_MINUTES.length + 1}
      END AS bucket
      FROM ${table}
      WHERE ${predicate}
    )
    SELECT bucket, count(*)::int AS count
    FROM bucketed
    GROUP BY bucket
    ORDER BY bucket
  `;

  const result = await query(queryText);
  const counts = new Array(QUEUE_EDGES_MINUTES.length + 2).fill(0);

  for (const row of result.rows) {
    counts[row.bucket] = row.count;
  }

  return counts;
};

/**
 * The shape of both work queues on the QUEUE_EDGES_MINUTES ladder: due now, then out to the
 * ceiling, then everything beyond
 * @returns {Promise<{sync: number[], poll: number[]}>}
 */
export const getQueueShape = async () => {
  try {
    const [sync, poll] = await Promise.all([
      bucketDueTimes('github_installations', 'next_sync_at', SYNCABLE),
      bucketDueTimes('github_pull_requests', 'next_poll_at', POLLABLE),
    ]);

    return { sync, poll };
  } catch (cause) {
    throw new Error('could not read the shape of the work queues', { cause });
  }
};

/**
 * The subjects at the head of each queue, in the order the jobs will claim them
 *
 * The ORDER BY is the same one claimInstallationsForSync() and claimPullRequestsForPoll() use,
 * with the id to break a tie it leaves open, and that is load-bearing: a list showing a different
 * order from the scheduler's would be worse than no list, because it would be believed.
 *
 * Returns the head of the queue whether or not it is due yet, so the track can draw subjects
 * drifting toward their due time. `claimed` marks a row a worker is holding, honouring the lease
 * as the claims do: it is in the queue, and the next run steps over it until the lease expires.
 * $2 is the lease.
 * @param {number} [limit] - How many of each queue
 * @returns {Promise<{sync: Array<Object>, poll: Array<Object>}>}
 */
export const listNextSubjects = async (limit = TRACK_SUBJECTS) => {
  const syncQuery = `
    SELECT user_login,
           next_sync_at,
           sync_interval_minutes,
           sync_error_count,
           last_sync_error,
           last_synced_at,
           coalesce(sync_claimed_at >= CURRENT_TIMESTAMP - make_interval(mins => $2::int), false) AS claimed
    FROM github_installations
    WHERE ${SYNCABLE}
    ORDER BY next_sync_at ASC NULLS FIRST, id
    LIMIT $1
  `;

  // Unaliased on purpose: POLLABLE spells out `github_pull_requests.opened_by`, which an alias
  // would stop resolving. The join is what names the subject - the current name, from the
  // registry, because the copy frozen on the contribution is what it was called then.
  const pollQuery = `
    SELECT r.full_name,
           github_pull_requests.number,
           opened_by,
           commits_count,
           created_at,
           next_poll_at,
           poll_interval_minutes,
           poll_error_count,
           last_poll_error,
           last_polled_at,
           coalesce(poll_claimed_at >= CURRENT_TIMESTAMP - make_interval(mins => $2::int), false) AS claimed
    FROM github_pull_requests
    INNER JOIN github_repositories r ON r.id = github_pull_requests.repository_id
    WHERE ${POLLABLE}
    ORDER BY next_poll_at ASC NULLS FIRST, github_pull_requests.id
    LIMIT $1
  `;

  try {
    const [sync, poll] = await Promise.all([
      query(syncQuery, [limit, SCHEDULING.CLAIM_LEASE_MINUTES]),
      query(pollQuery, [limit, SCHEDULING.CLAIM_LEASE_MINUTES]),
    ]);

    return {
      // `label` and `sub` name the subject; everything below them is detail for the tooltip.
      sync: sync.rows.map((row) => ({
        at: row.next_sync_at ?? null,
        claimed: row.claimed,
        errors: row.sync_error_count,
        intervalMinutes: row.sync_interval_minutes,
        label: row.user_login,
        sub: row.last_synced_at ?? null,
        lastError: row.last_sync_error,
      })),
      poll: poll.rows.map((row) => ({
        at: row.next_poll_at ?? null,
        claimed: row.claimed,
        errors: row.poll_error_count,
        intervalMinutes: row.poll_interval_minutes,
        label: `${row.full_name}#${row.number}`,
        sub: row.opened_by,
        commits: row.commits_count,
        openedAt: row.created_at ?? null,
        lastPolledAt: row.last_polled_at ?? null,
        lastError: row.last_poll_error,
      })),
    };
  } catch (cause) {
    throw new Error('could not list the head of the work queues', { cause });
  }
};

/**
 * The subjects the next runs will claim, in the order they will claim them
 *
 * Each claim's own order - its due time, NULLS FIRST - with the id to break a tie it leaves
 * open, and nothing a live lease holds, which the claim steps over. Two claims run
 * independently, so the two heads are interleaved by due time, a tie going to the sync queue.
 * @param {number} [limit] - How many, both queues together
 * @returns {Promise<Array<Object>>}
 */
export const listNextToClaim = async (limit = 12) => {
  const queryText = `
    ${SUBJECTS}
    SELECT * FROM (
      SELECT subjects.*, row_number() OVER (PARTITION BY kind ORDER BY due_at ASC NULLS FIRST, id) AS rank
      FROM subjects
      WHERE NOT claimed
    ) ranked
    WHERE rank <= $2
  `;

  try {
    const { rows } = await query(queryText, [SCHEDULING.CLAIM_LEASE_MINUTES, limit]);
    const at = (row) => row.due_at?.getTime() ?? -Infinity;
    const queue = (row) => (row.kind === 'sync' ? 0 : 1);

    return rows
      .sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1) || queue(a) - queue(b) || a.id - b.id)
      .slice(0, limit)
      .map(subjectOf);
  } catch (cause) {
    throw new Error('could not list the next subjects to claim', { cause });
  }
};

/**
 * When an account reached the state it is in: how long it has been stuck there, on the page
 *
 * Keyed by the state rather than re-deriving it. The state is decided once, by the ladder in
 * listUsers(), and this is told the answer - so the two can never disagree about which state a
 * row is in, which a second ladder of its own would make possible the day either is reordered.
 * A row reading "suspended" beside its install date would be a wrong date that looks right.
 *
 * Only `uninstalled` can legitimately answer null: GitHub reports no removal date, so an
 * account that left before installation_deleted_at existed has none and never will.
 * @param {Object} row - As selected by listUsers()
 * @param {string} state - The state that row was found to be in
 * @returns {?Date}
 */
const stateSince = (row, state) => {
  switch (state) {
    case 'uninstalled': return row.installation_deleted_at;
    case 'suspended': return row.installation_suspended_at;
    case 'disabled': return row.sync_disabled_at;
    // verified_at is the fallback for the window between the column existing and the first
    // reconciliation filling it. It answers a near-enough question: when enrollment completed,
    // rather than when the app was installed.
    case 'installed': return row.installation_created_at ?? row.verified_at;
    // Pending: installed, never verified, and no transition dated since. Its own row is the only
    // record of when it appeared, so it has been pending since its enrolment.
    default: return row.created_timestamp;
  }
};

/**
 * Every enrolled account, with its state and what it has contributed
 *
 * The one read in this file that returns an email address, which is why it belongs to the
 * operator tier: it is read for the Operations tab only, which nobody else is sent.
 *
 * Pull requests are counted in one pass over the table and joined on, rather than with a
 * correlated subquery per user: at 73 users and a thousand pull requests the difference does
 * not matter, at ten times either it would. Joined on the lower-cased login, both sides: a
 * pull request keeps the case GitHub wrote that day, and one person is one row whatever it was.
 * @returns {Promise<Array<Object>>} One row per account, alphabetically
 */
export const listUsers = async () => {
  const queryText = `
    WITH contributions AS (
      SELECT lower(p.opened_by) AS who,
             count(*)::int AS pull_requests,
             count(*) FILTER (WHERE p.merged = true)::int AS merged
      FROM github_pull_requests p
      WHERE ${BY_A_PERSON}
      GROUP BY 1
    )
    SELECT gi.user_id,
           gi.user_login,
           gi.user_enrollment_email_address,
           gi.verified_at,
           gi.installation_suspended,
           gi.installation_deleted,
           gi.sync_disabled_at,
           gi.sync_disabled_reason,
           gi.last_synced_at,
           -- Raw, for stateSince() below. Selected rather than resolved here: which of them
           -- answers is decided by the state, and the state is decided once, in JavaScript.
           gi.installation_created_at,
           gi.installation_suspended_at,
           gi.installation_deleted_at,
           gi.created_timestamp,
           coalesce(c.pull_requests, 0) AS pull_requests,
           coalesce(c.merged, 0) AS merged
    FROM github_installations gi
    LEFT JOIN contributions c ON c.who = lower(gi.user_login)
    ORDER BY gi.user_login ASC
  `;

  try {
    const result = await query(queryText);

    return result.rows.map((row) => {
      // One word for the row, in the order that matters: what GitHub says first, then what we
      // decided, then whether the person ever finished enrolling. The only place a row's state
      // is decided - stateSince() is handed this answer rather than working it out again.
      const state = row.installation_deleted ? 'uninstalled'
        : row.installation_suspended ? 'suspended'
          : row.sync_disabled_at ? 'disabled'
            : row.verified_at ? 'installed'
              : 'pending';

      return {
        // The key of the force-sync route: a login can be renamed, an account id cannot.
        userId: Number(row.user_id),
        login: row.user_login,
        email: row.user_enrollment_email_address,
        state,
        disabledReason: row.sync_disabled_reason,
        // Null is a real answer here, not a gap: it means the account left before
        // installation_deleted_at existed, and that date is unrecoverable.
        stateSince: stateSince(row, state) ?? null,
        // When its row was written, which a reinstall does not move: the enrolment, not the
        // installation.
        enrolledAt: row.created_timestamp,
        lastSyncedAt: row.last_synced_at ?? null,
        pullRequests: row.pull_requests,
        merged: row.merged,
      };
    });
  } catch (cause) {
    throw new Error('could not list the enrolled accounts', { cause });
  }
};

/**
 * How long the bot took to notice each merge, and over the whole window
 *
 * merged_at is the forge's clock and state_changed_at is ours, so the difference is real
 * end-to-end latency: the poll interval, the batch wait and the request.
 *
 * Only a merge this application saw happen: state_changed_at is written by the very statement
 * that first records a row, beside created_timestamp, so a row first seen already merged - a
 * backfill, a manual entry, a pull request opened and merged between two polls - has the two
 * equal and measures nothing but when it was found. A negative difference is clock skew.
 *
 * A bot's pull request is excluded for a reason of its own: no bot has an installation, so the
 * poller never touches one, and its merge is noticed through a maintainer's events feed - a
 * different path, on a different clock. A person's merge can come in by that path too, when the
 * maintainer is enrolled and the sync's refresh stamps it first, and it is kept: it is still when
 * this application noticed, whichever of the two noticed first.
 *
 * Every merge rather than a figure per day: at a merge or two a day, a daily median is a gap on
 * most days and a two-point segment between the rest. Percentiles as percentile_cont computes
 * them, ungated: the page holds each to the sample its threshold asks for.
 * @param {number} [days] - How many UTC days, today included
 * @returns {Promise<{from: string, days: number, points: Array<{at: string, seconds: number}>,
 *   window: {n: number, p50: ?number, p90: ?number, p99: ?number}}>} `from` is the first day's
 *   UTC midnight; points run oldest first; durations are in seconds
 */
export const getDetectionLatency = async (days = 30) => {
  const queryText = `
    WITH detected AS (
      SELECT p.merged_at,
             extract(epoch FROM (p.state_changed_at - p.merged_at))::float8 AS seconds
      FROM github_pull_requests p
      WHERE ${BY_A_PERSON}
        AND p.state_changed_at IS NOT NULL
        -- The first day's UTC midnight. Through timestamp: a date has no AT TIME ZONE of its
        -- own, and cast to timestamptz on the way it would be the SESSION's midnight.
        AND p.merged_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ($1::int - 1))::timestamp AT TIME ZONE 'UTC'
        AND p.state_changed_at > p.merged_at
        AND p.state_changed_at > p.created_timestamp
    )
    SELECT count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) AS p90,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY seconds) AS p99,
           -- In UTC and spelled out, so the page reads the instant whatever the session's zone.
           coalesce(json_agg(json_build_object(
             'at', to_char(merged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'seconds', seconds
           ) ORDER BY merged_at, seconds), '[]') AS points
    FROM detected
  `;

  try {
    const { rows: [row] } = await query(queryText, [days]);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    return {
      from: new Date(today - (days - 1) * 86_400_000).toISOString(),
      days,
      points: row.points,
      window: { n: row.n, p50: row.p50, p90: row.p90, p99: row.p99 },
    };
  } catch (cause) {
    throw new Error(`could not read the detection latency over the last ${days} day(s)`, { cause });
  }
};

/**
 * What the bot has recorded: the machine's inventory, every table counted whole
 *
 * Bots included, and every owner, on purpose: this is what is stored, not what anybody
 * contributed - that is the report's, under BY_A_PERSON. A pull request not opened by a person
 * is counted as a bot's, so the two shares add up to the total: a NULL user_type is not a
 * person either. Active accounts are the ones the sync queue drains, by its own predicate.
 *
 * One statement, one scalar subquery per table beside the pass over the pull requests: every
 * table here is small, and the page polls this every few seconds.
 * @returns {Promise<{pullRequests: number, byPeople: number, byBots: number, merged: number,
 *   commits: number, authors: number, byHand: number, since: ?Date, lastWeek: number,
 *   repositories: number, repositoriesOurs: number, accounts: number, accountsActive: number,
 *   pullRequestEvents: number, pushEvents: number, renames: number}>}
 */
export const getInventory = async () => {
  const queryText = `
    SELECT
      count(*)::int AS pull_requests,
      count(*) FILTER (WHERE ${BY_A_PERSON})::int AS by_people,
      count(*) FILTER (WHERE p.merged)::int AS merged,
      coalesce(sum(p.commits_count), 0)::int AS commits,
      count(DISTINCT lower(p.opened_by))::int AS authors,
      count(*) FILTER (WHERE p.origin = 'manual')::int AS by_hand,
      min(p.created_timestamp) AS since,
      count(*) FILTER (WHERE p.created_timestamp > CURRENT_TIMESTAMP - interval '7 days')::int AS last_week,
      (SELECT count(*) FROM github_repositories)::int AS repositories,
      (SELECT count(*) FROM github_repositories r WHERE ${IS_OWN})::int AS repositories_ours,
      (SELECT count(*) FROM github_installations)::int AS accounts,
      (SELECT count(*) FROM github_installations WHERE ${SYNCABLE})::int AS accounts_active,
      (SELECT count(*) FROM github_pull_request_events)::int AS pull_request_events,
      (SELECT count(*) FROM github_push_events)::int AS push_events,
      (SELECT count(*) FROM github_repository_renames)::int AS renames
    FROM github_pull_requests p
  `;

  try {
    const row = (await query(queryText, owners())).rows[0];

    return {
      pullRequests: row.pull_requests,
      byPeople: row.by_people,
      byBots: row.pull_requests - row.by_people,
      merged: row.merged,
      commits: row.commits,
      authors: row.authors,
      byHand: row.by_hand,
      // Null on an empty table: nothing has been collected yet.
      since: row.since,
      lastWeek: row.last_week,
      repositories: row.repositories,
      repositoriesOurs: row.repositories_ours,
      accounts: row.accounts,
      accountsActive: row.accounts_active,
      pullRequestEvents: row.pull_request_events,
      pushEvents: row.push_events,
      renames: row.renames,
    };
  } catch (cause) {
    throw new Error('could not read what the bot has recorded', { cause });
  }
};
