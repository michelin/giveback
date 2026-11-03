import Bree from 'bree';
import { fileURLToPath } from 'node:url';
import { hasSecondsField } from '../utils/cron.js';
import { recordJobRun } from '../db/job_runs.js';
import { SCHEDULING, CRON } from '../utils/constants.js';
import { getLogger, format, fields } from "../utils/logger.js";
import { jobOutcome } from "../utils/jobSummary.js";

const logger = getLogger("breeService");

// Bree uses job.path verbatim, so a relative path would resolve against the process cwd —
// which is not something to rely on when a platform starts the app for you.
const jobPath = (file) => fileURLToPath(new URL(`../../jobs/${file}`, import.meta.url));

// Four static jobs, never one per user. The scheduler does not decide *who* to process —
// each subject carries its own due time and these jobs drain what is due, which is what lets a
// second instance share the work and a truncated run resume instead of restarting.
const JOB_DEFINITIONS = [
  {
    name: 'sync_contributions',
    path: jobPath('sync_contributions.js'),
    cron: CRON.SYNC,
    // Below the PRODUCTION tick (CRON.SYNC/POLL `*/5`), so a hung run is gone before the next
    // one is due. Overlap itself is Bree's guarantee, not this timeout's — it refuses to start
    // a job already running, which under the shorter development crons means a SKIPPED tick,
    // visible only at debug (see breeLogger below). A run that hangs is killed, and its
    // claimed rows come back when their lease expires.
    closeWorkerAfterMs: 4 * 60 * 1000,
  },
  {
    name: 'poll_non_closed_pull_requests',
    path: jobPath('poll_non_closed_pull_requests.js'),
    cron: CRON.POLL,
    closeWorkerAfterMs: 4 * 60 * 1000,
  },
  {
    name: 'sync_repositories',
    path: jobPath('sync_repositories.js'),
    cron: CRON.SYNC_REPOS,
    closeWorkerAfterMs: 4 * 60 * 1000,
  },
  {
    name: 'reconcile_installations',
    path: jobPath('reconcile_installations.js'),
    cron: CRON.RECONCILE,
    // Longer, and sized against the development tick (CRON.RECONCILE `*/10`): the paginated
    // GET /app/installations is the call most likely to hang — see the start marker in
    // jobs/reconcile_installations.js.
    closeWorkerAfterMs: 9 * 60 * 1000,
  },
];

const closeWorkerAfterMsOf = (name) =>
  JOB_DEFINITIONS.find((job) => job.name === name)?.closeWorkerAfterMs;

// Whether recording a run into job_runs is currently working. Complained about once, then
// demoted: every job would repeat the same line on every tick, which in production is some
// twenty-five identical warnings an hour for one condition.
let recordingRuns = true;

/**
 * Persist a finished run, for the dashboard
 *
 * Fire and forget: this is telemetry about the run, and a database that cannot accept it must
 * not change what the run reported or delay the line an operator is reading.
 * @param {string} job
 * @param {Object} summary - The object the worker posted back
 */
const recordRun = (job, summary) => {
  // The run's own counters, not the flattened log fields: job, outcome and duration_ms have
  // their own columns here, and system state is not a counter of this run.
  const { outcome, counters } = jobOutcome(summary);

  recordJobRun({
    job,
    outcome,
    durationMs: summary?.durationMs,
    counters,
    // The message only. A stack in a table nobody greps is weight without a reader.
    error: summary?.error ? String(summary.error).split('\n')[0].slice(0, 500) : null,
    // Which subjects the run could not process. Its counterpart `failed` is a count; this is
    // the answer to "which ones, and why", which the count alone can never give.
    failures: Array.isArray(summary?.failures) ? summary.failures : [],
  }).then(() => {
    if (!recordingRuns) {
      recordingRuns = true;
      logger.info('job runs are being recorded again - the dashboard will fill in from here');
    }
  }).catch((error) => {
    const line = `could not record the ${job} run - the dashboard will show a gap: ${error.message}`;

    if (recordingRuns) {
      recordingRuns = false;
      logger.warn({ err: error, ...fields.job(job) }, line);
    } else {
      logger.debug({ err: error, ...fields.job(job) }, line);
    }
  });
};

// Which jobs posted a report during their current run. A worker killed at
// closeWorkerAfterMs surfaces as a non-zero exit with no report, which is a timeout the
// scheduler recovers from — not the same event as a job that crashed while reporting.
//
// Cleared when each worker starts, below, so the verdict is about this run and not an earlier
// one.
const reported = new Set();

/**
 * Adapter for the logger handed to Bree
 *
 * Bree calls logger.info(message, metadata); pino expects the opposite order, so the raw
 * instance reads metadata as the message — and Bree's warn(new Error(...), metadata) renders a
 * line with no message at all.
 *
 * Every level is demoted. Bree's info is routine bookkeeping (`Worker for job "x" online`,
 * `exited with code 0`), one line per job per tick that the run report already covers — ~75
 * info lines an hour of the scheduler talking about itself. trace rather than debug, so
 * LOG_LEVEL=debug stays usable for tracing actual subjects.
 */
const breeLogger = {
  info: (message, metadata) => logger.trace(metadata ?? {}, String(message?.message ?? message)),
  warn: (message, metadata) => logger.debug(metadata ?? {}, String(message?.message ?? message)),
  error: (message, metadata) => logger.debug(metadata ?? {}, String(message?.message ?? message)),
};

export const bree = new Bree({
  root: false,
  logger: breeLogger,
  jobs: JOB_DEFINITIONS.map((job) => ({
    ...job,
    // Derived from the expression itself, so a 6-field cron can never reach Bree with
    // hasSeconds:false — see hasSecondsField().
    hasSeconds: hasSecondsField(job.cron),
  })),

  /**
   * The one line a finished run produces. Everything a worker posts arrives here, including
   * Bree's "done" sentinel, which only means "you may close the worker".
   */
  workerMessageHandler: (message) => {
    const summary = message.message;

    if (summary === 'done') {
      return;
    }

    reported.add(message.name);

    const line = format.jobReport(message.name, summary);
    const context = fields.jobReport(message.name, summary);

    // Every outcome including idle: a run that did nothing is still proof the scheduler is
    // alive, which is exactly what a gap in the sparkline is meant to reveal.
    recordRun(message.name, summary);

    if (summary?.ok === false) {
      // Wrapped, because what crosses the worker boundary is `error.message` — a string, see
      // runJob() in jobs/jobRun.js — and pino's err serializer passes a non-Error through
      // unchanged, so this one line-kind would emit `err` as a string where every other error
      // line in the tree emits {type, message, stack}. The synthesized stack points here, not at
      // the throw: the real one is on the worker's own abort line, logged by runJob()
      // immediately before this report.
      logger.error({ ...context, err: new Error(String(summary.error)) }, line);
      return;
    }

    // An idle run is the common case at scale and says nothing an operator needs.
    if (context.outcome === 'idle') {
      logger.debug(context, line);
      return;
    }

    logger.info(context, line);
  },

  errorHandler: (error, metadata) => {
    const name = metadata?.name;
    const timeoutMs = closeWorkerAfterMsOf(name);

    // Bree synthesizes `Worker for job "x" exited with code 1` when it kills a worker at
    // closeWorkerAfterMs. The absence of a report is what distinguishes that from a crash, and
    // it is recoverable: the claimed rows come back when their lease expires.
    if (timeoutMs && !reported.has(name) && /exited with code/.test(error?.message ?? '')) {
      logger.warn(
        { ...fields.job(name), timeout_ms: timeoutMs },
        `${name} was killed after ${format.duration(timeoutMs)} without reporting - its claimed rows return to the queue when their lease expires`
      );
      return;
    }

    logger.error({ ...fields.job(name), err: error }, `${name ?? 'a job'} failed: ${error.message}`);
  },
});

// 'worker created' fires just before the worker starts, which is the only moment "has this
// run reported yet" is knowably false.
bree.on('worker created', (name) => reported.delete(name));

/**
 * Start every scheduled job
 * @throws {Error} A scheduler that fails to start means the app does no work at all, and that
 *   must not look like a healthy boot.
 */
export const startBree = async () => {
  await bree.start();

  // Announced after the fact: lines written ahead of bree.start() describe schedules that do
  // not exist if the start then throws.
  const schedules = JOB_DEFINITIONS.map((job) => `${job.name} ${job.cron}`).join(', ');

  logger.info(
    { jobs: JOB_DEFINITIONS.map((job) => job.name) },
    `scheduler started - ${JOB_DEFINITIONS.length} job(s): ${schedules}`
  );

  // The tuning knobs, resolved. Every environment variable that reaches the scheduler through
  // constants.js, and without this line setting one in a hosted environment and having it
  // silently not take effect is indistinguishable from success. No count in this sentence: the
  // `{ ...SCHEDULING }` spread below keeps the set complete without a number to maintain.
  logger.info(
    { ...SCHEDULING },
    `scheduling: sync every ${SCHEDULING.SYNC_MIN_INTERVAL_MINUTES}-${SCHEDULING.SYNC_MAX_INTERVAL_MINUTES}min, `
    + `poll every ${SCHEDULING.POLL_MIN_INTERVAL_MINUTES}-${SCHEDULING.POLL_MAX_INTERVAL_MINUTES}min, `
    + `batches ${SCHEDULING.SYNC_BATCH_SIZE}/${SCHEDULING.POLL_BATCH_SIZE}, `
    + `claim lease ${SCHEDULING.CLAIM_LEASE_MINUTES}min, error backoff up to ${SCHEDULING.MAX_ERROR_BACKOFF_MINUTES}min`
  );
};

/** Stop every scheduled job and terminate running workers. */
export const stopBree = async () => {
  const startedAt = Date.now();
  const running = bree.workers?.size ?? 0;

  logger.info(`stopping the scheduler - ${running} worker(s) still running`);

  await bree.stop();

  // A stop that hangs on a busy worker is the usual reason a container is killed after its
  // grace period, and without this line the process looks like it simply vanished.
  logger.info(`scheduler stopped in ${format.duration(Date.now() - startedAt)}`);
};

/** Scheduler state, for the dashboard. */
export const getSchedulerState = () => ({
  // `running` per job, from the Map Bree keys by job name. Asked of the scheduler rather than
  // inferred from job_runs, which only learns a run happened once it has finished.
  jobs: JOB_DEFINITIONS.map(({ name, cron }) => ({
    name,
    cron,
    running: bree.workers?.has(name) ?? false,
  })),
});
