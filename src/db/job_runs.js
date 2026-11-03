import { query } from "./index.js";

// How many recent runs of each job the dashboard draws as a sparkline. At the production
// cadence, 48 runs is four hours — long enough to see a trend, short enough to stay one screen.
export const SPARKLINE_RUNS = 48;

// One shape for a job_runs row, because two functions returned it and both had to keep
// agreeing on duration_ms -> durationMs.
const runOf = (row) => ({
  outcome: row.outcome,
  durationMs: row.duration_ms,
  counters: row.counters,
  error: row.error,
  startedAt: row.started_at,
});

/**
 * Record one finished run
 *
 * Deliberately tolerant of a missing field: a run that reported something unexpected must still
 * be recorded, because "the job ran and we do not know how it went" is itself the fact.
 * @param {Object} run
 * @param {string} run.job - The job's name, as Bree schedules it
 * @param {number} run.durationMs - How long it took; anything but a finite, non-negative number
 *   is stored as 0
 * @param {string} run.outcome - one of JOB_OUTCOMES in src/utils/jobSummary.js, which owns
 *   this vocabulary: ok | failed | idle | skipped
 * @param {Object} [run.counters] - The run's own counters, stored verbatim
 * @param {?string} [run.error] - First line of the failure of the RUN, never a stack
 * @param {Array<Object>} [run.failures] - The subjects the run could not process. A run can
 *   report outcome 'ok' and still carry a full list here.
 */
export const recordJobRun = async ({ job, outcome, durationMs, counters = {}, error = null, failures = [] }) => {
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0;

  const queryText = `
    INSERT INTO job_runs (job, outcome, duration_ms, counters, error, failures, started_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, CURRENT_TIMESTAMP - make_interval(secs => $3::numeric / 1000))
  `;

  try {
    // started_at is derived in SQL rather than sent from here: a worker reports how long it
    // took, not when it began, and this keeps every timestamp in the table on one clock.
    await query(queryText, [job, outcome, duration, JSON.stringify(counters ?? {}), error, JSON.stringify(failures ?? [])]);
  } catch (cause) {
    throw new Error(`could not record the ${job} run`, { cause });
  }
};

/**
 * Delete runs older than the retention window
 *
 * A rolling window, not an archive: unbounded it would grow by ~26k rows a month for
 * information nobody reads. Called from the reconciliation job, the low-frequency housekeeping.
 * @returns {Promise<number>} Rows deleted
 */
export const purgeJobRuns = async (retentionDays) => {
  const queryText = `
    DELETE FROM job_runs
    WHERE started_at < CURRENT_TIMESTAMP - make_interval(days => $1::int)
  `;

  try {
    const result = await query(queryText, [retentionDays]);

    return result.rowCount ?? 0;
  } catch (cause) {
    throw new Error(`could not purge job runs older than ${retentionDays} day(s)`, { cause });
  }
};

/**
 * The recent runs of every job, newest first
 *
 * One query rather than one per job: the window function ranks within each job, so a job that
 * ran twice and one that ran a thousand times both return at most `limit` rows.
 * @returns {Promise<Map<string, Array<Object>>>} Runs by job name
 */
export const listRecentRunsPerJob = async (limit = SPARKLINE_RUNS) => {
  const queryText = `
    SELECT job, outcome, duration_ms, counters, error, started_at
    FROM (
      SELECT job, outcome, duration_ms, counters, error, started_at,
             row_number() OVER (PARTITION BY job ORDER BY started_at DESC) AS rank
      FROM job_runs
    ) ranked
    WHERE rank <= $1
    ORDER BY job ASC, started_at DESC
  `;

  try {
    const result = await query(queryText, [limit]);
    const byJob = new Map();

    for (const row of result.rows) {
      if (!byJob.has(row.job)) {
        byJob.set(row.job, []);
      }

      byJob.get(row.job).push(runOf(row));
    }

    return byJob;
  } catch (cause) {
    throw new Error('could not list recent job runs', { cause });
  }
};

/**
 * Per-job behaviour over a rolling window
 *
 * The failure count is what turns the page from a status light into a diagnosis: one failed run
 * is a hiccup, the same job failing eight times in an hour is an outage nobody was paged for.
 * @returns {Promise<Map<string, Object>>} Stats by job name
 */
export const summariseJobRuns = async (hours = 24) => {
  const queryText = `
    SELECT job,
           count(*)::int AS runs,
           count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
           count(*) FILTER (WHERE outcome = 'idle')::int AS idle,
           -- Over the runs that did something: an idle run is ~40ms and would drag the figure
           -- down far enough to hide a slow one.
           coalesce(round(avg(duration_ms) FILTER (WHERE outcome <> 'idle'))::int, 0) AS avg_duration_ms,
           coalesce(max(duration_ms), 0)::int AS max_duration_ms,
           -- Per-SUBJECT failures, the blind spot a failed-run count leaves: a run where
           -- every claimed subject failed still reports 'ok', because the run completed.
           -- Green job, nothing collected.
           coalesce(sum((counters->>'failed')::int), 0)::int AS subjects_failed,
           coalesce(sum((counters->>'claimed')::int), 0)::int AS subjects_claimed
    FROM job_runs
    WHERE started_at >= CURRENT_TIMESTAMP - make_interval(hours => $1::int)
    GROUP BY job
  `;

  try {
    const result = await query(queryText, [hours]);

    return new Map(result.rows.map((row) => [row.job, {
      runs: row.runs,
      failed: row.failed,
      idle: row.idle,
      avgDurationMs: row.avg_duration_ms,
      maxDurationMs: row.max_duration_ms,
      subjectsFailed: row.subjects_failed,
      subjectsClaimed: row.subjects_claimed,
    }]));
  } catch (cause) {
    throw new Error(`could not summarise job runs over the last ${hours} hour(s)`, { cause });
  }
};

/**
 * The most recent runs, across every job, newest first
 *
 * Distinct from listRecentRunsPerJob(), which answers "how has THIS job behaved": here the
 * interleaving is the information, because a poll that stopped while syncs kept going is a
 * different fault from everything stopping at once.
 *
 * Idle runs are left out: a job ticking every minute on an empty queue writes sixty of them an
 * hour, and they would bury the runs that did something.
 * @param {number} [limit] - How many
 */
export const listRecentRuns = async (limit = 100) => {
  const queryText = `
    SELECT job, outcome, duration_ms, counters, error, started_at
    FROM job_runs
    WHERE outcome <> 'idle'
    ORDER BY started_at DESC
    LIMIT $1
  `;

  try {
    const result = await query(queryText, [limit]);

    return result.rows.map((row) => ({ job: row.job, ...runOf(row) }));
  } catch (cause) {
    throw new Error('could not list the recent job runs', { cause });
  }
};

/**
 * The last subject each job failed over a rolling window, and why
 *
 * The cause a failing job card gives when the run itself carries none: a run can complete, say
 * ok, and have failed every subject it claimed.
 *
 * Carries the raw error alongside the subject, so it belongs to the operator tier - read for
 * the Operations tab only, which nobody else is sent.
 * @param {number} [hours] - Width of the window
 * @returns {Promise<Map<string, {subject: string, message: string, status: ?number}>>} By job name
 */
export const listRecentFailures = async (hours = 24) => {
  const queryText = `
    SELECT DISTINCT ON (job) job,
           failure->>'subject' AS subject,
           failure->>'message' AS message,
           (failure->>'status')::int AS status
    FROM job_runs, jsonb_array_elements(failures) WITH ORDINALITY AS f(failure, position)
    WHERE started_at >= CURRENT_TIMESTAMP - make_interval(hours => $1::int)
    -- The latest run, and in it the subject failed last: a run fails several at once, and which
    -- one names the cause must not be the planner's choice.
    ORDER BY job, started_at DESC, position DESC
  `;

  try {
    const result = await query(queryText, [hours]);

    return new Map(result.rows.map((row) => [row.job, { subject: row.subject, message: row.message, status: row.status }]));
  } catch (cause) {
    throw new Error(`could not list the failing subjects over the last ${hours} hour(s)`, { cause });
  }
};
