# Contributing

Bug reports, questions and pull requests are all welcome.

**Security issues are the exception: do not open a public issue.** Follow [SECURITY.md](SECURITY.md).

## Opening an issue

Check that you are on the latest revision, and search the existing issues first: if yours is
already there, add what you know to it.

A useful report says what you did, what happened, and what you expected. For anything the bot does
at runtime the log is the evidence: run with `LOG_LEVEL=debug` and include the relevant lines,
with the output of `GET /version`.

Redact before pasting: a log line can carry a GitHub login or an email address, and a smee channel
URL lets anyone who holds it receive your app's webhooks.

## Setting up

Follow [the getting started guide](docs/getting-started.md). Use a
**separate GitHub App for development**, never one a live instance uses.
[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Tests

Both must pass, and CI runs them on every commit:

```sh
npm run lint
npm test
```

`npm test` **skips the SQL layer**. `test/db.integration.test.js` runs the real `src/db/*`
functions against a real PostgreSQL, and only when pointed at one, so a checkout without a
database still reports green. With the compose database (on your `POSTGRES_HOST_PORT` if you moved it):

```sh
DB_INTEGRATION_URL=postgres://postgres@localhost:5432/postgres npm test
```

It is the only place a misspelt column or a `$n` pointing at the wrong parameter is caught, so run
it whenever you touch `src/db/` or `init.sql`. It deliberately reads its own variable rather than
the `DB_*` the app reads, because it creates and drops a schema, `oss_bot_integration_test`. Two
checkouts running it against the same server would drop each other's: give each its own with
`DB_INTEGRATION_SCHEMA` (a lower-case identifier starting with `oss_bot_`; anything else is
refused):

```sh
DB_INTEGRATION_SCHEMA=oss_bot_it_mine DB_INTEGRATION_URL=postgres://postgres@localhost:5432/postgres npm test
```

## Submitting a pull request

- **One subject per pull request.** Do not reformat or refactor unrelated code; several small pull
  requests beat one large one.
- **Open an issue first for anything non-trivial**, so the approach is agreed before you spend
  the time.
- **Add a test.** `test/` is `node:test` with no framework. Several tests read the source rather
  than execute it, to pin invariants no unit test can reach, such as a partial index matching the
  query that needs it. Follow the existing patterns.
- **Keep the docs true.** `test/configuration.test.js` fails the build when an environment
  variable the code reads is missing from `.env.example` or from
  [docs/configuration.md](docs/configuration.md), or the other way round, and when a route is
  missing from the Endpoints table of [docs/architecture.md](docs/architecture.md). Where a change
  goes:
  - A **webhook handler** goes in `src/app.js` and nowhere else; `src/index.js` owns startup,
    routes and shutdown.
  - A **job** is four places: a file in `jobs/`, an entry in `JOB_DEFINITIONS` in
    `src/services/breeService.js`, a key in `CRON` in `src/utils/constants.js` if its cadence is
    configurable, and the job table in `docs/architecture.md`. Forget `JOB_DEFINITIONS` and
    nothing fails: the job simply never runs.
  - A **route** added to `src/index.js` needs a row in the Endpoints table.
  - A **table or column** is a schema change: [docs/database.md](docs/database.md#changing-the-schema).
  - In docs and comments, cite a **symbol**, never a line number: line numbers move.
- **Comment the why, never the what.** A comment earns its place by recording what the code cannot
  say: an external constraint, a measured trap, a choice that reads as wrong without its reason.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <summary in the imperative, lower case, no full stop>

Why this change, if it is not obvious. What the code does is in the diff.
```

`type` is one of `feat`, `fix`, `docs`, `style`, `test`, `refactor`, `chore`, `ci`. Keep the
summary under about 70 characters and state an outcome rather than an activity:
`fix(cron): stop answering with a firing that has already happened`, not `update cron.js`.

## Code review

Review the code, not the author. Give actionable feedback with your reasoning, and remember that
nobody writes a bug on purpose.

## Certificate of Origin

By contributing you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under this project's licence, and
that you understand the contribution and your sign-off are public and kept indefinitely.

All contributions are licensed under the project's [licence](LICENSE).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
