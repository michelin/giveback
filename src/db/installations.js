import { query } from "./index.js";
import { InstallationEvent } from "../utils/types.js";
import { getLogger, format, fields } from "../utils/logger.js";
import { SCHEDULING } from "../utils/constants.js";

const logger = getLogger("installations");

/**
 * Record an installation reported by the (signed) installation.created webhook
 *
 * Written as pending: the webhook proves the app was installed but says nothing about the
 * user's email address, so the row is not synchronized until the OAuth callback passes the
 * domain check. It also means an installation whose owner closes the tab before the redirect is
 * still known to us. A reinstall - an existing row under a NEW installation id - is reset to
 * pending too: it re-opens the question of eligibility rather than inheriting the previous answer.
 *
 * The same installation id is not a reinstall. It is this webhook arriving after the OAuth
 * callback already verified the row, or GitHub redelivering it, and either way the row holds
 * newer facts than the payload: resetting it would leave a verified person pending for good.
 * @param {Object} account - installation.account from the webhook payload
 */
export const insertPendingInstallation = async (account, installationId) => {
  try {
    // For a user installation account.id IS the GitHub user id, the same value the OAuth
    // callback reads from GET /user — which is what binds the two paths together.
    const queryText = `
      INSERT INTO github_installations (
        user_id, user_login, installation_id, installation_suspended, installation_deleted,
        next_sync_at, sync_interval_minutes, sync_error_count
      ) VALUES (
        $1, $2, $3, false, false, CURRENT_TIMESTAMP, $4, 0
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        user_login = $2,
        installation_id = $3,
        installation_suspended = false,
        installation_deleted = false,
        next_sync_at = CURRENT_TIMESTAMP,
        sync_claimed_at = NULL,
        sync_interval_minutes = $4,
        sync_error_count = 0,
        sync_404_count = 0,
        -- The previous verification does NOT carry over: the claim query only looks at
        -- verified_at, so keeping it would let someone who has since lost their allowed
        -- address be synchronized again just by reinstalling. The stale address goes too.
        verified_at = NULL,
        user_enrollment_email_address = NULL,
        -- A new installation id invalidates any cached feed state.
        events_etag = NULL
      -- Every column above, the lease included, is left alone for an unchanged id: clearing a
      -- lease a worker still holds would hand the row to a second one.
      WHERE github_installations.installation_id IS DISTINCT FROM EXCLUDED.installation_id
    `;

    const { rowCount } = await query(queryText, [
      account.id,
      account.login,
      installationId,
      SCHEDULING.SYNC_MIN_INTERVAL_MINUTES,
    ]);

    if (rowCount === 0) {
      logger.debug(
        { ...fields.installation(installationId), ...fields.user(account.login) },
        `${format.installation(installationId)} is already recorded for ${format.user(account.login)} - the webhook changes nothing`
      );
      return;
    }

    logger.info(
      { ...fields.installation(installationId), ...fields.user(account.login) },
      `${format.installation(installationId)} recorded as pending for ${format.user(account.login)} - it is not synchronized until the email check passes`
    );
  } catch (cause) {
    // Not logged here: this layer cannot say why the insert was attempted. The caller
    // reports it once with { err }, and pino walks `cause` down to the PostgreSQL message.
    throw new Error(`could not record pending ${format.installation(installationId)} for ${account?.login}`, { cause });
  }
};

/**
 * Mark an installation as verified after the email domain check passed
 *
 * next_sync_at is set to now, so a user who just enrolled sees their contributions on the next
 * tick rather than after a full interval.
 * @param {Object} user - GitHub user object from GET /user
 */
export const verifyInstallation = async (user, enrollmentEmailAddress, installationId) => {
  try {
    const { id, login, name } = user;

    const queryText = `
      INSERT INTO github_installations (
        user_id, user_login, user_name, user_enrollment_email_address,
        installation_id, installation_suspended, installation_deleted, verified_at,
        next_sync_at, sync_interval_minutes, sync_error_count
      ) VALUES (
        $1, $2, $3, $4, $5, false, false, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, $6, 0
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        user_login = $2,
        user_name = $3,
        user_enrollment_email_address = $4,
        installation_id = $5,
        installation_suspended = false,
        installation_deleted = false,
        verified_at = CURRENT_TIMESTAMP,
        next_sync_at = CURRENT_TIMESTAMP,
        sync_claimed_at = NULL,
        sync_interval_minutes = $6,
        sync_error_count = 0,
        sync_404_count = 0,
        -- Signing in again is the person answering in their own voice, which outranks any
        -- conclusion the sync job drew from a failing feed.
        sync_disabled_at = NULL,
        sync_disabled_reason = NULL
    `;

    const queryParams = [
      id,
      login,
      name,
      enrollmentEmailAddress,
      installationId,
      SCHEDULING.SYNC_MIN_INTERVAL_MINUTES,
    ];

    await query(queryText, queryParams);

    logger.info(
      { ...fields.installation(installationId), ...fields.user(login) },
      `${format.installation(installationId)} verified for ${format.user(login)}`
    );
  } catch (cause) {
    throw new Error(`could not verify ${format.installation(installationId)} for ${user?.login}`, { cause });
  }
};

/**
 * Handle a lifecycle transition reported by a webhook
 *
 * On unsuspend the row becomes due immediately: the user is active again and should not wait
 * out a due time computed before the suspension.
 * @param {string} installationEvent - One of InstallationEvent
 */
export const handleInstallationEvent = async (installationEvent, installationId) => {
  try {
    let queryText;

    switch (installationEvent) {
      case InstallationEvent.DELETED:
        // coalesce, not a plain assignment: GitHub redelivers a webhook, and the first sighting
        // is the closest to the truth. The reconciliation cannot correct this one afterwards -
        // a removed installation is absent from GET /app/installations, so there is nothing to
        // compare against.
        queryText = `
          UPDATE github_installations
          SET installation_deleted = true,
              installation_deleted_at = coalesce(installation_deleted_at, CURRENT_TIMESTAMP),
              sync_claimed_at = NULL
          WHERE installation_id = $1`;
        break;
      case InstallationEvent.UNSUSPEND:
        queryText = `
          UPDATE github_installations
          SET installation_suspended = false,
              -- Cleared with the flag it belongs to: a row that is not suspended must not carry
              -- a suspension date.
              installation_suspended_at = NULL,
              next_sync_at = CURRENT_TIMESTAMP,
              sync_claimed_at = NULL,
              sync_error_count = 0,
              sync_404_count = 0
          WHERE installation_id = $1`;
        break;
      case InstallationEvent.SUSPEND:
        // A suspended installation cannot mint a token at all — GitHub answers 403 — so the
        // flag has to keep it out of the claim query, not merely out of the job.
        //
        // Our own clock here, where the reconciliation uses GitHub's suspended_at. The webhook
        // arrives in seconds and the reconciliation overwrites this with the authoritative
        // value within the hour, so the gap closes itself; coalesce keeps a redelivery from
        // moving the date meanwhile.
        queryText = `
          UPDATE github_installations
          SET installation_suspended = true,
              installation_suspended_at = coalesce(installation_suspended_at, CURRENT_TIMESTAMP),
              sync_claimed_at = NULL
          WHERE installation_id = $1`;
        break;
      default:
        throw new Error(`unknown installation event: ${installationEvent}`);
    }

    const res = await query(queryText, [installationId]);

    // Only the zero-row case is worth a line, and it means a webhook arrived for an
    // installation that was never recorded.
    if (res.rowCount === 0) {
      logger.warn(
        { ...fields.installation(installationId), event: installationEvent },
        `installation event ${installationEvent} matched no row for ${format.installation(installationId)} - the installation was never recorded`
      );
    }
  } catch (cause) {
    throw new Error(`could not apply installation event ${installationEvent} to ${format.installation(installationId)}`, { cause });
  }
};

/**
 * Atomically claim the installations that are due for a sync
 *
 * A single UPDATE ... RETURNING, never a SELECT then an UPDATE: two instances would otherwise
 * read the same rows and do the work twice. FOR UPDATE SKIP LOCKED lets the second take the
 * *next* batch, so scaling out partitions the work instead of duplicating it.
 *
 * sync_claimed_at is a lease, not an in-flight flag: a worker that dies leaves it set, and the
 * row returns to the queue once the lease expires.
 */
export const claimInstallationsForSync = async () => {
  try {
    const queryText = `
      UPDATE github_installations
      SET sync_claimed_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id
        FROM github_installations
        WHERE installation_suspended = false
          AND installation_deleted = false
          AND verified_at IS NOT NULL
          AND installation_id IS NOT NULL
          -- Retired by the app itself, and kept in the table for its history and its
          -- enrollment record. See disableReasonFor().
          AND sync_disabled_at IS NULL
          AND (next_sync_at IS NULL OR next_sync_at <= CURRENT_TIMESTAMP)
          AND (sync_claimed_at IS NULL
               OR sync_claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $2::int))
        ORDER BY next_sync_at ASC NULLS FIRST
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, installation_id, user_login, events_etag, sync_interval_minutes,
                sync_error_count, sync_404_count, last_synced_at
    `;

    const result = await query(queryText, [
      SCHEDULING.SYNC_BATCH_SIZE,
      SCHEDULING.CLAIM_LEASE_MINUTES,
    ]);

    logger.debug(`claimed ${result.rows.length} installation(s) for sync`);

    return result.rows;
  } catch (cause) {
    throw new Error('could not claim installations for sync', { cause });
  }
};

/**
 * Release a claimed installation after a successful sync
 *
 * Committed per installation rather than per batch, so a worker killed mid-run keeps the
 * progress it already made.
 * @param {{intervalMinutes: number, delaySeconds: number, etag: ?string}} outcome
 */
export const markSyncSucceeded = async (id, { intervalMinutes, delaySeconds, etag }) => {
  const queryText = `
    UPDATE github_installations
    SET last_synced_at = CURRENT_TIMESTAMP,
        -- The delay carries the dispersion; the interval stored beside it does not. The ladder
        -- doubles from the stored value, so a jittered one would compound into the interval.
        next_sync_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        sync_interval_minutes = $3,
        events_etag = COALESCE($4, events_etag),
        sync_claimed_at = NULL,
        sync_error_count = 0,
        sync_404_count = 0,
        -- Cleared, or the page would keep showing a failure that has already been repaired.
        last_sync_error = NULL
    WHERE id = $1
  `;

  try {
    await query(queryText, [id, delaySeconds, intervalMinutes, etag ?? null]);
  } catch (cause) {
    // Named, because the caller cannot. This runs inside the job's per-subject try, whose
    // catch reads "could not sync <user>" and then runs the backoff and retirement machinery
    // as if GitHub had failed - so an unwrapped driver sentence gets attributed to the wrong
    // operation.
    throw new Error(`could not release the sync claim on installation row ${id}`, { cause });
  }
};

/**
 * Release a claimed installation after a failed sync
 * @param {number} delaySeconds - Dispersed on this path too: an outage fails every subject at
 *   once, and an undispersed backoff would send the whole population back at the same instant
 * @param {?string} [errorMessage] - Why it failed. Overwritten by the next failure and cleared
 *   by the next success, so it only ever answers "who is failing now"
 * @param {?string} [disableReason] - From disableReasonFor(), or null to keep retrying
 * @param {boolean} [notFound] - The feed itself answered 404. Any other failure breaks the run
 *   of 404s, so sync_404_count only ever counts consecutive ones
 */
export const markSyncFailed = async (id, delaySeconds, errorMessage = null, disableReason = null, notFound = false) => {
  const queryText = `
    UPDATE github_installations
    SET next_sync_at = CURRENT_TIMESTAMP + make_interval(secs => $2::int),
        sync_claimed_at = NULL,
        sync_error_count = sync_error_count + 1,
        sync_404_count = CASE WHEN $5::boolean THEN sync_404_count + 1 ELSE 0 END,
        last_sync_error = $3::text,
        -- Written in the same statement as the increment, so the count the caller's decision
        -- was made on cannot move underneath it.
        sync_disabled_at = CASE WHEN $4::text IS NULL THEN sync_disabled_at ELSE CURRENT_TIMESTAMP END,
        sync_disabled_reason = COALESCE($4::text, sync_disabled_reason)
    WHERE id = $1
  `;

  try {
    await query(queryText, [id, delaySeconds, errorMessage, disableReason, notFound]);
  } catch (cause) {
    throw new Error(`could not record a failed sync of installation row ${id}`, { cause });
  }
};

/**
 * Pull one account's next sync forward to now, on an operator's request
 *
 * The dashboard's one write on an account. It moves a due time and nothing else - no interval
 * reset, no error count cleared - so the adaptive ladder keeps its state and a forced run that
 * finds nothing settles straight back where it was.
 *
 * Restricted to exactly the rows claimInstallationsForSync() takes. Bringing forward a row it
 * excludes - suspended, uninstalled, retired, never verified - would only park it at the head
 * of a queue no run will ever drain.
 * @param {number} userId - GitHub account id, which survives a rename where a login does not
 * @returns {Promise<?{login: string, running: boolean}>} null when no syncable row carries that
 *   id; `running` means a worker holds the row right now, and the outcome it is about to record
 *   will overwrite this due time
 */
export const forceSyncNow = async (userId) => {
  const queryText = `
    UPDATE github_installations
    SET next_sync_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
      AND installation_suspended = false
      AND installation_deleted = false
      AND verified_at IS NOT NULL
      AND installation_id IS NOT NULL
      AND sync_disabled_at IS NULL
    RETURNING user_login,
              (sync_claimed_at IS NOT NULL
               AND sync_claimed_at >= CURRENT_TIMESTAMP - make_interval(mins => $2::int)) AS running
  `;

  try {
    const row = (await query(queryText, [userId, SCHEDULING.CLAIM_LEASE_MINUTES])).rows[0];

    return row ? { login: row.user_login, running: row.running } : null;
  } catch (cause) {
    throw new Error('could not bring an installation forward for sync', { cause });
  }
};

/**
 * Count installations by scheduling state, for the contribution report and run summaries
 * @returns {Promise<{active: number, pending: number, suspended: number, disabled: number, due: number}>}
 */
export const countInstallationStates = async () => {
  const queryText = `
    SELECT
      count(*) FILTER (WHERE verified_at IS NOT NULL
                         AND installation_suspended = false
                         AND installation_deleted = false
                         AND sync_disabled_at IS NULL)::int AS active,
      count(*) FILTER (WHERE verified_at IS NULL
                         AND installation_deleted = false)::int AS pending,
      count(*) FILTER (WHERE installation_suspended = true
                         AND installation_deleted = false)::int AS suspended,
      -- Its own column because it is none of the other three: the person is enrolled and
      -- GitHub still reports the installation, but the app has stopped trying. Folded into
      -- active it would be invisible; omitted, the numbers would stop summing to the table.
      count(*) FILTER (WHERE installation_deleted = false
                         AND sync_disabled_at IS NOT NULL)::int AS disabled,
      count(*) FILTER (WHERE verified_at IS NOT NULL
                         AND installation_suspended = false
                         AND installation_deleted = false
                         AND sync_disabled_at IS NULL
                         AND (next_sync_at IS NULL OR next_sync_at <= CURRENT_TIMESTAMP))::int AS due
    FROM github_installations
  `;

  try {
    const result = await query(queryText);

    return result.rows[0];
  } catch (cause) {
    throw new Error('could not count installation states', { cause });
  }
};

/**
 * Is this GitHub login an enrolled user, right now?
 *
 * Who may be credited with a contribution recorded by hand. Verified, not suspended, not
 * uninstalled — deliberately wider than claimInstallationsForSync(): an account the app retired
 * (sync_disabled_at) is still an enrolled person. The dashboard applies the same rule on the
 * account id instead, in enrollmentByUserId() below; this is the rule documented in
 * docs/dashboard.md.
 * @returns {Promise<{enrolled: boolean, known: boolean}>} `known` distinguishes somebody who
 *   never installed the app from somebody who installed it and was refused
 */
export const isEnrolledUser = async (login) => {
  const queryText = `
    SELECT
      count(*)::int AS known,
      count(*) FILTER (WHERE verified_at IS NOT NULL
                         AND installation_suspended = false
                         AND installation_deleted = false)::int AS enrolled
    FROM github_installations
    WHERE lower(user_login) = lower($1)
  `;

  try {
    const row = (await query(queryText, [login])).rows[0];

    return { enrolled: row.enrolled > 0, known: row.known > 0 };
  } catch (cause) {
    throw new Error(`could not check whether ${login} is enrolled`, { cause });
  }
};

/**
 * Is this GitHub account an enrolled user, right now - and under which login?
 *
 * The dashboard's check, on the numeric id rather than on the login: a login is released when
 * its owner renames, and whoever claims it next would otherwise inherit the session's access.
 * The id never moves. Same rule as isEnrolledUser() above. The login returned is the stored
 * one, which reconcile_installations keeps current across a rename, so it is the one the rest
 * of the dashboard reads. The operator tier is matched on the id itself.
 * @returns {Promise<{enrolled: boolean, known: boolean, login: ?string}>}
 */
export const enrollmentByUserId = async (userId) => {
  // user_id is unique, so this is at most one row.
  const queryText = `
    SELECT user_login,
           (verified_at IS NOT NULL
             AND installation_suspended = false
             AND installation_deleted = false) AS enrolled
    FROM github_installations
    WHERE user_id = $1
  `;

  try {
    const [row] = (await query(queryText, [userId])).rows;

    return { enrolled: row?.enrolled === true, known: Boolean(row), login: row?.user_login ?? null };
  } catch (cause) {
    throw new Error(`could not check whether github user ${userId} is enrolled`, { cause });
  }
};

/**
 * The live installation of one enrolled person, to read GitHub with
 *
 * For an operator action, and deliberately theirs rather than any live one: a manual entry is
 * somebody's decision, so the token that fetches it is the token of the person who decided. The
 * refresh job takes the opposite view - see claimRepositoriesForRefresh() - because a repository
 * belongs to nobody, where an operator action belongs to whoever performed it.
 *
 * lower() on both sides, as isEnrolledUser() writes it and as idx_installations_user_login_lower
 * serves it.
 * @returns {Promise<?number>} Null when the login is unknown, unverified, suspended or deleted
 */
export const liveInstallationIdForLogin = async (login) => {
  const queryText = `
    SELECT installation_id
    FROM github_installations
    WHERE lower(user_login) = lower($1)
      AND verified_at IS NOT NULL
      AND installation_id IS NOT NULL
      AND installation_suspended = false
      AND installation_deleted = false
    LIMIT 1
  `;

  try {
    const { rows } = await query(queryText, [login]);

    return rows.length === 0 ? null : Number(rows[0].installation_id);
  } catch (cause) {
    throw new Error(`could not read the installation of ${login}`, { cause });
  }
};

/** Installation ids known to the database, whatever their state. */
export const listKnownInstallationIds = async () => {
  try {
    const result = await query(`SELECT installation_id FROM github_installations WHERE installation_id IS NOT NULL`);

    return new Set(result.rows.map((row) => Number(row.installation_id)));
  } catch (cause) {
    throw new Error('could not list known installation ids', { cause });
  }
};

/**
 * Bring stored logins back in line with what GitHub reports
 *
 * A login can be changed by its owner at any time and nothing announces it: the installation id
 * is stable, the stored login silently is not. Every subsequent GET /users/{login}/events
 * answers 404, and the row looks exactly like an account that no longer exists.
 *
 * Costs no request, because reconcile_installations already holds account.login for every live
 * installation — which is why this lives here rather than in the sync job's error path, where it
 * would need a fresh call per failing row.
 *
 * A rename also clears a retirement made for 'account gone', because that verdict was reached
 * on the 404 this very rename was causing. Retirements for any other reason stand.
 *
 * The stored contributions are carried across in the same transaction — see the comment on the
 * `carried` CTE below for why that is required and why it is only a stop-gap.
 * @returns {Promise<Array<{old_login: string, new_login: string}>>} The renames applied
 */
export const refreshStaleLogins = async (liveInstallations) => {
  if (!Array.isArray(liveInstallations) || liveInstallations.length === 0) {
    return [];
  }

  const ids = liveInstallations.map((installation) => Number(installation.id));
  const logins = liveInstallations.map((installation) => installation.account?.login ?? null);

  // A CTE rather than a plain UPDATE ... FROM: RETURNING sees the row after the write, so the
  // login being replaced would be gone from the result — and that is the half worth logging,
  // since it is what past log lines were keyed on.
  const queryText = `
    WITH stale AS (
      SELECT gi.id, gi.user_login AS old_login, live.login AS new_login
      FROM github_installations gi
      JOIN unnest($1::bigint[], $2::text[]) AS live(installation_id, login)
        ON gi.installation_id = live.installation_id
      WHERE live.login IS NOT NULL
        AND gi.user_login IS DISTINCT FROM live.login
    ),
    renamed AS (
      UPDATE github_installations gi
      SET user_login = stale.new_login,
          sync_disabled_at = CASE WHEN gi.sync_disabled_reason = 'account gone' THEN NULL ELSE gi.sync_disabled_at END,
          sync_disabled_reason = CASE WHEN gi.sync_disabled_reason = 'account gone' THEN NULL ELSE gi.sync_disabled_reason END,
          -- The failures were caused by the stale login, so the backoff ladder they built was
          -- earned by a problem that no longer exists.
          sync_error_count = 0,
          sync_404_count = 0,
          sync_claimed_at = NULL,
          next_sync_at = CURRENT_TIMESTAMP
      FROM stale
      WHERE gi.id = stale.id
      RETURNING stale.old_login, stale.new_login
    ),
    -- The contributions have to move with the login, in this same transaction. Every query
    -- that decides whether a contribution is polled or measured joins the person on the NAME
    -- (polling.js's claim, dashboard.js's POLLABLE, contributions.js's report), so rewriting
    -- the installation alone orphans every past pull request of the renamed user: the poll
    -- claim stops matching, the open ones are never checked again and the merge is never
    -- detected. Measured: one claimed row became zero.
    --
    -- This is a stop-gap, not the fix. It is a heuristic on a name, so it misfires if the
    -- freed old login has since been taken by another enrolled contributor. The real answer is
    -- an opened_by_user_id column joined to github_installations.user_id; drop this rewrite
    -- once that column is populated and joined on.
    carried AS (
      UPDATE github_pull_requests pr
      SET opened_by = s.new_login
      FROM stale s
      WHERE pr.opened_by = s.old_login
      RETURNING 1
    )
    -- A plain SELECT closes the statement, because RETURNING on the pull-request UPDATE would
    -- yield one row per contribution: the caller counts these rows as renames and logs one
    -- line each.
    SELECT old_login, new_login FROM renamed
  `;

  try {
    const result = await query(queryText, [ids, logins]);

    return result.rows;
  } catch (cause) {
    throw new Error(`could not refresh logins for ${liveInstallations.length} live installation(s)`, { cause });
  }
};

/**
 * Align the stored state of live installations with what GitHub reports
 *
 * Webhooks can be missed or arrive out of order, and a wrongly suspended row is invisible: the
 * user simply stops being synchronized, with nothing in the logs. GET /app/installations is
 * authoritative, so this makes the flag self-correcting and resurrects a row wrongly deleted.
 * @param {Array<{id: number, suspended_at: ?string}>} liveInstallations - From GET /app/installations
 * @returns {Promise<number>} Rows corrected
 */
export const reconcileInstallationStates = async (liveInstallations) => {
  if (!Array.isArray(liveInstallations) || liveInstallations.length === 0) {
    return 0;
  }

  try {
    const ids = liveInstallations.map((installation) => Number(installation.id));
    const suspended = liveInstallations.map((installation) => Boolean(installation.suspended_at));
    // The two timestamps the dashboard dates an account's state by. suspended_at is the
    // very value the boolean above is derived from, read twice rather than stored once so the
    // flag stays the single thing the claim query reads.
    const createdAt = liveInstallations.map((installation) => installation.created_at ?? null);
    const suspendedAt = liveInstallations.map((installation) => installation.suspended_at ?? null);

    const queryText = `
      UPDATE github_installations gi
      SET installation_suspended = live.suspended,
          installation_deleted = false,
          -- GitHub owns both of these, so they are mirrored rather than merged. coalesce only
          -- guards the case of the field missing from the payload: keeping a known date beats
          -- replacing it with null.
          installation_created_at = coalesce(live.created_at, gi.installation_created_at),
          -- Null unless suspended, so the flag and the date can never disagree.
          installation_suspended_at = CASE WHEN live.suspended THEN live.suspended_at ELSE NULL END,
          -- GitHub lists it, so it is not gone; whatever absence we once recorded is over.
          installation_deleted_at = NULL,
          next_sync_at = CASE
            WHEN live.suspended THEN gi.next_sync_at
            -- Only a row genuinely coming back from suspended or deleted deserves a prompt
            -- look. The predicate below also fires for a pure timestamp backfill, which on the
            -- first run after deploy matches EVERY row - without this guard that would reset
            -- the whole queue to now and align the herd docs/architecture.md#dispersion exists
            -- to prevent.
            WHEN gi.installation_suspended IS DISTINCT FROM false
              OR gi.installation_deleted IS DISTINCT FROM false THEN CURRENT_TIMESTAMP
            ELSE gi.next_sync_at
          END
      FROM unnest($1::bigint[], $2::boolean[], $3::timestamptz[], $4::timestamptz[])
        AS live(installation_id, suspended, created_at, suspended_at)
      WHERE gi.installation_id = live.installation_id
        AND (gi.installation_suspended IS DISTINCT FROM live.suspended
             OR gi.installation_deleted IS DISTINCT FROM false
             OR gi.installation_created_at IS DISTINCT FROM coalesce(live.created_at, gi.installation_created_at)
             OR gi.installation_suspended_at IS DISTINCT FROM (CASE WHEN live.suspended THEN live.suspended_at ELSE NULL END)
             OR gi.installation_deleted_at IS NOT NULL)
    `;

    const result = await query(queryText, [ids, suspended, createdAt, suspendedAt]);

    return result.rowCount;
  } catch (cause) {
    throw new Error(`could not reconcile the state of ${liveInstallations.length} live installation(s)`, { cause });
  }
};

/**
 * Mark every installation absent from GitHub as deleted
 * @param {number[]} liveInstallationIds - Installation ids GitHub still reports
 * @returns {Promise<number>} Rows marked deleted
 */
export const markMissingInstallationsDeleted = async (liveInstallationIds) => {
  // An empty list makes the NOT (... = ANY(...)) predicate true for every row. A GitHub hiccup
  // must never look like "everybody uninstalled".
  if (!Array.isArray(liveInstallationIds) || liveInstallationIds.length === 0) {
    logger.warn('refusing to reconcile deletions from an empty installation list - nothing is marked deleted');
    return 0;
  }

  try {
    const queryText = `
      UPDATE github_installations
      SET installation_deleted = true,
          -- The earliest moment the absence is provable. GitHub reports no removal date - the
          -- installation is simply missing from the list - so an hourly reconciliation is up to
          -- an hour late, and handleInstallationEvent is what usually gets there first. The
          -- predicate already restricts this to the false -> true transition, so a row that
          -- already carries a date is never matched and never overwritten.
          installation_deleted_at = CURRENT_TIMESTAMP,
          sync_claimed_at = NULL
      WHERE installation_deleted = false
        AND installation_id IS NOT NULL
        AND NOT (installation_id = ANY($1::bigint[]))
    `;

    const result = await query(queryText, [liveInstallationIds]);

    return result.rowCount;
  } catch (cause) {
    throw new Error('could not mark missing installations deleted', { cause });
  }
};
