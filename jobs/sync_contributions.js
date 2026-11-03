import { pathToFileURL } from "node:url";
import * as installationsDb from "../src/db/installations.js";
import * as eventLedger from "../src/db/events.js";
import * as pullRequestsDb from "../src/db/pull_requests.js";
import * as repositoriesDb from "../src/db/repositories.js";
import { transaction } from "../src/db/index.js";
import { appOctokit, fetchPublicEvents, pullRequestById } from "../src/services/octokitService.js";
import { getLogger, format, fields } from "../src/utils/logger.js";
import { parseRepoFullname, missedEventsWindow, isTokenMintFailure } from "../src/utils/github.js";
import { SCHEDULING, CRON } from "../src/utils/constants.js";
import { nextIntervalMinutes, errorBackoffMinutes, dispersedDelaySeconds, disableReasonFor } from "../src/utils/backoff.js";
import { tickMinutes } from "../src/utils/cron.js";
import { runJob, failureLedger, releaseClaim } from "./jobRun.js";

const logger = getLogger("sync_contributions");

const SYNC_BOUNDS = {
  min: SCHEDULING.SYNC_MIN_INTERVAL_MINUTES,
  max: SCHEDULING.SYNC_MAX_INTERVAL_MINUTES,
};

// Minutes between two wake-ups, derived from EVENTS_CRON itself — see tickMinutes().
const TICK_MINUTES = tickMinutes(CRON.SYNC);

// Outside run() on purpose: a run that throws mid-loop still reports how far it got.
const totals = { claimed: 0, changed: 0, unchanged: 0, failed: 0, disabled: 0, prs: 0, others: 0, pushes: 0, repositories: 0, skipped: 0 };
const { failures, noteFailure } = failureLedger();

/** Activity in one's own namespace is a personal project, not an open-source contribution. */
export const isExternalContribution = (event) =>
  typeof event.repo?.name === 'string' &&
  typeof event.actor?.login === 'string' &&
  !event.repo.name.startsWith(`${event.actor.login}/`);

/**
 * Whether the person whose feed this is opened the pull request, rather than merely acted on it
 *
 * The feed returns what somebody DID, and a PullRequestEvent is emitted for ten actions besides
 * `opened` - assigned, labeled, closed, merged, reopened, review_requested and the rest. Every
 * one of them is a maintainer's normal day on somebody else's pull request, and every one of
 * them lands in the maintainer's own feed as a perfectly legitimate event.
 *
 * The envelope cannot answer this question: its `payload.pull_request` carries base, head, id,
 * number and url, and no author at all. Only the hydration response does - which is why this
 * takes the fetched pull request and not the event, and why the check cannot be moved earlier to
 * save the fetch.
 *
 * Lower-cased on both sides: GitHub logins are case-insensitive, and the stored one was written
 * at enrollment while this one comes from the API.
 * @param {Object} pullRequest - As returned by the hydration call
 * @param {string} githubHandle - The login of the installation being synchronized
 */
const isOwnPullRequest = (pullRequest, githubHandle) =>
  typeof pullRequest?.user?.login === 'string' &&
  typeof githubHandle === 'string' &&
  pullRequest.user.login.toLowerCase() === githubHandle.toLowerCase();

/**
 * Fetch the full pull request behind a PullRequestEvent
 *
 * By repository id, not by the name in the envelope. The name is what the repository was called
 * when the event was produced, and the feed reaches back as far as ~90 days: a repository renamed
 * since answers a 301 at best and, if the move was a transfer, a bare 404. The id in the same
 * envelope has neither problem. The name is parsed for the log line and for nothing else.
 */
const hydratePullRequest = async (octokit, pullRequestEvent) => {
  const repo = parseRepoFullname(pullRequestEvent.repo.name);
  const number = pullRequestEvent.payload.number;

  const data = await pullRequestById(octokit, pullRequestEvent.repo.id, number);

  logger.trace({ ...fields.pr(number, repo) }, `hydrated ${format.pr(number, repo)}`);

  return data;
};

/**
 * Record the repository and the event as one unit, and say whether the event is new
 *
 * ORDER, and it is forced: the ledger row has a foreign key on the repository row, so the
 * repository comes first. That costs one indexed no-op insert per event even when the event
 * turns out to be known, on a feed that returns the same three hundred entries every run. Paid
 * deliberately — the way to avoid it is a second creator of repository rows keyed on something
 * other than the id, and two creators with two keys is how one repository gets two rows.
 *
 * The unit is what makes a failure retryable rather than half-written: a crash between the two
 * would leave a repository row for an event nothing recorded, where this way the next run finds
 * the event unknown and starts again from the same clean state.
 *
 * The two ledger writers answer in two shapes, because they have two different amounts to say. A
 * push is complete the moment it is stored - nothing describes one, so there is no second half
 * that could be missing - and it answers a plain boolean. A pull request event has a snapshot
 * filled in by a later statement, so it answers `{ isNew, hydrated }` and a stored row can still
 * be incomplete. Normalised here so the caller has one shape to read.
 * @param {Function} insert - The ledger writer for this event's kind
 * @returns {Promise<{repositoryId: number, created: boolean, isNew: boolean, hydrated: boolean}>}
 *   `hydrated` is true for anything with nothing left to fetch
 */
export const noteEvent = async (event, insert) => transaction(async (run) => {
  const repository = await repositoriesDb.ensureRepository(event.repo.name, event.repo.id, run);
  const noted = await insert(event, repository.id, run);
  const isNew = typeof noted === 'boolean' ? noted : noted.isNew;
  const hydrated = typeof noted === 'boolean' ? true : noted.hydrated;

  return { repositoryId: repository.id, created: repository.created, isNew, hydrated };
});

/**
 * Synchronize one installation's contributions
 * @param {Object} claimed - Row returned by claimInstallationsForSync
 * @returns {Promise<{changed: boolean, notModified: boolean, etag: ?string, prs: number, others: number, pushes: number, repositories: number, skipped: number}>}
 */
export const syncInstallation = async (claimed) => {
  const {
    installation_id: installationId,
    user_login: githubHandle,
    events_etag: etag,
    last_synced_at: lastSyncedAt,
  } = claimed;
  const stats = { changed: false, notModified: false, etag: null, prs: 0, others: 0, pushes: 0, repositories: 0, skipped: 0 };

  // One client for the feed and every hydration after it: each client mints its own token.
  const octokit = appOctokit(installationId);
  const feed = await fetchPublicEvents(octokit, githubHandle, etag);

  if (feed.notModified) {
    // No line of its own: the per-installation outcome below carries the reason, so a quiet
    // installation costs one line instead of two.
    stats.notModified = true;
    return stats;
  }

  stats.etag = feed.etag;

  // The one thing this job can lose permanently, and the only place it can be noticed. A warn
  // rather than an error: the sync succeeds with everything GitHub still serves, but this
  // person's history now has a hole no later run can fill.
  const missed = missedEventsWindow(feed, lastSyncedAt);

  if (missed) {
    logger.warn(
      {
        ...fields.installation(installationId),
        ...fields.user(githubHandle),
        events: feed.events.length,
        missed_since: missed.since?.toISOString() ?? null,
        missed_until: missed.until.toISOString(),
      },
      missed.since
        ? `${format.user(githubHandle)} produced more than ${feed.events.length} public events since the last sync - what happened between ${missed.since.toISOString()} and ${missed.until.toISOString()} is past GitHub's feed limit and cannot be recovered`
        : `${format.user(githubHandle)} is synced for the first time and the feed is already full at ${feed.events.length} events - nothing before ${missed.until.toISOString()} was ever readable`
    );
  }

  const contributions = feed.events.filter(isExternalContribution);

  for (const event of contributions) {
    // Isolated, so a deleted fork or a repository turned private cannot throw out of the loop
    // and silently drop everything after it.
    try {
      if (event.type === 'PullRequestEvent') {
        const noted = await noteEvent(event, eventLedger.insertPullRequestEventIfNotExists);

        stats.repositories += noted.created ? 1 : 0;

        // A known event is not re-hydrated: that lookup is the bulk of the API budget. But the
        // ledger row is committed before the fetch below, so a fetch that failed leaves a known
        // event with an empty snapshot - skipping on `isNew` alone would never fill it in.
        if (!noted.isNew && noted.hydrated) {
          continue;
        }

        const pullRequest = await hydratePullRequest(octokit, event);

        // Who opened it, which the envelope could not say - see isOwnPullRequest(). The ledger
        // keeps every event either way; this decides only whether the pull request joins the
        // measured contributions.
        const own = isOwnPullRequest(pullRequest, githubHandle);

        // The second unit: none of the snapshot columns is in the feed's payload, so the ledger
        // is written in two goes. Together, so the snapshot and the contribution are either both
        // written from this response or neither is.
        //
        // The snapshot is written for somebody else's pull request too: `hydrated` is read off
        // `title IS NOT NULL`, so skipping it would re-fetch that event on every run.
        await transaction(async (run) => {
          await eventLedger.recordPullRequestSnapshot(event.id, pullRequest, run);

          if (own) {
            await pullRequestsDb.upsertPullRequest(pullRequest, noted.repositoryId, run);
          }
        });

        // Counted apart rather than not at all: an event on somebody else's pull request is real
        // activity in this feed, it cost a fetch, and a run reporting prs=0 with nothing beside
        // it reads like a job that found nothing.
        if (own) {
          stats.prs++;
        } else {
          stats.others++;
        }

        stats.changed = true;
      } else if (event.type === 'PushEvent') {
        const noted = await noteEvent(event, eventLedger.insertPushEventIfNotExists);

        stats.repositories += noted.created ? 1 : 0;

        // Nothing hydrates a push: there is no call that describes one, which is why this
        // branch ends here and the four popularity columns beside it are an archive.
        if (noted.isNew) {
          stats.pushes++;
          stats.changed = true;
        }
      }
    } catch (error) {
      stats.skipped++;

      // A warn: a deleted fork or a repository turned private is the common case, it is
      // counted, and the run still succeeds.
      logger.warn(
        {
          err: error,
          ...fields.installation(installationId),
          ...fields.user(githubHandle),
          event_type: event.type,
          event_id: event.id,
          repo: event.repo?.name,
        },
        `skipped ${event.type} ${event.id} on ${event.repo?.name ?? 'an unknown repository'} - it is counted as skipped and the run continues: ${error.message}`
      );
    }
  }

  return stats;
};

export const run = async () => {
  const claimed = await installationsDb.claimInstallationsForSync();

  // No line for an idle run: the scheduler reports it at debug, from the summary below.
  if (claimed.length === 0) {
    return;
  }

  totals.claimed = claimed.length;

  logger.info(`syncing ${claimed.length} due installation(s)`);

  for (const installation of claimed) {
    try {
      const stats = await syncInstallation(installation);

      const intervalMinutes = nextIntervalMinutes(
        installation.sync_interval_minutes,
        stats.changed,
        SYNC_BOUNDS
      );

      // Released per installation, not per batch, so a worker killed mid-run keeps its progress.
      await installationsDb.markSyncSucceeded(installation.id, {
        intervalMinutes,
        delaySeconds: dispersedDelaySeconds(intervalMinutes, TICK_MINUTES),
        etag: stats.etag,
      });

      totals.prs += stats.prs;
      totals.others += stats.others;
      totals.pushes += stats.pushes;
      totals.repositories += stats.repositories;
      totals.skipped += stats.skipped;

      const context = {
        ...fields.installation(installation.installation_id),
        ...fields.user(installation.user_login),
        next_in_minutes: intervalMinutes,
      };

      if (stats.changed) {
        totals.changed++;
        logger.info(
          { ...context, prs: stats.prs, others: stats.others, pushes: stats.pushes, skipped: stats.skipped },
          `synced ${format.user(installation.user_login)} - ${stats.prs} new pull request(s), ${stats.others} on somebody else's, ${stats.pushes} new push(es), ${stats.skipped} skipped, next in ${intervalMinutes}min`
        );
      } else {
        totals.unchanged++;
        const reason = stats.notModified ? 'feed unchanged' : 'no new contribution';
        logger.debug(context, `${format.user(installation.user_login)} has nothing new (${reason}) - next in ${intervalMinutes}min`);
      }
    } catch (error) {
      totals.failed++;
      noteFailure(installation.user_login, error);

      const consecutive = installation.sync_error_count + 1;

      // A 404 from the feed itself, not from minting the token: that one is about the
      // installation, and says nothing about whether the account exists.
      const notFound = error.status === 404 && !isTokenMintFailure(error);
      const consecutive404s = notFound ? installation.sync_404_count + 1 : 0;

      const retryInMinutes = errorBackoffMinutes(consecutive, {
        min: SCHEDULING.SYNC_MIN_INTERVAL_MINUTES,
        max: SCHEDULING.MAX_ERROR_BACKOFF_MINUTES,
      });

      // Dispersed on this path too: an outage fails every subject in the same run, and an
      // undispersed backoff would send the whole population back at the same instant, onto a
      // dependency that has just proved it is struggling.
      const retryInSeconds = dispersedDelaySeconds(retryInMinutes, TICK_MINUTES);

      // Decided here rather than in SQL: the status code separates "this account is gone" from
      // "GitHub is unwell", and only the caller has it.
      const disableReason = disableReasonFor(consecutive, consecutive404s, {
        after404: SCHEDULING.SYNC_DISABLE_AFTER_404,
        afterFailures: SCHEDULING.SYNC_DISABLE_AFTER_FAILURES,
      });

      // The Error stays at each call site rather than riding inside this object: a spread hides
      // it from the reader and from the check that every logger.error hands one to pino.
      const context = {
        ...fields.installation(installation.installation_id),
        ...fields.user(installation.user_login),
        status: error.status ?? null,
        consecutive_failures: consecutive,
      };

      if (disableReason) {
        totals.disabled++;

        const accountGone = disableReason === 'account gone';

        // An error, not a warning: the app is giving up on someone who enrolled, and an
        // operator should be able to find that decision later without looking for it.
        logger.error(
          { err: error, ...context, disabled_reason: disableReason },
          `giving up on ${format.user(installation.user_login)} after ${accountGone ? `${consecutive404s} consecutive 404(s)` : `${consecutive} consecutive failure(s)`} - ${disableReason}, no further sync until they enroll again${accountGone ? ', or until reconciliation finds the login was merely renamed' : ''}`
        );
      } else {
        logger.error(
          { err: error, ...context, retry_in_minutes: Math.round(retryInSeconds / 60) },
          `could not sync ${format.user(installation.user_login)} - retrying in ${format.duration(retryInSeconds * 1000)}: ${error.message}`
        );
      }

      // Released explicitly rather than waiting out the lease, and pushed out so a permanently
      // broken installation stops taking a slot every tick.
      await releaseClaim(
        installationsDb.markSyncFailed(installation.id, retryInSeconds, error.message, disableReason, notFound),
        logger,
        format.installation(installation.installation_id),
        fields.installation(installation.installation_id)
      );
    }
  }
};

// Guarded so a test can import the body without running the job against the real database and
// the real GitHub API. Bree starts each job in a Worker whose process.argv[1] is this file, and a
// run by hand is the same check, so both still execute it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runJob({ name: 'sync_contributions', logger, run, totals, tail: () => ({ failures }) });
}
