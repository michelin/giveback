import { query } from "./index.js";
import { getLogger } from "../utils/logger.js";
import { SCHEDULING } from "../utils/constants.js";

/**
 * The registry: one row per repository anything has been contributed to, and its popularity as
 * it is today.
 *
 * Popularity, licence and topics belong to the repository, and this is where they are current.
 * The columns of the same name on github_pull_requests are not redundant with these: they are
 * the snapshot at the moment of the contribution, and any aggregate over THOSE picks one copy
 * out of twelve that disagree.
 *
 * Identity here is `github_id`, and the row's own `id` is what every other table points at. A
 * name is an attribute: each refresh rewrites it, its previous values go to
 * github_repository_renames, and nothing in this application looks a repository up by one.
 */

const logger = getLogger("repositories");

/**
 * Give a repository its row the moment a contribution to it is seen
 *
 * Every envelope in the events feed carries `repo.id` beside the name — measured on the live
 * API, 107 PullRequestEvent out of 107, always equal to the `base.repo.id` the hydration would
 * read. So the id is free here, and it has to be taken: this is the only creator of a row WITH
 * an id - ensureForeignRepository() below writes the id-less ones - so a row created here
 * without an id could never acquire one.
 *
 * Which is why a missing id throws rather than inserting. `github_id` is the conflict target,
 * and two nulls are distinct in the partial unique index behind it — so an id-less insert
 * conflicts with nothing and every single event adds another row for the same repository. Not a
 * row to repair later; a row nothing can ever tell apart from its twin.
 *
 * The rows that legitimately have no id are written by hand, and they are not one kind of thing:
 * in production, two are GitLab projects this application cannot see, and one is a GitHub
 * repository whose name answers 404 with no id to fall back on. Which is why the null means
 * "cannot be read" rather than "another forge", and why there is no `forge` column. Nothing here
 * reaches any of them, and nothing here should.
 * @param {string} fullName - As the feed gave it; the refresh owns it from then on
 * @param {number} githubId - `event.repo.id`
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 * @returns {Promise<{id: number, created: boolean}>} The row every child table points at
 */
export const ensureRepository = async (fullName, githubId, run = query) => {
  // A positive integer, or nothing happens. `Number(null)` is 0 and `Number('')` is 0, both of
  // which would sail through a plain isFinite() check and reach the insert.
  if (!Number.isInteger(Number(githubId)) || Number(githubId) <= 0) {
    throw new Error(`refusing to record the repository ${fullName} without a GitHub id`);
  }

  // Two branches and a deterministic order, because a statement cannot see its own INSERT: on a
  // fresh insert the second branch reads the pre-statement snapshot and returns nothing, and on
  // a conflict the first returns nothing. Exactly one of them yields a row. `ORDER BY` rather
  // than relying on UNION ALL's order, which SQL does not promise.
  const queryText = `
    WITH created AS (
      INSERT INTO github_repositories (github_id, full_name)
      VALUES ($1, $2)
      -- The predicate is repeated, and it is not optional: idx_repositories_github_id is a
      -- PARTIAL unique index, and PostgreSQL will not infer one from the column alone. Without
      -- it this raises 42P10, "there is no unique or exclusion constraint matching the ON
      -- CONFLICT specification" - at run time, on the one code path that runs when somebody
      -- actually contributes.
      ON CONFLICT (github_id) WHERE github_id IS NOT NULL DO NOTHING
      RETURNING id
    )
    SELECT id, created
      FROM (SELECT id, true AS created, 1 AS branch FROM created
            UNION ALL
            SELECT id, false, 2 FROM github_repositories WHERE github_id = $1) either
     ORDER BY branch
     LIMIT 1
  `;

  try {
    const { rows } = await run(queryText, [githubId, fullName]);

    // Neither branch returned a row, which the two of them together cannot do. Thrown rather
    // than returned as a null id, because the caller's next statement has a foreign key on it.
    if (rows.length === 0) {
      throw new Error('neither the insert nor the lookup returned a row');
    }

    return { id: rows[0].id, created: rows[0].created };
  } catch (cause) {
    throw new Error(`could not record the repository ${fullName} (GitHub id ${githubId})`, { cause });
  }
};

/**
 * The registry row for a project on another forge
 *
 * ensureRepository() refuses a repository without a GitHub id, and it is right to: every row it
 * creates is one the refresh job will later read by that id. A GitLab project has no such id and
 * no call to make, so it comes in here instead - `github_id` left NULL, which is precisely what
 * keeps it out of `idx_repositories_due_for_refresh` and out of the queue for ever.
 *
 * The figures on such a row are whatever the operator typed and are never refreshed. That is a
 * known cost, written down rather than discovered: `gitlab-org/gitlab` carries 6,129 stars here
 * against the 5,562 its oldest contribution froze.
 *
 * @param {string} fullName - The project path as the forge writes it, groups included
 * @returns {Promise<{id: number, created: boolean}>}
 */
export const ensureForeignRepository = async (fullName, run = query) => {
  if (typeof fullName !== 'string' || !fullName.includes('/')) {
    throw new Error(`refusing to record ${fullName} as a repository: not a project path`);
  }

  // The same two-branch shape as ensureRepository, and for the same reason: a statement cannot
  // see its own INSERT, so exactly one of the branches yields a row and the order decides which.
  const queryText = `
    WITH created AS (
      INSERT INTO github_repositories (full_name)
      VALUES ($1)
      -- On the expression the partial index is built on, and carrying its predicate: PostgreSQL
      -- infers a partial unique index only when both are spelled out.
      ON CONFLICT (lower(full_name)) WHERE github_id IS NULL DO NOTHING
      RETURNING id
    )
    SELECT id, created
      FROM (SELECT id, true AS created, 1 AS branch FROM created
            UNION ALL
            SELECT id, false, 2 FROM github_repositories
             WHERE lower(full_name) = lower($1) AND github_id IS NULL) either
     ORDER BY branch
     LIMIT 1
  `;

  try {
    const { rows } = await run(queryText, [fullName]);

    if (rows.length === 0) {
      throw new Error('neither the insert nor the lookup returned a row');
    }

    return { id: rows[0].id, created: rows[0].created };
  } catch (cause) {
    throw new Error(`could not record the foreign repository ${fullName}`, { cause });
  }
};

/**
 * Atomically claim the repositories that are due for a refresh
 *
 * Same protocol as claimInstallationsForSync(): a single UPDATE over a FOR UPDATE SKIP LOCKED
 * selection, so two instances partition the work instead of duplicating it.
 *
 * Two predicates decide who is in the queue, and both are facts rather than judgements. A row
 * with no `github_id` is a contribution this application cannot read — there is no call to make
 * for it, so it is not a failure to retry, it is not in the queue at all. A row with `gone_at`
 * answered 404 by id often enough to be believed. Nothing else takes a repository out: there is
 * deliberately no disabled-by-us column here.
 *
 * The installation is only a key, and deliberately ANY active one. A repository belongs to
 * nobody here, and an installation token reads any public repository. Tying a repository to the
 * installation of somebody who contributed to it would mean losing the ability to refresh it
 * the day that person leaves and uninstalls.
 *
 * An app JWT cannot stand in: measured against the live API, `GET /app` and
 * `GET /app/installations` answer 200 with one, and `GET /repositories/{id}` answers 401. The
 * JWT only mints installation tokens. So the refresh stops only if the enrolled population
 * reaches zero, at which point there is nothing to report on either.
 * @returns {Promise<Array<Object>>} Claimed rows, each with the installation to read it with
 */
export const claimRepositoriesForRefresh = async () => {
  const queryText = `
    WITH due AS (
      SELECT r.id
      FROM github_repositories r
      WHERE r.github_id IS NOT NULL
        AND r.gone_at IS NULL
        AND (r.next_refresh_at IS NULL OR r.next_refresh_at <= CURRENT_TIMESTAMP)
        AND (r.refresh_claimed_at IS NULL
             OR r.refresh_claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $2::int))
      ORDER BY r.next_refresh_at ASC NULLS FIRST
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
      UPDATE github_repositories
      SET refresh_claimed_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM due)
      -- The lease as text, the token the release is fenced on: see claimInstallationsForSync().
      RETURNING id, github_id, full_name, etag, stargazers_count, refresh_error_count,
                refresh_404_count, refresh_claimed_at::text AS lease
    )
    SELECT c.*,
           -- Read once for the whole batch, not once per repository: it is the same answer for
           -- every row, and the ordering makes it stable from run to run.
           (SELECT gi.installation_id
              FROM github_installations gi
             WHERE gi.installation_id IS NOT NULL
               AND gi.installation_suspended = false
               AND gi.installation_deleted = false
               AND gi.verified_at IS NOT NULL
             ORDER BY gi.id
             LIMIT 1) AS installation_id
    FROM claimed c
  `;

  try {
    const result = await query(queryText, [SCHEDULING.REPO_BATCH_SIZE, SCHEDULING.CLAIM_LEASE_MINUTES]);

    logger.debug(`claimed ${result.rows.length} repository(ies) for refresh`);

    return result.rows;
  } catch (cause) {
    throw new Error('could not claim repositories for refresh', { cause });
  }
};

/**
 * Whether a fenced release found its lease, saying so when it did not
 *
 * Every release below writes only while the row still holds the lease its claim took - the
 * sync's fence, see heldLease() in installations.js. Nothing but a release clears this lease, so
 * here it only ever catches a run that outlived CLAIM_LEASE_MINUTES while another took the row,
 * and that run's outcome is the one to keep.
 * @param {{full_name: string}} claim - The row as it was claimed
 * @param {number} rowCount - What the release updated
 * @returns {boolean} Whether the outcome was written
 */
const heldLease = (claim, rowCount) => {
  if (rowCount === 0) {
    logger.info(
      { repo: claim.full_name },
      `the refresh outcome for ${claim.full_name} is dropped - another run claimed the row after this one's lease ran out`
    );
  }

  return rowCount > 0;
};

/**
 * Store what GitHub said about a repository, and put it back in the queue
 *
 * `full_name` is rewritten from the response rather than left alone: the request went out with
 * an id, GitHub answered with whatever the repository is called today, and this is the only
 * place a rename is noticed. Nothing has to move with it — every child row points at this row's
 * id, never at its name — so the whole cost of a rename is this column and one row in
 * github_repository_renames.
 *
 * `github_id` is deliberately NOT written. It is identity: ensureRepository() sets it once, the
 * request was made with it, and an UPDATE able to change it is an UPDATE able to point this
 * row's whole history at a different repository.
 * @param {{id: number, lease: string, full_name: string}} claim - The row as
 *   claimRepositoriesForRefresh() returned it
 * @param {Object} repository - As returned by GET /repositories/{id}
 * @param {?string} etag - Response ETag, for the next conditional request
 * @param {number} delaySeconds - Dispersed delay until the next refresh
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 * @returns {Promise<boolean>} False when the outcome was superseded and dropped
 */
export const markRefreshSucceeded = async (claim, repository, etag, delaySeconds, run = query) => {
  const queryText = `
    UPDATE github_repositories
    SET full_name = $3,
        html_url = $4,
        description = $5,
        stargazers_count = $6,
        forks_count = $7,
        subscribers_count = $8,
        license = $9,
        topics = $10,
        primary_language = $11,
        archived = $12,
        pushed_at = $13,
        etag = COALESCE($14, etag),
        last_refreshed_at = CURRENT_TIMESTAMP,
        next_refresh_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        refresh_claimed_at = NULL,
        refresh_error_count = 0,
        refresh_404_count = 0,
        -- Cleared, or the page keeps reporting a failure that has already been repaired.
        last_refresh_error = NULL
    WHERE id = $1
      AND refresh_claimed_at = $15::timestamptz
  `;

  try {
    const { rowCount } = await run(queryText, [
      claim.id,
      delaySeconds,
      repository.full_name,
      repository.html_url ?? null,
      repository.description ?? null,
      repository.stargazers_count ?? null,
      repository.forks_count ?? null,
      // Not watchers_count: GitHub returns the star count under that name.
      repository.subscribers_count ?? null,
      repository.license?.key ?? null,
      repository.topics ?? null,
      repository.language ?? null,
      repository.archived ?? null,
      repository.pushed_at ?? null,
      etag ?? null,
      claim.lease,
    ]);

    return heldLease(claim, rowCount);
  } catch (cause) {
    // The refresh job's catch says "could not refresh <name>" and can mark the repository gone
    // on the strength of it, so a bare driver sentence here would be read as GitHub failing.
    throw new Error(`could not record the refresh of repository row ${claim?.id}`, { cause });
  }
};

/**
 * Write down that a repository changed name
 *
 * The registry holds one name, today's, and the refresh above overwrites it. Without this row
 * the previous name is simply gone, and a report published last quarter becomes unreadable
 * against the database that produced it.
 *
 * Append-only, and never consulted by this application: it is history for a human, and for a
 * consumer reconciling two exports. Called in the same transaction as the refresh, so a name is
 * never overwritten without its predecessor being kept.
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 */
export const recordRename = async (id, oldFullName, newFullName, run = query) => {
  const queryText = `
    INSERT INTO github_repository_renames (repository_id, old_full_name, new_full_name)
    VALUES ($1, $2, $3)
  `;

  try {
    await run(queryText, [id, oldFullName, newFullName]);
  } catch (cause) {
    throw new Error(`could not record the rename of repository row ${id} to ${newFullName}`, { cause });
  }
};

/**
 * A conditional request answered 304: nothing changed, so only the cursor moves
 * @param {{id: number, lease: string}} claim - The row as claimRepositoriesForRefresh() returned it
 * @param {number} delaySeconds - Dispersed delay until the next refresh
 * @returns {Promise<boolean>} False when the outcome was superseded and dropped
 */
export const markRefreshUnchanged = async (claim, delaySeconds) => {
  const queryText = `
    UPDATE github_repositories
    SET last_refreshed_at = CURRENT_TIMESTAMP,
        next_refresh_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        refresh_claimed_at = NULL,
        refresh_error_count = 0,
        refresh_404_count = 0,
        last_refresh_error = NULL
    WHERE id = $1
      AND refresh_claimed_at = $3::timestamptz
  `;

  try {
    const { rowCount } = await query(queryText, [claim.id, delaySeconds, claim.lease]);

    return heldLease(claim, rowCount);
  } catch (cause) {
    throw new Error(`could not record an unchanged refresh of repository row ${claim?.id}`, { cause });
  }
};

/**
 * Record a failed refresh and put the row back in the queue
 *
 * No retirement here. A repository leaves the queue by having no `github_id` or by being gone,
 * and both are decided elsewhere — this counts a failure and backs off, and does nothing else.
 * @param {{id: number, lease: string}} claim - The row as claimRepositoriesForRefresh() returned it
 * @param {number} delaySeconds - Backoff before the next attempt
 * @param {?string} errorMessage - What went wrong, for the page
 * @param {boolean} [notFound] - The repository itself answered 404 or 410. Anything else breaks
 *   the run, so refresh_404_count only ever counts consecutive ones
 * @returns {Promise<boolean>} False when the outcome was superseded and dropped
 */
export const markRefreshFailed = async (claim, delaySeconds, errorMessage = null, notFound = false) => {
  const queryText = `
    UPDATE github_repositories
    SET refresh_error_count = refresh_error_count + 1,
        refresh_404_count = CASE WHEN $4::boolean THEN refresh_404_count + 1 ELSE 0 END,
        refresh_claimed_at = NULL,
        next_refresh_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        last_refresh_error = $3::text
    WHERE id = $1
      AND refresh_claimed_at = $5::timestamptz
  `;

  try {
    const { rowCount } = await query(queryText, [claim.id, delaySeconds, errorMessage, notFound, claim.lease]);

    return heldLease(claim, rowCount);
  } catch (cause) {
    throw new Error(`could not record a failed refresh of repository row ${claim?.id}`, { cause });
  }
};

/**
 * A repository stopped answering: stamp it and take it out of the queue
 *
 * The verdict is safe to write because the request carried the id. Asked by NAME, a 404 cannot
 * be told from a transfer that left no redirect — measured on raphi011/amux, which moved to
 * mixpeek/amux and whose old path answers a bare 404 on both the API and the website — so by
 * name this would retire a repository for moving. An id survives a rename and a transfer, so a
 * 404 against one is about the repository itself and says nothing about its name.
 *
 * It still cannot tell deleted from private from transferred-out-of-reach, so `gone_at` claims
 * only "not readable", and the row keeps every value it last knew. COALESCE keeps the FIRST
 * sighting: a second one is not new information.
 *
 * One-way, on purpose. Nothing here clears `gone_at`, because a cleared row would have to be
 * back in the queue to be noticed, and a row in the queue is one this function just took out. A
 * repository that comes back is a hand-written UPDATE, and rare enough to be worth one.
 * @param {{id: number, lease: string}} claim - The row as claimRepositoriesForRefresh() returned it
 * @param {?string} errorMessage - The status GitHub answered with, for the page
 * @returns {Promise<boolean>} False when the outcome was superseded and dropped
 */
export const markRepositoryGone = async (claim, errorMessage = null) => {
  const queryText = `
    UPDATE github_repositories
    SET gone_at = COALESCE(gone_at, CURRENT_TIMESTAMP),
        refresh_claimed_at = NULL,
        refresh_error_count = refresh_error_count + 1,
        refresh_404_count = refresh_404_count + 1,
        last_refresh_error = $2::text
    WHERE id = $1
      AND refresh_claimed_at = $3::timestamptz
  `;

  try {
    const { rowCount } = await query(queryText, [claim.id, errorMessage, claim.lease]);

    return heldLease(claim, rowCount);
  } catch (cause) {
    throw new Error(`could not mark repository row ${claim?.id} gone`, { cause });
  }
};
