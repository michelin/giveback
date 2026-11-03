import { pathToFileURL } from "node:url";
import * as installationsDb from "../src/db/installations.js";
import { listAppInstallations } from "../src/services/octokitService.js";
import { getLogger, format, fields } from "../src/utils/logger.js";
import { purgeJobRuns } from "../src/db/job_runs.js";
import { JOB_RUN_RETENTION_DAYS } from "../src/utils/constants.js";
import { runJob } from "./jobRun.js";

const logger = getLogger("reconcile_installations");

// Outside run() on purpose: a run that throws mid-way still reports how far it got.
const totals = { live: 0, corrected: 0, renamed: 0, deleted: 0, unknown: 0, purged: 0 };
let skippedRun = false;

/**
 * Bring the database in line with what GitHub reports for this app.
 *
 * Low-frequency on purpose: GET /app/installations is paginated, so at a few thousand
 * installations it is ~30 requests against the app-level (JWT) budget.
 *
 * It exists for two silent, permanent drifts, and only those two are worth a job:
 *  - **a missed or out-of-order unsuspend webhook**. The row stays flagged suspended, the user
 *    stops being synchronized, and nothing in the logs says so.
 *  - **a renamed GitHub login**, which has no webhook at all. The installation id does not move,
 *    the stored login silently goes stale, and every later GET /users/{login}/events answers
 *    404 — indistinguishable from a deleted account.
 *
 * Every other drift is noisy or self-limiting. A missed *suspend* or *deleted* shows up as
 * failing syncs and the error backoff pushes the row aside; repaired here anyway, because it is
 * free. A missed *created* is already covered by the OAuth callback resolving the installation
 * from GET /user/installations, so installations GitHub knows and we do not are only *counted*
 * here — a pending row is never synchronized, so creating one would repair nothing.
 * @returns {Promise<Object>} State counters, for the ` | ` segment of the run report
 */
export const run = async () => {
  // A start marker, because this job holds the longest closeWorkerAfterMs and makes the
  // paginated call most likely to hang: without it a killed worker leaves no trace it ever ran.
  logger.info('reconciling stored installations against github');

  const live = await listAppInstallations();

  if (live.length === 0) {
    // A GitHub hiccup must never look like "everybody uninstalled".
    logger.warn('github reports no installation at all - skipping reconciliation, the next run will retry');
    skippedRun = true;
    return installationsDb.countInstallationStates();
  }

  const liveIds = live.map((installation) => installation.id);
  const known = await installationsDb.listKnownInstallationIds();

  totals.live = live.length;
  totals.unknown = liveIds.filter((id) => !known.has(id)).length;

  if (totals.unknown > 0) {
    // Reported, not repaired: a number that keeps growing means people install the app and
    // never finish the email check, which is a signal about the enrollment page.
    logger.warn(`${totals.unknown} installation(s) known to github but not to the database - their owner never completed enrollment`);
  }

  totals.corrected = await installationsDb.reconcileInstallationStates(live);

  // Before the deletion pass, so a row about to be judged is judged on its current login.
  const renamed = await installationsDb.refreshStaleLogins(live);

  totals.renamed = renamed.length;

  for (const { old_login: oldLogin, new_login: newLogin } of renamed) {
    // One line each, at info: a rename is rare, it silently broke every sync until now, and
    // this is the only record tying past log lines to the login used from here.
    logger.info(
      { ...fields.user(newLogin), previous_login: oldLogin },
      `${oldLogin ?? 'an installation with no stored login'} is now ${format.user(newLogin)} - syncing resumes immediately`
    );
  }

  totals.deleted = await installationsDb.markMissingInstallationsDeleted(liveIds);

  // Housekeeping rides along rather than in a fourth job: this is the only run infrequent
  // enough that a rolling delete costs nothing, and one DELETE an hour is not worth a worker
  // thread and a schedule to keep in sync. Never fatal — a job_runs table missing from the
  // schema must not turn into a failed reconciliation.
  try {
    totals.purged = await purgeJobRuns(JOB_RUN_RETENTION_DAYS);
  } catch (error) {
    logger.warn(
      { err: error },
      `could not purge job runs older than ${JOB_RUN_RETENTION_DAYS} day(s) - the table keeps growing until this succeeds: ${error.message}`
    );
  }

  return installationsDb.countInstallationStates();
};

// Guarded so a test can import the body without running the job against the real database and
// the real GitHub API. Bree starts each job in a Worker whose process.argv[1] is this file, and a
// run by hand is the same check, so both still execute it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runJob({
    name: 'reconcile_installations',
    logger,
    run,
    totals,
    // The one job whose summary needs more than its totals, which is why runJob takes this hook
    // rather than guessing. `state` describes the whole system rather than this run, which is why
    // it sits behind the ` | ` separator. `skipped` is a side effect of run(), not something it
    // returns.
    tail: (state) => ({
      ...(skippedRun ? { skipped: true } : {}),
      ...(state ? { state } : {}),
    }),
  });
}
