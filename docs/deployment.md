# Deploying giveback

## What it needs

| | |
| --- | --- |
| **Runtime** | Node.js `>=24`, the same version as development |
| **Database** | PostgreSQL 9.5+ (`FOR UPDATE SKIP LOCKED`) |
| **Network** | A public HTTPS origin GitHub can reach, for the webhook and the OAuth callbacks. Outbound access to `api.github.com`, directly or through `OCTOKIT_HTTP_PROXY` |
| **Processes** | One is enough. More is safe: instances share the work through the database rather than duplicating it |

No container, message broker, cache or object storage.

## 1. Create the GitHub App

Register a separate App for production, from [`app.yml`](../app.yml) through
[a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
or from the [pre-filled form](./getting-started.md#4-create-a-development-github-app) above with these changes:
**Any account** may install it, the **Webhook URL** is `https://<your-host>/api/github/webhooks`,
and both callback URLs use `https://<your-host>`.

Three settings are easy to miss, and two of them fail silently:

- **Request user authorization (OAuth) during installation: on.** Without it, installing produces
  no OAuth code and enrollment never completes, with no error anywhere.
- **Permissions: Email addresses read-only, and nothing else.** Without it, enrollment's
  `GET /user/emails` answers `403`, no eligible address is ever found and nobody can enroll.
- **Webhook secret** must equal `WEBHOOK_SECRET`, or every webhook answers HTTP 400.

The callback URLs are followed by the user's **browser**, the webhook URL is called by GitHub's
**servers**: that is why only the webhook needs a relay locally
([details](./configuration.md#webhooks-need-a-relay-locally-callbacks-do-not)).

## 2. Configure

Set the variables from [`.env.example`](../.env.example) in your platform's settings (or in a
`.env` file, read by `npm start`), and add `NODE_ENV=production`, which few platforms set for
you. In production the app refuses to start with `WEBHOOK_PROXY_URL` set, or with TLS to a
database that is not on the same machine turned off. `ALLOWED_EMAIL_DOMAINS` has no default on purpose: set it to **your** domains. Reference:
[docs/configuration.md](./configuration.md).

## 3. Create the database

```sh
psql "$DATABASE_URL" -f init.sql
```

`init.sql` is the whole schema and is idempotent. It creates no database and no role, so both
must exist. On a database that already has the tables it changes nothing:
[changing the schema](./database.md#changing-the-schema).

## 4. Run

```sh
npm install
npm start
```

`npm start` reads `.env` if present and otherwise the environment, so the same command works on
a platform that injects its own settings.

On `SIGTERM` or `SIGINT` it lets in-flight requests finish for up to 5 s, gives a running job up
to 3 s more, then terminates it and releases the database pool. Keep the platform's grace period
at 10 s or above. A terminated job loses nothing it committed: its claimed rows return to the queue
when their lease expires.

## 5. Turn on the dashboard (optional)

Set `SESSION_SECRET` (`openssl rand -hex 32`) and `GET /dashboard` serves three tabs: **Me**, what
was recorded under the reader's login; **Overall**, the contribution report; and **Operations**,
the jobs, queue and accounts, for the logins in `DASHBOARD_ALLOWED_LOGINS` only. Any enrolled
employee can read it. Read [docs/dashboard.md](./dashboard.md) first: it needs the second
callback URL on the App.

