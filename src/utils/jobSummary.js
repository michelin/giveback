/**
 * The vocabulary of job_runs.outcome, and nothing else
 *
 * This is a persisted domain value, not a log format: breeService writes it to the `outcome`
 * column, and src/db/job_runs.js queries it back as data (`FILTER (WHERE outcome = 'failed')`,
 * `AND outcome <> 'idle'`). Kept out of the logger, so a presentation edit cannot change what the
 * database holds, and pino-free, so nothing has to pull a log transport in to read it.
 */

/**
 * Every word jobOutcome() can return — the same four init.sql documents on job_runs.outcome.
 *
 * The dashboard's Operations tab is sent it in its snapshot. views/dashboard/core.js keeps a
 * hand-written copy as a class vocabulary, VOCAB.RUN_OUTCOMES: a browser script cannot import this.
 */
export const JOB_OUTCOMES = ['ok', 'failed', 'idle', 'skipped'];

/**
 * Split a worker summary into its outcome word and its counters
 *
 * Shared by the prose renderer, the field builder and breeService's recordRun, so a line, its
 * structured twin and the stored row can never disagree. `skipped` is overloaded: reconcile
 * posts the boolean `true` to mean "this run did nothing on purpose", sync posts a count of
 * events it stepped over. The boolean is an outcome and is consumed here; the number is a
 * counter and stays on the line.
 * @param {Object} summary - Object the worker posted back
 * @returns {{outcome: string, counters: Object}} outcome is one of JOB_OUTCOMES
 */
export const jobOutcome = (summary) => {
  const counters = { ...(summary ?? {}) };
  const skippedRun = counters.skipped === true;

  // These have their own slot in the report line, so they are never printed as counters.
  // Deleted rather than destructured away: an unused binding is a lint error.
  delete counters.ok;
  delete counters.error;
  delete counters.durationMs;
  delete counters.state;
  // A list, not a number. The count is already on the line as `failed`; the list is for
  // job_runs and the dashboard, and would render as [object Object] here.
  delete counters.failures;

  if (skippedRun) {
    delete counters.skipped;
  }

  const outcome = summary?.ok === false ? 'failed'
    : skippedRun ? 'skipped'
      : counters.claimed === 0 ? 'idle'
        : 'ok';

  return { outcome, counters };
};
