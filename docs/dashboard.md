# Dashboard

`GET /dashboard`, in three tabs: **Me**, what has been recorded under the reader's own login;
**Overall**, the contribution report the collection exists for; and **Operations**, what the
machine is doing right now, for the operator tier only.

## Turning it on

1. Set `SESSION_SECRET` to a key of at least 32 characters: `openssl rand -hex 32`. While it is
   unset the routes are not registered at all, and `/dashboard` answers 404.
2. Register `https://<your-host>/dashboard/callback` as a **second callback URL** on the GitHub
   App. [`app.yml`](../app.yml) lists it; an existing App needs it added by hand. GitHub refuses an
   unregistered `redirect_uri`, and the failure reads as "the app is broken".
3. Optionally, list the operators in `DASHBOARD_ALLOWED_LOGINS`.

All three settings are in [configuration.md](./configuration.md#dashboard).

## Who can read it

Two checks, both on **every request**:

1. **GitHub OAuth** establishes which GitHub account is asking, by its numeric id. Nothing else
   identifies the caller: no shared link, no token in a URL.
2. **The database** decides whether they get in, on the enrolled row with that account id:

```
verified_at IS NOT NULL
AND installation_deleted   = false
AND installation_suspended = false
```

That is: *this GitHub account proved it holds a verified address on one of
`ALLOWED_EMAIL_DOMAINS`*. Not "has installed the app": the app is public, and installing proves
nothing. The population that may read the page is the population being measured.

### Two tiers

| | Who | Tabs |
| --- | --- | --- |
| **reader** (default) | any enrolled user | **Me** and **Overall** |
| **operator** | the logins in `DASHBOARD_ALLOWED_LOGINS` | the same two, then **Operations** |

The line is **operational detail, not identity**. A pull request is public on github.com, and the
people who opened it are who the page celebrates; an enrollment address, a retirement reason, a
queue of named subjects or a raw GitHub error are not. So everything operational is on the
Operations tab, and that tab is the operator's.

For a reader the tab is **absent, not hidden**: the template is not rendered, the snapshot has no
`ops` key, the tab's script and stylesheet answer `404`, and every route behind it answers `404`
before reading anything. Unset means **nobody** is an operator: a setting that fails to arrive
degrades the page for a handful of people instead of publishing addresses to everyone.

The decision is made **once, on the server**, in `getSnapshot()`. A reader's snapshot is built by
**picking** fields (`readerSnapshot()`), so a field added to the operational half later is
withheld by default.

### Why the cookie carries an account id and never a permission

The session says *who*, not *what they may do*: it holds the GitHub account id and an expiry. Every
request re-reads the database, so an uninstall or a suspension closes the door on the next click
rather than at the end of an eight-hour session.

An id, never a login, because a login is released when its owner renames and whoever registers it
next would otherwise inherit the previous owner's session and enrollment. The login the rest of the
page uses, for the Me tab and for the operator tier, is the one stored on the enrolled row, looked up
from the id on each request. So:

- An operator who renames on GitHub keeps the tier only once `DASHBOARD_ALLOWED_LOGINS` names the
  new login. The list is read when the process starts: a change takes effect on restart.
- A session issued by an earlier version, which held a login, reads as no session: its holder signs
  in once more.

### The four answers

| Situation | Answer |
| --- | --- |
| No session, a browser navigating | `303` into the OAuth flow |
| No session, a request sending `Accept: application/json` | `401 {"error":"sign-in required"}`. A `303` would send the page's fetch to github.com, a cross-origin hop it cannot follow. The page stops its loops and offers to sign in again |
| Session, allowed | the page |
| Session, refused | `404 Not found.`, the same answer as a route that does not exist |

A `403` would confirm the page exists to somebody who is not on the list. Every refusal is logged
at `warn` with the login and the reason, so an operator refused by mistake can find out why.

> The route's *existence* is discoverable: `GET /dashboard` visibly redirects to a sign-in. Its
> *content* is not.

### The mechanics, and why each piece is there

| Piece | Why |
| --- | --- |
| `state` nonce, signed, 10-minute cookie | **We** initiate this redirect, so a nonce is possible here, unlike `/callback`. Without it, an attacker's authorization code delivered to your browser would pair your session with their account. Cleared on every callback outcome, refused and failed included, so it can never be replayed |
| Callback throttled | `GET /dashboard/callback` shares the 20-a-minute budget of `/callback`: both spend the App's client secret on a caller-supplied code |
| Same-origin writes | Every non-`GET` route answers `403` unless `Sec-Fetch-Site: same-origin` or an `Origin` naming this host says the request came from the page: a second line behind `SameSite=Lax` |
| `SameSite=Lax` | The callback is a top-level GET navigation from `github.com`; `Strict` would withhold the cookie on exactly that request and the nonce check would always fail |
| `HttpOnly`, `Path=/dashboard` | Not readable by script, and never sent to the webhook endpoint or the enrollment flow |
| `Secure` in production only | A `Secure` cookie is never sent over http, which would break `http://localhost:3000` |
| Signed, expiring payload (8 h) | The expiry is inside the signed blob, so editing the cookie to extend it breaks the signature |
| Constant-time signature compare | `===` leaks how many leading characters matched |
| The OAuth token is discarded | Used once, for `GET /user`; never stored |
| Headers | The page's own Content Security Policy, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`, on top of what every response carries: `nosniff`, no `X-Powered-By`, and HSTS in production |
| `SESSION_SECRET` is its own key | Rotating it must not break webhook verification, and leaking it must not leak an App credential |
| `trust proxy` in production | Behind a front end that terminates TLS and forwards over http, `req.protocol` would read `http` and the `redirect_uri` would stop matching the registered one. Trusts exactly one hop |

## Where it opens

An operator opens on **Operations**. Anyone else opens on **Me** if at least one pull request is
recorded under their login, and on **Overall** otherwise, so a manager who never contributed does
not land on an empty tab.

The address wins when it names a tab this reader has: `#mine`, `#collective`, `#ops`. Anything else
falls back to where the server opened the page. Switching tabs rewrites the hash with
`replaceState`, so a reload or a shared link opens the same tab and Back leaves the page.

Above the tabs, every reader sees their own avatar, login, merged count, rank and open count, drawn
from their own rows.

## Conventions every tab follows

Each tab is **four tiles**, then its **panels**: curves first, then the bars that divide a whole,
then the lists. Each panel carries one subtitle line, its base, unit or window; what a figure means
is the footnote's to say, once. `test/dashboard-page.test.js` holds every tab to this.

- **Every figure carries its base, and every rank its window**: *736 of 858 judged*, *4th of 41 ·
  since day one*.
- **Colour is never alone.** An outcome is a shape and a word (circle merged, square open, triangle
  closed); scope is a glyph (the company logo for ours, a globe for elsewhere) and a hue; a dashed
  line is merged, a solid one opened.
- **A person is a face and a login.** Avatars are loaded by the reader's browser from
  `avatars.githubusercontent.com`, lazily, with no referrer: the one resource the page loads from
  outside.
- **Nothing is ever a flat zero.** Every tile, chart and list has an empty state saying what will
  fill it; a tab still loading is busy (`aria-busy`), never empty.
- **English only**, one format per kind: *Sep 14, 2026*, *3 d 2 h*, *2,840*. Months and days are
  cut in UTC.

## Me

What has been recorded under the reader's own login: the only answer that differs per reader,
for the login stored on the reader's enrolled row, with nothing in the path to point at anybody
else.

| Tile | Value | Base | Sub-line |
| --- | --- | --- | --- |
| **Merged** | merged | of *n* judged | the merge rate |
| **Awaiting a verdict** | still open | | how long the oldest has been open |
| **Time to merge** | the reader's median | *n* merged | p90 · everyone's median |
| **Rank** | *4th* | of *N* | since day one · this month |

The rank is a **competition rank**: since day one on pull requests merged, among the logins with at
least one; this month on pull requests opened. There is no rank before a first merge.

- **How it added up**: running totals of opened and merged by month, drawn as steps. A running
  total is never empty after the first contribution, where a per-month chart would be one bar for
  most people. Months older than 24 are folded into the start.
- **Outcome and scope**: merged, open and closed with their rates over what was judged; ours and
  elsewhere, each with its number of repositories.
- **Every one of them**: every row, newest first, filterable by state and scope, groupable by
  repository, ten to a page; a hand-recorded one carries a `manual` chip.

The tiles, the chart, the bars and the list all come from **one list**, so they cannot disagree.

An empty tab says **"No pull request is recorded under *login*."**, not "you have not contributed":
`opened_by` is a login. A rename the bot sees (the reconciliation, a reinstall or a
re-enrollment) moves the history to the new one, but a rename it never saw, or one whose old login
is still on record for somebody else, leaves it under the old name.

## Overall

The contribution report: what everybody enrolled opened, and what became of it. Nothing in it
depends on who reads it, except two marks the page adds from the reader's own rows.

| Tile | Value | Base | Sub-line |
| --- | --- | --- | --- |
| **Merged** | merged | of *n* judged | the merge rate · people only |
| **Contributors** | logins that opened a pull request this month | in *Sep* | *n* first-time · *n* accounts installed |
| **Time to merge** | the median | | p90 |
| **Projects** | repositories touched | | *n* ours · *n* elsewhere |

- **Who is contributing**: over the last eight months, people who opened a pull request and pull
  requests merged, with this month's first-time contributors (a login whose first recorded pull
  request was opened that month).
- **Month by month**: ours opened, ours merged, elsewhere opened, elsewhere merged, each counted on
  its own date, so the gap between a dashed line and its solid one is how long acceptance takes.
- **Outcome by scope**: merged, open and closed, for ours and for elsewhere.
- **Time to merge and size**: merged pull requests by time to merge and by commit count. A
  hand-recorded contribution may lack a date or a commit count; each base says how many could be
  measured.
- **Awaiting a verdict**: everything still open, by age, then the ten oldest. A pull request whose
  author is suspended, uninstalled or renamed without the bot following the rename is never polled
  again; it is counted as *no longer polled*.
- **The biggest ones we got into**: the three most-starred projects outside ours with a merged
  pull request, and who got one in. Merged only, and never ours.
- **Most contributed projects**: the top six on merged pull requests, with their outcomes; the
  reader's own are marked.
- **This month's contributors**: the top four of the month on pull requests opened.

Every figure counts what a **person** opened (`user_type = 'User'`); how many a bot opened is the
footnote's. `OWN_GITHUB_ORGS` splits the report into ours and elsewhere, because contributing to a
repository the company owns and contributing to the wider ecosystem are different claims.

Served by `GET /dashboard/contributions`, built at most once a minute (`REPORT_TTL_MS`) with one
build in flight, because it is ten reads of the pull request table for figures that move every few
minutes. The standings the ranks are cut from stay on the server, so the report names only the
people it shows.

## Operations

The operator tier only.

| Tile | Value | Base | Sub-line |
| --- | --- | --- | --- |
| **Overdue subjects** | overdue | of *n* tracked | *n* on the floor tier |
| **Oldest lateness** | how long the first overdue subject has been due | | the subject · its tier |
| **Claimed now** | subjects under a live lease | | age of the oldest claim |
| **Failing jobs** | failing jobs | of *n* | their names |

*Tracked* is what the two claims consider: every syncable installation and every pollable pull
request. Each is in exactly one state, decided in this order: **claimed** while a worker holds its
lease, **overdue** once it fell due before the last tick of its queue's cron, **in backoff** after a
failure, **on schedule** otherwise. The four add up to what is tracked.

- **The jobs**: one card per job, with its state, cron, last and next run, its last 48 runs as bars
  (height is duration, colour is outcome, **a hairline is a run that never happened**) and its last
  24 hours in figures. A job is **failing** if its last run that did something failed, *or claimed
  subjects and failed every one of them*: the run reports `ok` and nothing was collected. A failing
  card shows the run's error, else its last failed subject's.
- **The queue**: every subject at the head of its queue drifting toward a `NOW` line, in two lanes
  (installations to sync, pull requests to poll), on the doubling ladder of the adaptive interval
  (`QUEUE_EDGES_MINUTES`, derived from the scheduling settings). The first 300 of each queue are
  drawn (`TRACK_SUBJECTS`). Hovering a subject gives its due time, interval, lease, failures in a
  row and last error. Folded under it: the next 12 subjects, in the order they will be claimed.
- **Capacity and backlog**: the tracked subjects as one bar, by state.
- **Detection latency**: `state_changed_at - merged_at`, the forge's clock against ours, one dot per
  merge over 30 days, under the window's p50 and p90 as level lines once each has its sample. A
  figure per day would be a gap on most days at a merge or two a day. Pull requests first recorded
  already merged have nothing to measure and are left out.
- **Recent runs**: the last hundred runs that were not idle, with their counters verbatim and their
  error. Interleaving the jobs shows whether one stopped or all did.
- **Enrolled accounts**: every account with its address, state, how long it has been in that state,
  enrollment date, pull requests, merges and last sync; searchable, filterable by state
  (`installed`, `pending`, `suspended`, `uninstalled`, `disabled`), sortable. An account that
  uninstalled before `installation_deleted_at` existed has no date and never will: GitHub reports no
  removal time.
- **Record a contribution** and **Recorded by hand**: see
  [below](#recording-a-contribution-by-hand).
- **What the bot has recorded**: every table counted whole, **bots and every owner included**, which
  is what sets it apart from every figure about people.
- **Settings**: what this process was started with (what counts as ours, the crons, the pacing),
  read from the constants the jobs use. Never a secret.

### One number, one meaning

"Tracked" and "overdue" count only what a claim would take: the queue reads repeat the claims' own
predicates, `SYNCABLE` and `POLLABLE`. An open pull request whose author is no longer enrolled is
past its poll time forever and drained never, so counting it would draw a backlog no run will
drain.

### Reading it right

- **The jobs are *this process*.** On a second instance the page sees only its own workers.
  `job_runs` is in the database and therefore global.
- **A flat sparkline with gaps** means the scheduler is not ticking: worse than a red bar.
- **A ring that outlasts a run** is a worker that died mid-run. The lease expires
  (`CLAIM_LEASE_MINUTES`) and the next run takes the subject again.
- **A red token** is in error backoff: queued because something failed, not because its turn came.
- **The track starts 30 minutes in the past.** Anything older is held at the left edge, so a deep
  backlog reads as a wall; the lane's *due* says how many.
- **Overdue is not lateness.** A subject becomes overdue one tick after it falls due.
- **Detection latency counts only observed transitions**: rows first seen already merged are left
  out rather than counted as instant, which would flatter the figure.

### Why a subject failed

`job_runs.failures` is a list per run, `[{subject, status, message}]`, capped at 20 entries; the
`failed` counter keeps the true total. It differs from `job_runs.error`, the failure of the **run**:
a run can report `ok` and still carry a full list of failures.

`github_installations.last_sync_error` and `github_pull_requests.last_poll_error` answer *what is
wrong with this row now*, cleared by the next success. They reach the queue's tooltip, which is the
operator's alone: a raw GitHub error quotes the subject it happened to.

## The footnote

*How these figures are computed*, under every tab, for both tiers, rendered by the server so any
figure can be checked against it.

| | |
| --- | --- |
| **Ours** | the owners in `OWN_GITHUB_ORGS`; every other repository is elsewhere |
| **Who can enroll** | a GitHub account with a verified address at `ALLOWED_EMAIL_DOMAINS` |
| **Merged** | pull requests a person opened that were merged, and how many a bot opened (and of those merged), left out |
| **Judged** | merged, plus closed without a merge; every rate is over judged |
| **Contributors** | logins that opened a pull request, counted once; what first-time means; what each rank is on |
| **Percentiles** | the thresholds below |
| **Dates** | months and days are cut in UTC |
| **History** | collection starts at each person's enrollment, so earlier months are incomplete |

When the report cannot be read the bot counts read *—*, never zero.

## Thresholds

A median needs **3** values, a p90 **10** and a p99 **100** (`PERCENTILE_MIN_SAMPLE` in
`src/utils/constants.js`, sent to the page in the snapshot). Below its threshold a figure reads *—*
beside its base, and a chart leaves a gap rather than drawing a zero.

## Keyboard, pointer and screen reader

- **Tabs** are a tablist: arrows move and wrap, Home and End jump, one stop in the tab order. An
  arrow with Alt, Ctrl or Cmd is left to the browser.
- **A chart** is a Chart.js canvas: one image to a screen reader, whose label states every value it
  draws. Its legend is text in the page. It fits its panel at every width.
- **The queue** is a canvas; the folded list under it gives the next twelve subjects as text.
- **Filter chips** are toggle buttons that say whether they are pressed; the match counter is a live
  region.
- **Lists longer than ten rows** are paged with *Previous* and *Next*, named and described by the
  range shown.
- **Every control** is at least 44 px tall and shows a focus ring.

## How it stays current

Only the tab showing is drawn, and each follows its own source:

| Tab | Reads | Cadence |
| --- | --- | --- |
| **Operations** | `GET /dashboard/data`, the snapshot with its `ops` half | every 5 s while it shows, and at once when shown |
| **Me** | `GET /dashboard/mine` | again once the report's one-minute window is over |
| **Overall** | `GET /dashboard/contributions`, and `GET /dashboard/mine` for the reader's marks | the same |

The document opens with the first snapshot and the reader's own rows embedded as JSON islands, so it
never opens empty. Filters, grouping, page and sort survive every refresh, and a refresh that
changes nothing writes nothing to the page. With reduced motion asked for, nothing animates.

The header badge gives the age of the read behind the tab showing. A banner names a read that
failed, leaving the last good figures on screen. A `401` from anywhere stops every loop and turns
the banner into *Session expired*, with a link to sign in.

## What it can change

Three writes, all on the Operations tab, so all behind the operator tier and `404` to anyone else.

### Bringing a sync forward

`POST /dashboard/users/:userId/sync`, the **Force sync** button, sets one account's `next_sync_at`
to now and nothing else: the adaptive interval and the error count are untouched, so a forced run
that finds nothing settles straight back. It is offered only for `installed` accounts and refused
with `409` for any other: an account the claim excludes would sit at the head of a queue no run
drains.

It is safe on a page a browser holds a session for because:

- **It is a POST.** The `SameSite=Lax` cookie is withheld from a cross-site POST, and the
  same-origin check refuses a write the page did not send. That is the CSRF defence, and why it
  must never become a GET.
- **It is operator-only**, `404` to anyone else.
- **It leaves a trace**: one `info` line naming the operator and the account.

### Recording a contribution by hand

The only place that writes a contribution by hand. It exists for work the events feed never
offered: GitHub keeps 90 days per account and nothing from before somebody enrolled.

Paste the address of a pull or merge request:

- A **GitHub** pull request is fetched through the operator's own installation.
- A **GitLab** merge request is fetched from the instance's public API, without a token, only on a
  host in [`GITLAB_API_HOSTS`](./configuration.md#dashboard): the address comes from a human, and
  calling any host it names would let the form make the server fetch on somebody's behalf.
- Anything that cannot be read (a private project, an unreachable instance, a host not on the
  list) falls back to a typed form. That is not an error; it is why the form exists.

**The author is chosen from the enrolled**, never read from GitLab: a GitLab username is not a
GitHub login, and nothing joins the two. The GitLab username is shown as a hint, and nothing is
pre-selected unless it matches an enrolled login. An author who has never enrolled is **refused**.

Recording fetches **again** and writes from that, never from what the browser sends back: the
preview is a courtesy, this is the record. Forge data and typed fields are never mixed in one row.

**Merged work only.** An entry is a fact, not a thing to follow: `origin = 'manual'` keeps it out of
the poll queue, and a project on another forge has no `github_id`, which keeps it out of the
refresh queue. Nothing updates it afterwards, so its star count is whatever was recorded.
*Recorded by hand* lists every entry, each with a **remove** that reaches `origin = 'manual'` rows
only.

## The page's files

`views/dashboard.ejs` is the shell (header, tab bar, JSON islands) and includes one template per tab
the reader has (`views/dashboard/{mine,collective,ops}.ejs`) and the footnote. The browser code is
classic scripts in order: Chart.js, then `core.js` (the `Dash` namespace, formats and shared
components), each tab's script registering itself with `Dash.tab()`, and `main.js` last, which runs
the tab bar and the refresh loops. Stylesheets follow `/base.css`, shared with the enrollment page:
`core.css`, then one per tab, scoped to it.

All are served by `GET /dashboard/assets/:name`, behind the page's own gate, from the allow-list in
`src/services/dashboardAssets.js` (Chart.js straight from `node_modules`), never from the ungated
`public/` mount, which would publish the renderer and the route names in it. `ops.js` and `ops.css`
answer a reader like an unknown name. `Cache-Control: private, no-cache`, so a deploy is picked up
on the next load.

The page's Content Security Policy is its own: `script-src 'self'`, no inline script,
`form-action 'none'`. See `src/index.js`.

## Where the history comes from

`job_runs`, one row per run, written by the scheduler's report handler, fire and forget: telemetry
about a run must not change what the run reported. Purged on a rolling window
(`JOB_RUN_RETENTION_DAYS`, default 7) by `reconcile_installations`. Neither the recording nor the
purge can fail a job: a missing table costs the sparklines, not the collection, and the page says
so.
