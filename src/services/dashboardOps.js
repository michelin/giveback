import { getSchedulerState } from "./breeService.js";
import { tolerate } from "./dashboardShared.js";
import {
  getSubjectStates, getQueueShape, listNextSubjects, listNextToClaim, getDetectionLatency, listUsers, getInventory, TICK_MINUTES, QUEUE_EDGES_MINUTES,
} from "../db/dashboard.js";
import { listRecentRunsPerJob, summariseJobRuns, listRecentRuns, listRecentFailures, SPARKLINE_RUNS } from "../db/job_runs.js";
import { nextRunAt } from "../utils/cron.js";
import { intervalLadder, tierOf, backoffBand, errorBackoffMinutes } from "../utils/backoff.js";
import { JOB_OUTCOMES } from "../utils/jobSummary.js";
import {
  ALLOWED_EMAIL_DOMAINS, OWN_GITHUB_ORGS, GITLAB_API_HOSTS, CRON, SCHEDULING, JOB_RUN_RETENTION_DAYS,
} from "../utils/constants.js";

// Each queue's interval bounds, as its job reads them.
const BOUNDS = Object.freeze({
  sync: { min: SCHEDULING.SYNC_MIN_INTERVAL_MINUTES, max: SCHEDULING.SYNC_MAX_INTERVAL_MINUTES },
  poll: { min: SCHEDULING.POLL_MIN_INTERVAL_MINUTES, max: SCHEDULING.POLL_MAX_INTERVAL_MINUTES },
});

/**
 * The rungs each queue's subjects are named by - "15 min tier" on a tile and in the fold - floor
 * first, and the band above them when a failing subject can wait longer than the ceiling
 *
 * Per queue: the two share one error backoff but not their bounds, so one can have a band the
 * other has not.
 */
const LADDERS = Object.freeze(Object.fromEntries(Object.entries(BOUNDS).map(([kind, bounds]) => [kind, {
  tiers: intervalLadder(bounds),
  backoff: backoffBand({ ...bounds, backoffMax: SCHEDULING.MAX_ERROR_BACKOFF_MINUTES }),
}])));

/**
 * What the running process was started with, in the three rows the Settings panel draws
 *
 * Read from the constants the jobs and the enrolment read, so the panel is what this process
 * believes rather than what a file says it should. Each entry names the variables it comes from,
 * and none of them is a secret: a list, a schedule or a bound, never a token or a key. `unit`
 * says how the page writes a number; a value without one is written as it is.
 */
const SETTINGS = Object.freeze([
  {
    title: 'What counts as ours',
    items: [
      { label: 'Repositories we own', env: ['OWN_GITHUB_ORGS'], values: OWN_GITHUB_ORGS, none: 'no owner is ours' },
      { label: 'Enrolment accepts', env: ['ALLOWED_EMAIL_DOMAINS'], values: ALLOWED_EMAIL_DOMAINS, none: 'no domain is accepted' },
      { label: 'GitLab hosts read', env: ['GITLAB_API_HOSTS'], values: GITLAB_API_HOSTS, none: 'no host is read' },
    ],
  },
  {
    title: 'When the jobs wake',
    items: [
      { label: 'sync_contributions', env: ['EVENTS_CRON'], values: [CRON.SYNC] },
      { label: 'poll_non_closed_pull_requests', env: ['EVENTS_CRON_POLL'], values: [CRON.POLL] },
      { label: 'sync_repositories', env: ['REPOS_CRON'], values: [CRON.SYNC_REPOS] },
      { label: 'reconcile_installations', env: ['RECONCILE_CRON'], values: [CRON.RECONCILE] },
    ],
  },
  {
    title: 'How the queues are paced',
    items: [
      { label: 'Sync interval', env: ['SYNC_MIN_INTERVAL_MINUTES', 'SYNC_MAX_INTERVAL_MINUTES'], unit: 'minutes',
        values: [BOUNDS.sync.min, BOUNDS.sync.max] },
      { label: 'Poll interval', env: ['POLL_MIN_INTERVAL_MINUTES', 'POLL_MAX_INTERVAL_MINUTES'], unit: 'minutes',
        values: [BOUNDS.poll.min, BOUNDS.poll.max] },
      { label: 'Error backoff ceiling', env: ['MAX_ERROR_BACKOFF_MINUTES'], unit: 'minutes', values: [SCHEDULING.MAX_ERROR_BACKOFF_MINUTES] },
      { label: 'Claim lease', env: ['CLAIM_LEASE_MINUTES'], unit: 'minutes', values: [SCHEDULING.CLAIM_LEASE_MINUTES] },
      { label: 'Sync batch', env: ['SYNC_BATCH_SIZE'], unit: 'subjects', values: [SCHEDULING.SYNC_BATCH_SIZE] },
      { label: 'Poll batch', env: ['POLL_BATCH_SIZE'], unit: 'subjects', values: [SCHEDULING.POLL_BATCH_SIZE] },
      { label: 'Repository batch', env: ['REPO_BATCH_SIZE'], unit: 'subjects', values: [SCHEDULING.REPO_BATCH_SIZE] },
      { label: 'Run history kept', env: ['JOB_RUN_RETENTION_DAYS'], unit: 'days', values: [JOB_RUN_RETENTION_DAYS] },
    ],
  },
]);

/**
 * A subject with where it stands: how long it waits between two turns, and the rung that is on
 *
 * A failing subject waits what the error backoff says rather than its interval, which the jobs
 * leave as it was: the same errorBackoffMinutes() call they make, with the same bounds. Past the
 * ceiling it is in the backoff band, below it on the rung of its wait.
 * @param {{kind: string, errors: number, interval: ?number}} subject - As the queue reads return it
 * @returns {Object} The subject, its interval replaced by `minutes` and `tier`
 */
const placed = ({ interval, ...subject }) => {
  const { min, max } = BOUNDS[subject.kind];
  const { tiers, backoff } = LADDERS[subject.kind];
  const minutes = subject.errors > 0
    ? errorBackoffMinutes(subject.errors, { min, max: SCHEDULING.MAX_ERROR_BACKOFF_MINUTES })
    : interval;

  return { ...subject, minutes, tier: backoff !== null && minutes > max ? backoff : tierOf(minutes, tiers) };
};

// A job with no run in the last 24 hours: every count zero, rather than a card that has to
// tell "nothing ran" from "nothing was read".
const EMPTY_WINDOW = Object.freeze({
  runs: 0, failed: 0, idle: 0, avgDurationMs: 0, maxDurationMs: 0, subjectsFailed: 0, subjectsClaimed: 0,
});

/**
 * One word for a job, the same for its card's pill and for the Failing jobs tile
 *
 * Failing is about the last run that did something: it failed, or it claimed subjects and
 * failed every one of them - the run completed, reports ok, and nothing was collected, which is
 * the outage a status light hides. A few failed subjects out of many are the parc, not the job.
 * Then running, while Bree has a worker for it; idle, when its last run found nothing to do.
 * @param {{running: boolean, runs: Array<Object>}} job - Its runs oldest first
 * @returns {'failing'|'running'|'idle'|'ok'}
 */
export const jobState = ({ running, runs }) => {
  const worked = runs.findLast((run) => run.outcome !== 'idle');
  const { claimed = 0, failed = 0 } = worked?.counters ?? {};

  if (worked?.outcome === 'failed' || (claimed > 0 && failed === claimed)) return 'failing';
  if (running) return 'running';
  if (runs.at(-1)?.outcome === 'idle') return 'idle';

  return 'ok';
};

/**
 * Everything the Operations tab draws, in one payload
 *
 * Only ever read for an operator, so nothing in it is redacted: every account with its
 * address, every queued subject by name, every failure with its cause.
 *
 * Read in parallel, because the page polls this every few seconds and sequentially every read
 * would be its own round trip to a database that in production is a network hop away.
 *
 *   app       revision and uptime, for the footer
 *   jobs      [{ name, cron, running, nextRunAt, state, runs, window, lastError }]
 *   ladders   per queue, { tiers, backoff }
 *   subjects  per queue, the state counts; oldestLate, the subject late the longest
 *   queue     the track: its axis past now, each queue counted on it, and the head of each
 *   next      the subjects the next runs claim, in that order
 *   latency   detection latency, every merge and over the window
 *   runs      the latest runs that did something
 *   users     every enrolled account
 *   inventory what the bot has recorded, every table counted whole, bots included
 *   settings  what the process was started with, in rows of labelled values
 *   limits    the sparkline's length, each queue's tick, and the outcome words in their order
 * @param {Set<string>} degraded - Collects what this snapshot could not read
 */
export const getOpsSnapshot = async (degraded) => {
  const scheduler = getSchedulerState();

  const [runsPerJob, windows, failuresByJob, subjects, shape, heads, next, latency, runs, users, inventory] = await Promise.all([
    listRecentRunsPerJob().catch(tolerate(degraded, 'run history', new Map())),
    summariseJobRuns(24).catch(tolerate(degraded, 'run history', new Map())),
    listRecentFailures().catch(tolerate(degraded, 'run history', new Map())),
    getSubjectStates(),
    getQueueShape(),
    listNextSubjects(),
    listNextToClaim(),
    getDetectionLatency(),
    listRecentRuns().catch(tolerate(degraded, 'run history', [])),
    listUsers().catch(tolerate(degraded, 'the account list', [])),
    // Null rather than zeros: a read that failed is not an empty database.
    getInventory().catch(tolerate(degraded, 'the inventory', null)),
  ]);

  return {
    // Which build, and for how long: the footer's, and an operator's alone.
    app: {
      revision: process.env.APP_REVISION || 'unknown',
      uptimeMs: Math.round(process.uptime() * 1000),
    },
    // One entry per scheduled job, assembled here so the page never has to join anything.
    jobs: scheduler.jobs.map(({ name, cron, running }) => {
      // Oldest first, the order the sparkline reads in.
      const history = (runsPerJob.get(name) ?? []).slice().reverse();
      const state = jobState({ running, runs: history });
      const cause = failuresByJob.get(name);

      return {
        name,
        cron,
        // In flight right now. The tick bar cannot show a position while this is true: a run's
        // row is only written when it ENDS, so its start point still names the previous run
        // while nextRunAt has already moved on - the bar sat at half for the whole run.
        running: Boolean(running),
        // Computed with the library Bree schedules with, so the countdown is the real next
        // firing rather than an estimate. null for an expression that never fires.
        nextRunAt: nextRunAt(cron)?.toISOString() ?? null,
        state,
        runs: history.map(({ outcome, durationMs, startedAt }) => ({ outcome, durationMs, startedAt })),
        // The last 24 hours, counted in SQL rather than over the sparkline: 48 runs are four
        // hours of a five-minute job, and a day of one that runs every two.
        window: windows.get(name) ?? EMPTY_WINDOW,
        // A failing card's reason: the run's own error, or else what its last failed subject
        // answered. Null on a failing card is a failure nothing recorded a cause for.
        lastError: state === 'failing'
          ? history.findLast((run) => run.outcome !== 'idle')?.error
            ?? (cause ? `${cause.subject}: ${cause.status ? `${cause.status} ` : ''}${cause.message}` : null)
          : null,
      };
    }),
    ladders: LADDERS,
    subjects: { ...subjects, oldestLate: subjects.oldestLate && placed(subjects.oldestLate) },
    queue: { edges: QUEUE_EDGES_MINUTES, shape, subjects: heads },
    next: next.map(placed),
    // Measured, not promised: state_changed_at minus merged_at.
    latency,
    runs,
    users,
    inventory,
    settings: SETTINGS,
    limits: {
      sparklineRuns: SPARKLINE_RUNS,
      // The page calls a subject overdue past its tick, as getSubjectStates() counts it.
      tickMinutes: TICK_MINUTES,
      // The job_runs vocabulary, in its owner's order: the page counts a sparkline's runs by it.
      outcomes: JOB_OUTCOMES,
    },
  };
};
