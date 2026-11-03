import { pathToFileURL } from "node:url";
import * as repositoriesDb from "../src/db/repositories.js";
import { transaction } from "../src/db/index.js";
import { fetchRepository } from "../src/services/octokitService.js";
import { isTokenMintFailure } from "../src/utils/github.js";
import { getLogger, format } from "../src/utils/logger.js";
import { SCHEDULING, CRON } from "../src/utils/constants.js";
import { errorBackoffMinutes, dispersedDelaySeconds } from "../src/utils/backoff.js";
import { tickMinutes } from "../src/utils/cron.js";
import { runJob, failureLedger, releaseClaim } from "./jobRun.js";

const logger = getLogger("sync_repositories");

// Minutes between two wake-ups, derived from REPOS_CRON itself — see tickMinutes().
const TICK_MINUTES = tickMinutes(CRON.SYNC_REPOS);

// Fixed, not adaptive: see SCHEDULING.REPO_REFRESH_INTERVAL_MINUTES for why this one subject
// does not climb the ladder the others do.
const INTERVAL_MINUTES = SCHEDULING.REPO_REFRESH_INTERVAL_MINUTES;

// Outside run() on purpose: a run that throws mid-loop still reports how far it got.
const totals = { claimed: 0, changed: 0, unchanged: 0, renamed: 0, gone: 0, failed: 0 };
const { failures, noteFailure } = failureLedger();

const NO_INSTALLATION = 'no active installation to read with';

/**
 * Refresh one claimed repository
 *
 * This job owns exactly two facts about the outside world, and both arrive through the same
 * request: what a repository is called today, and whether it still answers. Nothing else in this
 * application discovers either, and nothing else writes them.
 * @returns {Promise<{changed: boolean, renamed: boolean}>}
 */
export const refreshRepository = async (claimed) => {
  // By id. The claim never returns a row without one, so there is no name to fall back on and
  // none to fail on.
  const { notModified, repository, etag } = await fetchRepository(
    claimed.installation_id, claimed.github_id, claimed.etag);

  if (notModified) {
    await repositoriesDb.markRefreshUnchanged(
      claimed.id,
      dispersedDelaySeconds(INTERVAL_MINUTES, TICK_MINUTES)
    );

    return { changed: false, renamed: false };
  }

  // The request went out with an id and GitHub answered with today's name. There is no other
  // signal - GitHub exposes no rename history - and nothing has to move with it: every child row
  // points at this row rather than at its name, so a rename costs one column and one history
  // row.
  const renamed = repository.full_name !== claimed.full_name;

  // Together, so a name is never overwritten without its predecessor being written down.
  await transaction(async (run) => {
    await repositoriesDb.markRefreshSucceeded(
      claimed.id,
      repository,
      etag,
      dispersedDelaySeconds(INTERVAL_MINUTES, TICK_MINUTES),
      run
    );

    if (renamed) {
      await repositoriesDb.recordRename(claimed.id, claimed.full_name, repository.full_name, run);
    }
  });

  if (renamed) {
    logger.info(
      { repo: repository.full_name, previous_repo: claimed.full_name, github_id: claimed.github_id },
      `${claimed.full_name} is now called ${repository.full_name} - nothing else moves, every contribution points at the row`
    );
  }

  return {
    // Only the star count decides: a repository whose ETag moved because of a new description
    // is not news, and this counter exists to say whether the popularity figures are moving.
    changed: repository.stargazers_count !== claimed.stargazers_count,
    renamed,
  };
};

export const run = async () => {
  const claimed = await repositoriesDb.claimRepositoriesForRefresh();

  totals.claimed = claimed.length;

  // No line for an idle run: the scheduler reports it at debug, from the summary below.
  if (claimed.length > 0) {
    logger.info(`refreshing ${claimed.length} due repository(ies)`);
  }

  for (const repository of claimed) {
    // Nothing to authenticate with. Not an error worth retrying either: it clears the moment
    // one account is enrolled, so the row simply goes back in the queue.
    if (!repository.installation_id) {
      totals.failed++;
      noteFailure(repository.full_name, new Error(NO_INSTALLATION));
      await releaseClaim(
        repositoriesDb.markRefreshFailed(
          repository.id,
          dispersedDelaySeconds(INTERVAL_MINUTES, TICK_MINUTES),
          NO_INSTALLATION
        ),
        logger,
        repository.full_name,
        { repo: repository.full_name }
      );
      continue;
    }

    try {
      const result = await refreshRepository(repository);

      if (result.renamed) {
        totals.renamed++;
      }

      if (result.changed) {
        totals.changed++;
      } else {
        totals.unchanged++;
      }
    } catch (error) {
      totals.failed++;
      noteFailure(repository.full_name, error);

      const consecutive = repository.refresh_error_count + 1;

      // 404 or 410 against an ID, which is what makes the verdict safe to write at all: an id
      // survives a rename and a transfer, so this is about the repository and not about a name
      // that moved. A token that could not be minted answers 404 too, about the installation.
      const notFound = (error.status === 404 || error.status === 410) && !isTokenMintFailure(error);
      const consecutive404s = notFound ? repository.refresh_404_count + 1 : 0;

      // Not on the first one, and only on an unbroken run: a repository made private for an
      // afternoon answers identically to a deleted one, and the mark is one-way.
      const gone = notFound && consecutive404s >= SCHEDULING.REPO_GONE_AFTER_404;

      if (gone) {
        totals.gone++;
      }

      const retryInMinutes = errorBackoffMinutes(consecutive, {
        min: INTERVAL_MINUTES,
        max: SCHEDULING.MAX_ERROR_BACKOFF_MINUTES,
      });
      const retryInSeconds = dispersedDelaySeconds(retryInMinutes, TICK_MINUTES);

      logger[gone ? 'warn' : 'error'](
        { err: error, repo: repository.full_name, status: error.status ?? null, consecutive_failures: consecutive },
        gone
          ? `${repository.full_name} answered ${error.status} on ${consecutive404s} consecutive refreshes by id - marked gone, no further refresh, everything it last reported is kept`
          : `could not refresh ${repository.full_name} - retrying in ${format.duration(retryInSeconds * 1000)}: ${error.message}`
      );

      // One release site, two verdicts. A gone row leaves the queue through gone_at; anything
      // else goes back into it with a backoff.
      const release = gone
        ? repositoriesDb.markRepositoryGone(repository.id, `${error.status} by id after ${consecutive404s} attempts`)
        : repositoriesDb.markRefreshFailed(repository.id, retryInSeconds, error.message, notFound);

      await releaseClaim(release, logger, repository.full_name, { repo: repository.full_name });
    }
  }
};

// Guarded so a test can import the body without running the job against the real database and
// the real GitHub API. Bree starts each job in a Worker whose process.argv[1] is this file, and a
// run by hand is the same check, so both still execute it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runJob({ name: 'sync_repositories', logger, run, totals, tail: () => ({ failures }) });
}
