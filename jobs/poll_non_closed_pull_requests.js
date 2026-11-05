import { pathToFileURL } from "node:url";
import * as pollCursor from "../src/db/polling.js";
import * as pullRequestsDb from "../src/db/pull_requests.js";
import { fetchPullRequest } from "../src/services/octokitService.js";
import { isTokenMintFailure } from "../src/utils/github.js";
import { getLogger, format, fields } from "../src/utils/logger.js";
import { SCHEDULING, CRON } from "../src/utils/constants.js";
import { nextIntervalMinutes, errorBackoffMinutes, dispersedDelaySeconds } from "../src/utils/backoff.js";
import { tickMinutes } from "../src/utils/cron.js";
import { runJob, failureLedger, releaseClaim } from "./jobRun.js";

const logger = getLogger("poll_non_closed_pull_requests");

const POLL_BOUNDS = {
  min: SCHEDULING.POLL_MIN_INTERVAL_MINUTES,
  max: SCHEDULING.POLL_MAX_INTERVAL_MINUTES,
};

// Minutes between two wake-ups, derived from EVENTS_CRON_POLL itself — see tickMinutes().
const TICK_MINUTES = tickMinutes(CRON.POLL);

// Outside run() on purpose: a run that throws mid-loop still reports how far it got.
const totals = { claimed: 0, changed: 0, unchanged: 0, gone: 0, failed: 0 };
const { failures, noteFailure } = failureLedger();

/**
 * The repository name, for a log line and for nothing else
 *
 * Deliberately unable to fail. The request is addressed by id, so a name this cannot read is not
 * an error to handle: it returns null, format.pr() falls back to "pr #12", and the poll goes out
 * either way. A hand-entered name with three segments is enough to make that happen.
 * @returns {?{owner: string, name: string}}
 */
export const displayName = (fullName) => {
  const [owner, name, ...rest] = String(fullName ?? '').split('/');

  return owner && name && rest.length === 0 ? { owner, name } : null;
};

/**
 * Refresh one claimed pull request
 *
 * When a maintainer merges a contributor's pull request, the event lands in the *maintainer's*
 * public feed, not the contributor's: the events job sees the final state only when that
 * maintainer is enrolled (refreshPullRequest() in src/db/pull_requests.js), so polling is what
 * covers everyone else.
 * @returns {Promise<{changed: boolean, gone: boolean}>}
 */
export const pollPullRequest = async (claimed) => {
  const repo = displayName(claimed.full_name);

  try {
    // By the repository's GitHub id, which the claim read from the registry. Asked by name this
    // is a 301 for a renamed repository and a bare 404 for a transferred one - and the 301
    // resolves to exactly this route, so going straight to it skips a hop that may not be there.
    const pullRequest = await fetchPullRequest(claimed.installation_id, claimed.github_id, claimed.number);

    await pullRequestsDb.upsertPullRequest(pullRequest, claimed.repository_id);

    // Only a state change earns the fast interval: comments and pushes move updated_at without
    // telling us anything this app tracks.
    const changed = pullRequest.state !== claimed.state;

    // Only the transition is worth a line — on a 200-row batch, logging every refresh is 199
    // no-ops for one event of interest.
    if (changed) {
      logger.debug(
        { ...fields.pr(claimed.number, repo), from: claimed.state, to: pullRequest.state },
        `${format.pr(claimed.number, repo)} changed state: ${claimed.state} -> ${pullRequest.state}`
      );
    }

    return { changed, gone: false };
  } catch (error) {
    // 404/410 means the pull request or its repository is gone for good. Anything else — 403,
    // 5xx, network — is transient and must not be treated as permanent, and so is a 404 from
    // minting the token, which is about the installation and not about the pull request.
    if ((error.status === 404 || error.status === 410) && !isTokenMintFailure(error)) {
      logger.warn(
        { ...fields.pr(claimed.number, repo), status: error.status },
        `${format.pr(claimed.number, repo)} is gone (${error.status}) - backing off to the maximum interval`
      );
      return { changed: false, gone: true };
    }

    throw error;
  }
};

export const run = async () => {
  const claimed = await pollCursor.claimPullRequestsForPoll();

  // No line for an idle run: the scheduler reports it at debug, from the summary below.
  if (claimed.length === 0) {
    return;
  }

  totals.claimed = claimed.length;

  logger.info(`polling ${claimed.length} due pull request(s)`);

  for (const pullRequest of claimed) {
    const repo = displayName(pullRequest.full_name);

    try {
      const result = await pollPullRequest(pullRequest);

      const intervalMinutes = result.gone
        ? SCHEDULING.POLL_MAX_INTERVAL_MINUTES
        : nextIntervalMinutes(pullRequest.poll_interval_minutes, result.changed, POLL_BOUNDS);

      // The claim itself, lease included: see heldLease() in src/db/polling.js.
      await pollCursor.markPollSucceeded(pullRequest, {
        intervalMinutes,
        delaySeconds: dispersedDelaySeconds(intervalMinutes, TICK_MINUTES),
      });

      if (result.gone) {
        totals.gone++;
      } else if (result.changed) {
        totals.changed++;
      } else {
        totals.unchanged++;
      }
    } catch (error) {
      totals.failed++;
      noteFailure(format.pr(pullRequest.number, repo), error);

      const retryInMinutes = errorBackoffMinutes(pullRequest.poll_error_count + 1, {
        min: SCHEDULING.POLL_MIN_INTERVAL_MINUTES,
        max: SCHEDULING.MAX_ERROR_BACKOFF_MINUTES,
      });

      // Dispersed on this path too: an outage fails every subject in the same run.
      const retryInSeconds = dispersedDelaySeconds(retryInMinutes, TICK_MINUTES);

      logger.error(
        { err: error, ...fields.pr(pullRequest.number, repo), retry_in_minutes: Math.round(retryInSeconds / 60) },
        `could not poll ${format.pr(pullRequest.number, repo)} - retrying in ${format.duration(retryInSeconds * 1000)}: ${error.message}`
      );

      await releaseClaim(
        pollCursor.markPollFailed(pullRequest, retryInSeconds, error.message),
        logger,
        format.pr(pullRequest.number, repo),
        fields.pr(pullRequest.number, repo)
      );
    }
  }
};

// Guarded so a test can import the body without running the job against the real database and
// the real GitHub API. Bree starts each job in a Worker whose process.argv[1] is this file, and a
// run by hand is the same check, so both still execute it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runJob({ name: 'poll_non_closed_pull_requests', logger, run, totals, tail: () => ({ failures }) });
}
