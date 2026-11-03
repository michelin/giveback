import { query } from "./index.js";
import { getLogger, format, fields } from "../utils/logger.js";
import { parseRepoFullname } from "../utils/github.js";

/**
 * The ledgers: what the public events feed produced, and nothing else.
 *
 * Both tables answer one question — "have I already handled this event id?" — so the sync job
 * can skip an event it has seen instead of hydrating it again, and that hydration is the bulk
 * of the API budget. Each relies on the unique index on `event_id` rather than a preceding
 * SELECT: check-then-insert is two round trips and is not atomic.
 *
 * Beside that, github_pull_request_events is a TIME SERIES. Its own columns are what the pull
 * request looked like at the moment the event was seen, which github_pull_requests cannot
 * reconstruct because it holds the final state — over 787 comparable rows, updated_at differs
 * from the pull request row 576 times, state 221, closed_at 221. They are written in two goes,
 * and the reason is the order of operations rather than a preference: the insert has to come
 * FIRST, because it decides whether the fetch happens at all, and the snapshot is only known
 * once the fetch has answered.
 *
 * Every function takes an optional `run` so a caller can compose it into a transaction with a
 * statement from another module — see transaction() in index.js.
 */

const logger = getLogger("events");

/**
 * Note that a pull request event has been seen
 *
 * `repositoryId` is the registry row, not GitHub's number: which repository this event belongs
 * to is a question only a local key answers, because the name in the feed is the name it had
 * that day. It is required, there is a foreign key on it, and ensureRepository() is what
 * produces it — in the same transaction as this insert, so a crash leaves neither.
 *
 * `hydrated` is the second half of the answer, and it exists because the two halves of this
 * ledger row are written by two statements with a network call between them. If that call fails
 * - a 403 at the rate limit, a 5xx, a socket hung up - the row is already committed and its
 * thirteen snapshot columns are still NULL. Reporting only "already known" would then retire
 * the contribution permanently: the next run would see a known event and skip it, and nothing
 * would ever fetch the pull request. So the caller is told whether the row it collided with was
 * ever filled in, and re-hydrates the ones that were not.
 *
 * Read in the same statement rather than in a second round trip, and off the snapshot taken
 * BEFORE the insert - which is what a data-modifying CTE sees - so a row this statement has just
 * created correctly reports hydrated: false.
 * @param {number} repositoryId - github_repositories.id
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 * @returns {Promise<{isNew: boolean, hydrated: boolean}>} `isNew` is false for an event already
 *   in the ledger; `hydrated` says whether that existing row carries its snapshot
 */
export const insertPullRequestEventIfNotExists = async (pullRequestEvent, repositoryId, run = query) => {
  try {
    const {
      id: eventId,
      created_at: createdAt,
      // Safe to destructure: isExternalContribution() has already required a string here, and
      // nothing reaches this function without passing it.
      actor: { login: actor },
      repo: { name: repoFullname },
      payload: {
        number,
        action,
        pull_request: { id: prId },
      },
    } = pullRequestEvent;

    const { owner, name: repoName } = parseRepoFullname(repoFullname);

    // DO NOTHING, still: the feed hands back the same three hundred entries every run, and
    // DO UPDATE would turn each of them into a real write. The EXISTS beside it is an index
    // lookup on the same unique key the conflict is resolved against.
    //
    // `actor` is whose feed this came from, and it is the only attribution available here: the
    // envelope's payload.pull_request carries base, head, id, number and url, and no author. Who
    // OPENED the pull request is a different question, answered by github_pull_requests.opened_by
    // after the hydration. Kept out of the column list below, where a comment would be read as a
    // column name by the schema guard in test/configuration.test.js.
    const queryText = `
      WITH noted AS (
        INSERT INTO github_pull_request_events (
          event_id,
          pull_request_id,
          number,
          action,
          actor,
          repository_id,
          repo_fullname,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        ON CONFLICT (event_id) DO NOTHING
        RETURNING 1
      )
      SELECT
        EXISTS (SELECT 1 FROM noted) AS is_new,
        EXISTS (
          SELECT 1 FROM github_pull_request_events
          WHERE event_id = $1 AND title IS NOT NULL
        ) AS hydrated
    `;

    const result = await run(queryText, [eventId, prId, number, action, actor, repositoryId, repoFullname, createdAt]);
    const { is_new: isNew, hydrated } = result.rows[0];

    if (!isNew) {
      if (hydrated) {
        logger.trace(`pull request event ${eventId} for ${format.pr(number, { owner, name: repoName })} is already stored - skipping`);
      } else {
        // Not trace: this is a contribution an earlier run noted and never managed to fetch, and
        // it stayed invisible until now precisely because the ledger row existed.
        logger.debug(
          { ...fields.pr(number, { owner, name: repoName }), event_id: eventId },
          `pull request event ${eventId} for ${format.pr(number, { owner, name: repoName })} was noted but never hydrated - fetching it now`
        );
      }

      return { isNew: false, hydrated };
    }

    logger.debug(
      { ...fields.pr(number, { owner, name: repoName }), event_id: eventId },
      `saved pull request event for ${format.pr(number, { owner, name: repoName })}`
    );

    return { isNew: true, hydrated: false };
  } catch (cause) {
    // Not logged here: this layer cannot say why the insert was attempted. Identifiers are read
    // from the parameter, because the destructured consts above are scoped to the try.
    throw new Error(`could not save pull request event ${pullRequestEvent?.id} on ${pullRequestEvent?.repo?.name}`, { cause });
  }
};

/**
 * Fill in what the pull request looked like when the event was seen
 *
 * The other half of the insert above, and the half that cannot be written at the same time: the
 * events feed's payload carries none of this. `payload.pull_request.base.repo` has three keys —
 * id, name, url — where the hydration response has eighty-one, and none of the thirteen columns
 * here is among the three.
 *
 * Which makes this the one place the ledger stops being a list of ids and becomes a record of
 * how a contribution moved: the same pull request seen opened, then reopened, then closed leaves
 * three rows whose state, closed_at and star count differ, and github_pull_requests keeps only
 * the last of them.
 *
 * "At the moment the event was seen" means when it was PROCESSED, not when GitHub produced it,
 * and on a first sync those are far apart: the feed reaches back at most ~90 days and at most
 * 300 events, whichever binds first, so everything in it is hydrated at once and every row gets
 * the same state — measured on a fresh database, four pull requests, eight events, eight
 * identical snapshots. The series only accumulates while the feed is followed live. Worth knowing before measuring a young database and concluding these
 * columns duplicate github_pull_requests, which they do not.
 *
 * Nothing reads these columns back, in this application. They are written for the report and
 * for whoever asks, in a year, what a project looked like when somebody contributed to it.
 * @param {number|string} eventId - The feed's event id, which this row was inserted under
 * @param {Object} pullRequest - As returned by the hydration call
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 */
export const recordPullRequestSnapshot = async (eventId, pullRequest, run = query) => {
  const queryText = `
    UPDATE github_pull_request_events
    SET title = $2,
        state = $3,
        updated_at = $4,
        closed_at = $5,
        merged_at = $6,
        merged = $7,
        merged_by = $8,
        commits_count = $9,
        changed_files = $10,
        license = $11,
        topics = $12,
        forks_count = $13,
        stargazers_count = $14
    WHERE event_id = $1
  `;

  try {
    await run(queryText, [
      eventId,
      pullRequest.title ?? null,
      pullRequest.state ?? null,
      pullRequest.updated_at ?? null,
      pullRequest.closed_at ?? null,
      pullRequest.merged_at ?? null,
      pullRequest.merged ?? null,
      pullRequest.merged_by?.login ?? null,
      pullRequest.commits ?? null,
      pullRequest.changed_files ?? null,
      pullRequest.base?.repo?.license?.key ?? null,
      pullRequest.base?.repo?.topics ?? null,
      pullRequest.base?.repo?.forks_count ?? null,
      pullRequest.base?.repo?.stargazers_count ?? null,
    ]);
  } catch (cause) {
    throw new Error(`could not record the snapshot for pull request event ${eventId}`, { cause });
  }
};

/**
 * Persist a push event, ignoring events already stored
 *
 * A push is never hydrated — no call describes one — so this row is written once and never
 * touched again. Which is why the four popularity columns beside it are an archive: nothing
 * available for a push carries a star count, and no request can restore the ones already there.
 * @param {number} repositoryId - github_repositories.id
 * @param {Function} [run] - Bound to a transaction by transaction(); defaults to the pool
 * @returns {Promise<boolean>} True when a new row was written, false when already known
 */
export const insertPushEventIfNotExists = async (pushEvent, repositoryId, run = query) => {
  try {
    const {
      id: eventId,
      created_at: createdAt,
      actor: { login: actor },
      repo: { name: repoFullname },
      payload: {
        push_id: pushId,
        ref: rawRef,
        // No compareCommits call needed: `size` counts the commits in the push,
        // `distinct_size` those new to the repository.
        distinct_size: distinctSize,
        size,
      },
    } = pushEvent;

    const { owner, name: repoName } = parseRepoFullname(repoFullname);

    const repoBranch = rawRef ? rawRef.replace(/^refs\/heads\//, '') : null;
    const commitsCount = distinctSize ?? size ?? null;

    const queryText = `
      INSERT INTO github_push_events (
        event_id,
        push_id,
        created_at,
        repository_id,
        repository_fullname,
        repository_branch,
        actor,
        commits_count
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
      ON CONFLICT (event_id) DO NOTHING
    `;

    const queryParams = [
      eventId,
      pushId,
      createdAt,
      repositoryId,
      repoFullname,
      repoBranch,
      actor,
      commitsCount,
    ];

    const result = await run(queryText, queryParams);

    if (result.rowCount === 0) {
      logger.trace(`push event ${eventId} for ${format.repo(owner, repoName)} is already stored - skipping`);
      return false;
    }

    logger.debug(
      { ...fields.repo(owner, repoName), event_id: eventId, commits: commitsCount },
      `saved push event for ${format.repo(owner, repoName)}${Number.isFinite(commitsCount) ? ` (${commitsCount} commit(s))` : ''}`
    );

    return true;
  } catch (cause) {
    // Not logged here: this layer cannot say why the insert was attempted. Identifiers are read
    // from the parameter, because the destructured consts above are scoped to the try.
    throw new Error(`could not save push event ${pushEvent?.id} on ${pushEvent?.repo?.name}`, { cause });
  }
};
