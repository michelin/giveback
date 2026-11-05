# Getting started locally

You will run the app against a PostgreSQL in Docker, with a GitHub App of your own and a
[smee.io](https://smee.io) channel relaying GitHub's webhooks to your machine.

**Prerequisites**

- **Node.js 24.** [`mise install`](https://mise.jdx.dev) reads the version from
  [`mise.toml`](../mise.toml); any Node 24 or later works. Every npm command refuses an older one.
- **Docker** with Compose, or a PostgreSQL 9.5+ you already run.
- **A GitHub account** with a verified email address: you will enroll yourself with it.

## 1. Install

From a clone of this repository:

```sh
mise install
npm install
```

Behind a corporate proxy that re-signs TLS, or a corporate npm registry, see
[`.npmrc`](../.npmrc).

## 2. Start PostgreSQL

```sh
docker compose up -d --wait
```

This starts PostgreSQL 16 on `127.0.0.1:5432`, applies [`init.sql`](../init.sql) on first start,
and returns once it accepts connections.

**If port 5432 is already taken** (a local PostgreSQL, Postgres.app, another container), Compose
stops with `ports are not available … address already in use`. Publish the container on another
port, and remember it for step 5:

```sh
POSTGRES_HOST_PORT=5433 docker compose up -d --wait
```

Using a PostgreSQL of your own instead? Create a database and apply the schema:
`psql "postgresql://user@localhost:5432/dbname" -f init.sql`.

## 3. Create a webhook channel

Open <https://smee.io/new> and keep the URL it shows (`https://smee.io/AbC123…`). GitHub's servers
cannot reach `localhost`, so the app holds an outbound connection to this channel and replays each
webhook locally. Anyone holding the URL receives your webhooks: keep it to yourself.

## 4. Create a development GitHub App

Use an App of your own, never a production one: an App sends its webhooks to one URL at a time,
so pointing a live App at your channel silently cuts that instance off.

1. Open
   [this pre-filled registration form](https://github.com/settings/apps/new?description=Local%20development%20instance%20of%20giveback&url=https://opensource.michelin.io/&public=false&webhook_active=true&request_oauth_on_install=true&callback_urls%5B%5D=http://localhost:3000/callback&callback_urls%5B%5D=http://localhost:3000/dashboard/callback&emails=read).
   It carries the settings of [`app.yml`](../app.yml), adapted for local use.
2. Fill in the three fields it cannot:
   - **GitHub App name**: unique across GitHub, e.g. `giveback-dev-<your-login>`.
   - **Webhook URL**: your smee channel.
   - **Webhook secret**: any random string (`openssl rand -hex 20`). Keep it for step 5.
3. Before creating it, check that the form shows what matters: **Request user authorization
   (OAuth) during installation** ticked, the callback URLs `http://localhost:3000/callback` and
   `http://localhost:3000/dashboard/callback`, and **Account permissions → Email addresses:
   Read-only** as the only permission. [Why each one matters](./deployment.md#1-create-the-github-app).
4. **Create GitHub App**. On its settings page, note the **App ID** and the **Client ID**, then
   **Generate a new client secret** and **Generate a private key** (a `.pem` file downloads).

## 5. Configure

```sh
cp .env.example .env.local
```

Fill in the required block at the top of `.env.local`:

| Variable | Value |
| --- | --- |
| `APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from step 4 |
| `PRIVATE_KEY` | the key on one line: `base64 < your-app.private-key.pem \| tr -d '\n'` |
| `WEBHOOK_SECRET` | the secret you typed in step 4 |
| `DB_HOST`, `DB_USER` | `localhost` and `postgres` |
| `ALLOWED_EMAIL_DOMAINS` | the domain of a **verified address on your own GitHub account**, or your own enrollment is refused |

Then, below it, uncomment and set:

| Variable | Value |
| --- | --- |
| `WEBHOOK_PROXY_URL` | your smee channel |
| `SESSION_SECRET` | `openssl rand -hex 32`. Turns the dashboard on |
| `DASHBOARD_OPERATOR_IDS` | your GitHub account id, from `gh api users/<your-login> --jq .id`. Adds the Operations tab for you |
| `DB_PORT` | only if you moved the port in step 2. Otherwise the app connects to whatever listens on 5432 |

Every variable is described in [docs/configuration.md](./configuration.md).

## 6. Start

```sh
npm run start:local
```

Three lines tell you it is wired up:

```
INFO (db): database target postgresql://postgres@localhost:5432/postgres (ssl=false, pool max 10)
INFO (index): smee webhook relay started (local development)
INFO (index): authenticated as github app giveback-dev-octocat
```

The first names the database it will use, the last proves `APP_ID` and `PRIVATE_KEY` belong to
your App. Runs that find nothing to do log at `debug`, so a quiet log is normal.

## 7. Enroll yourself and open the dashboard

1. Open `https://github.com/apps/<your-app-slug>/installations/new` (the slug is the name in the
   `authenticated as` line) and install the App on your **personal** account.
2. GitHub sends your browser to `http://localhost:3000/callback`, which checks your verified
   addresses against `ALLOWED_EMAIL_DOMAINS` and redirects you to the installation's page on
   github.com.
3. Open <http://localhost:3000/dashboard> and sign in with GitHub. Your account is synchronised
   within a minute (in development the sync wakes every minute), and your pull requests appear
   under **Me**.

## When something goes wrong

| You see | Do this |
| --- | --- |
| `missing required environment variables: …` | Set each one it names in `.env.local` |
| `PRIVATE_KEY is neither a PEM nor a base64-encoded PEM` | Paste the key as one base64 line, as in step 5 |
| `could not identify this github app` | `APP_ID` and `PRIVATE_KEY` do not belong to the same App, or GitHub is unreachable (`OCTOKIT_HTTP_PROXY`) |
| `statement failed … [ECONNREFUSED]` or `connection timeout` | Nothing answers at `DB_HOST`:`DB_PORT`: is the container up, and does `DB_PORT` match `POSTGRES_HOST_PORT`? |
| `statement failed … [42P01]` | The database has no schema: apply `init.sql` |
| Installing the App changes nothing in the log | `WEBHOOK_PROXY_URL` is unset, or the App's webhook URL is not your channel |
| `webhook delivery refused - its signature does not match WEBHOOK_SECRET` | `WEBHOOK_SECRET` differs from the secret set on the App: set the same value in both |
| The browser cannot reach `localhost:3000/callback` | The app is not running, or runs on another `PORT`: the callback URLs must name the same port |
| `localhost:3000` shows another app, though this one started | Another process listens on `[::1]:3000`, which does not stop this app binding IPv4. Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN`, or set `PORT` and change the App's callback URLs to match |
| *Email verification required* after installing | No verified address on `ALLOWED_EMAIL_DOMAINS`. The App has been removed from your account: fix the setting or your GitHub emails, then install again |
| `/dashboard` answers 404 | `SESSION_SECRET` is unset, or you have not enrolled (step 7) |

## Lint and test

```sh
npm run lint
npm test
```

`npm test` skips the SQL layer unless it is pointed at a database:
[CONTRIBUTING.md](../CONTRIBUTING.md#tests).

