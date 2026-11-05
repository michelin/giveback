-- Schema for a fresh database. Idempotent, and the SINGLE description of the schema.
--
--   psql "$DATABASE_URL" -f init.sql
--
-- There is no migrations/ directory: a schema change is made HERE and applied to a running
-- database with a hand-written ALTER in the same window as the deploy. See docs/database.md.
--
-- READING ORDER, and it is the design in one line: github_repositories comes first because
-- everything else points at it. A contribution, an event and a push are identified by the
-- repository ROW they belong to - `repository_id`, a local key with a foreign key behind it -
-- never by a name. A name can be renamed, transferred, freed and taken by somebody else; a row
-- cannot. The names stored beside the links are frozen snapshots, and the column comments at
-- the bottom of this file say so where a reader could be tempted.

-- ---------------------------------------------------------------------------
-- The registry. One row per repository anything has been contributed to.
-- ---------------------------------------------------------------------------
-- Popularity, licence and topics belong to the REPOSITORY, and this is the only place they are
-- current. Held per contribution they are one copy per pull request - twelve on average for a
-- popular project, disagreeing with each other, since each froze at its own last poll - and any
-- aggregate over them silently picks one: apache/kafka's copies span 2,874 stars.
--
-- The columns of the same name on the three tables below are NOT redundant with these. Those are
-- the snapshot at the moment the contribution was seen; these are today's. Two different
-- questions, and refreshing in place would answer only one.
CREATE TABLE IF NOT EXISTS github_repositories (
    id SERIAL PRIMARY KEY,
    -- GitHub's own id, which survives a rename where full_name does not. It builds an API call
    -- and is never a join key. Null for a repository this application cannot read - a
    -- contribution made on another forge - and that null is the discriminator, which is why
    -- there is no `forge` column.
    --
    -- The prefix is the naming rule, and it is load-bearing: github_* is a number that belongs
    -- to GitHub, a bare _id is a local key. Any name closer than this to `repository_id` on the
    -- child tables would sit one syllable from a join that returns zero rows and no error at
    -- all - a foreign key catches a wrong WRITE, never a wrong JOIN.
    github_id BIGINT,
    -- The CURRENT name, rewritten by every refresh. Not unique, on purpose: two rows may
    -- legitimately share one for a while - a renamed repository whose refresh has not run yet,
    -- and a new repository that took the freed name, which GitHub allows.
    full_name VARCHAR(255) NOT NULL,
    -- The public address, so nothing ever builds a link out of a name. Free from the refresh
    -- response; typed by hand for a row no API will answer for.
    html_url TEXT,
    description TEXT,
    stargazers_count INTEGER,
    forks_count INTEGER,
    -- The real watcher count. GitHub's watchers_count is an alias of stargazers_count, so
    -- storing it would be a second column holding the same number.
    subscribers_count INTEGER,
    license VARCHAR(100),
    topics TEXT[],
    primary_language VARCHAR(100),
    -- GitHub's own flag: the owner froze the repository. It is still there and still refreshed.
    -- NOT the same question as gone_at.
    archived BOOLEAN,
    pushed_at TIMESTAMP WITH TIME ZONE,
    etag TEXT,
    next_refresh_at TIMESTAMP WITH TIME ZONE,
    -- Lease held by the worker currently refreshing; expires so crashes self-heal.
    refresh_claimed_at TIMESTAMP WITH TIME ZONE,
    refresh_error_count INTEGER NOT NULL DEFAULT 0,
    -- The 404s and 410s among those failures, and only an unbroken run of them: any other
    -- outcome resets it. What gone_at is decided on, because a timeout between two 404s says
    -- nothing about whether the repository still exists.
    refresh_404_count INTEGER NOT NULL DEFAULT 0,
    last_refreshed_at TIMESTAMP WITH TIME ZONE,
    last_refresh_error TEXT,
    -- Set when GET /repositories/{github_id} answered 404 or 410. Because that call carries the
    -- id, this cannot be a rename - an id survives one - which is what makes the verdict safe
    -- to write at all. Deliberately the only verdict there is: a repository leaves this queue
    -- for two facts and no judgements, having no github_id or being gone, so there is no
    -- disabled-by-us column here of the kind the other queues carry.
    gone_at TIMESTAMP WITH TIME ZONE,
    created_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- The history of names. One row per rename actually observed.
-- ---------------------------------------------------------------------------
-- The registry holds one name, today's, and a rename overwrites it. This is where the old one
-- goes, so a report that named a project last quarter can still be read.
--
-- detected_at is when WE saw it, not when it happened: GitHub exposes no rename history, so the
-- column says only what it can honestly say.
CREATE TABLE IF NOT EXISTS github_repository_renames (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES github_repositories(id),
    old_full_name VARCHAR(255) NOT NULL,
    new_full_name VARCHAR(255) NOT NULL,
    detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS github_installations (
    id SERIAL PRIMARY KEY,
    -- Named explicitly rather than left to PostgreSQL's <table>_<column>_key: the constraint
    -- name is what a later ALTER ... DROP CONSTRAINT has to match, so a fresh database and an
    -- existing one must agree on it.
    user_id BIGINT CONSTRAINT github_installations_user_id_unique UNIQUE,
    user_login VARCHAR(255),
    -- The person's display name from their GitHub profile. Nothing in this application reads it
    -- back: it is written at enrollment and never selected, and the dashboard's guard tests list it
    -- among the columns the dashboard may never publish. Kept deliberately for now - dropping
    -- it is a one-way ALTER on real personal data, and that decision is not this file's to make.
    user_name VARCHAR(255),
    -- The address that granted eligibility: the evidence behind verified_at. Its domain is one
    -- of ALLOWED_EMAIL_DOMAINS.
    user_enrollment_email_address VARCHAR(255),
    installation_id BIGINT,
    installation_suspended BOOLEAN,
    installation_deleted BOOLEAN,
    -- WHEN each of those two became true, for how long the dashboard says an account is stuck.
    -- Split by who owns the fact, the same way the booleans above are:
    --
    -- created_at and suspended_at are GitHub's own, mirrored from GET /app/installations by
    -- reconcile_installations - which already reads suspended_at to derive the boolean and
    -- threw the value away. Both are therefore authoritative and self-healing: a wrong one is
    -- corrected within the hour, and existing rows are backfilled by the first run.
    --
    -- deleted_at is OURS, and it is the one that cannot be backfilled. GitHub does not report
    -- when an installation was removed - a removed installation is simply absent from
    -- GET /app/installations - so this records when WE first observed the absence, by webhook
    -- or by reconciliation. It is null for every account that left before this column existed,
    -- and no query can recover those dates.
    installation_created_at TIMESTAMP WITH TIME ZONE,
    installation_suspended_at TIMESTAMP WITH TIME ZONE,
    installation_deleted_at TIMESTAMP WITH TIME ZONE,
    -- NULL until the OAuth callback proved an allowed, verified address. Such rows are known
    -- but never synchronized.
    verified_at TIMESTAMP WITH TIME ZONE,
    next_sync_at TIMESTAMP WITH TIME ZONE,
    -- Lease held by the worker currently syncing; expires so crashes self-heal.
    sync_claimed_at TIMESTAMP WITH TIME ZONE,
    sync_interval_minutes INTEGER,
    -- ETag of page 1 of the public events feed: a 304 costs no rate limit.
    events_etag TEXT,
    sync_error_count INTEGER NOT NULL DEFAULT 0,
    -- Consecutive 404s from the events feed, reset by any other outcome. The 'account gone'
    -- verdict is read off this one, sync_error_count backs off and feeds 'repeated failures'.
    sync_404_count INTEGER NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMP WITH TIME ZONE,
    -- The only column meaning "WE stopped trying", and it exists because of who owns the other
    -- two. installation_suspended and installation_deleted mean "GitHub told us this", and
    -- reconcile_installations rewrites them hourly from GET /app/installations - so a verdict
    -- written into either would be reverted within the hour AND have next_sync_at reset to now,
    -- promoting the broken row to the front of the queue instead of retiring it.
    sync_disabled_at TIMESTAMP WITH TIME ZONE,
    -- 'account gone' or 'repeated failures'. Free text on purpose: read by a human on the
    -- dashboard, never branched on.
    sync_disabled_reason TEXT,
    -- Why the last failed sync failed, in GitHub's own words. Overwritten by the next failure
    -- and cleared by the next success, so it answers "who is failing right now" and nothing
    -- else - job_runs.failures carries the history.
    last_sync_error TEXT,
    created_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS github_pull_requests (
    id SERIAL PRIMARY KEY,
    pull_request_id BIGINT UNIQUE NOT NULL,
    number INTEGER NOT NULL,
    -- WHICH repository, and the only answer to that question. Every read joins on it, the poll
    -- builds its API call from the github_id behind it, and NOT NULL is what makes both safe.
    repository_id INTEGER NOT NULL REFERENCES github_repositories(id),
    -- The pull request's own address. Free from the hydration response; typed by hand for a
    -- contribution entered by hand, which no API will ever answer for.
    html_url TEXT,
    title TEXT,
    state VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    closed_at TIMESTAMP WITH TIME ZONE,
    merged_at TIMESTAMP WITH TIME ZONE,
    merged BOOLEAN,
    merged_by VARCHAR(255),
    commits_count INTEGER,
    changed_files INTEGER,
    opened_by VARCHAR(255),
    user_type VARCHAR(50),
    -- Git refs have no length limit; VARCHAR(255) would raise 22001 on a long branch name.
    src_repo VARCHAR(255),
    src_ref TEXT,
    -- FROZEN at first sighting: the repository's name the day this contribution was seen. Kept
    -- for information, and nothing may join, group or filter on it - see the comment at the
    -- bottom of this file, and the guard that enforces it.
    dest_repo VARCHAR(255),
    dest_ref TEXT,
    -- A point-in-time snapshot taken when the pull request was first seen, never the
    -- repository's current state. github_repositories carries today's values; these stay as the
    -- contribution last saw them, and for a hand-entered row they are the only record there is.
    license VARCHAR(100),
    topics TEXT[],
    forks_count INTEGER,
    stargazers_count INTEGER,
    -- Same scheduling protocol as github_installations.
    next_poll_at TIMESTAMP WITH TIME ZONE,
    poll_claimed_at TIMESTAMP WITH TIME ZONE,
    poll_interval_minutes INTEGER,
    poll_error_count INTEGER NOT NULL DEFAULT 0,
    last_polled_at TIMESTAMP WITH TIME ZONE,
    -- Why the last failed poll failed. Same contract as github_installations.last_sync_error:
    -- overwritten by the next failure, cleared by the next success, so it only ever answers
    -- "what is wrong with this row now" - job_runs.failures carries the history.
    last_poll_error TEXT,
    -- Our clock, when the state change was noticed. state_changed_at - merged_at is the
    -- detection latency. Not last_polled_at, which every poll overwrites including the ones
    -- that found nothing.
    state_changed_at TIMESTAMP WITH TIME ZONE,
    -- How this row got here. 'github' is everything the bot detected in a public events feed;
    -- 'manual' is a contribution entered by hand, typically one made on another forge, which
    -- belongs in the report but exists nowhere on github.com. The default means every row
    -- written before this column existed is correctly 'github'.
    origin VARCHAR(16) NOT NULL DEFAULT 'github',
    created_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Append-only log of the PullRequestEvent entries seen in the public events feed, so a known
-- event already hydrated is never fetched again - that lookup is the bulk of the API budget.
-- One noted but never hydrated IS fetched again: see the skip condition in
-- jobs/sync_contributions.js and the `hydrated` half of insertPullRequestEventIfNotExists.
--
-- A TIME SERIES, not a fossil: beside the id it dedupes on, it keeps what the pull request
-- looked like at the moment the event was seen, which github_pull_requests cannot reconstruct
-- because it holds the final state. Over 787 comparable rows, updated_at differs from the pull
-- request row 576 times, state 221, closed_at 221. Written in two goes - the insert notes the
-- event, the update after hydration fills the snapshot - because the snapshot is only known
-- after the fetch that the insert exists to authorize.
CREATE TABLE IF NOT EXISTS github_pull_request_events (
    id SERIAL PRIMARY KEY,
    event_id BIGINT,
    pull_request_id BIGINT,
    number INTEGER NOT NULL,
    action VARCHAR(50) NOT NULL,
    -- WHOSE feed produced this event: the enrolled person who performed the action. NOT the
    -- author of the pull request, and the distinction is the whole point of the column. The feed
    -- returns what somebody DID, and `action` is one of eleven - assigned, labeled, closed,
    -- merged, reopened, review_requested - so most rows here describe a person acting on
    -- SOMEBODY ELSE's pull request. github_pull_requests.opened_by answers "who wrote it"; this
    -- answers "who did this", and nothing else in the database can.
    --
    -- Null for every row written before this column existed, and unrecoverable: the feed reaches
    -- back ~90 days and those events have fallen out of it. Read a null as "not recorded", never
    -- as "nobody".
    actor VARCHAR(255),
    -- WHICH repository. Beside it, repo_fullname is the name as the feed gave it - frozen, for
    -- a human reading the ledger months later.
    repository_id INTEGER NOT NULL REFERENCES github_repositories(id),
    repo_fullname VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE,
    -- The snapshot. Filled by the update that follows hydration, so it is null for the instant
    -- between the two statements and for ever if the hydration failed - which is a fact about
    -- that event, not a gap to be backfilled.
    title TEXT,
    state VARCHAR(50),
    updated_at TIMESTAMP WITH TIME ZONE,
    closed_at TIMESTAMP WITH TIME ZONE,
    merged_at TIMESTAMP WITH TIME ZONE,
    merged BOOLEAN,
    merged_by VARCHAR(255),
    commits_count INTEGER,
    changed_files INTEGER,
    license VARCHAR(100),
    topics TEXT[],
    forks_count INTEGER,
    stargazers_count INTEGER,
    created_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- The other half of the feed. A push is never hydrated - there is no second call that would
-- describe one - so this table is written once and never updated, and the four popularity
-- columns on it are an archive of what was known until 2025-11-13 and nothing more.
CREATE TABLE IF NOT EXISTS github_push_events (
    id SERIAL PRIMARY KEY,
    event_id BIGINT,
    push_id BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE,
    -- WHICH repository, and beside it the name as the feed gave it, frozen.
    repository_id INTEGER NOT NULL REFERENCES github_repositories(id),
    repository_fullname VARCHAR(255),
    repository_branch TEXT,
    actor VARCHAR(255),
    commits_count INTEGER,
    -- ARCHIVE. 1,071 values, and never one more: nothing available to a PushEvent carries them.
    license VARCHAR(100),
    topics TEXT[],
    forks_count INTEGER,
    stargazers_count INTEGER,
    created_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- One row per run of a scheduled job, so the dashboard can show trends and not only the
-- current instant. Purged on a rolling window by reconcile_installations: operational
-- telemetry, not history to keep.
CREATE TABLE IF NOT EXISTS job_runs (
    id BIGSERIAL PRIMARY KEY,
    job VARCHAR(64) NOT NULL,
    -- ok | failed | idle | skipped, the same four words the log line uses.
    outcome VARCHAR(16) NOT NULL,
    duration_ms INTEGER NOT NULL,
    -- The key set differs per job and changes with the code, which is why this is jsonb.
    counters JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- First line of the failure only. Stacks stay in the log.
    error TEXT,
    -- The subjects this run could not process, and why: [{subject, status, message}, ...].
    -- Distinct from `error`, which is the failure of the RUN itself - a run can complete
    -- normally, report outcome 'ok', and still have failed every subject inside it.
    failures JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes ---------------------------------------------------------------------------

-- github_repositories: the identity is the GitHub id. Partial, because a row without one is
-- legitimate - a contribution on another forge - and two nulls are distinct in a unique index,
-- so without the predicate every such row would sit in it for nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_github_id
  ON github_repositories(github_id) WHERE github_id IS NOT NULL;
-- Every predicate in claimRepositoriesForRefresh(), in its order. A predicate in the query and
-- not here makes the index unusable for it, and nothing fails - the scan just quietly becomes
-- sequential.
-- A repository on another forge carries no GitHub id, so the partial unique index above cannot
-- keep it unique - its predicate excludes exactly those rows. Manual contributions are the only
-- writer that creates one, and without this an operator recording a second merge request on the
-- same GitLab project would split that project into two rows, each with its own figures.
--
-- lower(), because a forge path is case-insensitive in practice and `Gitlab-Org/GitLab` pasted
-- once out of a browser would otherwise become a second project.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_foreign_full_name
  ON github_repositories (lower(full_name)) WHERE github_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_repositories_due_for_refresh
  ON github_repositories(next_refresh_at ASC NULLS FIRST)
  WHERE github_id IS NOT NULL AND gone_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_repository_renames_repository
  ON github_repository_renames(repository_id);

-- github_installations
CREATE INDEX IF NOT EXISTS idx_installations_installation_id
  ON github_installations(installation_id);
CREATE INDEX IF NOT EXISTS idx_installations_user_login
  ON github_installations(user_login);
-- isEnrolledUser() matches on lower(user_login), which the plain-column index above cannot
-- serve: the predicate is an expression, so the planner reads every row and filters. The
-- plain-column index stays - the joins in contributions.js and polling.js are on the bare
-- column.
CREATE INDEX IF NOT EXISTS idx_installations_user_login_lower
  ON github_installations (lower(user_login));
-- Every predicate below appears in claimInstallationsForSync() AND in dashboard.js's SYNCABLE.
CREATE INDEX IF NOT EXISTS idx_installations_due_for_sync
  ON github_installations(next_sync_at ASC NULLS FIRST)
  WHERE installation_suspended = false
    AND installation_deleted = false
    AND verified_at IS NOT NULL
    AND sync_disabled_at IS NULL;

-- One index per link. github_pull_requests is read all over this application and joined on
-- repository_id by the contribution report (src/db/contributions.js). The two ledgers below have
-- no reader here at all - see the COMMENT ON github_pull_request_events and src/db/events.js -
-- so their index is not for this application: it serves whoever queries the database directly,
-- and the foreign-key check Postgres runs against these tables if a github_repositories row is
-- ever deleted.
CREATE INDEX IF NOT EXISTS idx_pull_requests_repository
  ON github_pull_requests(repository_id);
CREATE INDEX IF NOT EXISTS idx_pr_events_repository
  ON github_pull_request_events(repository_id);
CREATE INDEX IF NOT EXISTS idx_push_events_repository
  ON github_push_events(repository_id);

-- github_pull_requests
CREATE INDEX IF NOT EXISTS idx_pull_requests_opened_by
  ON github_pull_requests(opened_by);
-- IS DISTINCT FROM, exactly as claimPullRequestsForPoll() writes it, or the planner cannot use
-- this index.
CREATE INDEX IF NOT EXISTS idx_pull_requests_due_for_poll
  ON github_pull_requests(next_poll_at ASC NULLS FIRST)
  WHERE state IS DISTINCT FROM 'closed' AND origin = 'github';
-- Serves the detection-latency percentiles. Partial, because a row with no state_changed_at
-- can never contribute to them.
CREATE INDEX IF NOT EXISTS idx_pull_requests_state_changed_at
  ON github_pull_requests (merged_at DESC)
  WHERE state_changed_at IS NOT NULL;

-- Event tables: UNIQUE so the app can rely on ON CONFLICT (event_id) DO NOTHING
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_events_event_id
  ON github_pull_request_events(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_events_event_id
  ON github_push_events(event_id);

-- job_runs: the only per-job read is listRecentRunsPerJob(), and it partitions rather than
-- filters - row_number() OVER (PARTITION BY job ORDER BY started_at DESC). No query in
-- src/db/job_runs.js has a WHERE job = ... predicate.
CREATE INDEX IF NOT EXISTS idx_job_runs_job_started_at
  ON job_runs (job, started_at DESC);
-- Serves every job-agnostic read: the rolling purge and listRecentRuns' ordered scan directly,
-- listRecentFailures as a started_at range.
CREATE INDEX IF NOT EXISTS idx_job_runs_started_at
  ON job_runs (started_at);

-- ---------------------------------------------------------------------------
-- Column comments
-- ---------------------------------------------------------------------------
-- These live in the database rather than only in this file: they are what pgAdmin, DataGrip, a
-- BI tool or the Streamlit report shows to whoever opens the schema without reading the
-- repository. Keep them for the traps a downstream consumer would otherwise discover the hard
-- way, not for every column.
--
-- Most of them below say the same thing about a different column, because it is the one thing
-- this schema can be misread on: a name or a figure stored beside a contribution is what was
-- true THEN. Today's answer is on github_repositories, reached through repository_id.

COMMENT ON COLUMN github_repositories.github_id IS
  'GitHub''s own id. The address used to build an API call, NEVER a join key - the key is id. Null for a repository this application cannot read, and that null is what keeps it out of the refresh queue.';

COMMENT ON COLUMN github_repositories.full_name IS
  'The CURRENT name, rewritten by every refresh. Deliberately not unique: a renamed repository whose refresh has not run yet and a new repository that took the freed name may share one for a while. The names it had before are in github_repository_renames.';

COMMENT ON COLUMN github_repositories.gone_at IS
  'Set when GET /repositories/{github_id} answered 404 or 410. Because the call carries the id, this cannot be a rename - an id survives one. It cannot tell deleted from private from transferred-out-of-reach, so it means exactly "no longer readable". NOT the same question as archived, which is GitHub''s own flag for a repository the owner froze and which is still refreshed.';

COMMENT ON COLUMN github_repository_renames.detected_at IS
  'When THIS application saw the rename, not when it happened: GitHub exposes no rename history.';

COMMENT ON TABLE github_pull_requests IS
  'The product: read by downstream consumers and by most of this application. The contribution report (src/db/contributions.js) selects the title, the commit count, the dates, the author and, where github_repositories has none yet, the star count; the dashboard (src/db/dashboard.js) selects the counts, the dates, the author and user_type - no title, no snapshot column. WHICH repository is repository_id, joined to github_repositories; the names and figures stored here are frozen at first sighting. Two of the dates are read for what only they say: closed_at dates a pull request closed without a merge, and created_timestamp - when this application first recorded the row - is what detection latency and the lateness of a pull request never polled are measured from. The columns nothing here reads are the ones written from the GitHub payload and never read back: changed_files, src_repo, src_ref, dest_repo, dest_ref, license, topics, forks_count and merged_by. updated_at is read once, by refreshPullRequest (src/db/pull_requests.js), so that a read from somebody else''s feed never overwrites a newer one. Treat every other column as a published interface with an in-app reader as well.';

COMMENT ON COLUMN github_pull_requests.repository_id IS
  'WHICH repository this contribution was made to, as a local key into github_repositories. The only correct way to ask that question: a name moves, this does not. Never join on a name column.';

COMMENT ON COLUMN github_pull_requests.merged_by IS
  'Who merged it, as a GitHub login. Kept for downstream consumers; nothing in this application reads it back, and both of its privacy guards ban the column from every read. A NAME, with the same hazard as dest_repo below: a login GitHub renames keeps its old spelling here.';

COMMENT ON COLUMN github_pull_requests.user_type IS
  'GitHub''s own word for the account that opened it, frozen at hydration: "User", or "Bot" for Dependabot, Renovate and the rest. It is the whole of BY_A_PERSON - spelled p.user_type = ''User'' in src/db/contributions.js and src/db/dashboard.js alike - and so the single predicate behind every "person" figure on the dashboard. = ''User'' rather than <> ''Bot'' on purpose: a type nobody has seen yet, and a NULL, stay out of a figure about people until somebody decides they belong there.';

COMMENT ON COLUMN github_pull_requests.dest_repo IS
  'FROZEN. The repository''s name as it was when this contribution was first seen. Written once, on insert, and never updated. Information only: no query may join, group or filter on it - the current name comes from github_repositories via repository_id. A wrong value here is harmless, and one is wrong: pull request 372518254 names the source fork it came from.';

COMMENT ON COLUMN github_pull_requests.stargazers_count IS
  'FROZEN at first sighting, not today. Today''s figure is on github_repositories. Same for forks_count, topics and license. It is the contribution-time snapshot for 514 of 1,129 contributions, and the only record for the hand-entered ones, which have no ledger row.';

COMMENT ON COLUMN github_pull_requests.origin IS
  '"github" for everything detected in a public events feed, "manual" for a contribution entered by hand - typically one made on another forge, which belongs in the report but exists nowhere on github.com. The poll claims only "github": there is nothing to fetch for the other kind.';

COMMENT ON COLUMN github_pull_requests.next_poll_at IS
  'When this pull request is due for a refresh. NULL is treated as due.';

COMMENT ON COLUMN github_pull_requests.last_poll_error IS
  'Why the last failed poll failed. Overwritten by the next failure, cleared by the next success: it answers "what is wrong with this row now", never "what failed over the last day" - job_runs.failures carries that.';

COMMENT ON COLUMN github_pull_requests.state_changed_at IS
  'When this application noticed the state change, on its own clock. state_changed_at - merged_at is the detection latency. Set on insert and on a state transition only, never by a poll that found nothing.';

COMMENT ON TABLE github_pull_request_events IS
  'One row per PullRequestEvent seen in a public events feed, so an event already hydrated is never fetched again - that lookup is the bulk of the API budget. An event noted but NOT hydrated IS fetched again: the row is committed before the fetch, so a fetch that failed leaves the snapshot NULL, and re-offering it is what stops a transient GitHub failure retiring the contribution for ever. A time series: its own columns are what the pull request looked like at that moment, which github_pull_requests cannot reconstruct because it holds the final state. "At that moment" means when the event was PROCESSED: the feed reaches back ~90 days, so a first sync hydrates everything in it at once and every row gets the same state. A young database therefore looks like pure duplication and is not - the series only accumulates while the feed is followed live.';

COMMENT ON COLUMN github_pull_request_events.state IS
  'FROZEN: the pull request''s state at the moment this event was seen, not its final state - that is on github_pull_requests, keyed by pull_request_id. They differ on 221 of 787 comparable rows. Written from the hydration response, in the same update as the popularity columns. Never read as the current state.';

COMMENT ON COLUMN github_pull_request_events.closed_at IS
  'FROZEN, and the sharpest illustration of why these columns exist: it never varies between one pull request''s events, yet differs from github_pull_requests 198 times out of 787 - because the pull request was still open when the event was seen. Null here means "not closed yet", not "never closed".';

COMMENT ON COLUMN github_pull_request_events.stargazers_count IS
  'FROZEN at the moment the event was seen. The hydration response carries it for free, so this accumulates: 788 values so far, and one per event from here on.';

COMMENT ON COLUMN github_pull_request_events.actor IS
  'The enrolled person whose public events feed produced this event - who ASSIGNED, LABELED, CLOSED or MERGED, not who opened the pull request. Most rows here are a maintainer acting on somebody else''s contribution, and github_pull_requests.opened_by is the other question. Null for rows written before the column existed, and unrecoverable: the feed reaches back ~90 days.';

COMMENT ON COLUMN github_pull_request_events.repo_fullname IS
  'FROZEN: the name the events feed gave, kept so a human reading this ledger months later can see what it was called then. WHICH repository is repository_id.';

COMMENT ON COLUMN github_push_events.stargazers_count IS
  'ARCHIVE: 1,071 values that no request can restore, because a PushEvent is never hydrated and nothing available for one carries a star count. Read them as a record of what was known, never as current, and expect no new ones.';

COMMENT ON COLUMN github_installations.user_enrollment_email_address IS
  'Verified address the user enrolled with. Its domain is one of ALLOWED_EMAIL_DOMAINS. This is the evidence behind verified_at.';

COMMENT ON COLUMN github_installations.next_sync_at IS
  'When this installation is due for a contribution sync. NULL is treated as due.';

COMMENT ON COLUMN github_installations.sync_claimed_at IS
  'Lease held by the worker currently syncing this row; expires so crashes self-heal.';

COMMENT ON COLUMN github_installations.sync_disabled_at IS
  'Set when the application itself gave up on this row. NOT interchangeable with installation_suspended or installation_deleted, which mean "GitHub told us this" and are rewritten hourly by reconcile_installations. Cleared by re-enrollment, or - only when the reason was ''account gone'' - by the reconciliation finding a renamed login; a retirement for ''repeated failures'' stands through a rename.';

COMMENT ON COLUMN github_installations.last_sync_error IS
  'Why the last failed sync failed. Overwritten by the next failure, cleared by the next success: it answers "who is failing right now", never "what failed over the last day" - job_runs.failures carries that.';

COMMENT ON COLUMN github_installations.installation_created_at IS
  'When GitHub says the app was installed on this account. Mirrored from created_at in GET /app/installations by reconcile_installations, so it is authoritative and self-healing - a wrong value is corrected within the hour, and rows predating this column are backfilled by the first run. Distinct from verified_at, which is when the OAuth callback proved an allowed address: installing and finishing enrollment are two acts, minutes apart at best and never at all for a pending row.';

COMMENT ON COLUMN github_installations.installation_suspended_at IS
  'When GitHub says this installation was suspended, mirrored from suspended_at in the same call - the value reconcile_installations already read to derive installation_suspended and discarded. Null whenever installation_suspended is false, and cleared on unsuspend, so the two always agree.';

COMMENT ON COLUMN github_installations.installation_deleted_at IS
  'When WE first observed this installation was gone - by the installation.deleted webhook, or by the reconciliation finding it absent from GET /app/installations. NOT GitHub''s timestamp, because GitHub has none to give: a removed installation is simply missing from the list, so the moment of removal is unobservable and this is the earliest we can prove. Null for every account that left before this column existed, and no query can recover those dates. Cleared if the account reinstalls.';

COMMENT ON TABLE job_runs IS
  'One row per run of a scheduled job. Purged on a rolling window (JOB_RUN_RETENTION_DAYS, default 7) by reconcile_installations: it is operational telemetry, not history to keep.';

COMMENT ON COLUMN job_runs.failures IS
  'The subjects this run could not process, as [{subject, status, message}]. Not the same as error, which is the failure of the run itself: a run can report outcome ok and still have failed every subject inside it.';

COMMENT ON COLUMN job_runs.counters IS
  'The run counters verbatim, as reported by the job. The key set differs per job and changes with the code, which is why this is jsonb.';

COMMENT ON COLUMN job_runs.started_at IS
  'Derived as recorded_at minus duration_ms: the worker reports a duration, not a start.';
