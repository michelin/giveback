import { parentPort } from "node:worker_threads";
import { format, fields } from "../src/utils/logger.js";
import { closePool as closePoolImpl } from "../src/db/index.js";

// Not a job, and safe to sit among them: src/services/breeService.js passes `root: false` with an
// explicit JOB_DEFINITIONS list, so Bree never scans this directory for something to schedule.
// It lives here rather than in src/utils/ because it is job-protocol code - it closes the pool
// and speaks parentPort, which no general utility does.

/**
 * A run's failure ledger: the subjects it could not process, and how to add one
 *
 * Capped, because a GitHub outage fails every claimed subject and 200 near-identical entries per
 * run is weight without a reader - the `failed` counter beside it keeps the true total, so
 * nothing is silently lost.
 *
 * Destructured at module scope in each job, outside run(), for the same reason `totals` is: the
 * array's identity has to survive a run that throws mid-loop, because the report is assembled
 * from it afterwards.
 * @param {number} [kept] - How many entries to keep
 * @returns {{failures: Array<{subject: string, status: ?number, message: string}>, noteFailure: function(string, *): void}}
 */
export const failureLedger = (kept = 20) => {
  const failures = [];

  /**
   * Remember one failed subject, for job_runs and the dashboard
   * @param {string} subject - How the subject is named on the page
   * @param {*} error - The error it failed with
   */
  const noteFailure = (subject, error) => {
    if (failures.length < kept) {
      failures.push({
        subject,
        status: error?.status ?? null,
        message: String(error?.message ?? error).split('\n')[0].slice(0, 300),
      });
    }
  };

  return { failures, noteFailure };
};

/**
 * Release a claimed subject, reporting a release that failed instead of aborting the run
 *
 * The claim is not retried here: its lease expires on its own, and throwing out of the loop
 * would take every subject after this one with it.
 * @param {Promise<*>} release - The write that puts the subject back in the queue
 * @param {import('pino').Logger} logger - The job's own logger
 * @param {string} subject - How the subject is named in the message
 * @param {Object} [context] - The subject's identifying fields
 * @returns {Promise<*>} What the release resolved to - false from a fenced release whose outcome
 *   was dropped - or undefined when it threw
 */
export const releaseClaim = (release, logger, subject, context = {}) =>
  release.catch((releaseError) => {
    // No `: ${releaseError.message}` tail: every write this wraps already throws a "could not"
    // sentence of its own, with the pg error as `cause`, and `err` carries that chain to pino.
    logger.error(
      { err: releaseError, ...context },
      `could not release the claim on ${subject}`
    );
  });

/**
 * Run one job's body, then report the run - in a worker thread or by hand
 *
 * The five decisions every job shares: time the run, survive an abort, close the pool whatever
 * happened, assemble the summary the scheduler renders, and either hand it to parentPort or say
 * it out loud when nobody is listening.
 *
 * The logger is the caller's, never one this module makes: getLogger() stamps a pino `name`
 * binding, and the two lines below - the abort, and a pool that would not close - are the most
 * important a run can emit and the ones an operator filters by job name.
 *
 * Key insertion order is the contract: docs/logging.md promises counter keys in declaration
 * order, so `totals` first, then whatever `tail` adds, then the cause last.
 * @param {Object} options
 * @param {string} options.name - The Bree job name, as it appears in the report line
 * @param {import('pino').Logger} options.logger - The job's own logger
 * @param {function(): Promise<*>} options.run - The job body
 * @param {Object} [options.totals] - Counters the job keeps outside run(), so a run that throws
 *   mid-way still reports how far it got
 * @param {function(*): Object} [options.tail] - Summary keys that follow the totals, given
 *   whatever run() resolved to. Explicit rather than a pass-through: only the caller knows
 *   whether its resolved value is a counter of its own or nests under a key, and one job's extra
 *   key comes from a flag run() set as a side effect rather than from what it returned
 * @param {function(): Promise<void>} [options.closePool] - The pool teardown. Injectable for one
 *   reason: without a seam, deleting the finally below leaves every job-run test green, and a
 *   worker that never drains its pool holds its connections until Bree kills it
 * @returns {Promise<Object>} The summary that was reported
 */
export const runJob = async ({ name, logger, run, totals = {}, tail = () => ({}), closePool = closePoolImpl }) => {
  // Rebound so the lines below carry the same `job` field as the scheduler's report line. Lines
  // from src/db/* do not: each module there builds its own logger at module scope.
  //
  // `?.`/`??` because the logger is the caller's and need not be a pino one: test/job-run.test.js
  // passes a recorder with no child().
  const jobLogger = logger.child?.(fields.job(name)) ?? logger;
  const startedAt = Date.now();
  let ok = true;
  let failure;
  let resolved;

  try {
    resolved = await run();
  } catch (error) {
    ok = false;
    failure = error.message;
    jobLogger.error({ err: error, ...totals }, `${name} run aborted: ${error.message}`);
  } finally {
    try {
      await closePool();
    } catch (error) {
      jobLogger.error({ err: error }, `could not close the database pool: ${error.message}`);
    }
  }

  // The scheduler renders this into the single report line for the run.
  const summary = { ok, durationMs: Date.now() - startedAt, ...totals, ...tail(resolved), ...(failure ? { error: failure } : {}) };

  if (parentPort) {
    parentPort.postMessage(summary);
    parentPort.postMessage("done");
  } else {
    // Run by hand: nobody is listening on parentPort, so the job emits its own report. One report
    // line per run holds in both modes.
    // A real Error, not the bare `failure` string: pino's err serializer passes a non-Error
    // through untouched, which would emit `err` as a string here and as an object everywhere
    // else. Same treatment as the scheduler's report line in src/services/breeService.js. The
    // stack this synthesizes points here; the true one was logged at the abort line above.
    jobLogger[ok ? 'info' : 'error'](
      { ...fields.jobReport(name, summary), ...(ok ? {} : { err: new Error(String(failure)) }) },
      format.jobReport(name, summary)
    );

    // Not process.exit(): pino's transport is an async stream, and exiting discards what it has
    // not flushed yet.
    process.exitCode = ok ? 0 : 1;
  }

  return summary;
};
