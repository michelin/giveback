import { getTransformStream } from "@probot/pino";
import pino from "pino";
import { isProduction } from "./constants.js";
// The outcome taxonomy is a persisted domain value, so it is owned there, not here.
import { jobOutcome } from "./jobSummary.js";

/**
 * Pretty for a human at a terminal, JSON for a log platform. json in production by default.
 *
 * @probot/pino hardcodes its prettyFactory with no way to hide the multi-line field block
 * pino-pretty prints under every message, so the only choice available is the format itself.
 */
const resolveFormat = () => {
  const requested = (process.env.LOG_FORMAT || '').trim().toLowerCase();

  if (requested === 'json' || requested === 'pretty') {
    return requested;
  }

  return isProduction ? 'json' : 'pretty';
};

// getTransformStream is async in Probot v14.
const transform = await getTransformStream({ logFormat: resolveFormat() });
transform.pipe(pino.destination(1));

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/**
 * Resolve LOG_LEVEL, falling back rather than throwing
 *
 * pino throws on an unknown level, and this module is imported before validateEnv runs, so a
 * typo would crash the process with an unattributed stack before a single line of ours.
 * @returns {string} A level pino accepts
 */
const resolveLevel = () => {
  const requested = (process.env.LOG_LEVEL || '').trim().toLowerCase();

  if (!requested) {
    return 'info';
  }

  if (LEVELS.includes(requested)) {
    return requested;
  }

  // Written to stderr directly: the logger it would complain to does not exist yet.
  process.stderr.write(`LOG_LEVEL="${requested}" is not one of ${LEVELS.join(', ')} - falling back to info\n`);

  return 'info';
};

const level = resolveLevel();

// pg-promise builds `error.query` by inlining the parameter values client-side, so a failed
// enrollment INSERT carries the user's email address and real name on the Error object - and
// pino's default serializer publishes every enumerable own property of it. Measured: the values
// reach the log whenever a RAW pg error is handed to logger.error({ err }).
//
// The db layer wraps its errors, and pino does not walk a cause's own properties, so the
// sensitive statements are covered today. That is a convention, though, and one db function
// added without a wrapping try/catch reopens it silently. Stripped here instead, where it
// cannot be forgotten.
const PG_FIELDS_WITH_PARAMETER_VALUES = ['query', 'params'];

// @octokit/oauth-methods throws a RequestError whose `request` is the whole exchange, with
// client_secret and the code in it; RequestError only redacts the URL and the auth header.
// Any GitHub user reaches that throw by sending a made-up code to a callback. The method and
// the URL are all a request is kept for.
const keepMethodAndUrl = ({ method, url }) => ({ method, url });

// @octokit/webhooks attaches the whole delivery to every error it raises - on a signature
// mismatch that is a body any anonymous caller chose, raw, and on a handler failure the full
// GitHub payload. The event name and delivery id are what a line needs, and the call sites log
// those as fields of their own.
const WEBHOOK_FIELDS = ['event'];

/**
 * Strip one serialized error, and every error it aggregates
 *
 * pino serializes an AggregateError's members with its own serializer, not with this one, so
 * a field removed only at the top would still reach the log one level down.
 */
const strip = (serialized) => {
  for (const field of [...PG_FIELDS_WITH_PARAMETER_VALUES, ...WEBHOOK_FIELDS]) {
    delete serialized[field];
  }

  if (serialized.request) {
    serialized.request = keepMethodAndUrl(serialized.request);
  }

  serialized.aggregateErrors?.forEach(strip);

  return serialized;
};

/**
 * pino's err serializer, minus the pg fields that carry parameter values, the octokit request
 * that can carry the OAuth client secret and the webhook delivery
 *
 * Exported so the rule is testable without a database: it is a privacy guarantee, and the kind
 * of thing that is only noticed once it has already been broken.
 */
export const errSerializer = (error) => strip(pino.stdSerializers.err(error));

/**
 * How an entity is spelled in a log message. One entity, one spelling, everywhere.
 *
 * A pull request is always `owner/name#12` — GitHub's own notation, so an operator can paste
 * it straight into a browser.
 */
export const format = {
  /** @returns {string} e.g. "octocat/hello" */
  repo: (owner, name) => `${owner}/${name}`,

  /** @returns {string} e.g. "octocat/hello#12", or "pr #12" without a known repository */
  pr: (number, repo) =>
    repo?.owner && repo?.name ? `${format.repo(repo.owner, repo.name)}#${number}` : `pr #${number}`,

  /** @returns {string} e.g. "installation 12345" */
  installation: (installationId) => `installation ${installationId}`,

  /** @returns {string} e.g. "user octocat" */
  user: (login) => `user ${login}`,

  /**
   * Human duration, so no caller hand-formats one
   * @returns {string} "842ms" | "8.4s" | "2.3min" | "72.0h"
   */
  duration: (ms) => {
    const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;

    if (value < 1000) {
      return `${Math.round(value)}ms`;
    }

    if (value < 60_000) {
      return `${(value / 1000).toFixed(1)}s`;
    }

    if (value < 3_600_000) {
      return `${(value / 60_000).toFixed(1)}min`;
    }

    return `${(value / 3_600_000).toFixed(1)}h`;
  },

  /**
   * Counters as `key=value`, insertion order preserved, zeros kept — so the line has the same
   * shape every run and `grep 'failed=[1-9]'` finds every bad run and nothing else.
   * @returns {string} e.g. "claimed=4 changed=3 failed=0"
   */
  counts: (counters) =>
    Object.entries(counters ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(' '),

  /**
   * The one line a finished job run is allowed to produce
   *
   * `ok`, `error`, `durationMs`, `state` and `failures` are consumed rather than printed as
   * counters: the outcome word carries `ok`, the duration has its own slot, `state` goes after
   * the pipe because it describes the system rather than this run, `error` is the trailing
   * cause, and `failures` is a list kept for job_runs - see jobOutcome().
   * @returns {string} e.g. "sync_contributions ok in 8.4s - claimed=4 changed=3 failed=0"
   */
  jobReport: (name, summary) => {
    const { error, durationMs, state } = summary ?? {};
    const { outcome, counters } = jobOutcome(summary);

    const parts = [`${name} ${outcome} in ${format.duration(durationMs)}`];
    const rendered = format.counts(counters);

    if (rendered) {
      parts.push(` - ${rendered}`);
    }

    if (state && Object.keys(state).length > 0) {
      parts.push(` | ${format.counts(state)}`);
    }

    // A raw cause is the last thing on the line, and appears at most once.
    if (error) {
      parts.push(`: ${error}`);
    }

    return parts.join('');
  },
};

/**
 * The structured twin of each display helper, always spread into pino's FIRST argument.
 *
 * The prose stays readable for a human; these make the same identifiers queryable, which is
 * the difference between grepping a substring across five files and filtering on one field.
 */
export const fields = {
  repo: (owner, name) => ({ repo: format.repo(owner, name) }),

  pr: (number, repo) => ({
    pr_number: number,
    ...(repo?.owner && repo?.name ? { repo: format.repo(repo.owner, repo.name) } : {}),
  }),

  // Coerced on purpose: the same id arrives as a number from a webhook payload and as a
  // *string* from PostgreSQL, which returns BIGINT as text. Two types on one field breaks
  // every filter a log platform can apply, and GitHub ids sit far below MAX_SAFE_INTEGER.
  installation: (installationId) => ({ installation_id: Number(installationId) }),

  user: (login) => ({ user: login }),

  job: (name) => ({ job: name }),

  /**
   * The structured twin of format.jobReport
   *
   * `outcome` rather than a raw `ok` boolean: it is the same word the message shows, and
   * `outcome=failed` is a far more useful filter than `ok=false`. `state` is flattened with a
   * prefix because `active` would otherwise collide with a run counter of the same name.
   * @returns {Object}
   */
  jobReport: (name, summary) => {
    const { outcome, counters } = jobOutcome(summary);
    const { durationMs, state } = summary ?? {};

    return {
      job: name,
      outcome,
      duration_ms: durationMs,
      ...counters,
      ...Object.fromEntries(Object.entries(state ?? {}).map(([key, value]) => [`state_${key}`, value])),
    };
  },
};

/**
 * Create a logger for one module
 * @param {string} name - Logger name, conventionally the module's basename
 * @returns {import('pino').Logger}
 */
export const getLogger = (name) =>
  pino({ name, level, serializers: { err: errSerializer } }, transform);
