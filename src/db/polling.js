import { query } from "./index.js";
import { getLogger } from "../utils/logger.js";
import { SCHEDULING } from "../utils/constants.js";

/**
 * The poll cursor on pull requests: claim a batch, then record what became of each.
 *
 * Separate from the row's own data, which pull_requests.js writes. These functions touch only
 * the scheduling columns — `next_poll_at`, `poll_claimed_at`, `poll_interval_minutes`,
 * `poll_error_count`, `last_polled_at`, `last_poll_error` — and never the pull request itself.
 *
 * The claim below is the exception, and only because a claim has to hand the job everything its
 * request needs: it reads the repository the contribution points at, for the GitHub id the call
 * is built from.
 */

const logger = getLogger("polling");

/**
 * Atomically claim the open pull requests that are due for a refresh
 *
 * Same protocol as claimInstallationsForSync(). Ordering on next_poll_at — a column this poller
 * advances itself — is what makes the batch cap fair: updated_at comes from GitHub and does not
 * move when a poll finds no change, so the same rows would be re-polled forever.
 *
 * The join on github_repositories is the address of the request the job is about to make: it
 * returns `github_id`, which is what GET /repositories/{id}/pulls/{number} is built from, and
 * `full_name` beside it for the log line and nothing else. INNER because repository_id is NOT
 * NULL behind a foreign key — a row that could not join cannot exist, and a LEFT JOIN would only
 * hide it if one ever did.
 * @returns {Promise<Array<Object>>} Claimed rows, with the installation to authenticate as
 */
export const claimPullRequestsForPoll = async () => {
  try {
    const queryText = `
      WITH due AS (
        SELECT pr.id
        FROM github_pull_requests pr
        INNER JOIN github_installations gi ON pr.opened_by = gi.user_login
        WHERE pr.state IS DISTINCT FROM 'closed'
          -- A hand-entered contribution has no pull request on github.com to read, so polling
          -- it would fail on every run until the backoff retired it.
          AND pr.origin = 'github'
          AND gi.installation_suspended = false
          AND gi.installation_deleted = false
          AND gi.verified_at IS NOT NULL
          AND gi.installation_id IS NOT NULL
          AND (pr.next_poll_at IS NULL OR pr.next_poll_at <= CURRENT_TIMESTAMP)
          AND (pr.poll_claimed_at IS NULL
               OR pr.poll_claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $2::int))
        ORDER BY pr.next_poll_at ASC NULLS FIRST
        LIMIT $1
        FOR UPDATE OF pr SKIP LOCKED
      ),
      claimed AS (
        UPDATE github_pull_requests
        SET poll_claimed_at = CURRENT_TIMESTAMP
        WHERE id IN (SELECT id FROM due)
        RETURNING id, number, repository_id, state, poll_interval_minutes, poll_error_count,
                  opened_by, poll_claimed_at
      )
      SELECT c.id, c.number, c.repository_id, c.state, c.poll_interval_minutes,
             c.poll_error_count,
             -- The token the release is fenced on, as text for the reason given in
             -- claimInstallationsForSync().
             c.poll_claimed_at::text AS lease,
             r.github_id, r.full_name,
             -- The due CTE's predicates again: two rows can share a login - an uninstalled
             -- account whose freed login somebody else enrolled with - and only a live one can
             -- mint a token. Ordered so the pick does not change from one run to the next.
             (SELECT gi.installation_id
              FROM github_installations gi
              WHERE gi.user_login = c.opened_by
                AND gi.installation_suspended = false
                AND gi.installation_deleted = false
                AND gi.verified_at IS NOT NULL
                AND gi.installation_id IS NOT NULL
              ORDER BY gi.verified_at DESC, gi.id DESC
              LIMIT 1) AS installation_id
      FROM claimed c
      INNER JOIN github_repositories r ON r.id = c.repository_id
    `;

    const result = await query(queryText, [
      SCHEDULING.POLL_BATCH_SIZE,
      SCHEDULING.CLAIM_LEASE_MINUTES,
    ]);

    logger.debug(`claimed ${result.rows.length} pull request(s) for polling`);

    return result.rows;
  } catch (cause) {
    throw new Error('could not claim pull requests for polling', { cause });
  }
};

/**
 * Whether a fenced release found its lease, saying so when it did not
 *
 * Same fence as the sync's - see heldLease() in installations.js. Nothing but a release clears
 * this lease, so here it only ever catches a run that outlived CLAIM_LEASE_MINUTES while another
 * took the row.
 * @param {{number: number, full_name: string}} claim - The row as it was claimed
 * @param {number} rowCount - What the release updated
 * @returns {boolean} Whether the outcome was written
 */
const heldLease = (claim, rowCount) => {
  if (rowCount === 0) {
    logger.info(
      { pr_number: claim.number, repo: claim.full_name },
      `the poll outcome for ${claim.full_name}#${claim.number} is dropped - another run claimed the row after this one's lease ran out`
    );
  }

  return rowCount > 0;
};

/**
 * Release a claimed pull request after a successful poll
 * @param {{id: number, lease: string}} claim - The row as claimPullRequestsForPoll() returned it
 * @param {{intervalMinutes: number, delaySeconds: number}} outcome
 * @returns {Promise<boolean>} False when the outcome was superseded and dropped
 */
export const markPollSucceeded = async (claim, { intervalMinutes, delaySeconds }) => {
  const queryText = `
    UPDATE github_pull_requests
    SET last_polled_at = CURRENT_TIMESTAMP,
        -- The delay carries the dispersion; the interval stored beside it does not. The ladder
        -- doubles from the stored value, so a jittered one would compound into the interval.
        next_poll_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        poll_interval_minutes = $3,
        poll_claimed_at = NULL,
        poll_error_count = 0,
        -- Cleared, or the page would keep showing a failure that has already been repaired.
        last_poll_error = NULL
    WHERE id = $1
      AND poll_claimed_at = $4::timestamptz
  `;

  try {
    const { rowCount } = await query(queryText, [claim.id, delaySeconds, intervalMinutes, claim.lease]);

    return heldLease(claim, rowCount);
  } catch (cause) {
    // Named, because the caller cannot: this runs inside the poll job's per-subject try, whose
    // catch reports the failure as a failed poll of the pull request itself.
    throw new Error(`could not release the poll claim on pull request row ${claim?.id}`, { cause });
  }
};

/**
 * Release a claimed pull request after a failed poll
 * @param {{id: number, lease: string}} claim - The row as claimPullRequestsForPoll() returned it
 * @param {number} delaySeconds - Backoff before the next attempt
 * @param {?string} [errorMessage] - Why it failed. Overwritten by the next failure and cleared
 *   by the next success, so it only ever answers "what is wrong now"
 * @returns {Promise<boolean>} False when the outcome was superseded and dropped
 */
export const markPollFailed = async (claim, delaySeconds, errorMessage = null) => {
  const queryText = `
    UPDATE github_pull_requests
    SET next_poll_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        poll_claimed_at = NULL,
        poll_error_count = poll_error_count + 1,
        last_poll_error = $3::text
    WHERE id = $1
      AND poll_claimed_at = $4::timestamptz
  `;

  try {
    const { rowCount } = await query(queryText, [claim.id, delaySeconds, errorMessage, claim.lease]);

    return heldLease(claim, rowCount);
  } catch (cause) {
    throw new Error(`could not record a failed poll of pull request row ${claim?.id}`, { cause });
  }
};
