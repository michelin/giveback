# Database

PostgreSQL 9.5 or later (`FOR UPDATE SKIP LOCKED`).

## A new installation only needs `init.sql`

```sh
psql "$DATABASE_URL" -f init.sql
```

`init.sql` is idempotent and is the **whole schema**. There is no migration directory, by choice:
see [Changing the schema](#changing-the-schema).

To check that a live database matches the file, build a scratch database from `init.sql` and
compare the two catalogs: columns, types, nullability, defaults, index definitions, constraint
*names* and `COMMENT ON` objects must be identical. Comments matter too: they are what `\d+`,
pgAdmin and schema-documentation tools show.

## Refreshing the compose database

`compose.yaml` mounts `init.sql` into `/docker-entrypoint-initdb.d/`, which PostgreSQL runs **only
when it creates the data directory**, on the first `up`. Edit `init.sql` afterwards and nothing
happens until you do one of these:

```sh
# Keep the data: apply the file to the running container like any other database
# (use your POSTGRES_HOST_PORT if you moved it).
psql "postgresql://postgres@localhost:5432/postgres" -f init.sql

# Start over: destroy the volume, and the next `up` runs init.sql from scratch.
docker compose down -v && docker compose up -d --wait
```

The first only adds what is missing: it adds no column to an existing table and drops nothing
([why](#changing-the-schema)). Locally the second is almost always the right one.

## Tables

| Table | Holds |
| --- | --- |
| `github_installations` | One row per enrolled user: identity, installation state, scheduling cursor, feed ETag, retirement |
| `github_pull_requests` | One row per pull request recorded, **bots included** (`user_type`), with its scheduling cursor. **This is the product** |
| `github_pull_request_events` | Event ids already processed, so a hydrated event is never fetched again, **and** what the pull request looked like at that moment, **and** who acted (`actor`). A time series that nothing here reads back, holding every event seen, including those on other people's pull requests |
| `github_push_events` | Public pushes to repositories the user does not own. Written once, never updated |
| `github_repositories` | One row per repository contributed to, with its popularity **as it is today**. The tables above point at it by `repository_id` |
| `github_repository_renames` | One row per rename observed: the registry holds today's name, this the previous ones |
| `job_runs` | One row per scheduled job run. Rolling window, purged by `reconcile_installations`: operational telemetry, not history |

### Why the pull request ledger is wide and the push ledger is frozen

The feed's payload carries no licence, topics, star count or pull request state; the hydration
response does. So the ledger is written in **two goes**: the insert notes the event, which is what
authorises the fetch, and an update fills thirteen snapshot columns once the fetch answers.

Nine of them are the pull request's own state at that moment, not a duplicate of
`github_pull_requests`, which holds the *final* state: `state`, `closed_at`, `merged`, `merged_at`,
`commits_count` and the like differ between the two whenever the pull request was still open when
the event was seen. Columns that never differ (`opened_by`, the source and target repository and
ref) are not copied: a second copy nobody can tell from the first only raises the question of which
is authoritative.

"At that moment" means when the event was *processed*. A first sync hydrates the whole ~90-day feed
at once, so the series only accumulates while the feed is followed live.

`github_push_events` is the opposite: **a push is never hydrated**, as no call describes one. Its
four popularity columns are an archive nothing can refresh or restore, marked `ARCHIVE` in the
schema so nobody takes them for today's figures.

`test/configuration.test.js` fails the build if a column of either table has no writer (an INSERT
or an UPDATE), or a writer names a column the schema lacks. The archive columns are the one
exemption, and only because `init.sql` declares them an archive.

### Why repositories have a table of their own

Popularity, licence and topics belong to the repository. Held on each pull request, they made
hundreds of copies that drifted apart (one project carried seven different star counts), and
`max()` over them put the wrong project on the podium.

So `github_repositories` holds one row per repository and `sync_repositories` keeps it current
every six hours. That interval is **fixed**, where every other subject climbs an adaptive ladder:
a star count always moves, so the ladder would sit on its floor and spend 96 calls a day per
popular repository on a figure nobody needs in real time. The same columns on
`github_pull_requests` stay: they are the figure **at the time of the contribution**, a different
question from today's.

**The table fills itself when a contribution is written, and never afterwards.**
`sync_contributions` writes the repository row when it records a new event, using the `repo.id` the
feed's envelope already carries, in the same transaction as the ledger row. The manual entry form
does the same: a GitHub pull request by the id its lookup answered, anything on another forge by
name. There is deliberately **no sweep** filling gaps: it would be one more creator of repository
rows, keyed on a name, and two creators with two keys is how one repository ends up with two rows.
A row somebody deletes is not recreated.

Two creators exist, both in `src/db/repositories.js`, and each has a conflict target that can
match:

- `ensureRepository()` refuses a row without a `github_id`. Its conflict target is the partial
  unique index on `github_id`, where two NULLs are distinct: an id-less insert would conflict with
  nothing and every event would add a twin.
- `ensureForeignRepository()`, for rows with no `github_id`, conflicts on
  `idx_repositories_foreign_full_name`, unique on `lower(full_name)` where `github_id IS NULL`.

`test/configuration.test.js` asserts that no other file creates a repository row.

**`github_id` is GitHub's own id: the address of an API call, never a join key.** It matters
because a **transfer can leave no redirect**: the old name answers a bare 404, so by name a move
looks like a deletion, while by id it is a 200 with the new name. `github_id` is NULL only where
GitHub cannot be asked (a project on another forge, or a GitHub name that answers 404 with no id),
which is what keeps the row out of the refresh queue. There is no `forge` column: the NULL means
"this application cannot read it".

**`repository_id` is the local key**, `NOT NULL` behind a foreign key, and the only correct answer to
"which repository". Grouped by their frozen names, two contributions to a renamed repository are two
projects, and the day somebody takes the freed name they become one project with a stranger's
contributions in it. Every read joins on `repository_id` with an `INNER JOIN`, spelled once in
`src/db/contributions.js`.

The naming rule, because two columns are one syllable apart: a **`github_` prefix is a number that
belongs to GitHub**, a bare `_id` is a local key. A foreign key catches a wrong *write*, never a
wrong *join*: a join on the wrong number returns zero rows and no error.

A repository leaves the refresh queue for two **facts**: it has no `github_id`, or `gone_at` is
set, after `REPO_GONE_AFTER_404` 404s or 410s *by id* in an unbroken run, counted in
`refresh_404_count`. Three, not one, because a repository made
private for an afternoon answers like a deleted one; not fifty, because the id leaves no ambiguity.
`gone_at` is one-way: a repository that comes back needs a hand-written `UPDATE`.

A rename costs one column and one row. `sync_repositories` is the only thing that notices one (it
asked by id, GitHub answered with today's name) and writes both in one transaction, so a name is
never overwritten without its predecessor being kept in `github_repository_renames`.

### Columns worth knowing before you write to them

`origin` says where a contribution came from: `github` for the events feed, `manual` for an entry
made by hand on the dashboard. Only `github` rows are polled, which is what the partial index
`idx_pull_requests_due_for_poll` encodes; every figure counts both.

`github_installations` has **three** state columns that look interchangeable and are not:

| Column | Means | Written by |
| --- | --- | --- |
| `installation_suspended` | GitHub told us | webhooks, and `reconcile_installations` hourly |
| `installation_deleted` | GitHub told us | webhooks, and `reconcile_installations` hourly |
| `sync_disabled_at` | *we* stopped trying | `sync_contributions` only |

The third exists because the first two are rewritten hourly from `GET /app/installations`, which
also makes a corrected row due now: a verdict of ours written into either would be reverted *and*
its row promoted to the front of the queue.

Two counters sit behind the retirement verdicts, and both count **only an unbroken run of
not-found answers**, never a total:

| Column | Counts | Reset by |
| --- | --- | --- |
| `github_installations.sync_404_count` | consecutive 404s from the events feed (`account gone`) | any other failure, a success, verification, unsuspension, a login rename, a reinstall |
| `github_repositories.refresh_404_count` | consecutive 404s or 410s by id (`gone_at`) | any other failure, a success |

A 404 from minting the installation token never counts: it is about the installation. The general
failure counts (`sync_error_count`, `refresh_error_count`) are separate and drive the backoff.

`github_installations.last_sync_error` and `github_pull_requests.last_poll_error` hold why the last
failure failed, and only that: the next success clears them. The history is `job_runs.failures`,
purged with the rest of that table.

`github_pull_requests.state_changed_at` is written on insert and on a state transition **only**, so
`state_changed_at - merged_at` is the real detection latency. `last_polled_at` cannot answer that:
every poll overwrites it.

### `github_pull_requests` is a published interface

Downstream consumers read it, and so does most of this application. Columns nothing here reads
back (`updated_at`, `changed_files`, `src_repo`, `src_ref`, `dest_repo`, `dest_ref`, `license`,
`topics`, `forks_count`, `merged_by`) are kept for those consumers. The traps are recorded as
`COMMENT ON` in the database itself, where a BI tool shows them:

- `dest_repo` is **frozen**: the repository's name when the contribution was first seen.
  Information only; no query may join, group or filter on it. The current name comes from
  `github_repositories` through `repository_id`.
- `merged_by` is a login kept for downstream consumers. Nothing here reads it, both privacy guards
  ban it from every read, and a renamed login keeps its old spelling here.
- `license`, `topics`, `forks_count` and `stargazers_count` are **frozen** too: the snapshot at first
  sighting, and the only record for hand-entered contributions. A consumer wanting current values
  joins `github_repositories` on `repository_id`.
- `html_url` is the contribution's own address, stored rather than built, because a rename breaks
  any link assembled from a name and a number.

Which columns freeze is enforced: a test reads the `ON CONFLICT` clause of `upsertPullRequest` and
requires every column to be either refreshed or in the frozen list, and every name in that list to
be genuinely absent from the clause.

## Changing the schema

Edit `init.sql`. It must always describe a database the current code can run against, with no step
in between.

There are no migration files, by choice. Whatever a live database needs to catch up is a throwaway:
written outside the repository, run once, deleted. A statement that repairs one database on one day
is not a fact about the schema, and a list of them rots into a second, contradictory description of
the tables.

Before you edit:

**A rename or a drop breaks readers, instantly and silently.** It is a catalog-only operation in
PostgreSQL. Anything selecting the column by name fails at once (BI datasets, ETL jobs, ad-hoc SQL,
the *previous* version of this app). Check the downstream consumers first; `pg_stat_statements`,
where available, shows who has been reading a column.

**Re-running `init.sql` does not add a column.** Every table is `CREATE TABLE IF NOT EXISTS`, so on
an existing database the file is a no-op. Add the column by hand, in the right order: a
**nullable** column, or a `NOT NULL` one with a default (as `sync_404_count` and
`refresh_404_count` are), can be added *before* the deploy, invisible to the running code. Added
after, every statement naming it fails with `42703 undefined_column` until it exists. A `NOT NULL`
column without a default needs two deploys.

**Priming a queue means dispersing it.** Anything that seeds `next_sync_at` or `next_poll_at` should
spread the rows over one interval, never set them all to `CURRENT_TIMESTAMP`:
[architecture.md](./architecture.md#dispersion).

Before touching a database that holds real enrollments, take a backup and check it restores:

```sh
pg_dump "$DATABASE_URL" --format=custom --schema=public --file="$HOME/backup.dump"
pg_restore --list "$HOME/backup.dump" | grep -cE 'TABLE DATA|SEQUENCE SET'
```

The count must cover every table **and** every sequence: a dump taken by a role without `SELECT`
on the sequences restores the rows, then collides on the first insert. Keep the dump in `$HOME`,
outside the working tree: it holds every enrolled address, and a file in the repository is one
`git add -A` away from being committed.
