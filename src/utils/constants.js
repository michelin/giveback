/**
 * Parse the accepted enrollment domains from a comma-separated list
 *
 * There is deliberately NO default. A wrong domain list does not crash — it accepts the wrong
 * company's employees and rejects your own, in INFO-level silence. validateEnv makes an empty
 * result a startup failure instead.
 * @param {string|undefined} raw - e.g. "acme.com,acme-labs.com"
 * @returns {string[]} Lower-cased domains, no leading "@", de-duplicated, order preserved
 */
export const parseAllowedEmailDomains = (raw) =>
  [...new Set(
    (raw ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/^@+/, ''))
      .filter(Boolean)
  )];

// Order matters: it is the preference order when a user has several eligible addresses.
export const ALLOWED_EMAIL_DOMAINS = parseAllowedEmailDomains(process.env.ALLOWED_EMAIL_DOMAINS);

/**
 * The GitHub organisations this company owns
 *
 * Contributing to a repository the company publishes and contributing to the wider ecosystem
 * are two different stories, and the contribution report tells them apart. Empty is a valid
 * answer and the honest default: with no list, every measured contribution is external and the
 * distinction never appears on screen.
 *
 * Owners only, never `owner/repo` — the comparison is against the owner segment of a full name.
 * @param {string|undefined} raw - e.g. "acme,acme-labs"
 * @returns {string[]} Lower-cased owners, de-duplicated
 */
export const parseOwnGithubOrgs = (raw) =>
  [...new Set(
    (raw ?? '')
      .split(',')
      .map((org) => org.trim().toLowerCase().replace(/^@+/, '').split('/')[0])
      .filter(Boolean)
  )];

export const OWN_GITHUB_ORGS = parseOwnGithubOrgs(process.env.OWN_GITHUB_ORGS);

/**
 * The GitLab instances this application may call
 *
 * An operator pastes the address of a merge request, and that address names a host. Calling
 * whatever host it names would make the manual-entry form a way to have the server fetch
 * something on somebody's behalf - so the host is checked against this list instead, and one
 * that is not on it is simply typed in by hand.
 *
 * gitlab.com by default because that is where merge requests answer to nobody's token. An
 * instance added here has to be readable WITHOUT authentication for the lookup to find
 * anything; nothing here carries a credential.
 * @param {string|undefined} raw - e.g. "gitlab.com,gitlab.example.org"
 * @returns {string[]} Lower-cased hosts
 */
const parseGitlabApiHosts = (raw) =>
  [...new Set(
    (raw ?? 'gitlab.com')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )];

export const GITLAB_API_HOSTS = parseGitlabApiHosts(process.env.GITLAB_API_HOSTS);

/**
 * Read a positive integer from the environment
 * @param {string} name - Variable name
 * @param {number} fallback - Value to use when unset or unusable
 * @returns {number}
 */
const intFromEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// A rolling window, not an archive: job_runs answers "how has this job behaved lately", and a
// week covers a deploy, a weekend and a bad night. Purged by reconcile_installations.
export const JOB_RUN_RETENTION_DAYS = intFromEnv('JOB_RUN_RETENTION_DAYS', 7);

/**
 * How many values a percentile needs before anything shows it
 *
 * A median of two pull requests is one of the two, and a p90 of three is the slowest of them:
 * both read as a measurement and are an anecdote. Below its threshold a figure is "—" beside the
 * base it does have, and a chart leaves the point out - a gap, not a zero. Defined once, here:
 * the server gates what it measures with it, and the page is sent this very object in its
 * snapshot rather than keeping copies of the numbers.
 */
export const PERCENTILE_MIN_SAMPLE = Object.freeze({ p50: 3, p90: 10, p99: 100 });

export const PAGINATION = {
  PER_PAGE: 100,
  // GitHub caps the public events feed at 300 events and answers 422 beyond it, so
  // PER_PAGE * MAX_PAGES must never exceed 300. Measured in production on a real account:
  // page 3 returns 100 events with 200 OK, page 4 returns 422 — and a 422 fails that user's
  // entire sync, which by construction hits the most active contributors first.
  MAX_PAGES: 3,
};

// One definition, because five places import it: cron cadence, DB TLS, the Secure cookie,
// the log format, and trust proxy. validateEnv is the deliberate exception - it re-reads
// process.env.NODE_ENV itself, because it runs after imports are hoisted and must see the
// value at call time rather than the one frozen here. The literal process.env.NODE_ENV read
// stays here: test/configuration.test.js finds the variables the code reads by scanning for
// that text, and would call NODE_ENV dead configuration without it.
export const isProduction = (process.env.NODE_ENV || 'development') === 'production';

/**
 * How often each job WAKES UP. Which subjects run is decided by their own due time.
 *
 * Resolved here rather than in breeService because the jobs need these too: each derives its
 * tick from its own expression to size the dispersion. Deliberately not a separate DISPERSION
 * setting — that would be a second knob to keep aligned with these, the exact shape that once
 * left the app running with nothing scheduled because `hasSeconds` disagreed.
 */
export const CRON = {
  SYNC: process.env.EVENTS_CRON || (isProduction ? '*/5 * * * *' : '*/1 * * * *'),
  POLL: process.env.EVENTS_CRON_POLL || '*/5 * * * *',
  // Deliberately offset from the others: a repository refresh is the only job that reads a
  // third-party resource on a fixed schedule, and it has no reason to share a tick.
  SYNC_REPOS: process.env.REPOS_CRON || (isProduction ? '23 */2 * * *' : '*/3 * * * *'),
  // Deliberately infrequent: GET /app/installations is paginated and spends app-level (JWT)
  // budget, for information that changes rarely.
  RECONCILE: process.env.RECONCILE_CRON || (isProduction ? '7 * * * *' : '*/10 * * * *'),
};

/**
 * Adaptive scheduling. See docs/architecture.md for the reasoning behind each bound.
 *
 * What the doubling buys is NOT GitHub quota — a 304 already costs none — but the things a 304
 * does not cover: one installation-token mint against the app-level (JWT) budget, ~0.5s of
 * worker time and two DB writes per poll. Without it, 3000 users at a flat 15 minutes would be
 * ~96 minutes of work per hour.
 *
 * MAX is the freshness guarantee, and must stay far below GitHub's ~90-day public events
 * window — the only hard correctness deadline in the system.
 */
export const SCHEDULING = {
  SYNC_MIN_INTERVAL_MINUTES: intFromEnv('SYNC_MIN_INTERVAL_MINUTES', 15),
  SYNC_MAX_INTERVAL_MINUTES: intFromEnv('SYNC_MAX_INTERVAL_MINUTES', 4 * 60),
  POLL_MIN_INTERVAL_MINUTES: intFromEnv('POLL_MIN_INTERVAL_MINUTES', 15),
  POLL_MAX_INTERVAL_MINUTES: intFromEnv('POLL_MAX_INTERVAL_MINUTES', 4 * 60),

  // Sized so a run finishes well inside the scheduler interval. At the measured ~0.5s per
  // subject, 200 is ~100s against a 5-minute tick.
  SYNC_BATCH_SIZE: intFromEnv('SYNC_BATCH_SIZE', 200),
  POLL_BATCH_SIZE: intFromEnv('POLL_BATCH_SIZE', 200),

  REPO_BATCH_SIZE: intFromEnv('REPO_BATCH_SIZE', 40),
  // Consecutive 404s (or 410s) by id before a repository is stamped gone_at and leaves the
  // refresh queue for good - counted in refresh_404_count, so a timeout in between starts the
  // count again. Three, not one and not fifty. Not one, because a repository made private for an
  // afternoon answers exactly like a deleted one. Not fifty, because the request carries the
  // repository's ID: an id survives a rename and a transfer, so a 404 against one is already
  // about the repository itself and not about a name that moved - which is the uncertainty
  // SYNC_DISABLE_AFTER_FAILURES has to sit out. At the 6h interval this is about a day, and
  // nothing in this application clears the verdict afterwards.
  REPO_GONE_AFTER_404: intFromEnv('REPO_GONE_AFTER_404', 3),
  // Fixed, not adaptive, and that is the one deliberate departure from every other subject
  // here. The adaptive ladder halves the interval whenever something changed - and a star
  // count changes constantly on an active repository, so the ladder would pin every popular
  // one to the floor and spend 96 calls a day on a number nobody needs to the minute.
  REPO_REFRESH_INTERVAL_MINUTES: intFromEnv('REPO_REFRESH_INTERVAL_MINUTES', 6 * 60),
  // Longer than the worst-case run so a live worker is never overtaken; short enough that a
  // dead worker's rows come back.
  CLAIM_LEASE_MINUTES: intFromEnv('CLAIM_LEASE_MINUTES', 15),

  MAX_ERROR_BACKOFF_MINUTES: intFromEnv('MAX_ERROR_BACKOFF_MINUTES', 6 * 60),

  // Two thresholds, one per kind of certainty — disableReasonFor() carries the reasoning.
  // Consecutive 404s from the events feed (sync_404_count). Low, because a wrong 404 verdict is
  // undone hourly by the login refresh.
  SYNC_DISABLE_AFTER_404: intFromEnv('SYNC_DISABLE_AFTER_404', 3),
  // High, because nothing repairs this one: at the 6h backoff ceiling, 50 is ~12 days.
  SYNC_DISABLE_AFTER_FAILURES: intFromEnv('SYNC_DISABLE_AFTER_FAILURES', 50),
};
