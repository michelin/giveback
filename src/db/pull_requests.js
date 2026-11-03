import { query } from "./index.js";
import { getLogger, format, fields } from "../utils/logger.js";
import { parseRepoFullname } from "../utils/github.js";

/**
 * Hydration: one row per pull request, written from the hydration response.
 *
 * This is the product. Everything the report and the dashboard say about a contribution is read
 * from here — the event ledger that triggered the fetch keeps a snapshot rather than the current
 * state, and the poll cursor beside it in polling.js keeps only scheduling.
 *
 * WHICH repository is `repository_id`, and it comes from the caller rather than from the
 * response. The response does carry `base.repo.id`, but that is GitHub's number where this
 * column is a local key with a foreign key behind it: resolving one into the other is the
 * registry's job, done once by ensureRepository(), not a lookup repeated on every write.
 */

const logger = getLogger("pull_requests");

/**
 * Insert or update a pull request record
 *
 * FROZEN AT INSERT, which is why the ON CONFLICT clause is shorter than the column list:
 * `dest_repo`, `license`, `topics`, `forks_count` and `stargazers_count` are what was true when
 * the contribution was first seen, and that is the one figure this row is uniquely able to
 * answer for. Refreshing them on every poll gives each contribution its own star count, frozen
 * at its own last poll — apache/kafka's copies span 2,874 — and destroys the snapshot without
 * producing a current value either. Today's figures live on github_repositories, reached through
 * repository_id.
 *
 * `repository_id` is left out of the clause for a different reason: it is identity. A row's
 * repository does not change, and an UPDATE able to move it is an UPDATE able to reassign a
 * contribution to another project.
 * @param {Object} pullRequest - As returned by the hydration call
 * @param {number} repositoryId - github_repositories.id, from ensureRepository or the poll claim
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 */
export const upsertPullRequest = async (pullRequest, repositoryId, run = query) => {
  try {
    const {
      id: pullRequestId,
      number,
      title,
      state,
      html_url: htmlUrl,
      created_at: createdAt,
      updated_at: updatedAt,
      closed_at: closedAt,
      merged_at: mergedAt,
      merged,
      merged_by,
      commits: commitsCount,
      changed_files: changedFiles,
      user: { login: openedBy, type: userType },
      head,
      base,
    } = pullRequest;

    const repoFullname = base?.repo?.full_name;

    if (!repoFullname) {
      throw new Error(`pull request ${pullRequestId} has no base repository`);
    }

    const { owner, name: repoName } = parseRepoFullname(repoFullname);

    const queryText = `
      INSERT INTO github_pull_requests (
        pull_request_id, number, repository_id, html_url, title, state, created_at, updated_at,
        closed_at, merged_at, merged, merged_by, commits_count, changed_files, opened_by,
        user_type, src_repo, src_ref, dest_repo, dest_ref, license, topics, forks_count,
        stargazers_count, state_changed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, CURRENT_TIMESTAMP
      )
      ON CONFLICT (pull_request_id)
      DO UPDATE SET
        number = EXCLUDED.number,
        html_url = EXCLUDED.html_url,
        title = EXCLUDED.title,
        state = EXCLUDED.state,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        closed_at = EXCLUDED.closed_at,
        merged_at = EXCLUDED.merged_at,
        merged = EXCLUDED.merged,
        merged_by = EXCLUDED.merged_by,
        commits_count = EXCLUDED.commits_count,
        changed_files = EXCLUDED.changed_files,
        opened_by = EXCLUDED.opened_by,
        user_type = EXCLUDED.user_type,
        src_repo = EXCLUDED.src_repo,
        src_ref = EXCLUDED.src_ref,
        dest_ref = EXCLUDED.dest_ref,
        -- Stamped only when the state actually moved: a poll that found nothing must not touch
        -- it, or the detection latency it measures becomes the poll interval.
        state_changed_at = CASE
          WHEN github_pull_requests.state IS DISTINCT FROM EXCLUDED.state THEN CURRENT_TIMESTAMP
          ELSE github_pull_requests.state_changed_at
        END
    `;

    const queryParams = [
      pullRequestId,
      number,
      repositoryId,
      htmlUrl ?? null,
      title,
      state,
      createdAt,
      updatedAt,
      closedAt,
      mergedAt,
      merged,
      merged_by?.login ?? null,
      commitsCount,
      changedFiles,
      openedBy,
      userType,
      head?.repo?.full_name ?? null,
      head?.ref ?? null,
      repoFullname,
      base.ref,
      base.repo.license?.key ?? null,
      base.repo.topics ?? null,
      base.repo.forks_count ?? null,
      base.repo.stargazers_count ?? null,
    ];

    await run(queryText, queryParams);

    logger.debug(
      { ...fields.pr(number, { owner, name: repoName }), state },
      `saved ${format.pr(number, { owner, name: repoName })} (${state})`
    );
  } catch (cause) {
    throw new Error(`could not save pull request ${pullRequest?.id} (#${pullRequest?.number}) on ${pullRequest?.base?.repo?.full_name}`, { cause });
  }
};

/**
 * A contribution recorded by hand, by an operator
 *
 * Separate from upsertPullRequest() rather than a flag on it, and the separation is the point:
 * that function takes a GitHub hydration response and leaves `origin` at its default, so every
 * row the sync writes says `github` without having to be told. This one writes `manual`, which
 * is what keeps these rows out of POLLABLE - the poll has nothing to fetch for a merge request
 * on another forge.
 *
 * Merged work only. An entry is a fact, not a thing to track: nothing polls it, nothing updates
 * it, so `state` is closed and `merged` is true by construction rather than by argument.
 *
 * `opened_by` is a login the CALLER has already checked against a live installation. Nothing
 * here can check it - this function sees a string - and the one time that check was skipped, a
 * GitLab handle was stored where a GitHub login belonged and spent a year attached to nobody.
 *
 * @param {Object} contribution - Coordinates, figures and author, all already validated
 * @param {number} repositoryId - From ensureRepository() or ensureForeignRepository()
 * @returns {Promise<{recorded: boolean}>} False when the row already existed and was updated
 */
export const upsertManualContribution = async (contribution, repositoryId, run = query) => {
  const {
    id: pullRequestId, number, title, url, openedBy,
    openedAt, mergedAt, mergedBy, commits, changedFiles, stars, fullName,
  } = contribution;

  const queryText = `
    INSERT INTO github_pull_requests (
      pull_request_id, number, repository_id, html_url, title, state, created_at, merged_at,
      merged, merged_by, commits_count, changed_files, opened_by, user_type, dest_repo,
      stargazers_count, origin, state_changed_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'closed', $6, $7, true, $8, $9, $10, $11, 'User', $12, $13,
      'manual', CURRENT_TIMESTAMP
    )
    ON CONFLICT (pull_request_id)
    DO UPDATE SET
      number = EXCLUDED.number,
      -- repository_id is NOT refreshed, for the reason it is frozen on the statement above: an
      -- UPDATE able to move it is an UPDATE able to reassign a contribution to another project.
      -- The same id derives the same project anyway - both come from the one pasted address.
      html_url = EXCLUDED.html_url,
      title = EXCLUDED.title,
      created_at = EXCLUDED.created_at,
      merged_at = EXCLUDED.merged_at,
      merged_by = EXCLUDED.merged_by,
      commits_count = EXCLUDED.commits_count,
      changed_files = EXCLUDED.changed_files,
      opened_by = EXCLUDED.opened_by,
      stargazers_count = EXCLUDED.stargazers_count,
      -- Never downgraded to 'manual': a row the sync has since collected on its own is a real
      -- github row, and re-recording it by hand must not take it out of the poll queue.
      origin = github_pull_requests.origin
    RETURNING (xmax = 0) AS recorded
  `;

  try {
    const { rows } = await run(queryText, [
      pullRequestId, number, repositoryId, url, title, openedAt ?? null, mergedAt,
      mergedBy ?? null, commits ?? null, changedFiles ?? null, openedBy, fullName, stars ?? null,
    ]);

    // debug, like the sync's own write above: the route logs this at info, naming the operator
    // who decided as well as the person credited, and one action does not need two info lines.
    logger.debug(
      { pull_request_id: pullRequestId, repository: fullName, opened_by: openedBy },
      `recorded ${fullName}#${number} by hand, for ${format.user(openedBy)}`
    );

    return { recorded: rows[0]?.recorded === true };
  } catch (cause) {
    throw new Error(`could not record ${fullName}#${number} by hand`, { cause });
  }
};

/**
 * Everything an operator has recorded by hand, newest merge first
 *
 * The forge is derived from the address rather than stored: there is no column for it, and the
 * host in `html_url` is the only place the answer already lives. A column would be a second
 * copy of the same fact, free to disagree with the link people actually click.
 */
export const listManualContributions = async () => {
  const queryText = `
    SELECT p.pull_request_id, p.number, p.title, p.html_url, p.opened_by,
           p.merged_at, p.commits_count, r.full_name AS repo,
           CASE WHEN p.html_url LIKE 'https://github.com/%' THEN 'github' ELSE 'gitlab' END AS forge
    FROM github_pull_requests p
    JOIN github_repositories r ON r.id = p.repository_id
    WHERE p.origin = 'manual'
    ORDER BY p.merged_at DESC NULLS LAST, p.pull_request_id DESC
  `;

  try {
    const { rows } = await query(queryText);

    return rows.map((row) => ({
      pullRequestId: Number(row.pull_request_id),
      number: row.number,
      title: row.title,
      url: row.html_url,
      login: row.opened_by,
      mergedAt: row.merged_at,
      commits: row.commits_count,
      repo: row.repo,
      forge: row.forge,
    }));
  } catch (cause) {
    throw new Error('could not list the contributions recorded by hand', { cause });
  }
};

/**
 * Remove one hand-recorded contribution
 *
 * Scoped to `origin = 'manual'`, which is not belt and braces: the id of a manual row is the
 * forge's own, and the two forges number in the same space. Without this predicate a mistyped
 * id could delete a contribution the sync collected and will not collect again.
 * @returns {Promise<boolean>} False when nothing matched, which the caller answers 404 to
 */
export const deleteManualContribution = async (pullRequestId) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM github_pull_requests WHERE pull_request_id = $1 AND origin = 'manual'`,
      [pullRequestId]
    );

    return rowCount > 0;
  } catch (cause) {
    throw new Error(`could not remove the hand-recorded contribution ${pullRequestId}`, { cause });
  }
};
