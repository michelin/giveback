# Architecture

What the application is made of, and why each part is shaped the way it is.

## One process, two responsibilities

```
                    ┌──────────────────────────────────────────┐
   GitHub  ────────▶│  POST /api/github/webhooks   (Probot)    │
   webhooks         │  GET  /callback  /enroll      (Express)  │──▶ PostgreSQL
                    │  GET  /health  /ping  /version           │
                    │  /dashboard/*  (only with SESSION_SECRET)│
                    ├──────────────────────────────────────────┤
                    │  Bree scheduler — 4 jobs, worker threads │──▶ PostgreSQL
                    └──────────────────┬───────────────────────┘
                                       │
                                       ▼
                              GitHub REST API
```

The HTTP side handles enrollment and observability; the scheduler side collects the data. They
share nothing but the database, which is what lets several instances run side by side (see
[Claiming](#claiming)).

## Enrollment

An **installation** of the GitHub App is not an access grant here: it is a consent signal and a
source of API tokens. The App requests **no repository or organisation permission**: everything
the collection reads is public, and an installation's scope does not gate a public read.

The one exception, stated plainly for a security review: `request_oauth_on_install` obtains a
**user** access token, and the callback spends it on `GET /user/emails` to find a verified
address on an allowed domain. That address is not public. Exactly one is stored, in
`github_installations.user_enrollment_email_address`; the token is used for that request and
discarded, never written down.

Two paths write the `github_installations` row, and only one of them is trusted:

1. **`installation.created` webhook**: HMAC-signed by GitHub, so it cannot be forged. Writes the
   row with `verified_at` NULL: known, never synchronised. Its job is durability. A webhook
   carrying the installation id the row already holds changes nothing (one `debug` line): it is a
   redelivery, or it arrived after the callback had already verified the row, and resetting it
   would leave that person pending for good. Only a **new** installation id, a reinstall, resets
   the row to pending.
2. **`GET /callback?code=…`**: GitHub redirects the browser here after the install, with a
   single-use OAuth code. The app exchanges it for a user token, then calls `GET /user`,
   `GET /user/installations` and `GET /user/emails`, runs the domain check, and only then sets
   `verified_at`.

### Why the query-string installation id is ignored

Nothing ties `?installation_id=` to the OAuth code, and since GitHub, not the app, initiates that
redirect, a CSRF `state` nonce is impossible. Trusting it would let anyone act on an arbitrary
installation.

`GET /user/installations` is the authority instead. Called with the user's own token it can only
return that user's installations, so it proves ownership, and it reports the installation that
exists **right now**: the database can lag behind the webhook, and on a reinstall would point at
a dead installation id.

### Rejection uninstalls the app

Safe *because* the installation came from `GET /user/installations` and is provably the caller's
own. Leaving it installed but unverified would leave an ineligible user with a bot on their
account doing nothing, forever.

A reinstall (a new installation id) resets the row to pending. Prior verification does **not**
carry over: it only proves the address was held at the time.

### The callback never renders

It always redirects: on success to the installation's settings page on github.com, on every
rejection to `GET /enroll?reason=…`. An OAuth code is single-use, so a page rendered by the
callback would break on the first refresh. `/enroll` has no side effect and can be reloaded,
bookmarked or shared; a replayed code (`bad_verification_code`) lands on a page saying nothing is
wrong.

Past 20 callbacks a minute from one address the route answers `429` with a JSON body
(`CALLBACK_LIMIT` in `src/index.js`, a constant, not a setting). `GET /dashboard/callback` spends
the same budget: both exchange a caller-supplied code with the App's client secret, and a flood
of them could trip GitHub's abuse detection on the App's OAuth client.

The install button on that page is derived, not configured: at startup the app calls `GET /app`,
which answers for whichever App the loaded `APP_ID` and `PRIVATE_KEY` belong to, so the button can
never send users to another App. `GITHUB_APP_PUBLIC_URL` overrides it. Either way the startup log
names the App:

```
INFO (index): authenticated as github app your-app-slug
```

### Only personal installations

The table is keyed on `user_id` and contributions are fetched per GitHub login, so an
organisation install is logged and ignored on both paths.

## Collection

There is no per-user cron: four static jobs, and the priority lives in the data.

| Job | Reads | Writes |
| --- | --- | --- |
| `sync_contributions` | `GET /users/{login}/events`, then `GET /repositories/{id}/pulls/{number}` for each new PR event | `github_pull_requests`, `github_push_events`, `github_pull_request_events`, and the `github_repositories` row of anything newly contributed to |
| `poll_non_closed_pull_requests` | `GET /repositories/{id}/pulls/{number}` for each due open PR | `github_pull_requests` |
| `reconcile_installations` | `GET /app/installations` | `github_installations` state flags **and stale logins**, and the rolling purge of `job_runs` |
| `sync_repositories` | `GET /repositories/{id}` | `github_repositories` (current name, popularity, `gone_at`) and `github_repository_renames` |

Every call about a repository or a pull request carries an **id**, never a name: a transfer does
not always leave a redirect, and by name a move is indistinguishable from a deletion. Which
repository a contribution belongs to is likewise a local key, `repository_id`; see
[database.md](./database.md#why-repositories-have-a-table-of-their-own).

Each job runs in a Bree worker thread and posts a structured summary back to the parent, so a
failed run is distinguishable from a successful one.

### Which token each call goes out with

`reconcile_installations` reads as the **app itself** (a JWT): `GET /app/installations` is an
app-level route. The sync and the poll read as **the person's own installation**. A user's sync
mints one installation token and uses it for the feed and every hydration after it.

`sync_repositories` has nobody to be, so its claim **borrows** one installation for the whole
batch: the oldest enrolled row (`ORDER BY gi.id LIMIT 1`) that has an `installation_id`, is not
suspended or deleted, and is verified. Consequences:

- Every repository refresh in a run spends **one arbitrary employee's** installation budget, and
  which employee is re-evaluated on every claim, silently.
- With **no** such row the job makes no request: it marks every claimed row failed with
  `no active installation to read with`. That failure carries no HTTP status, so
  `REPO_GONE_AFTER_404` never fires and the queue churns. An app JWT cannot stand in:
  `GET /repositories/{id}` answers `401` to one.

### What is actually in the poll queue

`claimPullRequestsForPoll` takes a row only if its `state` is not `closed`, its `origin` is
`'github'` (a hand-entered contribution has nothing to read), **and its author is still an
enrolled installation**: the claim joins `pr.opened_by = gi.user_login` and requires that row to
be verified, not suspended, not deleted, and to carry an `installation_id`.

So an open pull request **silently leaves the queue** when its author is suspended, uninstalls or
loses verification: no failure, no counter. The dashboard repeats the same predicate, so it never
draws a backlog no run will drain. `sync_disabled_at` is deliberately *not* in it: a user this
application retired (see [Giving up](#giving-up)) keeps having their open pull requests polled.

The join is on a **name**. A GitHub login rename would evict that user's open pull requests for
good, since only a poll rewrites `opened_by` and the rename stops the poll matching.
`refreshStaleLogins` patches that in the same transaction as the login rewrite
(`UPDATE github_pull_requests SET opened_by = <new> WHERE opened_by = <old>`). It is a stop-gap:
it misfires if another enrolled contributor has since taken the freed login. The real fix is an
`opened_by_user_id` column joined on `github_installations.user_id`.

### What the events feed is narrowed to

Two filters decide what is *read*; a third decides only what is *measured*.

1. **Not the contributor's own namespace**: events whose `repo.name` starts with
   `<actor login>/` are personal projects. The company's own organisations are **not** excluded:
   `OWN_GITHUB_ORGS` is never applied at collection, only to split figures afterwards.
2. **`PullRequestEvent` and `PushEvent` only.** Every other type (issues, comments, reviews,
   forks, stars…) is dropped with **no counter**. A busy account whose activity is issues and
   reviews therefore reports `changed=0 … prs=0 pushes=0`, which is not evidence of a stuck job.
   The `skipped` counter counts neither filter: it counts events that *threw*.
3. **Pull requests the person opened themselves**, for `github_pull_requests` only. The feed lists
   what somebody *did*, and a maintainer's feed is full of `labeled`, `closed` or `merged` actions
   on other people's pull requests. The envelope carries no author, so `isOwnPullRequest` asks the
   hydration response.

`github_pull_request_events` keeps **every** event with its full snapshot, whoever opened the pull
request. It is the archive, kept against the day reviews or merges become a figure, and it is what
stops a hydration being paid twice: `hydrated` is read off `title IS NOT NULL` on the ledger row.
Without the third filter, a maintainer of a busy project would collect every contributor's pull
requests as their own; on production data, 491 of 1,144 stored pull requests were.

### And what the report is narrowed to

One predicate, `user_type = 'User'` (`BY_A_PERSON`, shared by `src/db/contributions.js` and
`src/db/dashboard.js`): `user_type` is GitHub's word for the account that opened the pull request,
frozen at hydration, and `Bot` covers Dependabot, Renovate and the rest. It applies to the report,
the accounts table and the detection latency. Two reads are outside it on
purpose:

- `getContributionTotals` counts exactly what it drops: the pull requests a bot opened, and how
  many were merged, stated in the dashboard's footnote.
- The queue reads: `POLLABLE` already requires an enrolled author, and no bot has an installation.

The bot rows stay in the table: what a bot opened and a person merged is real maintenance work.
`merged_by` is stored and read by nothing here; both privacy guards ban it from the read modules.

### Reconciliation, pass by pass

One paginated `GET /app/installations`, then four passes, in this order:

1. **State.** `reconcileInstallationStates` rewrites `installation_suspended` from what GitHub
   reports and forces `installation_deleted = false` where either disagrees. A corrected row that
   is not suspended also becomes due now.
2. **Logins.** `refreshStaleLogins`, *before* deletions, so a row is judged on its current login.
   It also lifts a retirement whose reason was `account gone`, zeroes `sync_error_count` and makes
   the row due now.
3. **Deletions.** `markMissingInstallationsDeleted` flags every row whose installation id is absent
   from the live list.
4. **Purge.** `purgeJobRuns(JOB_RUN_RETENTION_DAYS)`, here because this run is infrequent. A
   failed purge warns and never fails the reconciliation.

If `GET /app/installations` comes back **empty**, the reconciliation is abandoned before pass 1 and
reports `skipped`: a GitHub hiccup must never read as "everybody uninstalled". The guard is
repeated inside `markMissingInstallationsDeleted`. Installations GitHub reports that the database
does not know are only **counted** (`unknown`), never created: they are people who never finished
enrollment.

### Why polling and not webhooks

The contributions that matter are to repositories **the employee does not own**, so the
installation has no access to them and GitHub sends no `pull_request` or `push` webhook for them.
The public events feed is the only path, and `src/app.js` subscribes to installation lifecycle
events only.

### Adaptive interval

Cron expressions only say how often the scheduler *wakes up*. Which subjects run is decided by
`next_sync_at`, `next_poll_at` and `next_refresh_at` in the database.

Something new: the interval drops back to the floor. Nothing new: it doubles, up to the ceiling.

| Subject | Floor / ceiling | "Something new" means |
| --- | --- | --- |
| `sync_contributions` (`next_sync_at`) | `SYNC_MIN_INTERVAL_MINUTES` (15 min) / `SYNC_MAX_INTERVAL_MINUTES` (4 h) | a ledger row was **inserted** this run. A `200` whose events are all known doubles the interval |
| `poll_non_closed_pull_requests` (`next_poll_at`) | `POLL_MIN_INTERVAL_MINUTES` (15 min) / `POLL_MAX_INTERVAL_MINUTES` (4 h) | `state` differs from the stored one. Commits, reviews and comments do not count |

The poll's floor is close to unreachable: the only state an open pull request can move to is
`closed`, which also takes it out of the queue. So the 4 h **ceiling** is the real detection
latency for a merge.

An active contributor gets 15-minute freshness; a dormant one settles at the ceiling, the
worst-case delay before a contribution is noticed. The ceiling must stay far below GitHub's
~90-day public events window, the only hard correctness deadline in the system.

The repository refresh does not climb this ladder: it is fixed at `REPO_REFRESH_INTERVAL_MINUTES`
(6 h), for the reason in [database.md](./database.md#why-repositories-have-a-table-of-their-own).
Its `changed` counter is star-count movement for the run summary and has no scheduling effect.

What the doubling saves is *not* GitHub quota (a `304` costs none) but what a `304` does not
cover: an installation-token mint, ~0.5 s of worker time and two writes per subject.

### Dispersion

Per-subject due times *allow* a smooth load; they do not produce one. A population that becomes
due together stays together, because the doubling is deterministic and the scheduler claims
**everything** due on a tick, destroying any spread smaller than a tick. Groups can merge; nothing
splits one. In production, 72 of 73 installations once fell due inside the same five minutes.

Every due time is therefore dispersed on write, on the success path *and* on the failure path: an
outage fails every subject in the same run, and an undispersed backoff would send them all back at
once onto a dependency that has just proved it is struggling.

The spread is a half-width (a due time lands in `interval ± spread`), bounded three ways:

| Bound | Why |
| --- | --- |
| at least **two ticks** | a spread below one tick moves nobody |
| at most **half the interval** | the interval ceiling is the freshness guarantee; a dispersion able to double a delay would move it |
| otherwise **10% of the interval** | enough on its own once the interval is large |

The half-interval cap wins over the two-tick floor, so a cron slower than half the interval floor
gets almost no spread. Keep `EVENTS_CRON` the faster of the two: the defaults (5-minute tick,
15-minute floor) give a three-tick window. Nothing enforces it.

The tick is **derived from the cron expression** (`runsPerHour`), never configured: a separate
setting would be a second knob to keep aligned with the cron.

> Priming a queue means **dispersing** it, not aligning it. Anything that seeds due times in bulk
> should spread them over one interval, never set them all to the same instant.

### Giving up

Backoff bounds the cost of a broken subject; it does not end it. A row that can never succeed,
most often an account deleted when its owner left the company, would retry at the ceiling forever.

The verdict reads the **HTTP status**, because the two failures that matter are opposite in kind:

| Failure | What it proves | Acted on after |
| --- | --- | --- |
| `404` on the events feed | that login does not exist | `SYNC_DISABLE_AFTER_404` (3) **in an unbroken run** (`sync_404_count`) |
| anything else | GitHub is having a bad hour | `SYNC_DISABLE_AFTER_FAILURES` (50) |

The 404 run is broken by any other outcome: a timeout between two 404s says nothing about whether
the account exists, so an outage with the odd 404 in it never adds up to "account gone". A `404`
from **minting the installation token** is about the installation, not the account, and never
counts as one; the same rule keeps the poll from reading it as "pull request gone".

The row is kept and only leaves the queue, through `sync_disabled_at`. That column exists because
`installation_suspended` and `installation_deleted` mean "GitHub told us this" and are rewritten
hourly by `reconcile_installations`: a verdict written into either would be reverted within the
hour, and the row made due now, promoting the broken row to the *front* of the queue.

Two things lift a *user's* retirement, and nothing else does:

- **Signing in again**: the person answering for themselves outranks a failing feed.
- **A rename found by the reconciliation.** A renamed login `404`s exactly like a deleted account.
  The reconciliation already holds `account.login` for every live installation, so it repairs the
  login at no cost; because it does, being wrong about a `404` is temporary, which is what lets the
  threshold be three.

A **repository** retires through `gone_at`, after `REPO_GONE_AFTER_404` (three) `404`s or `410`s in
an unbroken run (`refresh_404_count`), token-mint failures excluded:
the request carries the repository's **id**, which survives renames and transfers, so a `404` is
about the repository itself. Nothing clears `gone_at`; a repository that comes back needs a
hand-written `UPDATE`.

A **pull request** never retires. A `404` or `410` on the poll is not recorded as a failure: the
poll skips the upsert and takes the success path, with the interval set to the
`POLL_MAX_INTERVAL_MINUTES` ceiling. A deleted or privatised pull request is therefore re-polled
about every 4 h forever, counted as `gone=N` in every run report, and looks healthy in the
database. Neither the author's `sync_disabled_at` nor the repository's `gone_at` stops it.

### Conditional requests

The events feed is fetched with `If-None-Match` on page 1 only: the feed is newest-first, so an
unchanged head proves nothing new happened, and **a `304` costs no rate limit**.

That ETag is the **only** incrementality the sync has. Anything but a `304` re-reads the feed
window from the head, up to 300 events, with no watermark: `last_synced_at` is not a cursor. Each
kept event costs a no-op repository upsert and a no-op `ON CONFLICT (event_id) DO NOTHING` insert
in steady state, and what those return is what suppresses the expensive hydration call. An event
is skipped only when already known **and** hydrated, so a snapshot left NULL by a failed fetch is
retried. Size batches against that floor.

The ETag trick works for `GET /users/{u}/events`, whose ETag is stable across tokens, but **not**
for a pull request, whose ETag changes with every installation token; the poll is bounded by
scheduling instead. `GET /repositories/{id}` does answer `304`.

### The 300-event horizon

GitHub serves at most **300 public events** per user and answers `422` for page 4, so three pages
of 100 is GitHub's limit, not a loose choice. A `422` beyond page 1 keeps the pages already read.

Anything older than those 300 events is unreachable. A full feed is normal for an active account;
something was actually lost only when the oldest event served is **newer than the last successful
sync**, and that alone produces a warning. A first sync cannot know how much history predates the
window, and says so once.

### Claiming

A single `UPDATE … SET <subject>_claimed_at = now() WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
RETURNING …`, never a `SELECT` followed by an `UPDATE`. One column per queue: `sync_claimed_at`,
`poll_claimed_at`, `refresh_claimed_at`.

- **Instances partition the work** instead of duplicating it: no coordination, leader election or
  lock service.
- **A claim is a lease, not a flag.** A worker that dies leaves it set, and the row returns to the
  queue once `CLAIM_LEASE_MINUTES` elapses.
- **Due times are committed per subject**, not per batch, so a run killed halfway keeps its
  progress.
- **Batches are bounded** (`SYNC_BATCH_SIZE`, `POLL_BATCH_SIZE`, `REPO_BATCH_SIZE`), and Bree
  refuses to start a job that is already running.
- **Subjects are processed one at a time** within a run: no concurrency, no per-subject timeout. A
  run's wall time is batch size × per-subject latency (~0.5 s), and it must fit under
  `closeWorkerAfterMs`: 4 min for the three collectors, 9 min for the reconciliation. That, not the
  5-minute tick, is the ceiling to size a batch against. What a killed worker looks like is in
  [logging.md](./logging.md).
- **Each worker has its own database pool**, capped at 2 connections, against 10 for the main
  thread. One instance presents 10 plus 2 per running job to PostgreSQL, and scaling out
  multiplies it.

### Failure

Every subject is isolated: a deleted fork or a repository turned private is logged and skipped,
never allowed to abort the batch. A failing subject retries after `MIN × 2^n`, clamped at
`MAX_ERROR_BACKOFF_MINUTES`, where n counts the consecutive failures **including this one**: at the
default 15-minute floors the ladder is 30 / 60 / 120 / 240 / 360 min.

The repository refresh passes `REPO_REFRESH_INTERVAL_MINUTES` as its floor, which at the defaults
equals `MAX_ERROR_BACKOFF_MINUTES` (6 h): a failing repository retries on the same flat 6 h cadence
as a healthy one, and its third `404` lands about 18 h after the last good refresh.

## Data

Seven PostgreSQL tables: the enrolled installations, the pull requests (**the product**, read by
downstream consumers), the two event ledgers, the repository registry and its renames, and
`job_runs`. `init.sql` is the whole schema; see [database.md](./database.md#tables).

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /api/github/webhooks` | Webhook receiver. Bodies over 1 MiB answer `413`, and a request still arriving after 30 s is cut within 60 s (`server.requestTimeout`, on every route and checked every 30 s, Node's default being 300 s): sized for installation events, far below GitHub's 25 MB cap, since every anonymous caller gets that much buffered (the reasoning is at `WEBHOOK_BODY_LIMIT` in `src/services/webhookGuard.js`). The signature is checked against `WEBHOOK_SECRET` before Probot reads the delivery: a mismatch answers `400` with one `warn` line. Probot verifies again. Probot is mounted on this exact route, behind that check, and nowhere else: a spelling Express does not route here, such as a doubled trailing slash or a `.` segment, answers `404` without reaching Probot |
| `GET /` | Answers `🤖`, so a load balancer's root probe has something to hit |
| `GET /callback` | OAuth callback: performs the enrollment, then redirects |
| `GET /enroll` | Renders the enrollment outcome (`?reason=`). Side-effect free, refreshable |
| `GET /health` | `status`, `database` and `timestamp`, nothing else. `503` when the database is unreachable |
| `GET /ping` | Cheap liveness probe, no database access |
| `GET /version` | Name, package version, `APP_REVISION`, and the Node version actually running |
| `GET /dashboard` | The dashboard: Me and Overall for every enrolled reader, Operations for the operator tier ([dashboard.md](./dashboard.md)). Not registered while `SESSION_SECRET` is unset |
| `GET /dashboard/data` | The snapshot as JSON, same gate. For an operator, the Operations payload, polled every 5 s while that tab shows |
| `GET /dashboard/contributions` | The contribution report as JSON, same gate. Cached for a minute, with one build in flight |
| `GET /dashboard/assets/:name` | The page's stylesheets and scripts, same gate, from an allow-list in `src/services/dashboardAssets.js`. The Operations files answer 404 without the operator tier. Under `/dashboard/` so the `Path=/dashboard` session cookie reaches them |
| `GET /dashboard/mine` | The reader's own contributions as JSON, for the login stored on the reader's enrolled row. Same gate, no tier |
| `GET /dashboard/manual` | Contributions recorded by hand, as JSON. Operator tier; 404 to anyone else |
| `POST /dashboard/manual/lookup` | Reads one pasted pull or merge request address and answers what is behind it: GitHub through the operator's installation, GitLab only on a host in `GITLAB_API_HOSTS`. Writes nothing. Operator tier |
| `POST /dashboard/manual` | Records one merged contribution, fetching it again rather than trusting the payload. Operator tier |
| `DELETE /dashboard/manual/:id` | Removes one. Scoped to `origin = 'manual'`, so it cannot reach a collected contribution. Operator tier |
| `GET /dashboard/login`, `GET /dashboard/callback`, `GET /dashboard/logout` | The dashboard's sign-in. A **second** OAuth callback, registered separately on the App, throttled like `/callback` |
| `POST /dashboard/users/:userId/sync` | Makes one account due now. Operator tier |

Every dashboard route that is not a `GET` must come from the dashboard itself
(`Sec-Fetch-Site: same-origin`, or an `Origin` naming this host), or it answers `403` before any
session is read: a second line behind the `SameSite=Lax` cookie.

There is deliberately no unauthenticated route that names a subject or counts anything: the
backlog, the schedule and the enrollment figures are on the dashboard's Operations tab.

Every response carries `X-Content-Type-Options: nosniff` and no `X-Powered-By`; in production,
`Strict-Transport-Security: max-age=31536000` too (not locally, where it would pin your browser to
an https `localhost` does not serve). The two rendered pages add their own Content Security
Policy and `X-Frame-Options: DENY`.

## Observability

`GET /health` answers what a load balancer needs: is the process up, and can it reach the
database. It is public, so it says nothing more.

"The process is up" is not "the work is getting done". That question is the Operations tab's: the
backlog (a due count that only grows means something is stuck) and the run **history**, which tells
a job that is idle from one that stopped running. See [dashboard.md](./dashboard.md#operations).

`GET /version` echoes `APP_REVISION`, the only way to know what is running when a deployment is a
zip push.
