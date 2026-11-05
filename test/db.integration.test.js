import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pgPromise from "pg-promise";

import { hydrated } from "../test-support/integration/context.js";
import * as shared from "../test-support/integration/shared.js";
import * as ops from "../test-support/integration/ops.js";
import * as mine from "../test-support/integration/mine.js";
import * as collective from "../test-support/integration/collective.js";

/**
 * The SQL layer, executed.
 *
 * Every other test in this directory reads src/db/*.js as TEXT. That catches a predicate
 * dropped from a query, and it cannot catch anything PostgreSQL alone knows: a misspelt column,
 * a $n index pointing at the wrong parameter, an ON CONFLICT target no index can serve, a JOIN
 * against a table init.sql no longer declares. None of that is a syntax error in JavaScript, and
 * all of it fails on the one code path that only runs when somebody actually contributes.
 *
 * So this file runs the real exported functions against a real server. It is gated, because a
 * checkout without a database must still report a green `npm test`:
 *
 *   DB_INTEGRATION_URL=postgres://postgres@localhost:5432/postgres npm test
 *
 * Deliberately NOT the DB_HOST/DB_USER pair the application itself reads. Those are what a
 * developer's shell has pointed at a real database, and this file creates and DROPS a schema —
 * it must be impossible to arm it by accident.
 */
const DSN = process.env.DB_INTEGRATION_URL;

const skip = DSN
  ? false
  : 'set DB_INTEGRATION_URL (e.g. postgres://postgres@localhost:5432/postgres) to run the SQL layer against a real PostgreSQL';

/**
 * The scratch schema every table is created in.
 *
 * A schema of its own rather than `public`, and `public` deliberately left OUT of the search
 * path below: a table this file forgot to create must fail loudly, never resolve against
 * whatever the target database already holds.
 *
 * DB_INTEGRATION_SCHEMA names another, so two checkouts can run the suite against one server at
 * once without dropping each other's. Checked before use: it is interpolated into DROP SCHEMA ...
 * CASCADE, so only a name in this suite's own oss_bot_ namespace is accepted - never `public`,
 * never a schema the application uses.
 */
const SCHEMA = process.env.DB_INTEGRATION_SCHEMA ?? 'oss_bot_integration_test';

if (!/^oss_bot_[a-z0-9_]{1,55}$/.test(SCHEMA)) {
  throw new Error(`DB_INTEGRATION_SCHEMA must be a lower-case SQL identifier starting with oss_bot_, not ${JSON.stringify(SCHEMA)}`);
}

// Filled by before(). The modules under test read process.env at import time, so nothing here
// may be imported statically.
const db = {};

// One connection of our own, beside the application's pool: it applies init.sql and reads rows
// back to check what the functions under test actually wrote.
let pgp;
let admin;

const initSql = () => readFileSync(fileURLToPath(new URL('../init.sql', import.meta.url)), 'utf8');

const TABLES = [
  'github_push_events',
  'github_pull_request_events',
  'github_pull_requests',
  'github_repository_renames',
  'github_repositories',
  'github_installations',
  'job_runs',
];

/** A repository as GET /repositories/{id} returns it. */
const fetched = (overrides = {}) => ({
  full_name: 'acme/widget',
  html_url: 'https://github.com/acme/widget',
  description: 'A widget',
  stargazers_count: 341,
  forks_count: 13,
  subscribers_count: 9,
  license: { key: 'apache-2.0' },
  topics: ['tyres', 'widgets'],
  language: 'JavaScript',
  archived: false,
  pushed_at: '2026-01-03T10:00:00.000Z',
  ...overrides,
});

describe("the SQL layer, against a real PostgreSQL", { skip }, () => {
  before(async () => {
    const dsn = new URL(DSN);

    process.env.DB_HOST = decodeURIComponent(dsn.hostname);
    process.env.DB_PORT = dsn.port || '5432';
    process.env.DB_USER = decodeURIComponent(dsn.username) || 'postgres';
    process.env.DB_NAME = decodeURIComponent(dsn.pathname.replace(/^\//, '')) || 'postgres';
    process.env.DB_SSL = process.env.DB_SSL ?? 'false';
    // The modules under test log on import and on every slow query; a test run is not the place.
    process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

    if (dsn.password) {
      process.env.DB_PASSWORD = decodeURIComponent(dsn.password);
    }

    // How the application's pool - which this file does not get to configure - is pointed at the
    // scratch schema. node-postgres reads PGOPTIONS for any connection parameter it was not
    // given, so this reaches src/db/index.js without it knowing. Asserted below rather than
    // trusted: if it ever stops being read, every statement here would run against `public`.
    //
    // And in a zone that is not UTC, whatever the server's default: a query that cuts its months
    // in the session's zone instead of UTC then answers differently, and a test can see it.
    process.env.PGOPTIONS = `-c search_path=${SCHEMA} -c TimeZone=Europe/Paris`;

    pgp = pgPromise({ noWarnings: true });
    admin = pgp({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: false,
      max: 2,
    });

    // Dropped first, not only last: a run killed half way through must not leave the next one
    // reading its rows.
    await admin.none(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.none(`CREATE SCHEMA ${SCHEMA}`);
    await admin.tx(async (t) => {
      await t.none(`SET LOCAL search_path TO ${SCHEMA}`);
      await t.none(initSql());
    });

    db.index = await import("../src/db/index.js");
    db.installations = await import("../src/db/installations.js");
    db.repositories = await import("../src/db/repositories.js");
    db.pullRequests = await import("../src/db/pull_requests.js");
    db.polling = await import("../src/db/polling.js");
    db.events = await import("../src/db/events.js");
    db.dashboard = await import("../src/db/dashboard.js");
    db.contributions = await import("../src/db/contributions.js");
    db.jobRuns = await import("../src/db/job_runs.js");
    db.SCHEDULING = (await import("../src/utils/constants.js")).SCHEDULING;

    const { rows } = await db.index.query('SELECT current_schema() AS schema');

    assert.equal(
      rows[0].schema,
      SCHEMA,
      "the application's pool is not on the scratch schema - PGOPTIONS is no longer reaching node-postgres, and this suite would be writing to the target database itself"
    );
  });

  after(async () => {
    if (db.index) {
      await db.index.closePool();
    }

    if (admin) {
      await admin.none(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    }

    if (pgp) {
      pgp.end();
    }
  });

  // Every test starts from an empty schema, so none of them depends on the order they run in.
  beforeEach(async () => {
    await admin.none(`TRUNCATE ${TABLES.map((table) => `${SCHEMA}.${table}`).join(', ')} RESTART IDENTITY CASCADE`);
  });

  /** Read rows back with our own connection, never through the code under test. */
  const rowsOf = (text, params = []) => admin.any(`SET search_path TO ${SCHEMA}; ${text}`, params);

  const oneRow = async (text, params = []) => (await rowsOf(text, params))[0];

  /**
   * An installation that claimInstallationsForSync() will hand out
   * @returns {Promise<number>} github_installations.id, which lease() turns into what the mark*
   *   functions take
   */
  const enrol = async (login, { userId = 1, installationId = 42 } = {}) => {
    await db.installations.insertPendingInstallation({ id: userId, login }, installationId);
    await db.installations.verifyInstallation({ id: userId, login }, `${login}@michelin.com`, installationId);

    return (await oneRow(`SELECT id FROM github_installations WHERE user_id = $1`, [userId])).id;
  };

  /** A repository row and one open contribution to it, as the sync job would write them. */
  const contribute = async (overrides = {}) => {
    const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

    await db.pullRequests.upsertPullRequest(hydrated(overrides), id);

    return id;
  };

  /**
   * Hold the lease on one row as its claim would, and hand back what a release takes
   *
   * Every release is fenced on the lease its claim returned, so one handed a bare id - or a claim
   * since released or taken again - writes nothing. Set directly rather than through the claim
   * query, so the row need not be due.
   * @param {string} table - One of the three queues
   * @returns {Promise<{id: number, lease: string}>}
   */
  const lease = (table, id) => {
    const column = { github_installations: 'sync_claimed_at', github_pull_requests: 'poll_claimed_at', github_repositories: 'refresh_claimed_at' }[table];

    return oneRow(`UPDATE ${table} SET ${column} = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, ${column}::text AS lease`, [id]);
  };

  /** Push a lease into the past, so the row is claimable again without waiting it out. */
  const expireLease = (table, column) =>
    admin.none(
      `UPDATE ${SCHEMA}.${table} SET ${column} = CURRENT_TIMESTAMP - make_interval(mins => $1::int)`,
      [db.SCHEDULING.CLAIM_LEASE_MINUTES + 1]
    );

  describe("the installation sync queue", () => {
    test("a pending installation is not claimed, and the same row is claimed the moment it is verified", async () => {
      // The whole point of writing the webhook's row as pending: the app knows the installation
      // exists and must not read anybody's feed until the email check has passed.
      await db.installations.insertPendingInstallation({ id: 1, login: 'octocat' }, 42);

      assert.equal((await db.installations.claimInstallationsForSync()).length, 0);

      await db.installations.verifyInstallation({ id: 1, login: 'octocat' }, 'octocat@michelin.com', 42);

      const claimed = await db.installations.claimInstallationsForSync();

      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].user_login, 'octocat');
      assert.equal(Number(claimed[0].installation_id), 42);
      // The sync job destructures exactly these off the claim.
      assert.deepEqual(
        Object.keys(claimed[0]).sort(),
        ['events_etag', 'id', 'installation_id', 'last_synced_at', 'lease', 'sync_404_count', 'sync_error_count', 'sync_interval_minutes', 'user_login'],
        'the claim no longer returns what the sync job reads off it'
      );
      // One row, not two: the verification is an upsert on user_id, not a second enrollment.
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_installations`)).n, 1);
    });

    test("verifyInstallation lands each value in its own column, on the insert and on the conflict update", async () => {
      // The login, the name and the enrollment address are three interchangeable strings in one
      // parameter list, and the statement numbers its placeholders TWICE - once in VALUES, once
      // in DO UPDATE SET. Swapping two of them is not an error anywhere: the address is simply
      // filed as the person's name, and every count, claim and page still comes out right.
      await db.installations.verifyInstallation(
        { id: 1234, login: 'octocat-login', name: 'Octo Cat the person' },
        'octo.cat@michelin.com',
        4242
      );

      const columns = `SELECT user_id, user_login, user_name, user_enrollment_email_address,
                              installation_id, sync_interval_minutes, verified_at IS NOT NULL AS verified
                       FROM github_installations`;
      const inserted = await oneRow(columns);

      assert.equal(Number(inserted.user_id), 1234);
      assert.equal(inserted.user_login, 'octocat-login');
      assert.equal(inserted.user_name, 'Octo Cat the person');
      assert.equal(inserted.user_enrollment_email_address, 'octo.cat@michelin.com', 'the enrollment address is not what the domain check passed');
      assert.equal(Number(inserted.installation_id), 4242);
      assert.equal(inserted.sync_interval_minutes, db.SCHEDULING.SYNC_MIN_INTERVAL_MINUTES);
      assert.equal(inserted.verified, true);

      // The same account, with every value changed: the DO UPDATE clause carries its own
      // numbering and can be wrong where the VALUES list is right.
      await db.installations.verifyInstallation(
        { id: 1234, login: 'monalisa-login', name: 'Mona Lisa the person' },
        'mona.lisa@michelin.com',
        4343
      );

      const updated = await oneRow(columns);

      assert.equal(
        (await oneRow(`SELECT count(*)::int AS n FROM github_installations`)).n,
        1,
        'the second verification did not take the ON CONFLICT path, so this asserts nothing about it'
      );
      assert.equal(Number(updated.user_id), 1234);
      assert.equal(updated.user_login, 'monalisa-login');
      assert.equal(updated.user_name, 'Mona Lisa the person');
      assert.equal(updated.user_enrollment_email_address, 'mona.lisa@michelin.com');
      assert.equal(Number(updated.installation_id), 4343);
      assert.equal(updated.sync_interval_minutes, db.SCHEDULING.SYNC_MIN_INTERVAL_MINUTES);
    });

    test("insertPendingInstallation lands each value in its own column, on the insert and on the conflict update", async () => {
      // Same shape, same hazard: the installation id and the sync interval are two integers side
      // by side in the parameter list, numbered once in VALUES and again in DO UPDATE SET. A
      // pending row is read by nothing except a webhook matching on installation_id, so the two
      // exchanged would surface only as a suspend that quietly matches no row.
      await db.installations.insertPendingInstallation({ id: 1234, login: 'octocat-login' }, 4242);

      const columns = `SELECT user_id, user_login, installation_id, sync_interval_minutes,
                              verified_at, user_enrollment_email_address
                       FROM github_installations`;
      const inserted = await oneRow(columns);

      assert.equal(Number(inserted.user_id), 1234);
      assert.equal(inserted.user_login, 'octocat-login');
      assert.equal(Number(inserted.installation_id), 4242, 'a suspend webhook would match no row');
      assert.equal(inserted.sync_interval_minutes, db.SCHEDULING.SYNC_MIN_INTERVAL_MINUTES);
      assert.equal(inserted.verified_at, null, 'the webhook says nothing about the email address');

      // A reinstall: the same account, a new installation id, through the ON CONFLICT clause.
      await db.installations.insertPendingInstallation({ id: 1234, login: 'monalisa-login' }, 4343);

      const updated = await oneRow(columns);

      assert.equal(
        (await oneRow(`SELECT count(*)::int AS n FROM github_installations`)).n,
        1,
        'the reinstall did not take the ON CONFLICT path, so this asserts nothing about it'
      );
      assert.equal(Number(updated.user_id), 1234);
      assert.equal(updated.user_login, 'monalisa-login');
      assert.equal(Number(updated.installation_id), 4343);
      assert.equal(updated.sync_interval_minutes, db.SCHEDULING.SYNC_MIN_INTERVAL_MINUTES);
    });

    test("verified, then the same-id webhook arrives late: the row stays verified and keeps its lease", async () => {
      // installation.created and the OAuth callback race, and GitHub redelivers webhooks. The
      // webhook carries nothing the verified row does not already know, so arriving second it
      // must change nothing - resetting it left the person pending for good.
      await db.installations.verifyInstallation({ id: 1, login: 'octocat' }, 'octocat@michelin.com', 42);
      await admin.none(`UPDATE ${SCHEMA}.github_installations SET events_etag = 'W/"feed"'`);

      assert.equal((await db.installations.claimInstallationsForSync()).length, 1, 'the fixture holds no lease to protect');

      await db.installations.insertPendingInstallation({ id: 1, login: 'octocat' }, 42);

      const row = await oneRow(
        `SELECT verified_at IS NOT NULL AS verified, user_enrollment_email_address, events_etag,
                sync_claimed_at IS NOT NULL AS leased
         FROM github_installations`
      );

      assert.equal(row.verified, true, 'a late webhook made a verified person pending again');
      assert.equal(row.user_enrollment_email_address, 'octocat@michelin.com');
      assert.equal(row.events_etag, 'W/"feed"');
      assert.equal(row.leased, true, 'the lease a worker holds was cleared, so a second worker can take the row');
    });

    test("a reinstall under a new installation id still re-opens the eligibility question", async () => {
      await enrol('octocat');
      await db.installations.insertPendingInstallation({ id: 1, login: 'octocat' }, 43);

      const row = await oneRow(`SELECT verified_at, user_enrollment_email_address, installation_id FROM github_installations`);

      assert.equal(row.verified_at, null);
      assert.equal(row.user_enrollment_email_address, null);
      assert.equal(Number(row.installation_id), 43);
    });

    test("a claimed installation is not handed to a second claim while its lease holds", async () => {
      await enrol('octocat');

      assert.equal((await db.installations.claimInstallationsForSync()).length, 1);
      assert.equal(
        (await db.installations.claimInstallationsForSync()).length,
        0,
        'two workers running a tick apart would sync the same account twice'
      );
    });

    test("a claim whose lease has expired is handed out again, so a dead worker does not strand a row", async () => {
      await enrol('octocat');
      await db.installations.claimInstallationsForSync();
      await expireLease('github_installations', 'sync_claimed_at');

      assert.equal((await db.installations.claimInstallationsForSync()).length, 1);
    });

    test("a release from a worker whose row was renamed or re-enrolled meanwhile changes nothing", async () => {
      // The worker decides on the counts its claim returned. A rename found by the
      // reconciliation, or the person signing in again, resets those counts and clears the lease
      // while it is still running; the old login then 404s, and the snapshot says it is the
      // third in a row. Written, that retires an account that was just repaired - for good,
      // since the login now matches and no reconciliation will ever see it as stale again.
      await enrol('octocat');
      await admin.none(`UPDATE ${SCHEMA}.github_installations SET sync_404_count = 2, sync_error_count = 2`);

      const [renamedUnder] = await db.installations.claimInstallationsForSync();

      await db.installations.refreshStaleLogins([{ id: 42, account: { login: 'monalisa' } }]);

      assert.equal(
        await db.installations.markSyncFailed(renamedUnder, 3600, 'Not Found', 'account gone', true),
        false,
        'a superseded outcome is reported as dropped, not as a failure to throw'
      );

      const columns = `SELECT sync_disabled_at, sync_404_count, sync_error_count, last_sync_error,
                              sync_claimed_at, next_sync_at <= CURRENT_TIMESTAMP AS due
                       FROM github_installations`;
      const repaired = { sync_disabled_at: null, sync_404_count: 0, sync_error_count: 0, last_sync_error: null, sync_claimed_at: null, due: true };

      assert.deepEqual(await oneRow(columns), repaired, 'the stale verdict was written over the rename');

      // The same with a success, after the person enrolled again: the backoff and the interval
      // it would write belong to the row as it was.
      const [reenrolledUnder] = await db.installations.claimInstallationsForSync();

      await enrol('monalisa');

      assert.equal(await db.installations.markSyncSucceeded(reenrolledUnder, { intervalMinutes: 60, delaySeconds: 3600, etag: 'W/"stale"' }), false);
      assert.deepEqual(await oneRow(columns), repaired, 'a re-enrolled person waits out the outcome of a run that started before they did');
      assert.equal((await oneRow(`SELECT events_etag FROM github_installations`)).events_etag, null);
    });

    test("a release from a worker whose lease ran out and was taken again changes nothing, and the new holder's does", async () => {
      await enrol('octocat');

      const [first] = await db.installations.claimInstallationsForSync();

      await expireLease('github_installations', 'sync_claimed_at');

      const [second] = await db.installations.claimInstallationsForSync();

      assert.notEqual(second.lease, first.lease);
      assert.equal(await db.installations.markSyncFailed(first, 3600, 'Bad Gateway'), false);

      const held = await oneRow(`SELECT sync_error_count, sync_claimed_at::text AS lease FROM github_installations`);

      assert.deepEqual(held, { sync_error_count: 0, lease: second.lease }, 'the stale worker released a row another one holds');
      assert.equal(await db.installations.markSyncSucceeded(second, { intervalMinutes: 15, delaySeconds: 60, etag: null }), true);
      assert.equal((await oneRow(`SELECT sync_claimed_at FROM github_installations`)).sync_claimed_at, null);
    });

    test("markSyncSucceeded releases the lease, pushes the due time out and clears the failure", async () => {
      await enrol('octocat');

      const [claimed] = await db.installations.claimInstallationsForSync();

      await db.installations.markSyncFailed(claimed, 0, 'Not Found');

      const [again] = await db.installations.claimInstallationsForSync();

      assert.equal(await db.installations.markSyncSucceeded(again, { intervalMinutes: 30, delaySeconds: 600, etag: 'W/"abc"' }), true);

      const row = await oneRow(
        `SELECT sync_claimed_at, sync_error_count, last_sync_error, events_etag, sync_interval_minutes,
                next_sync_at > CURRENT_TIMESTAMP AS pushed_out
         FROM github_installations`
      );

      assert.equal(row.sync_claimed_at, null);
      assert.equal(row.sync_error_count, 0);
      assert.equal(row.last_sync_error, null, 'the page would keep reporting a failure that has been repaired');
      assert.equal(row.events_etag, 'W/"abc"');
      assert.equal(row.sync_interval_minutes, 30);
      assert.equal(row.pushed_out, true);
      assert.equal((await db.installations.claimInstallationsForSync()).length, 0, 'a row just synced is not due');
    });

    test("markSyncSucceeded keeps the stored etag when the sync had none to report", async () => {
      // COALESCE, not assignment: a 304 reports no new etag, and overwriting it with null would
      // make the next request unconditional and cost a rate-limit hit every time.
      const id = await enrol('octocat');

      await db.installations.markSyncSucceeded(await lease('github_installations', id), { intervalMinutes: 15, delaySeconds: 60, etag: 'W/"first"' });
      await db.installations.markSyncSucceeded(await lease('github_installations', id), { intervalMinutes: 15, delaySeconds: 60, etag: null });

      assert.equal((await oneRow(`SELECT events_etag FROM github_installations`)).events_etag, 'W/"first"');
    });

    test("markSyncFailed counts the failure and retires the row only when it is given a reason", async () => {
      await enrol('octocat');

      const [claimed] = await db.installations.claimInstallationsForSync();

      await db.installations.markSyncFailed(claimed, 0, 'Not Found', null);

      const retrying = await oneRow(`SELECT sync_error_count, last_sync_error, sync_disabled_at FROM github_installations`);

      assert.equal(retrying.sync_error_count, 1);
      assert.equal(retrying.last_sync_error, 'Not Found');
      assert.equal(retrying.sync_disabled_at, null, 'one failure must not retire an account');

      const [again] = await db.installations.claimInstallationsForSync();

      assert.ok(again, 'a failing row stays in the queue');

      await db.installations.markSyncFailed(again, 0, 'Not Found', 'account gone');

      const retired = await oneRow(`SELECT sync_error_count, sync_disabled_at, sync_disabled_reason FROM github_installations`);

      assert.equal(retired.sync_error_count, 2);
      assert.notEqual(retired.sync_disabled_at, null);
      assert.equal(retired.sync_disabled_reason, 'account gone');
      assert.equal((await db.installations.claimInstallationsForSync()).length, 0, 'a retired row has left the queue');
    });

    test("sync_404_count counts consecutive 404s only: any other outcome starts it again", async () => {
      const id = await enrol('octocat');
      const count404 = async () => (await oneRow(`SELECT sync_404_count, sync_error_count FROM github_installations`));

      const held = () => lease('github_installations', id);

      await db.installations.markSyncFailed(await held(), 0, 'Not Found', null, true);
      await db.installations.markSyncFailed(await held(), 0, 'Not Found', null, true);

      assert.deepEqual(await count404(), { sync_404_count: 2, sync_error_count: 2 });

      await db.installations.markSyncFailed(await held(), 0, 'Bad Gateway', null, false);

      assert.deepEqual(await count404(), { sync_404_count: 0, sync_error_count: 3 }, 'a 502 between two 404s is not a run');

      await db.installations.markSyncFailed(await held(), 0, 'Not Found', null, true);
      await db.installations.markSyncSucceeded(await held(), { intervalMinutes: 15, delaySeconds: 60, etag: null });

      assert.deepEqual(await count404(), { sync_404_count: 0, sync_error_count: 0 });
    });

    test("re-enrolling clears the retirement, because the person answered in their own voice", async () => {
      await enrol('octocat');

      const [claimed] = await db.installations.claimInstallationsForSync();

      await db.installations.markSyncFailed(claimed, 0, 'Not Found', 'repeated failures');
      await enrol('octocat');

      assert.equal((await db.installations.claimInstallationsForSync()).length, 1);
    });

    test("countInstallationStates returns the five counts the report and the job summaries read, as numbers", async () => {
      await enrol('octocat', { userId: 1, installationId: 42 });
      await db.installations.insertPendingInstallation({ id: 2, login: 'hubber' }, 43);

      const counts = await db.installations.countInstallationStates();

      assert.deepEqual(Object.keys(counts).sort(), ['active', 'disabled', 'due', 'pending', 'suspended']);
      // ::int, and it is load-bearing: count(*) is a bigint, which the driver hands back as a
      // STRING, and the report would carry "1" where the page adds numbers up.
      for (const [name, value] of Object.entries(counts)) {
        assert.equal(typeof value, 'number', `${name} is not a number`);
      }

      assert.deepEqual(counts, { active: 1, pending: 1, suspended: 0, disabled: 0, due: 1 });
    });
  });

  describe("a renamed login", () => {
    test("refreshStaleLogins carries the contributions across, so the renamed user's pull requests stay claimable", async () => {
      // The regression this file exists for. Every query that decides whether a contribution is
      // polled joins the person on the NAME, so rewriting the installation alone orphans every
      // pull request the renamed user ever opened: the poll claim stops matching and an open
      // contribution is never checked again.
      await enrol('octocat');
      await contribute();

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1, 'the fixture is not claimable to begin with');

      await expireLease('github_pull_requests', 'poll_claimed_at');

      const renames = await db.installations.refreshStaleLogins([{ id: 42, account: { login: 'monalisa' } }]);

      assert.deepEqual(renames, [{ old_login: 'octocat', new_login: 'monalisa' }]);
      assert.equal((await oneRow(`SELECT user_login FROM github_installations`)).user_login, 'monalisa');
      assert.equal((await oneRow(`SELECT opened_by FROM github_pull_requests`)).opened_by, 'monalisa');
      assert.equal(
        (await db.polling.claimPullRequestsForPoll()).length,
        1,
        'the contribution was orphaned by the rename - it will never be polled again'
      );
    });

    test("a reinstall under a new login carries the contributions, which the reconciliation would no longer see", async () => {
      // Renamed, then reinstalled: the webhook stores the new login before the hourly
      // reconciliation runs, and that reconciliation then finds nothing stale to carry.
      await enrol('octocat');
      await contribute();
      await contribute({ id: 7002, number: 2, user: { login: 'hubber', type: 'User' } });

      await db.installations.insertPendingInstallation({ id: 1, login: 'monalisa' }, 42);

      assert.equal(
        (await oneRow(`SELECT opened_by FROM github_pull_requests WHERE number = 7`)).opened_by,
        'octocat',
        'the same installation id rewrites no login, so nothing may move either'
      );

      await db.installations.insertPendingInstallation({ id: 1, login: 'monalisa' }, 43);
      await db.installations.verifyInstallation({ id: 1, login: 'monalisa' }, 'monalisa@michelin.com', 43);

      assert.deepEqual(
        await rowsOf(`SELECT number, opened_by FROM github_pull_requests ORDER BY number`),
        [{ number: 2, opened_by: 'hubber' }, { number: 7, opened_by: 'monalisa' }],
        "the renamed user's pull request was left under the old login, or somebody else's moved with it"
      );
      assert.deepEqual(await db.installations.refreshStaleLogins([{ id: 43, account: { login: 'monalisa' } }]), []);
      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1, 'the contribution was orphaned by the reinstall');
    });

    test("re-enrolling under a new login carries the contributions too", async () => {
      await enrol('octocat');
      await contribute();

      await db.installations.verifyInstallation({ id: 1, login: 'monalisa' }, 'monalisa@michelin.com', 42);

      assert.equal((await oneRow(`SELECT opened_by FROM github_pull_requests`)).opened_by, 'monalisa');
      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1, 'the contribution was orphaned by the re-enrollment');
    });

    test("a reinstall by the previous holder of a freed login leaves the new holder's pull requests alone", async () => {
      // Uninstalled, then renamed: somebody else registered the freed 'octocat' and enrolled.
      // The returning user's row still stores 'octocat', but the pull requests under it are
      // no longer theirs to take.
      const { InstallationEvent } = await import("../src/utils/types.js");

      await db.installations.insertPendingInstallation({ id: 1, login: 'octocat' }, 41);
      await db.installations.handleInstallationEvent(InstallationEvent.DELETED, 41);
      await enrol('octocat', { userId: 2, installationId: 42 });
      await contribute();

      await db.installations.insertPendingInstallation({ id: 1, login: 'monalisa' }, 43);
      await db.installations.verifyInstallation({ id: 1, login: 'monalisa' }, 'monalisa@michelin.com', 43);

      assert.equal(
        (await oneRow(`SELECT opened_by FROM github_pull_requests`)).opened_by,
        'octocat',
        "the new holder's pull request was handed to the old holder of the login"
      );
      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1, "the new holder's pull request left their poll");
    });

    test("a rename clears a retirement made for 'account gone' and leaves any other one standing", async () => {
      const octocat = await enrol('octocat', { userId: 1, installationId: 42 });
      const hubber = await enrol('hubber', { userId: 2, installationId: 43 });

      await db.installations.markSyncFailed(await lease('github_installations', octocat), 0, '404', 'account gone');
      await db.installations.markSyncFailed(await lease('github_installations', hubber), 0, 'boom', 'repeated failures');

      await db.installations.refreshStaleLogins([
        { id: 42, account: { login: 'monalisa' } },
        { id: 43, account: { login: 'hubbard' } },
      ]);

      const after = await rowsOf(`SELECT user_login, sync_disabled_reason, sync_error_count FROM github_installations ORDER BY id`);

      assert.deepEqual(after[0], { user_login: 'monalisa', sync_disabled_reason: null, sync_error_count: 0 });
      assert.deepEqual(after[1], { user_login: 'hubbard', sync_disabled_reason: 'repeated failures', sync_error_count: 0 });
    });

    test("refreshStaleLogins reports nothing when every stored login already matches", async () => {
      await enrol('octocat');

      assert.deepEqual(await db.installations.refreshStaleLogins([{ id: 42, account: { login: 'octocat' } }]), []);
      assert.deepEqual(await db.installations.refreshStaleLogins([]), []);
    });
  });

  describe("the pull request poll queue", () => {
    test("a hand-entered contribution is never claimed, because there is nothing on github.com to fetch", async () => {
      await enrol('octocat');
      await contribute();
      await admin.none(`UPDATE ${SCHEMA}.github_pull_requests SET origin = 'manual'`);

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 0);
    });

    test("a contribution whose author never passed the email check is not claimed", async () => {
      // A row that exists and is pending, not an absent one: the claim joins the installation,
      // so an absent row would be out of the queue whatever the predicates say.
      await contribute();
      await db.installations.insertPendingInstallation({ id: 1, login: 'octocat' }, 42);

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 0);

      await db.installations.verifyInstallation({ id: 1, login: 'octocat' }, 'octocat@michelin.com', 42);

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1);
    });

    test("a closed contribution has left the queue for good", async () => {
      await enrol('octocat');
      await contribute();
      await admin.none(`UPDATE ${SCHEMA}.github_pull_requests SET state = 'closed'`);

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 0);
    });

    test("the poll claim hands the job the GitHub id its request is built from", async () => {
      await enrol('octocat');
      await contribute();

      const [claimed] = await db.polling.claimPullRequestsForPoll();

      assert.equal(Number(claimed.github_id), 9001, 'the request would be built by name, which a rename breaks');
      assert.equal(claimed.full_name, 'acme/widget');
      assert.equal(claimed.number, 7);
      assert.equal(Number(claimed.installation_id), 42, 'there is no token to authenticate the fetch with');
    });

    test("the poll claim reads with the live installation when two rows share the author's login", async () => {
      // An uninstalled account whose login was freed and enrolled again by somebody else: the
      // dead row cannot mint a token, and picking it failed every poll of that author.
      const { InstallationEvent } = await import("../src/utils/types.js");

      await db.installations.insertPendingInstallation({ id: 1, login: 'octocat' }, 41);
      await db.installations.handleInstallationEvent(InstallationEvent.DELETED, 41);
      await enrol('octocat', { userId: 2, installationId: 42 });
      await contribute();

      const [claimed] = await db.polling.claimPullRequestsForPoll();

      assert.equal(Number(claimed.installation_id), 42);
    });

    test("the poll claim is a lease too: held once, handed out again once it is stale", async () => {
      await enrol('octocat');
      await contribute();

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1);
      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 0);

      await expireLease('github_pull_requests', 'poll_claimed_at');

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1);
    });

    test("a poll release from a worker whose lease ran out and was taken again changes nothing", async () => {
      await enrol('octocat');
      await contribute();

      const [first] = await db.polling.claimPullRequestsForPoll();

      await expireLease('github_pull_requests', 'poll_claimed_at');

      const [second] = await db.polling.claimPullRequestsForPoll();

      assert.equal(await db.polling.markPollFailed(first, 3600, 'Bad gateway'), false);
      assert.deepEqual(
        await oneRow(`SELECT poll_error_count, last_poll_error, poll_claimed_at::text AS lease FROM github_pull_requests`),
        { poll_error_count: 0, last_poll_error: null, lease: second.lease },
        'the stale worker released a row another one holds'
      );
      assert.equal(await db.polling.markPollSucceeded(second, { intervalMinutes: 45, delaySeconds: 900 }), true);
    });

    test("markPollSucceeded and markPollFailed move only the scheduling columns", async () => {
      await enrol('octocat');
      await contribute();

      const [claimed] = await db.polling.claimPullRequestsForPoll();

      await db.polling.markPollFailed(claimed, 0, 'Bad gateway');

      const failed = await oneRow(`SELECT poll_error_count, last_poll_error, poll_claimed_at FROM github_pull_requests`);

      assert.equal(failed.poll_error_count, 1);
      assert.equal(failed.last_poll_error, 'Bad gateway');
      assert.equal(failed.poll_claimed_at, null, 'a failed poll that keeps its lease strands the row for the lease window');

      const [again] = await db.polling.claimPullRequestsForPoll();

      await db.polling.markPollSucceeded(again, { intervalMinutes: 45, delaySeconds: 900 });

      const succeeded = await oneRow(
        `SELECT poll_error_count, last_poll_error, poll_claimed_at, poll_interval_minutes, title,
                next_poll_at > CURRENT_TIMESTAMP AS pushed_out
         FROM github_pull_requests`
      );

      assert.equal(succeeded.poll_error_count, 0);
      assert.equal(succeeded.last_poll_error, null);
      assert.equal(succeeded.poll_claimed_at, null);
      assert.equal(succeeded.poll_interval_minutes, 45);
      assert.equal(succeeded.pushed_out, true);
      assert.equal(succeeded.title, 'Teach the widget to spin', 'the poll cursor rewrote the contribution');
    });
  });

  describe("the repository registry", () => {
    test("ensureRepository called twice for the same GitHub id keeps one row, whatever it is called now", async () => {
      // The ON CONFLICT target is a PARTIAL unique index, which PostgreSQL will not infer from
      // the column alone: a clause that stops matching it raises 42P10 at run time, and a
      // conflict target that stops matching at all gives every event its own duplicate row.
      const first = await db.repositories.ensureRepository('acme/widget', 9001);
      const again = await db.repositories.ensureRepository('acme/widget-renamed', 9001);

      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.equal(again.id, first.id);
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_repositories`)).n, 1);
      // The insert lost the race, so the name it carried was never written: the refresh owns it.
      assert.equal((await oneRow(`SELECT full_name FROM github_repositories`)).full_name, 'acme/widget');
    });

    test("ensureRepository refuses a repository with no GitHub id rather than inserting a twin nothing can tell apart", async () => {
      await assert.rejects(
        () => db.repositories.ensureRepository('acme/widget', null),
        /refusing to record the repository acme\/widget without a GitHub id/
      );
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_repositories`)).n, 0);
    });

    test("a repository is claimed for refresh with an installation to read it with, and released by markRefreshSucceeded", async () => {
      await enrol('octocat');
      await db.repositories.ensureRepository('acme/widget', 9001);

      const [claimed] = await db.repositories.claimRepositoriesForRefresh();

      assert.equal(Number(claimed.github_id), 9001);
      assert.equal(Number(claimed.installation_id), 42, 'the refresh has no token to make its request with');
      assert.equal((await db.repositories.claimRepositoriesForRefresh()).length, 0, 'the lease did not hold');

      await db.repositories.markRefreshSucceeded(claimed, fetched({ full_name: 'acme/widget-renamed' }), 'W/"r1"', 3600);

      const row = await oneRow(
        `SELECT full_name, stargazers_count, subscribers_count, license, topics, primary_language,
                archived, etag, refresh_claimed_at, refresh_error_count, last_refresh_error,
                next_refresh_at > CURRENT_TIMESTAMP AS pushed_out
         FROM github_repositories`
      );

      assert.equal(row.full_name, 'acme/widget-renamed', 'a rename is only ever noticed here');
      assert.equal(row.stargazers_count, 341);
      assert.equal(row.subscribers_count, 9, 'watchers_count is an alias of the star count and must not be stored');
      assert.equal(row.license, 'apache-2.0');
      assert.deepEqual(row.topics, ['tyres', 'widgets']);
      assert.equal(row.primary_language, 'JavaScript');
      assert.equal(row.archived, false);
      assert.equal(row.etag, 'W/"r1"');
      assert.equal(row.refresh_claimed_at, null);
      assert.equal(row.refresh_error_count, 0);
      assert.equal(row.last_refresh_error, null);
      assert.equal(row.pushed_out, true);
    });

    test("a refresh release from a worker whose lease ran out and was taken again changes nothing", async () => {
      // gone_at is one-way, so this is the release that cannot be undone by the next run.
      await enrol('octocat');
      await db.repositories.ensureRepository('acme/widget', 9001);

      const [first] = await db.repositories.claimRepositoriesForRefresh();

      await expireLease('github_repositories', 'refresh_claimed_at');

      const [second] = await db.repositories.claimRepositoriesForRefresh();

      for (const release of [
        () => db.repositories.markRepositoryGone(first, '404 by id after 3 attempts'),
        () => db.repositories.markRefreshFailed(first, 3600, 'Not Found', true),
        () => db.repositories.markRefreshUnchanged(first, 3600),
        () => db.repositories.markRefreshSucceeded(first, fetched({ full_name: 'acme/stale' }), 'W/"stale"', 3600),
      ]) {
        assert.equal(await release(), false);
      }

      assert.deepEqual(
        await oneRow(`SELECT full_name, gone_at, refresh_error_count, etag, refresh_claimed_at::text AS lease FROM github_repositories`),
        { full_name: 'acme/widget', gone_at: null, refresh_error_count: 0, etag: null, lease: second.lease },
        'the stale worker released a row another one holds'
      );
      assert.equal(await db.repositories.markRefreshUnchanged(second, 3600), true);
    });

    test("markRefreshSucceeded never rewrites the GitHub id, which is the row's identity", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.repositories.markRefreshSucceeded(await lease('github_repositories', id), fetched({ id: 12345 }), null, 60);

      assert.equal(Number((await oneRow(`SELECT github_id FROM github_repositories`)).github_id), 9001);
    });

    test("markRefreshUnchanged moves the cursor and nothing else, and recordRename keeps the name it replaced", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.repositories.markRefreshSucceeded(await lease('github_repositories', id), fetched(), 'W/"r1"', 60);
      await db.repositories.markRefreshUnchanged(await lease('github_repositories', id), 3600);

      const row = await oneRow(`SELECT etag, stargazers_count, refresh_error_count FROM github_repositories`);

      assert.equal(row.etag, 'W/"r1"', 'a 304 threw away the etag that produced it');

      await db.repositories.markRefreshSucceeded(await lease('github_repositories', id), fetched(), null, 60);

      assert.equal(
        (await oneRow(`SELECT etag FROM github_repositories`)).etag,
        'W/"r1"',
        'a refresh that reported no etag cleared the one stored, so the next request is unconditional'
      );
      assert.equal(row.stargazers_count, 341);
      assert.equal(row.refresh_error_count, 0);

      await db.repositories.recordRename(id, 'acme/widget', 'acme/widget-renamed');

      assert.deepEqual(
        await oneRow(`SELECT repository_id, old_full_name, new_full_name FROM github_repository_renames`),
        { repository_id: id, old_full_name: 'acme/widget', new_full_name: 'acme/widget-renamed' }
      );
    });

    test("markRepositoryGone takes the repository out of the refresh queue and keeps the FIRST sighting", async () => {
      await enrol('octocat');

      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.repositories.markRefreshFailed(await lease('github_repositories', id), 0, 'Not Found', true);
      assert.equal((await db.repositories.claimRepositoriesForRefresh()).length, 1, 'a failed refresh leaves the queue');
      assert.equal(
        (await oneRow(`SELECT last_refresh_error FROM github_repositories`)).last_refresh_error,
        'Not Found',
        'the page says why the last refresh failed'
      );

      await db.repositories.markRepositoryGone(await lease('github_repositories', id), '404 Not Found');

      const first = await oneRow(`SELECT gone_at, refresh_error_count, refresh_404_count FROM github_repositories`);

      assert.notEqual(first.gone_at, null);
      assert.equal(first.refresh_error_count, 2);
      assert.equal(first.refresh_404_count, 2);
      assert.equal((await db.repositories.claimRepositoriesForRefresh()).length, 0);

      await db.repositories.markRepositoryGone(await lease('github_repositories', id), '410 Gone');

      assert.deepEqual(
        (await oneRow(`SELECT gone_at FROM github_repositories`)).gone_at,
        first.gone_at,
        'a second sighting is not new information and must not move the date'
      );
    });
  });

  describe("the repository refresh's run of 404s", () => {
    test("refresh_404_count counts consecutive 404s only, and a refresh that answered clears it", async () => {
      await enrol('octocat');

      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);
      const counts = async () => oneRow(`SELECT refresh_404_count, refresh_error_count FROM github_repositories`);

      const held = () => lease('github_repositories', id);

      await db.repositories.markRefreshFailed(await held(), 0, 'Not Found', true);
      await db.repositories.markRefreshFailed(await held(), 0, 'Not Found', true);

      assert.deepEqual(await counts(), { refresh_404_count: 2, refresh_error_count: 2 });

      await db.repositories.markRefreshFailed(await held(), 0, 'timeout');

      assert.deepEqual(await counts(), { refresh_404_count: 0, refresh_error_count: 3 });

      await db.repositories.markRefreshFailed(await held(), 0, 'Not Found', true);

      const [claimed] = await db.repositories.claimRepositoriesForRefresh();

      assert.equal(claimed.refresh_404_count, 1, 'the job decides on what the claim hands it');

      await db.repositories.markRefreshUnchanged(claimed, 60);

      assert.deepEqual(await counts(), { refresh_404_count: 0, refresh_error_count: 0 });
    });
  });

  describe("hydration", () => {
    test("a second upsert refreshes the state and leaves the contribution-time snapshot frozen", async () => {
      // The columns left out of the ON CONFLICT clause are the one figure this row is uniquely
      // able to answer for. Refreshed on every poll they become one star count per contribution,
      // each frozen at its own last poll, and no current value either.
      const repositoryId = await contribute();

      await db.pullRequests.upsertPullRequest(hydrated({
        title: 'Teach the widget to spin faster',
        state: 'closed',
        merged: true,
        merged_at: '2026-02-01T09:00:00.000Z',
        merged_by: { login: 'maintainer' },
        commits: 5,
        base: {
          ref: 'main',
          repo: {
            full_name: 'acme/widget-renamed',
            license: { key: 'mit' },
            topics: ['rubber'],
            forks_count: 99,
            stargazers_count: 999,
          },
        },
      }), repositoryId);

      const row = await oneRow(
        `SELECT title, state, merged, merged_by, commits_count, dest_repo, license, topics,
                forks_count, stargazers_count
         FROM github_pull_requests`
      );

      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_pull_requests`)).n, 1);
      assert.equal(row.title, 'Teach the widget to spin faster');
      assert.equal(row.state, 'closed');
      assert.equal(row.merged, true);
      assert.equal(row.merged_by, 'maintainer');
      assert.equal(row.commits_count, 5);
      assert.equal(row.dest_repo, 'acme/widget', 'dest_repo is frozen at first sighting');
      assert.equal(row.license, 'apache-2.0', 'the licence is the contribution-time snapshot');
      assert.deepEqual(row.topics, ['tyres']);
      assert.equal(row.forks_count, 12);
      assert.equal(row.stargazers_count, 340, "today's star count belongs on github_repositories");
    });

    test("state_changed_at moves only when the state actually moved", async () => {
      // It measures detection latency. Stamped by every poll it would measure the poll interval.
      const repositoryId = await contribute();

      const first = (await oneRow(`SELECT state_changed_at FROM github_pull_requests`)).state_changed_at;

      await db.pullRequests.upsertPullRequest(hydrated({ title: 'Retitled, still open' }), repositoryId);

      assert.deepEqual(
        (await oneRow(`SELECT state_changed_at FROM github_pull_requests`)).state_changed_at,
        first,
        'a poll that found no state change stamped the row anyway'
      );

      await db.pullRequests.upsertPullRequest(hydrated({ state: 'closed' }), repositoryId);

      assert.notDeepEqual((await oneRow(`SELECT state_changed_at FROM github_pull_requests`)).state_changed_at, first);
    });

    test("an upsert cannot move a contribution to another repository", async () => {
      const repositoryId = await contribute();
      const { id: other } = await db.repositories.ensureRepository('acme/other', 9002);

      await db.pullRequests.upsertPullRequest(hydrated(), other);

      assert.equal((await oneRow(`SELECT repository_id FROM github_pull_requests`)).repository_id, repositoryId);
    });

    test("a pull request reopened and merged by somebody else is refreshed, and is back in the poll queue", async () => {
      // A stale bot closed it, the poll stored `closed`, and the row left the queue. The reopen
      // and the merge are in the MAINTAINER's feed, whose hydration is the only news the
      // author's row will ever get.
      await enrol('octocat');

      const repositoryId = await contribute();

      await db.pullRequests.upsertPullRequest(hydrated({ state: 'closed', closed_at: '2026-01-05T10:00:00.000Z' }), repositoryId);
      await admin.none(
        `UPDATE ${SCHEMA}.github_pull_requests
         SET next_poll_at = CURRENT_TIMESTAMP + interval '4 hours', state_changed_at = '2026-01-05T10:00:00Z',
             created_timestamp = CURRENT_TIMESTAMP - interval '90 days'`
      );

      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 0, 'the closed row is out of the queue');

      // `user: null`: the response may name nobody, and who opened it is not this path's to say.
      const reopened = await db.pullRequests.refreshPullRequest(hydrated({
        state: 'open',
        closed_at: null,
        updated_at: '2026-02-01T09:00:00.000Z',
        user: null,
        base: { ref: 'main', repo: { full_name: 'acme/widget', stargazers_count: 999 } },
      }));

      assert.equal(reopened, true);

      const row = await oneRow(
        `SELECT state, closed_at, opened_by, user_type, stargazers_count, next_poll_at,
                state_changed_at > '2026-01-05T10:00:00Z'::timestamptz AS stamped
         FROM github_pull_requests`
      );

      assert.equal(row.state, 'open');
      assert.equal(row.closed_at, null);
      assert.equal(row.stamped, true, 'the reopen is a state change, and detection latency is measured from it');
      assert.ok(row.next_poll_at !== null && row.next_poll_at <= new Date(), 'a reopened row waited out the interval of the poll that closed it');
      assert.equal(row.opened_by, 'octocat');
      assert.equal(row.user_type, 'User');
      assert.equal(row.stargazers_count, 340, 'the contribution-time snapshot stays frozen');
      // Due now rather than NULL: the ops page reads NULL as never scheduled, late since the row
      // was recorded - 90 days here, and a red card for a row the next tick will take anyway.
      assert.equal((await db.dashboard.getSubjectStates()).poll.overdue, 0, 'the reopened row shows as late by its whole age');
      assert.equal((await db.polling.claimPullRequestsForPoll()).length, 1, 'the reopened row is due again');

      await db.pullRequests.refreshPullRequest(hydrated({
        state: 'closed',
        updated_at: '2026-02-02T09:00:00.000Z',
        merged: true,
        merged_at: '2026-02-02T09:00:00.000Z',
        closed_at: '2026-02-02T09:00:00.000Z',
        merged_by: { login: 'maintainer' },
        commits: 5,
      }));

      const merged = await oneRow(`SELECT state, merged, merged_at, merged_by, commits_count FROM github_pull_requests`);

      assert.deepEqual(
        { ...merged, merged_at: merged.merged_at.toISOString() },
        { state: 'closed', merged: true, merged_at: '2026-02-02T09:00:00.000Z', merged_by: 'maintainer', commits_count: 5 }
      );
    });

    test("a refresh with no state change leaves the poll schedule and state_changed_at alone", async () => {
      await enrol('octocat');
      await contribute();
      await admin.none(
        `UPDATE ${SCHEMA}.github_pull_requests
         SET next_poll_at = '2099-01-01T00:00:00Z', state_changed_at = '2026-01-05T10:00:00Z'`
      );

      await db.pullRequests.refreshPullRequest(hydrated({ title: 'Labelled by a maintainer' }));

      const row = await oneRow(`SELECT title, next_poll_at, state_changed_at FROM github_pull_requests`);

      assert.equal(row.title, 'Labelled by a maintainer');
      assert.equal(row.next_poll_at.toISOString(), '2099-01-01T00:00:00.000Z');
      assert.equal(row.state_changed_at.toISOString(), '2026-01-05T10:00:00.000Z');
    });

    test("a refresh never goes back in time", async () => {
      // The maintainer's sync read `closed` before the author reopened it, and the author's own
      // sync stored the reopen first. Written now, that older read closes the row again, and a
      // closed row is one the poll never reads back.
      await enrol('octocat');
      await contribute({ updated_at: '2026-02-01T09:00:00.000Z' });

      const refreshed = await db.pullRequests.refreshPullRequest(hydrated({
        state: 'closed',
        closed_at: '2026-01-20T09:00:00.000Z',
        updated_at: '2026-01-20T09:00:00.000Z',
      }));

      assert.equal(refreshed, false);
      assert.equal((await oneRow(`SELECT state FROM github_pull_requests`)).state, 'open');
    });

    test("a refresh never creates a row, and never touches a hand-entered one", async () => {
      // A maintainer's feed is full of other people's pull requests: a row exists only for one an
      // enrolled person opened. And a manual row's id is the other forge's, free to collide.
      assert.equal(await db.pullRequests.refreshPullRequest(hydrated()), false);
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_pull_requests`)).n, 0);

      await contribute({ state: 'closed' });
      await admin.none(`UPDATE ${SCHEMA}.github_pull_requests SET origin = 'manual'`);

      assert.equal(await db.pullRequests.refreshPullRequest(hydrated({ state: 'open' })), false);
      assert.equal((await oneRow(`SELECT state FROM github_pull_requests`)).state, 'closed');
    });
  });

  describe("the event ledger", () => {
    const prEvent = (eventId, over = {}) => ({
      id: eventId,
      created_at: '2026-01-02T10:00:00.000Z',
      // Whose feed the event came from - the person who performed the action, who is not
      // necessarily the author of the pull request.
      actor: { login: 'octocat' },
      repo: { name: 'acme/widget' },
      payload: { number: 7, action: 'opened', pull_request: { id: 5001 } },
      ...over,
    });

    const pushEvent = (eventId) => ({
      id: eventId,
      created_at: '2026-01-02T10:05:00.000Z',
      actor: { login: 'octocat' },
      repo: { name: 'acme/widget' },
      payload: { push_id: 900 + eventId, ref: 'refs/heads/main', distinct_size: 2, size: 3 },
    });

    test("an event already in the ledger is not noted a second time, and that lookup is the API budget", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      assert.deepEqual(
        await db.events.insertPullRequestEventIfNotExists(prEvent(77), id),
        { isNew: true, hydrated: false },
        'a row this statement has just created cannot already carry its snapshot'
      );
      assert.deepEqual(
        await db.events.insertPullRequestEventIfNotExists(prEvent(77), id),
        { isNew: false, hydrated: false },
        'a known event reported as new is re-hydrated on every run for ever'
      );
      assert.equal(await db.events.insertPushEventIfNotExists(pushEvent(78), id), true);
      assert.equal(await db.events.insertPushEventIfNotExists(pushEvent(78), id), false);

      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_pull_request_events`)).n, 1);

      const push = await oneRow(`SELECT repository_branch, commits_count, actor FROM github_push_events`);

      assert.deepEqual(push, { repository_branch: 'main', commits_count: 2, actor: 'octocat' });
    });

    test("the ledger records who performed the event, which is not who opened the pull request", async () => {
      // The one attribution available at insert time, and the only one this table can ever have:
      // the envelope's payload.pull_request carries base, head, id, number and url, and no
      // author. Without this column the ledger says an assignment happened and cannot say by
      // whom, so no report on review or maintenance work can ever be built from it.
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.events.insertPullRequestEventIfNotExists(
        prEvent(91, { actor: { login: 'AlexisSouquiere' }, payload: { number: 3212, action: 'assigned', pull_request: { id: 5002 } } }),
        id
      );

      assert.deepEqual(
        await oneRow(`SELECT actor, action FROM github_pull_request_events WHERE event_id = 91`),
        { actor: 'AlexisSouquiere', action: 'assigned' }
      );
    });

    test("an event noted but never hydrated is offered again, so a failed fetch is not permanent", async () => {
      // The ledger row is committed BEFORE the hydration call, so a fetch that failed - a 403 at
      // the rate limit, a 5xx, a socket hung up - leaves the event stored with an empty snapshot
      // and no github_pull_requests row. While this answered on `isNew` alone, the next run saw a
      // known event and skipped it: the contribution was never fetched again by any run, and the
      // only trace was one warn line. `hydrated` is what lets the job tell the two apart.
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.events.insertPullRequestEventIfNotExists(prEvent(77), id);

      const afterFailedFetch = await db.events.insertPullRequestEventIfNotExists(prEvent(77), id);

      assert.deepEqual(
        afterFailedFetch,
        { isNew: false, hydrated: false },
        'a stored event with a NULL snapshot must not be reported as complete'
      );

      await db.events.recordPullRequestSnapshot(77, hydrated({ state: 'open' }));

      assert.deepEqual(
        await db.events.insertPullRequestEventIfNotExists(prEvent(77), id),
        { isNew: false, hydrated: true },
        'once the snapshot is in, the event is done and must never cost another fetch'
      );

      assert.equal(
        (await oneRow(`SELECT count(*)::int AS n FROM github_pull_request_events`)).n,
        1,
        'and none of that wrote a second ledger row'
      );
    });

    test("the snapshot is written in a second go, by the hydration the note authorised", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.events.insertPullRequestEventIfNotExists(prEvent(77), id);

      assert.equal(
        (await oneRow(`SELECT state FROM github_pull_request_events`)).state,
        null,
        'the snapshot cannot be known before the fetch the note exists to authorise'
      );

      await db.events.recordPullRequestSnapshot(77, hydrated({
        state: 'closed',
        merged: true,
        merged_by: { login: 'maintainer' },
      }));

      const row = await oneRow(
        `SELECT state, merged, merged_by, commits_count, changed_files, license, topics,
                forks_count, stargazers_count
         FROM github_pull_request_events`
      );

      assert.deepEqual(row, {
        state: 'closed',
        merged: true,
        merged_by: 'maintainer',
        commits_count: 3,
        changed_files: 4,
        license: 'apache-2.0',
        topics: ['tyres'],
        forks_count: 12,
        stargazers_count: 340,
      });
    });

    test("a repository and the event that created it are written as one unit, or not at all", async () => {
      // The reason transaction() exists: the ledger row has a foreign key on the repository row,
      // and a crash between the two leaves a repository nothing ever recorded an event for.
      const noted = await db.index.transaction(async (run) => {
        const { id } = await db.repositories.ensureRepository('acme/widget', 9001, run);

        return db.events.insertPullRequestEventIfNotExists(prEvent(77), id, run);
      });

      assert.deepEqual(noted, { isNew: true, hydrated: false });
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_repositories`)).n, 1);

      await assert.rejects(() => db.index.transaction(async (run) => {
        const { id } = await db.repositories.ensureRepository('acme/other', 9002, run);

        await db.events.insertPullRequestEventIfNotExists(prEvent(78), id, run);

        throw new Error('the run died here');
      }), /the run died here/);

      assert.equal(
        (await oneRow(`SELECT count(*)::int AS n FROM github_repositories`)).n,
        1,
        'the rolled-back unit left a repository row behind for an event nothing recorded'
      );
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_pull_request_events`)).n, 1);
    });
  });

  describe("the job run ledger", () => {
    test("a recorded run comes back in the shape the sparkline reads, and the purge is bounded by its window", async () => {
      await db.jobRuns.recordJobRun({
        job: 'sync_contributions',
        outcome: 'ok',
        durationMs: 1234,
        counters: { claimed: 3, failed: 0 },
        failures: [{ subject: 'octocat', status: 404, message: 'Not Found' }],
      });

      const [run] = (await db.jobRuns.listRecentRunsPerJob()).get('sync_contributions');

      assert.equal(run.outcome, 'ok');
      assert.equal(run.durationMs, 1234);
      assert.deepEqual(run.counters, { claimed: 3, failed: 0 });
      assert.equal(run.error, null);

      // Ranked within each job, never across all of them: one busy job would otherwise fill the
      // window and every other sparkline would come back empty.
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'failed', durationMs: 20, error: 'boom' });
      await db.jobRuns.recordJobRun({ job: 'poll_non_closed_pull_requests', outcome: 'idle', durationMs: 30 });

      const capped = await db.jobRuns.listRecentRunsPerJob(1);

      assert.deepEqual([...capped.keys()].sort(), ['poll_non_closed_pull_requests', 'sync_contributions']);
      assert.equal(capped.get('sync_contributions').length, 1);
      assert.equal(capped.get('sync_contributions')[0].outcome, 'failed', 'the newest run of the job, not the oldest');

      assert.equal(await db.jobRuns.purgeJobRuns(7), 0, 'a run recorded a second ago is not older than the window');

      await admin.none(`UPDATE ${SCHEMA}.job_runs SET started_at = CURRENT_TIMESTAMP - make_interval(days => 8)`);

      assert.equal(await db.jobRuns.purgeJobRuns(7), 3);
    });
  });

  describe("reconciliation with what GitHub reports", () => {
    test("a suspend releases the lease and empties the queue; an unsuspend makes the account due at once", async () => {
      // A suspended installation cannot mint a token at all - GitHub answers 403 - so the flag
      // has to keep the row out of the CLAIM, not merely out of the job.
      const { InstallationEvent } = await import("../src/utils/types.js");
      const id = await enrol('octocat');

      // Due in an hour, and held by a worker that will never come back: both halves of the
      // suspend below have something to undo.
      await db.installations.markSyncSucceeded(await lease('github_installations', id), { intervalMinutes: 60, delaySeconds: 3600, etag: null });
      await admin.none(`UPDATE ${SCHEMA}.github_installations SET sync_claimed_at = CURRENT_TIMESTAMP`);

      await db.installations.handleInstallationEvent(InstallationEvent.SUSPEND, 42);

      const suspended = await oneRow(`SELECT installation_suspended, sync_claimed_at FROM github_installations`);

      assert.equal(suspended.installation_suspended, true);
      assert.equal(suspended.sync_claimed_at, null, 'a suspended row keeps a lease no run will ever release');
      assert.equal((await db.installations.claimInstallationsForSync()).length, 0);

      await db.installations.handleInstallationEvent(InstallationEvent.UNSUSPEND, 42);

      assert.equal(
        (await db.installations.claimInstallationsForSync()).length,
        1,
        'the account waits out a due time computed before it was suspended'
      );

      await db.installations.handleInstallationEvent(InstallationEvent.DELETED, 42);

      const deleted = await oneRow(`SELECT installation_deleted, sync_claimed_at FROM github_installations`);

      assert.equal(deleted.installation_deleted, true);
      assert.equal(deleted.sync_claimed_at, null, 'an uninstalled account keeps a lease nothing will ever release');
    });

    test("reconcileInstallationStates corrects a flag a missed webhook left wrong, and touches nothing else", async () => {
      const { InstallationEvent } = await import("../src/utils/types.js");

      await enrol('octocat');
      await db.installations.handleInstallationEvent(InstallationEvent.SUSPEND, 42);

      assert.equal(await db.installations.reconcileInstallationStates([{ id: 42, suspended_at: null }]), 1);
      assert.equal((await oneRow(`SELECT installation_suspended FROM github_installations`)).installation_suspended, false);
      assert.equal(
        await db.installations.reconcileInstallationStates([{ id: 42, suspended_at: null }]),
        0,
        'a row already in step is rewritten on every hourly run'
      );
    });

    test("markMissingInstallationsDeleted refuses an empty list, because a GitHub hiccup is not everybody uninstalling", async () => {
      await enrol('octocat');

      assert.equal(await db.installations.markMissingInstallationsDeleted([]), 0);
      assert.equal((await oneRow(`SELECT installation_deleted FROM github_installations`)).installation_deleted, false);

      assert.equal(await db.installations.markMissingInstallationsDeleted([99]), 1);
      assert.equal((await oneRow(`SELECT installation_deleted FROM github_installations`)).installation_deleted, true);
      assert.deepEqual(await db.installations.listKnownInstallationIds(), new Set([42]));
    });

    test("the state-since dates are backfilled onto a row already in the right state", async () => {
      // The trap this predicate exists for. The WHERE clause used to fire only on a state
      // change, and every row the app has ever known is already in the right state - so a
      // backfill that reused it would reach nobody.
      await enrol('octocat');

      const installed = '2026-02-24T09:15:00.000Z';

      assert.equal(
        await db.installations.reconcileInstallationStates([{ id: 42, created_at: installed, suspended_at: null }]),
        1,
        'a row whose flags already agree still has to take the dates'
      );

      const row = await oneRow(`SELECT installation_created_at, installation_suspended_at, installation_deleted_at FROM github_installations`);

      assert.equal(row.installation_created_at.toISOString(), installed);
      assert.equal(row.installation_suspended_at, null, 'not suspended, so it carries no suspension date');
      assert.equal(row.installation_deleted_at, null);

      assert.equal(
        await db.installations.reconcileInstallationStates([{ id: 42, created_at: installed, suspended_at: null }]),
        0,
        'and is left alone once it holds them'
      );
    });

    test("a backfill leaves the schedule alone, a row genuinely coming back does not", async () => {
      // Both halves of docs/architecture.md#dispersion in one test. installation_created_at is
      // null on every row the first time this runs, so the predicate matches the whole parc: if
      // next_sync_at were assigned unconditionally, every account would come due at the same
      // second.
      const id = await enrol('octocat');

      await db.installations.markSyncSucceeded(await lease('github_installations', id), { intervalMinutes: 60, delaySeconds: 3600, etag: null });

      const before = (await oneRow(`SELECT next_sync_at FROM github_installations`)).next_sync_at;

      await db.installations.reconcileInstallationStates([{ id: 42, created_at: '2026-02-24T09:15:00.000Z', suspended_at: null }]);

      assert.deepEqual(
        (await oneRow(`SELECT next_sync_at FROM github_installations`)).next_sync_at,
        before,
        'a pure date backfill must not promote the row to the front of the queue'
      );

      // Now a real state change: suspended, then reported live again.
      await admin.none(`UPDATE ${SCHEMA}.github_installations SET installation_suspended = true`);
      await db.installations.reconcileInstallationStates([{ id: 42, created_at: '2026-02-24T09:15:00.000Z', suspended_at: null }]);

      assert.notDeepEqual(
        (await oneRow(`SELECT next_sync_at FROM github_installations`)).next_sync_at,
        before,
        'a row coming back from suspended is still due at once'
      );
    });

    test("the suspension date follows the flag it belongs to, in both directions", async () => {
      const { InstallationEvent } = await import("../src/utils/types.js");

      await enrol('octocat');

      const suspended = '2026-08-30T12:00:00.000Z';

      await db.installations.reconcileInstallationStates([{ id: 42, created_at: null, suspended_at: suspended }]);

      const held = await oneRow(`SELECT installation_suspended, installation_suspended_at FROM github_installations`);

      assert.equal(held.installation_suspended, true);
      assert.equal(held.installation_suspended_at.toISOString(), suspended, "GitHub's own timestamp, not ours");

      await db.installations.handleInstallationEvent(InstallationEvent.UNSUSPEND, 42);

      const freed = await oneRow(`SELECT installation_suspended, installation_suspended_at FROM github_installations`);

      assert.equal(freed.installation_suspended, false);
      assert.equal(freed.installation_suspended_at, null, 'a row that is not suspended must not carry a suspension date');
    });

    test("the uninstall date is stamped once, by whichever notices first, and survives a redelivery", async () => {
      // The one date GitHub cannot give back: a removed installation is absent from
      // GET /app/installations, so the earliest sighting is all there is.
      const { InstallationEvent } = await import("../src/utils/types.js");

      await enrol('octocat');
      await db.installations.handleInstallationEvent(InstallationEvent.DELETED, 42);

      const first = (await oneRow(`SELECT installation_deleted_at FROM github_installations`)).installation_deleted_at;

      assert.notEqual(first, null);

      await db.installations.handleInstallationEvent(InstallationEvent.DELETED, 42);

      assert.deepEqual(
        (await oneRow(`SELECT installation_deleted_at FROM github_installations`)).installation_deleted_at,
        first,
        'GitHub redelivers webhooks; the first sighting is the closest to the truth'
      );

      // Reinstalled: GitHub lists it again, so the absence we recorded is over.
      await db.installations.reconcileInstallationStates([{ id: 42, created_at: null, suspended_at: null }]);

      assert.equal(
        (await oneRow(`SELECT installation_deleted_at FROM github_installations`)).installation_deleted_at,
        null
      );
    });

    test("the reconciliation stamps an uninstall the webhook never delivered", async () => {
      await enrol('octocat');

      assert.equal(await db.installations.markMissingInstallationsDeleted([99]), 1);

      const row = await oneRow(`SELECT installation_deleted, installation_deleted_at FROM github_installations`);

      assert.equal(row.installation_deleted, true);
      assert.notEqual(row.installation_deleted_at, null, 'up to an hour late, but the only date there will ever be');
    });

    test("every account state names the date that belongs to it", async () => {
      // stateSince() is keyed by the state rather than re-deriving it, so what is checked here
      // is that each state reaches for the column that belongs to it. Get one wrong and a row
      // reads "suspended" beside the day it was installed - a wrong date that looks right.
      const at = (iso) => `TIMESTAMPTZ '${iso}'`;

      await enrol('installed-one', { userId: 1, installationId: 101 });
      await enrol('suspended-one', { userId: 2, installationId: 102 });
      await enrol('uninstalled-one', { userId: 3, installationId: 103 });
      await enrol('disabled-one', { userId: 4, installationId: 104 });
      await db.installations.insertPendingInstallation({ id: 5, login: 'pending-one' }, 105);
      // The row that gives the ladder its order any meaning: markMissingInstallationsDeleted
      // does not clear installation_suspended, so an account suspended and then uninstalled
      // carries BOTH flags. Without it here, the deleted and suspended rungs can be swapped and
      // every assertion above still passes.
      await enrol('left-while-suspended', { userId: 6, installationId: 106 });
      // Installed, but the reconciliation has not run yet, so GitHub's install date is still
      // null. That is every row for the first hour after the column exists, and the fallback
      // to verified_at is the only thing keeping the whole column empty in the meantime.
      await enrol('awaiting-reconcile', { userId: 7, installationId: 107 });

      // Every row carries an install date except 105 and 107, the two that exercise a fallback:
      // that is what makes this a test of which column each state reaches for, rather than of
      // which column happens to be filled.
      await admin.none(`
        UPDATE ${SCHEMA}.github_installations SET installation_created_at = ${at('2026-01-01T00:00:00Z')} WHERE installation_id NOT IN (105, 107);
        UPDATE ${SCHEMA}.github_installations SET verified_at = ${at('2026-07-07T00:00:00Z')} WHERE installation_id = 107;
        UPDATE ${SCHEMA}.github_installations SET installation_suspended = true, installation_suspended_at = ${at('2026-02-02T00:00:00Z')} WHERE installation_id = 102;
        UPDATE ${SCHEMA}.github_installations SET installation_deleted = true, installation_deleted_at = ${at('2026-03-03T00:00:00Z')} WHERE installation_id = 103;
        UPDATE ${SCHEMA}.github_installations SET sync_disabled_at = ${at('2026-04-04T00:00:00Z')} WHERE installation_id = 104;
        UPDATE ${SCHEMA}.github_installations SET installation_suspended = true, installation_suspended_at = ${at('2026-05-05T00:00:00Z')}, installation_deleted = true, installation_deleted_at = ${at('2026-06-06T00:00:00Z')} WHERE installation_id = 106;
      `);

      const byLogin = Object.fromEntries((await db.dashboard.listUsers()).map((user) => [user.login, user]));

      const expected = {
        'installed-one': ['installed', '2026-01-01'],
        'suspended-one': ['suspended', '2026-02-02'],
        'uninstalled-one': ['uninstalled', '2026-03-03'],
        'disabled-one': ['disabled', '2026-04-04'],
        // Both flags true: uninstalled outranks suspended in the ladder, so the date shown is
        // the day it left, never the day it was suspended.
        'left-while-suspended': ['uninstalled', '2026-06-06'],
        // No install date from GitHub yet: falls back to when enrollment completed.
        'awaiting-reconcile': ['installed', '2026-07-07'],
      };

      for (const [login, [state, day]] of Object.entries(expected)) {
        assert.equal(byLogin[login].state, state, `${login} is in the state the test set up`);
        assert.equal(
          byLogin[login].stateSince.toISOString().slice(0, 10),
          day,
          `${login} shows the date of its own state, not of another one`
        );
      }

      // Pending has neither an install date nor a verified_at, so its own row is the only
      // record of when it appeared. Compared against created_timestamp rather than merely
      // asserted non-null, or dropping the fallback would still pass.
      const pending = await oneRow(`SELECT created_timestamp FROM github_installations WHERE installation_id = 105`);

      assert.equal(byLogin['pending-one'].state, 'pending');
      assert.deepEqual(
        byLogin['pending-one'].stateSince,
        pending.created_timestamp,
        'a pending row says when it first appeared'
      );
    });

    test("isEnrolledUser answers on a case-insensitive login, and keeps an account the app retired", async () => {
      // Who a hand-recorded contribution may credit, and deliberately wider than the sync
      // queue: an account the app gave up on is still an enrolled person.
      await enrol('OctoCat');

      assert.deepEqual(await db.installations.isEnrolledUser('octocat'), { enrolled: true, known: true });
      assert.deepEqual(await db.installations.isEnrolledUser('nobody'), { enrolled: false, known: false });

      const [claimed] = await db.installations.claimInstallationsForSync();

      await db.installations.markSyncFailed(claimed, 0, 'Not Found', 'account gone');

      assert.deepEqual(await db.installations.isEnrolledUser('OCTOCAT'), { enrolled: true, known: true });
    });

    test("enrollmentByUserId answers on the account id, with the login stored on its row", async () => {
      // The dashboard's check. On the id, because a login another account claims after a rename
      // must not inherit the access; the login it answers with is the row's, which is what the
      // operator list is matched against.
      await enrol('octocat', { userId: 583231 });

      assert.deepEqual(await db.installations.enrollmentByUserId(583231), { enrolled: true, known: true, login: 'octocat' });
      assert.deepEqual(await db.installations.enrollmentByUserId(1), { enrolled: false, known: false, login: null });

      // The rename reconcile records: same id, new login, and the answer follows the row.
      await admin.none(`UPDATE ${SCHEMA}.github_installations SET user_login = 'octocat-renamed' WHERE user_id = 583231`);
      assert.equal((await db.installations.enrollmentByUserId(583231)).login, 'octocat-renamed');

      await admin.none(`UPDATE ${SCHEMA}.github_installations SET installation_suspended = true WHERE user_id = 583231`);
      assert.deepEqual(await db.installations.enrollmentByUserId(583231), { enrolled: false, known: true, login: 'octocat-renamed' });
    });

    test("forceSyncNow brings a syncable account forward and refuses every row the queue excludes", async () => {
      const id = await enrol('octocat');

      await db.installations.markSyncSucceeded(await lease('github_installations', id), { intervalMinutes: 60, delaySeconds: 3600, etag: null });

      assert.equal((await db.installations.claimInstallationsForSync()).length, 0, 'the fixture is due before it was forced');
      // Keyed on the GitHub account id, which survives a rename where the login does not.
      assert.deepEqual(await db.installations.forceSyncNow(1), { login: 'octocat', running: false });
      const [forced] = await db.installations.claimInstallationsForSync();

      assert.ok(forced);

      await db.installations.markSyncFailed(forced, 0, 'Not Found', 'account gone');

      assert.equal(await db.installations.forceSyncNow(1), null, 'a retired row would be parked at the head of a queue no run drains');
      assert.equal(await db.installations.forceSyncNow(999), null);
    });
  });

  // The dashboard's areas, declared here so they share this file's schema and lifecycle.
  for (const area of [shared, ops, mine, collective]) {
    area.register({ db, rowsOf, oneRow, enrol, contribute, expireLease, lease });
  }
});
