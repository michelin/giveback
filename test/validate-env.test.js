import { beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

// Before the import, and the import dynamic for that reason: logger.js decides its level once,
// when it is loaded, and every accepted case here would otherwise print the boot lines.
process.env.LOG_LEVEL = 'silent';

const { validateEnv } = await import("../src/utils/validateEnv.js");

/**
 * The boot refusal gate. Every branch here ends the process before it serves anything, which is
 * the point: a missing ALLOWED_EMAIL_DOMAINS would reject every enrollment at INFO level, and a
 * SESSION_SECRET below the floor is a dashboard session HMAC guessable offline from one stolen
 * cookie. Both are worth failing at startup rather than at the first user's request.
 *
 * Which variables are declared required is pinned in test/configuration.test.js instead - that
 * is a property of the list, not of the checking, and one place is enough.
 */

// Everything validateEnv reads. Only these are cleared, so each case starts from a known
// environment without blanking PATH and friends: `node --test` children inherit the developer's
// shell, and this repo carries a .env.local worth of these locally.
const KEYS = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'DB_HOST',
  'DB_USER',
  'ALLOWED_EMAIL_DOMAINS',
  'DB_PASSWORD',
  'NODE_ENV',
  'PORT',
  'HOST',
  'DB_NAME',
  'DB_PORT',
  'DB_SSL',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'GITHUB_APP_PUBLIC_URL',
  'APP_REVISION',
  'OCTOKIT_HTTP_PROXY',
  'WEBHOOK_PROXY_URL',
  'SESSION_SECRET',
  'DASHBOARD_OPERATOR_IDS',
  'JOB_RUN_RETENTION_DAYS',
];

// The eight required variables, each with a value that passes. A case then removes or spoils
// exactly the one it is about.
const complete = () => {
  process.env.APP_ID = '123456';
  process.env.PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----';
  process.env.WEBHOOK_SECRET = 'webhook-secret';
  process.env.GITHUB_CLIENT_ID = 'Iv1.0123456789abcdef';
  process.env.GITHUB_CLIENT_SECRET = 'client-secret';
  process.env.DB_HOST = 'localhost';
  process.env.DB_USER = 'postgres';
  process.env.ALLOWED_EMAIL_DOMAINS = 'michelin.com,tyredating.com';
};

let saved;

beforeEach(() => {
  saved = { ...process.env };

  for (const key of KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...saved };
});

describe("validateEnv refuses to boot", () => {
  test("when a required variable is missing, naming it", () => {
    assert.throws(() => validateEnv(), /missing required environment variables: APP_ID/);

    complete();
    delete process.env.DB_USER;

    assert.throws(() => validateEnv(), /missing required environment variables: DB_USER$/m);
  });

  test("when production has no DB_PASSWORD", () => {
    // Development connects to the local database without one, so this is required by mode
    // rather than always - and the mode is the thing that is easy to get wrong.
    complete();
    process.env.NODE_ENV = 'production';

    assert.throws(() => validateEnv(), /missing required environment variables: DB_PASSWORD/);

    process.env.DB_PASSWORD = 'secret';

    assert.doesNotThrow(() => validateEnv());
  });

  test("when ALLOWED_EMAIL_DOMAINS parses to nothing", () => {
    // Set but useless is the dangerous shape: it is present, so a "missing variable" check
    // passes it, and every enrollment is then rejected for having the wrong address.
    complete();
    process.env.ALLOWED_EMAIL_DOMAINS = ' , ,';

    assert.throws(() => validateEnv(), /contains no usable domain/);
  });

  test("when ALLOWED_EMAIL_DOMAINS holds something that is not a domain", () => {
    // parseAllowedEmailDomains normalizes but does not validate syntax, so the bad label
    // reaches DOMAIN_PATTERN here and nowhere else.
    complete();
    process.env.ALLOWED_EMAIL_DOMAINS = 'michelin.com,-bad-.com';

    assert.throws(() => validateEnv(), /contains invalid domains: -bad-\.com/);
  });

  test("when DASHBOARD_OPERATOR_IDS holds a login rather than an account id", () => {
    // A login would match no session: its owner silently gets no Operations tab.
    complete();
    process.env.DASHBOARD_OPERATOR_IDS = '583231, octocat, 0';

    assert.throws(() => validateEnv(), /not GitHub account ids: octocat, 0 - find an id with: gh api users/);

    process.env.DASHBOARD_OPERATOR_IDS = ' 583231 , 9919 ';

    assert.doesNotThrow(() => validateEnv());
  });

  test("when SESSION_SECRET is present but too weak to sign a session", () => {
    complete();
    process.env.SESSION_SECRET = 'short';

    assert.throws(() => validateEnv(), /too short \(5 characters, 32 minimum\)/);

    process.env.SESSION_SECRET = '0'.repeat(32);

    assert.doesNotThrow(() => validateEnv());
  });

  test("when production would relay its webhooks through smee", () => {
    // Every delivery through a third party, to anybody else holding the channel URL too.
    complete();
    process.env.NODE_ENV = 'production';
    process.env.DB_PASSWORD = 'secret';
    process.env.WEBHOOK_PROXY_URL = 'https://smee.io/a-channel';

    assert.throws(() => validateEnv(), /WEBHOOK_PROXY_URL is set in production/);

    process.env.NODE_ENV = 'development';

    assert.doesNotThrow(() => validateEnv(), 'a laptop GitHub cannot reach is what smee is for');
  });

  test("when production would talk to a remote database in clear text", () => {
    complete();
    process.env.NODE_ENV = 'production';
    process.env.DB_PASSWORD = 'secret';
    process.env.DB_HOST = 'ossbot.postgres.database.azure.com';

    // Anything but "true" turns TLS off in db/index.js, so anything but "true" is refused here.
    for (const value of ['false', 'FALSE', '0']) {
      process.env.DB_SSL = value;
      assert.throws(() => validateEnv(), /only a loopback host may go without TLS/, `DB_SSL=${value}`);
    }

    process.env.DB_SSL = 'true';
    assert.doesNotThrow(() => validateEnv());

    // Unset means TLS on in production.
    delete process.env.DB_SSL;
    assert.doesNotThrow(() => validateEnv());

    process.env.DB_SSL = 'false';

    for (const host of ['localhost', '127.0.0.1', '::1', '/var/run/postgresql']) {
      process.env.DB_HOST = host;
      assert.doesNotThrow(() => validateEnv(), `${host} never leaves the machine`);
    }

    // Looks local, is not.
    process.env.DB_HOST = '127.example.com';
    assert.throws(() => validateEnv(), /only a loopback host/);
  });
});

describe("validateEnv accepts", () => {
  test("a complete environment with no SESSION_SECRET at all", () => {
    // Unset is a valid configuration: the dashboard stays off rather than the app refusing
    // to collect contributions over a missing optional setting.
    complete();

    assert.doesNotThrow(() => validateEnv());
  });
});

describe("validateEnv warns at boot", () => {
  /**
   * The lines a boot logs at warn, from a child process: the logger here was loaded silent, and a
   * pino instance writes to stdout through a transform no test can tap in-process.
   * @param {Object<string, string>} env - Added to a complete, valid environment
   * @returns {Promise<string[]>} The warn messages
   */
  const warningsFor = async (env) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const module = new URL("../src/utils/validateEnv.js", import.meta.url).href;

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", `(await import(${JSON.stringify(module)})).validateEnv();`],
      {
        env: {
          PATH: process.env.PATH, LOG_LEVEL: 'warn', LOG_FORMAT: 'json',
          APP_ID: '123456', PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----', WEBHOOK_SECRET: 'webhook-secret',
          GITHUB_CLIENT_ID: 'Iv1.0123456789abcdef', GITHUB_CLIENT_SECRET: 'client-secret',
          DB_HOST: 'localhost', DB_USER: 'postgres', DB_PASSWORD: 'secret', ALLOWED_EMAIL_DOMAINS: 'michelin.com',
          ...env,
        },
      }
    );

    return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).msg);
  };

  test("when NODE_ENV is a spelling of production that does not turn it on", async () => {
    const [warning] = await warningsFor({ NODE_ENV: 'prod' });

    assert.match(warning ?? '', /^unknown NODE_ENV=prod, neither development nor production - running as development: no database TLS/);
  });

  test("and says nothing when NODE_ENV is right", async () => {
    assert.deepEqual(await warningsFor({ NODE_ENV: 'production', DASHBOARD_OPERATOR_IDS: '583231' }), []);
  });
});
