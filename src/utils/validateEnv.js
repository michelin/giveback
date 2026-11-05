import { isIP } from "node:net";
import { getLogger } from "./logger.js";
import { parseAllowedEmailDomains, OWN_GITHUB_ORGS } from "./constants.js";
import { decodePrivateKey } from "./octokit.js";

const logger = getLogger("validateEnv");

const REQUIRED_ENV_VARS = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'DB_HOST',
  'DB_USER',
  // Required on purpose, with no default: a default would be one organization's domains
  // silently applied to another's employees.
  'ALLOWED_EMAIL_DOMAINS',
];

// Reported as one line at boot, so an operator can see which defaults are in force. The
// scheduling knobs are absent on purpose: breeService logs the resolved schedule itself.
const OPTIONAL_ENV_VARS = {
  PORT: '3000',
  HOST: '0.0.0.0',
  DB_NAME: 'postgres',
  DB_PORT: '5432',
  DB_SSL: 'true in production / false otherwise',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'json in production / pretty otherwise',
  GITHUB_APP_PUBLIC_URL: '(derived from GET /app)',
  APP_REVISION: 'unknown',
  OCTOKIT_HTTP_PROXY: '(none)',
  WEBHOOK_PROXY_URL: '(none - local development only)',
  SESSION_SECRET: '(none - the dashboard stays disabled)',
  DASHBOARD_OPERATOR_IDS: '(none - nobody is an operator)',
  GITLAB_API_HOSTS: 'gitlab.com',
  JOB_RUN_RETENTION_DAYS: '7',
};

// A 256-bit key expressed in hex or base64. Shorter than this and the HMAC protecting the
// dashboard session is guessable offline from a single stolen cookie.
const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Does this DB_HOST stay on the machine?
 *
 * The loopback names and addresses, and a socket directory, which is how pg spells a Unix
 * socket. Anything else crosses a network, however private it looks.
 */
const isLocalHost = (host) =>
  host === 'localhost'
  || host.startsWith('/')
  || (isIP(host) === 4 && host.startsWith('127.'))
  || (isIP(host) === 6 && host === '::1');

// A domain label per RFC 1035: alphanumerics and hyphens, no leading/trailing hyphen.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Validate the environment, and state at boot what it resolved to
 *
 * Called from src/index.js, but ESM imports are hoisted: db/index.js, constants.js and
 * breeService.js have already captured process.env by the time this runs. Safe, because
 * validation only ever throws — but it does mean a missing variable can produce one confusing
 * line before the process exits, and that every value is frozen at startup.
 * @throws {Error} If a required variable is missing or malformed
 */
export const validateEnv = () => {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  const isProduction = (process.env.NODE_ENV || 'development') === 'production';

  if (isProduction && !process.env.DB_PASSWORD) {
    missing.push('DB_PASSWORD');
  }

  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(', ')}`);
  }

  // Presence is not enough: a key that only fails when the first JWT is signed lets the app boot
  // and serve webhooks first. Thrown with the reader's own message.
  decodePrivateKey(process.env.PRIVATE_KEY);

  // An empty or malformed list would silently reject every enrollment, so it has to
  // fail at startup rather than at the first user's callback.
  const allowedDomains = parseAllowedEmailDomains(process.env.ALLOWED_EMAIL_DOMAINS);

  if (allowedDomains.length === 0) {
    throw new Error('ALLOWED_EMAIL_DOMAINS contains no usable domain - set it to your own, e.g. ALLOWED_EMAIL_DOMAINS=acme.com');
  }

  const invalidDomains = allowedDomains.filter((domain) => !DOMAIN_PATTERN.test(domain));

  if (invalidDomains.length > 0) {
    throw new Error(`ALLOWED_EMAIL_DOMAINS contains invalid domains: ${invalidDomains.join(', ')}`);
  }

  // Only checked when set: a missing SESSION_SECRET means the page is off, which is a valid
  // configuration. One that is present but too weak is not.
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET is too short (${process.env.SESSION_SECRET.length} characters, ${MIN_SESSION_SECRET_LENGTH} minimum) - generate one with: openssl rand -hex 32`);
  }

  // A login pasted here would match no session and make its owner silently no operator, so an
  // entry that is not an account id fails the boot with the way to find the right one.
  const notIds = (process.env.DASHBOARD_OPERATOR_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && !(/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))));

  if (notIds.length > 0) {
    throw new Error(`DASHBOARD_OPERATOR_IDS holds entries that are not GitHub account ids: ${notIds.join(', ')} - find an id with: gh api users/<login> --jq .id`);
  }

  // A smee channel relays every webhook through a third party, to anybody else who holds its URL
  // as well - fine for a laptop GitHub cannot reach, never for an instance it can.
  if (isProduction && process.env.WEBHOOK_PROXY_URL) {
    throw new Error('WEBHOOK_PROXY_URL is set in production - unset it and point the app\'s webhook URL at this instance instead');
  }

  // Read as db/index.js reads it: anything but "true" turns TLS off. In clear text the
  // connection carries the database password and every enrollment address, which is only
  // acceptable when it never leaves the machine.
  if (isProduction && process.env.DB_SSL && process.env.DB_SSL !== 'true' && !isLocalHost(process.env.DB_HOST)) {
    throw new Error(`DB_SSL=${process.env.DB_SSL} in production with DB_HOST=${process.env.DB_HOST} - unset DB_SSL or set it to true; only a loopback host may go without TLS`);
  }

  const defaulted = Object.entries(OPTIONAL_ENV_VARS)
    .filter(([key]) => !process.env[key])
    .map(([key, defaultValue]) => `${key}=${defaultValue}`);

  if (defaulted.length > 0) {
    logger.info(`${defaulted.length} setting(s) using their default: ${defaulted.join(', ')}`);
  }

  if (!isProduction && !process.env.DB_PASSWORD) {
    logger.warn('DB_PASSWORD not set - connecting to the local database without a password (development only)');
  }

  // The cron defaults differ between modes, so the active mode is stated: an unset NODE_ENV
  // silently gives a hosted deployment the development cadence.
  logger.info(`environment validated - NODE_ENV=${process.env.NODE_ENV || 'development (unset)'}`);

  // Only the exact word turns production on, so `prod` or `Production` silently runs a hosted
  // instance as development, without the safeguards below. Warned rather than refused: the
  // collection still works, and a boot that stops it over a word is the worse failure.
  if (process.env.NODE_ENV && !['development', 'production'].includes(process.env.NODE_ENV)) {
    logger.warn(`unknown NODE_ENV=${process.env.NODE_ENV}, neither development nor production - running as development: no database TLS by default, no Secure cookie, no HSTS, no trust proxy, DB_PASSWORD not required, development crons`);
  }

  logger.info(`enrollment accepts verified addresses on ${allowedDomains.join(', ')}`);

  // The parsed list, not the presence of the variable: a typo is truthy and would otherwise be
  // reported as a default in force while silently counting somebody else's repositories as
  // external. Nothing else logs it, and constants.js froze it before this ran.
  logger.info(OWN_GITHUB_ORGS.length
    ? `own organisations: ${OWN_GITHUB_ORGS.join(', ')}`
    : 'no own organisations set - every contribution counts as external');

  // A security decision, so it is stated at boot rather than discovered by whoever is refused.
  if (process.env.SESSION_SECRET) {
    const operators = process.env.DASHBOARD_OPERATOR_IDS;

    logger.info(`dashboard readable by any enrolled user, operator detail for ${
      operators ? `account ids ${operators}` : 'nobody - DASHBOARD_OPERATOR_IDS is unset'}`);
  }
};
