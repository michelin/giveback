# Logging

The log is the only window into a process that runs unattended and talks to an API you do not
control. This document is the contract every log statement in `src/` and `jobs/` follows.

## The API

```js
import { getLogger, format, fields } from "../utils/logger.js";

const logger = getLogger("moduleName");
```

`getLogger` returns a plain pino instance. `format` and `fields` are named exports, never
properties of the logger: import them directly.

### `format` — how a thing is spelled in prose

One entity, one spelling, in the whole stream.

| Helper | Renders |
| --- | --- |
| `format.repo(owner, name)` | `octocat/hello` |
| `format.pr(number, repo)` | `octocat/hello#12`, or `pr #12` without a repository |
| `format.installation(id)` | `installation 12345` |
| `format.user(login)` | `user octocat` |
| `format.duration(ms)` | `842ms` / `8.4s` / `2.3min` / `72.0h` |
| `format.counts(obj)` | `claimed=4 changed=3 failed=0` — insertion order, zeros kept |
| `format.jobReport(name, summary)` | the job report line, see below |

`format.pr` uses GitHub's own notation on purpose: an operator can paste `octocat/hello#12`
straight into a browser.

### `fields` — the structured twin, always pino's **first** argument

```js
fields.repo(owner, name)   // { repo: 'octocat/hello' }
fields.pr(number, repo)    // { pr_number: 12, repo: 'octocat/hello' }
fields.installation(id)    // { installation_id: 12345 }
fields.user(login)         // { user: 'octocat' }
fields.job(name)           // { job: 'sync_contributions' }
```

The prose stays readable for a human; the fields make the same identifiers queryable. Following
one enrollment across five modules is `installation_id = 12345`, not a grep for a substring.

> The argument order is easy to get wrong and fails silently:
> `logger.error('msg', { obj })` **discards the object**. `logger.error({ obj }, 'msg')` does not.

## Levels

| Level | When |
| --- | --- |
| `fatal` | The process is about to stop doing work forever. Names the consequence, ends with ` - exiting`. Four sites only: env validation, scheduler start, `unhandledRejection`, `uncaughtException`. |
| `error` | A failure a human must act on that the app will **not** repair by itself. Logged **once**, by the layer that knows *why* the work was attempted, always with `{ err: error }`. **Never log an error you also rethrow.** |
| `warn` | An expected-but-notable condition the app handles itself. **Always states the automatic consequence** — `- skipping, the next scheduled run will resume`. |
| `info` | Facts an operator would miss if they were gone: the boot and shutdown narrative, each enrollment step of one user, each installation state transition, and one report per job run. |
| `debug` | Per-subject tracing: one line per installation, pull request, push or HTTP request. Bree's and smee-client's own `warn` and `error` land here. |
| `trace` | High-frequency and uninteresting: "already stored, skipping", pool open/close, and both libraries' `info`. **If a line can fire more than once per stored object, it is trace.** |

Everything that scales with the number of enrolled users is `debug` or below, with one
deliberate exception: `sync_contributions` writes one `info` per installation where something
*changed*. That line is the only positive evidence an operator has that contributions are being
collected, so it scales with activity rather than with the number of users — at a few thousand users and a
few percent active per tick, `info` stays in the low hundreds of lines an hour.

## Format: pretty or JSON

The two goals genuinely conflict. Structured fields are what make a log queryable, and
pino-pretty renders them as a multi-line block under every message.

`LOG_FORMAT` resolves it: **`json` in production** (one line per event, fields indexed by the log
platform) and **`pretty` otherwise** (a human at a terminal). Set it explicitly to override —
`LOG_FORMAT=json` locally is the fastest way to see exactly what production will emit.

## Grammar

1. **Lowercase start, no trailing period.** Environment variables, SQL relations and webhook
   names keep their real casing — `DB_PASSWORD`, `installation.created`, `NODE_ENV=production` —
   so they stay greppable.
2. **Past tense, outcomes not intentions.** A line is written *after* the operation it describes.
   The only exception is a deliberate start-of-run marker, which exists so a worker killed at
   `closeWorkerAfterMs` leaves evidence that it ran.
3. **No first person.** The subject is the entity acted on — `installation 12345 suspended`, not
   `handling the installation event`.
4. **Never put a raw enum into English prose.** `suspend|unsuspend|deleted` is mapped to
   `suspended|unsuspended|deleted` once, in `eventService.js`.
5. **Never write `installation`, `user` or `pr` next to a helper that already prints it** —
   `no installation found with ${format.installation(id)}` reads "no installation found with
   installation 123".
6. **Never begin an error with `error` or `failed to handle`.** The level already says it. Start
   with what could not be done: `enrollment failed for user octocat: Bad credentials`.
7. **Identifiers only through `format.*`.** No hand-built `${owner}/${name}`, no bare
   `${account.login}`.
8. **Counts** are `<number> <noun>(s)` — `3 job(s)`, `137 due pull request(s)`.
9. **An elapsed duration goes through `format.duration(ms)`** — every measured time, including
   a retry delay computed in seconds: `format.duration(retryInSeconds * 1000)`. A **configured
   interval already authored in whole minutes** does not: it stays `${n}min`, as in
   `next in ${intervalMinutes}min` and the scheduler's `claim lease ${CLAIM_LEASE_MINUTES}min`.
   Passing a setting through the helper would render `15min` as `15.0min` and a two-minute one
   as `2.0min`, which reads like a measurement of something rather than the number in the
   environment.
10. **Punctuation is load-bearing**, so lines split mechanically:
    - ` - ` separates a statement from its consequence or detail
    - `: ` introduces a raw cause — at most once per line, always at the end
    - `(...)` holds a parenthetical fact: a status code, `webhook`, `local development`
    - ` | ` appears only in the job report line
11. **Never interpolate a stack trace.** Stacks reach the log as `{ err: error }` only.
12. **Never print a secret or a capability**: no proxy URL with credentials, no smee channel URL
    at info, and never pg-promise's formatted query — it inlines parameter values, which here
    means enrollment email addresses and real names.
13. **Template literals, not printf.** No `%s` / `%d` placeholders.

## Error ownership

> **Log where you know why, throw where you know what.**

A layer that cannot say *why* the operation was attempted never calls `logger.error`. It enriches
the Error and rethrows, reading identifiers from the function **parameters** — the destructured
consts inside a `try` are block-scoped and unreachable from the `catch`:

```js
throw new Error(`could not record pending ${format.installation(installationId)} for ${account?.login}`, { cause });
```

A layer that knows why logs **once**, with `{ err: error }`, and does not rethrow: a job's
per-subject catch, a webhook handler, the OAuth callback, the Express error handler.

pino's serializer flattens the cause chain into `err.message`, so a single line carries all three
levels of context:

```
ERROR (eventService): could not handle installation.created for user octocat
  err: could not record pending installation 999 for octocat: invalid input syntax for type bigint: "not-a-bigint"
```

One SQL failure therefore produces exactly **two** lines, by design:

| Line | Level | Carries |
| --- | --- | --- |
| `src/db/index.js` — `query()` | `warn` | An outline of the statement and the PostgreSQL SQLSTATE, neither of which belongs in a business message. Not the PostgreSQL message itself — the caller's line below carries it |
| The caller | `error` | Why the work was attempted, plus the flattened cause chain |

The SQL line is `warn` rather than `error` so a single failure counts as one error for alerting.

Neither line ever carries `error.query`. pg-promise builds it by inlining the parameter values
client-side, so on a failed enrollment `INSERT` it holds the user's email address and real name.
`getLogger`'s `err` serializer strips it, and `params` with it — the guarantee is in one place
rather than in every call site's discipline. It strips `event` as well: `@octokit/webhooks`
attaches the whole delivery to every error it raises, which on a bad signature is a body any
anonymous caller chose. It applies to every error an `AggregateError` wraps, too.

## The job report

**One line per run.** Emitted by `workerMessageHandler` in `src/services/breeService.js` from the
object the worker posts — a job run under the scheduler never logs its own report. A job run *by
hand* does, since nobody is listening on `parentPort`.

```
<job> <ok|failed|idle|skipped> in <duration> - <counters k=v> [| <system state k=v>]
```

```
sync_contributions ok in 8.4s - claimed=4 changed=3 unchanged=1 failed=0 disabled=0 prs=12 others=5 pushes=7 repositories=5 skipped=1
poll_non_closed_pull_requests ok in 21.7s - claimed=137 changed=9 unchanged=124 gone=3 failed=1
reconcile_installations ok in 6.2s - live=812 corrected=2 renamed=0 deleted=1 unknown=14 purged=0 | active=780 pending=17 suspended=15 disabled=3 due=126
sync_contributions idle in 41ms - claimed=0 changed=0 unchanged=0 failed=0 disabled=0 prs=0 others=0 pushes=0 repositories=0 skipped=0
poll_non_closed_pull_requests failed in 2.1s - claimed=137 changed=4 unchanged=0 gone=0 failed=1: connection terminated unexpectedly
```

Rules a reviewer can check:

- The outcome word is one of four, derived from the summary: `failed` when `ok === false`,
  `skipped` when the job declined to run, `idle` when `claimed === 0`, otherwise `ok`.
- **Level follows the outcome, under the scheduler**: `info` when ok, `debug` when idle, `error`
  when failed. A crashed run must never read like a success.
- **A run by hand keeps its report at `info` even when idle** (`jobs/jobRun.js` picks
  `info`/`error` on `ok` alone). `LOG_LEVEL` defaults to `info`, so demoting an idle hand-run to
  `debug` would print nothing at all for it — and "one report line per run" is the rule this
  whole section exists to keep. The distinction is safe because the two paths have different
  audiences: the scheduler's idle lines are one per tick forever, a hand-run's is one, in front
  of the person who typed the command.
- Counter keys are the summary's keys verbatim, in declaration order, **zeros kept** — so the line
  has the same shape every run and `grep 'failed=[1-9]'` finds every bad run and nothing else.
- The ` | ` segment holds only counters describing the whole system rather than this run.
- A summary key whose value is not a number is not a counter and never reaches the line.
  `failures` is the list of subjects the run could not process; the line carries `failed=N`.
- **`failures` is reserved for that list**, in the summary, in `job_runs.failures` and in a log
  field alike. A *count* of consecutive failures is `consecutive_failures` — the field
  `jobs/sync_contributions.js` and `jobs/sync_repositories.js` attach to a per-subject error —
  so nothing has to guess whether `failures: 3` is three subjects or the third attempt. The
  line that retires a user counts what the verdict was decided on: `after 3 consecutive 404(s)`
  for an account gone, `after 50 consecutive failure(s)` otherwise.
- Every job posts `durationMs`, and `totals` lives **outside** `run()` so a run that throws still
  reports the progress it made.
- Bree's `"done"` sentinel produces no line at all.

## Third-party loggers

Bree and smee-client are handed a **wrapped** logger, never the pino instance. Two reasons:

1. Their signature is `(message, metadata)`, the opposite of pino's `(mergingObject, message)`.
   Handing Bree the raw instance meant its `warn(new Error(...), metadata)` rendered a line with
   **no message at all**.
2. Their chatter — `Worker for job "x" online`, `Connected to <url>`, `exited with code 0` — is
   the library talking about itself, and written in a different editorial style from ours. Every
   level is demoted: their `info` to `trace`, so `LOG_LEVEL=debug` stays usable for tracing
   actual subjects, and their `warn` and `error` to `debug`.

**Probot** is handed the app's own logger (`getLogger("probot")`), so its lines follow
`LOG_LEVEL` and `LOG_FORMAT` like ours and go through the same `err` serializer. Left to itself,
Probot would build its own logger, defaulting to `warn`, without that serializer.

**The webhook guard** (`src/services/webhookGuard.js`) writes one `warn` line per delivery it
refuses for a bad signature, naming only the delivery id and the event name, never the body:

```
WARN (webhookGuard): webhook delivery refused - its signature does not match WEBHOOK_SECRET, answering 400
```

Either somebody is probing the URL, or `WEBHOOK_SECRET` differs from the App's: the delivery id
finds it on the App's *Advanced* page. A body refused for its size is not logged; the request line
at `debug` records the `413`.

**The last-resort Express error handler** (end of `src/index.js`) writes one `error` line, with
the stack, for a failure nobody else handled, and answers `500`. A request refused for what the
client sent is not such a failure: a 4xx `http-errors` marks `expose` (JSON the dashboard's parser
cannot parse, `400`; a body over 16 kb, `413`; a compressed one, `415`; an asset's failed
precondition or unsatisfiable range, `412` or `416`) is answered with that status and a small JSON
error, and logged as one `warn` line naming the status and body-parser's error type, if any.
`expose` is what tells it from an Octokit error, whose `status` is GitHub's and stays a `500`.
Never the error itself: body-parser attaches the raw body to it, and `JSON.parse` quotes that body
in its message.

```
WARN (index): POST /dashboard/manual refused (entity.parse.failed) - answering 400
```

## Two things not to regress

- **`process.exit()` truncates pino's async transport.** Set `process.exitCode` and let the loop
  drain instead. The lines most likely to be lost are the fatal and shutdown ones — exactly the
  ones worth keeping. The one backstop: after an `uncaughtException` or `unhandledRejection`, the
  process exits hard about 10 s later if the orderly shutdown has not finished, since after an
  error nobody handled, nothing guarantees the loop ever empties.
- **Bree's `errorHandler` is deliberate.** It also distinguishes a worker killed at
  `closeWorkerAfterMs` (a `warn`: the claimed rows return to the queue when their lease expires)
  from a genuine crash (an `error`).
