# Configuration

Every value comes from the environment. [`.env.example`](../.env.example) lists them all, grouped
the same way as below. `src/utils/validateEnv.js` checks them at startup and refuses to start
half-configured; the log then states the active mode, the accepted email domains, the own
organisations and every setting left at its default.

## Required

The app refuses to start if any of these is missing, and names every one it could not find.

| Variable | Description |
| --- | --- |
| `APP_ID` | GitHub App ID, at the top of the App's settings page |
| `PRIVATE_KEY` | GitHub App private key: a raw PEM, a PEM with `\n` escapes, or base64. Anything else fails the boot by name. Base64 on one line survives every settings editor: `base64 < your-app.private-key.pem \| tr -d '\n'` |
| `GITHUB_CLIENT_ID` | OAuth Client ID from the App's settings page |
| `GITHUB_CLIENT_SECRET` | OAuth client secret. Shown once at creation; generate another if lost |
| `WEBHOOK_SECRET` | Must equal the **Webhook secret** on the App's settings page. The app checks each delivery's signature before Probot sees it (and Probot checks again): a mismatch answers HTTP 400 and logs one `warn` line with the delivery id, which finds the delivery on the App's *Advanced* page |
| `ALLOWED_EMAIL_DOMAINS` | Domains whose verified addresses may enroll, comma-separated, leading `@` optional. **No default**, see below |
| `DB_HOST` | PostgreSQL host |
| `DB_USER` | PostgreSQL user |
| `DB_PASSWORD` | PostgreSQL password. Required **only when `NODE_ENV=production`**; left empty in development, the app starts and says so at `warn` |

### About `ALLOWED_EMAIL_DOMAINS`

Matching is case-insensitive and exact on the **full** domain: `acme.com` does not accept
`mail.acme.com`, list it explicitly. The order is the preference order when a user holds several
eligible addresses, so the stored address is deterministic. The list is stated in the footnote
under every tab of the dashboard.

There is deliberately no default: it would accept one company's employees and reject another's,
silently, and the bot would look healthy while enrolling nobody.

For local development, use the domain of a verified address on your own GitHub account, or your
own enrollment is refused.

## Optional

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port. The App's callback URLs must name the same port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `DB_NAME` | `postgres` | Database name |
| `DB_PORT` | `5432` | PostgreSQL port. Locally, match `POSTGRES_HOST_PORT` if you moved the compose port |
| `DB_SSL` | `true` in production, `false` otherwise | TLS on the database connection. Only the exact value `true` turns it on. In production any other value is refused at startup unless `DB_HOST` stays on the machine: `localhost`, `127.x`, `::1` or a Unix socket path |
| `NODE_ENV` | `development` | `development` or `production`. Drives the cron defaults, `DB_SSL`, `LOG_FORMAT`, the `Secure` cookie and whether `DB_PASSWORD` is required. Many platforms do **not** set it for you |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`. An unknown value falls back to `info`. Applies to Probot's own lines too. See [logging.md](./logging.md) |
| `LOG_FORMAT` | `json` in production, `pretty` otherwise | `json` emits one indexable line per event; `pretty` is for a human at a terminal |
| `GITHUB_APP_PUBLIC_URL` | derived from `GET /app` | Install URL behind the button on the enrollment page. Leave it unset and it follows the loaded credentials; set it only for a vanity or proxied URL |
| `APP_REVISION` | `unknown` | Commit SHA of the running build, echoed by `GET /version` |
| `WEBHOOK_PROXY_URL` | _(none)_ | smee.io channel relaying webhooks to `localhost`. **Local development only**: with `NODE_ENV=production` the app refuses to start while it is set, since anyone holding the channel URL receives every webhook. Webhooks only: the OAuth callback URLs stay `localhost`, see below |
| `OCTOKIT_HTTP_PROXY` | _(none)_ | HTTP proxy for outbound GitHub API calls, e.g. `http://proxy.example.com:8080` |

## Webhooks need a relay locally. Callbacks do not.

Two URLs on the App's settings page look alike and are reached by different parties:

| Setting | Who makes the request | Local value |
| --- | --- | --- |
| Webhook URL | **GitHub's servers**, outbound POST | a smee.io channel: `localhost` means nothing to them |
| Callback URL | **the user's browser**, following a `302` | `http://localhost:3000/callback`: the browser is already on your machine |

GitHub never connects to a callback URL; it answers the browser with
`302 Location: <callback>?code=...`. A smee URL there would send the browser to smee.io, replay
the redirect into the webhook endpoint instead of `/callback`, and burn the one-time OAuth code:
enrollment would never complete and nothing would report an error.

smee is not an inbound tunnel either. `smee-client` runs **inside this app**, holds an outbound
connection to smee.io and replays each delivery to `localhost` itself, which is why it works
behind a proxy that blocks inbound traffic.

In production both settings point at the same public origin.

## Dashboard

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_SECRET` | _(none)_ | Signing key for the dashboard session. **The `/dashboard` routes are not registered at all while it is unset.** At least 32 characters, or the boot fails: `openssl rand -hex 32` |
| `DASHBOARD_ALLOWED_LOGINS` | _(none)_ | Comma-separated GitHub logins that get the **operator tier**, the Operations tab. It does not decide who may read the page. Matched against the login stored on the operator's enrolled row, which follows a GitHub rename at the next reconciliation: an operator who renames must be renamed here too, and the change takes effect on restart |
| `OWN_GITHUB_ORGS` | _(none)_ | Comma-separated GitHub **owners** the company owns, e.g. `acme,acme-labs`. Report-time only: it splits figures between ours and elsewhere ([where](./dashboard.md#overall)) and never narrows what is collected. Empty means every contribution counts as external |
| `JOB_RUN_RETENTION_DAYS` | `7` | Days of run history kept in `job_runs`, purged by the reconciliation job |
| `GITLAB_API_HOSTS` | `gitlab.com` | Comma-separated GitLab hosts the **manual entry** form may read a merge request from, without a token, so only public projects are found. An address on another host is still recordable, typed in by hand. An allow-list because the address comes from a human, and calling any host it names would let the form make the server fetch on somebody's behalf |

Every enrolled user can read the page; `DASHBOARD_ALLOWED_LOGINS` only adds the Operations tab:
the jobs, the queue, enrollment addresses, account states, failure causes and the page's buttons.
Unset means **nobody** is an operator, so a setting that fails to arrive hides operational detail
rather than publishing addresses. Read [dashboard.md](./dashboard.md#two-tiers) before enabling
it: the page also needs a second OAuth callback URL on the GitHub App.

## Scheduling

Tuning knobs. The defaults suit a few thousand enrolled users on a single instance; read
[architecture.md](./architecture.md) before changing them.

| Variable | Default (dev / prod) | Description |
| --- | --- | --- |
| `EVENTS_CRON` | `*/1 * * * *` / `*/5 * * * *` | How often the contribution sync **wakes up** |
| `EVENTS_CRON_POLL` | `*/5 * * * *` | How often the open pull request poll wakes up |
| `RECONCILE_CRON` | `*/10 * * * *` / `7 * * * *` | How often reconciliation runs. Infrequent on purpose: it is paginated and spends app-level budget on information that rarely changes |
| `REPOS_CRON` | `*/3 * * * *` / `23 */2 * * *` | When `sync_repositories` wakes up, offset so it never shares a tick with the other jobs |
| `REPO_REFRESH_INTERVAL_MINUTES` | `360` | How long a repository stays fresh. **Fixed, not adaptive**: [why](./database.md#why-repositories-have-a-table-of-their-own) |
| `REPO_BATCH_SIZE` | `40` | Repositories claimed per run |
| `REPO_GONE_AFTER_404` | `3` | 404s or 410s **in an unbroken run** (any other outcome resets the count) before a repository is marked gone and leaves the refresh queue for good. A 404 from minting the installation token never counts ([why 3](./architecture.md#giving-up)) |
| `SYNC_MIN_INTERVAL_MINUTES` | `15` | Interval floor for a user who just contributed |
| `SYNC_MAX_INTERVAL_MINUTES` | `240` | Interval ceiling for a dormant user: **the freshness guarantee** |
| `POLL_MIN_INTERVAL_MINUTES` | `15` | Same, per open pull request |
| `POLL_MAX_INTERVAL_MINUTES` | `240` | Same, per open pull request |
| `SYNC_BATCH_SIZE` | `200` | Most installations one run may claim |
| `POLL_BATCH_SIZE` | `200` | Most pull requests one run may claim |
| `CLAIM_LEASE_MINUTES` | `15` | How long a worker's claim on a row is honoured before the row returns to the queue |
| `MAX_ERROR_BACKOFF_MINUTES` | `360` | Ceiling of the exponential retry backoff |
| `SYNC_DISABLE_AFTER_404` | `3` | **404s** on a user's events feed **in an unbroken run** (any other outcome resets the count) before the app stops syncing that user. A 404 from minting the installation token never counts ([why 3](./architecture.md#giving-up)) |
| `SYNC_DISABLE_AFTER_FAILURES` | `50` | Consecutive failures of **any other kind** before it stops: about 12 days at the backoff ceiling ([why not 3](./architecture.md#giving-up)) |

The integer settings fall back to their default when unset, not a number, or not positive.

The cron expressions only say how often the scheduler **wakes up**; which subjects run is decided
by each one's due time in the database, so a faster cron costs almost nothing. They also size the
**dispersion** applied to every due time, so there is no separate setting for it. Keep the ticks
faster than half the interval floor: [architecture.md#dispersion](./architecture.md#dispersion).

Both the 5-field form and the 6-field form with seconds (`*/30 * * * * *`) are accepted, and the
form is detected automatically.

## How the environment is loaded

| Command | Reads |
| --- | --- |
| `npm start` | `.env` if present, otherwise the environment alone |
| `npm run start:local` | `.env.local` |
| `npm run start:prod` | `.env.prod` |

Through Node's own `--env-file`: a later line wins over an earlier one, `#` starts a comment, and
**variables already in the environment take precedence over the file**. That last rule makes
`npm start` correct on a platform that injects its own settings, and it means a variable exported
in your shell silently overrides `.env.local`.

`.env*` is git-ignored except `.env.example`. Never ship one: use the platform's secret store.

### Probot's own variables

Probot reads a few variables of its own (`WEBHOOK_PATH`, `GHE_HOST`, `REDIS_URL`, `SENTRY_DSN`,
among others). This application is neither built nor tested for any of them: leave them unset.
The webhook path in particular is fixed at `/api/github/webhooks`, where the signature check and
the local relay expect it.
