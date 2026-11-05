// Set before anything that builds a logger: src/utils/logger.js resolves the level once, at
// import time, and these tests drive code paths that log a warn per skipped event.
process.env.LOG_LEVEL = 'silent';

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * The four job bodies, driven against fakes
 *
 * The sync and poll algorithms are the product, and until the jobs exported their bodies nothing
 * could reach them: importing a job ran it. They are importable now, but their collaborators are
 * still module-level imports - `import { fetchPullRequest } from "../src/services/octokitService.js"`
 * is not a seam a caller can pass anything through. So the seam is made one level lower, at the
 * module loader: registerHooks() replaces src/db/* and src/services/octokitService.js with
 * generated stubs before the jobs are imported, and every stubbed function routes to the one
 * recorder below.
 *
 * That has a second effect worth naming: pg-promise is never loaded, so no test here can open a
 * socket to a database however wrong a change to the source makes it. `node --test` gives each
 * file its own process, so the substitution stops at this file.
 *
 * Everything the jobs compute for themselves - the backoff ladder, the cron tick, the logger,
 * jobs/jobRun.js - is the real thing. Only the outside world is fake.
 */

// Every stubbed call, in order, as { name, args }. The assertions about what a job did NOT do
// are read from here; there is no other way to prove an absent API call.
let calls = [];

// What each stubbed function does for the test currently running. A name that is not in here has
// no behaviour, and calling it throws - so a job reaching for a collaborator the test did not
// expect fails loudly instead of receiving undefined and carrying on.
let behaviours = {};

globalThis.__jobFakes = {
  record(name, args) {
    calls.push({ name, args });

    const behaviour = behaviours[name];

    if (!behaviour) {
      throw new Error(`the job called ${name}(), which this test did not expect`);
    }

    return behaviour(...args);
  },
};

/** How many times a stubbed function was called in the test running now */
const countOf = (name) => calls.filter((call) => call.name === name).length;

/** The arguments of the first call to a stubbed function, or undefined if it was never called */
const argsOf = (name) => calls.find((call) => call.name === name)?.args;

/**
 * A module whose every export routes to the recorder
 * @param {...string} names - The exported function names the jobs import from that module
 * @returns {{format: string, shortCircuit: boolean, source: string}} A load-hook result
 */
const stubModule = (...names) => ({
  format: 'module',
  shortCircuit: true,
  source: names
    .map((name) => `export const ${name} = (...args) => globalThis.__jobFakes.record(${JSON.stringify(name)}, args);`)
    .join('\n'),
});

// Keyed on the path suffix rather than a full URL, so the map reads as the import list of the
// jobs it stands in for. Every name here is exported by the real module of the same path - a
// name dropped from one of them turns into "does not provide an export named ..." at import,
// which is the failure this indirection is allowed to have.
const STUBS = {
  '/src/db/index.js': stubModule('transaction', 'query', 'closePool'),
  '/src/db/events.js': stubModule('insertPullRequestEventIfNotExists', 'recordPullRequestSnapshot', 'insertPushEventIfNotExists'),
  '/src/db/repositories.js': stubModule(
    'ensureRepository', 'claimRepositoriesForRefresh', 'markRefreshSucceeded', 'recordRename',
    'markRefreshUnchanged', 'markRefreshFailed', 'markRepositoryGone'),
  '/src/db/pull_requests.js': stubModule('upsertPullRequest', 'refreshPullRequest'),
  '/src/db/polling.js': stubModule('claimPullRequestsForPoll', 'markPollSucceeded', 'markPollFailed'),
  '/src/db/installations.js': stubModule(
    'claimInstallationsForSync', 'markSyncSucceeded', 'markSyncFailed', 'countInstallationStates',
    'listKnownInstallationIds', 'reconcileInstallationStates', 'refreshStaleLogins',
    'markMissingInstallationsDeleted'),
  '/src/db/job_runs.js': stubModule('purgeJobRuns'),
  '/src/services/octokitService.js': stubModule(
    'appOctokit', 'fetchPublicEvents', 'pullRequestById', 'fetchPullRequest', 'fetchRepository',
    'listAppInstallations'),
};

registerHooks({
  load(url, context, nextLoad) {
    const stubbed = Object.keys(STUBS).find((suffix) => url.endsWith(suffix));

    return stubbed ? STUBS[stubbed] : nextLoad(url, context);
  },
});

// After the hooks, and dynamic for that reason alone: a static import is hoisted above them and
// would pull in the real database layer.
const sync = await import("../jobs/sync_contributions.js");
const poll = await import("../jobs/poll_non_closed_pull_requests.js");
const repositories = await import("../jobs/sync_repositories.js");

// The fourth job is imported differently, and the difference is itself the test - see the
// "the Bree entry point" suite at the foot of this file. The guard every job ends with compares
// pathToFileURL(process.argv[1]).href against its own import.meta.url, so pointing argv[1] at
// this module for the length of the import is the only way to watch the guard let a run happen:
// a second import of the same URL is served from the module cache and executes nothing, and a
// cache-busting query string would change import.meta.url and make the guard compare two things
// that differ for a reason that has nothing to do with the guard.
//
// The run it performs is a real one, against the same fakes as every other test here, so it
// opens no socket either. Its collaborators are wired before the import because a module body
// cannot be paused halfway, and what it did is snapshotted below before beforeEach() clears it.
const argvBeforeImport = process.argv[1];
const exitCodeBeforeImport = process.exitCode;

behaviours = {
  listAppInstallations: async () => [],
  countInstallationStates: async () => ({ active: 7 }),
  closePool: async () => undefined,
};

process.argv[1] = fileURLToPath(new URL("../jobs/reconcile_installations.js", import.meta.url));

const reconcile = await import("../jobs/reconcile_installations.js");

/** What the job run started by the entry-point guard called, in order */
const entryPointCalls = calls.map((call) => call.name);

// runJob reports a run nobody is listening to by setting process.exitCode, and that value
// belongs to the test runner, not to this run.
process.argv[1] = argvBeforeImport;
process.exitCode = exitCodeBeforeImport;
calls = [];
behaviours = {};

const { SCHEDULING } = await import("../src/utils/constants.js");

/** An error the way octokit raises one: a message and an HTTP status */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * The 404 octokit raises when the installation token itself could not be minted - before the
 * request the job meant to make was ever sent
 */
const mintError = () => Object.assign(httpError(404, 'Not Found'), {
  request: { url: 'https://api.github.com/app/installations/555/access_tokens' },
});

/** One entry of the public events feed */
const event = (type, id, repoName, extra = {}) => ({
  type,
  id,
  actor: { login: 'octocat' },
  repo: { id: 900 + Number(id), name: repoName },
  created_at: '2026-09-01T00:00:00Z',
  payload: { number: Number(id) },
  ...extra,
});

/** A row of claimInstallationsForSync, with only the columns syncInstallation reads */
const claimedInstallation = (overrides = {}) => ({
  id: 1,
  installation_id: 555,
  user_login: 'octocat',
  events_etag: null,
  last_synced_at: null,
  ...overrides,
});

beforeEach(() => {
  calls = [];
  behaviours = {};
});

describe("isExternalContribution", () => {
  test("a pull request on somebody else's repository is a contribution", () => {
    assert.equal(sync.isExternalContribution(event('PullRequestEvent', '1', 'michelin/some-tool')), true);
  });

  test("activity in the actor's own namespace is a personal project and is not recorded", () => {
    // The filter that decides what the whole product counts. Without it, an employee's private
    // side project shows up as an open-source contribution and the figure the dashboard reports
    // is wrong in the flattering direction, which is the direction nobody checks.
    assert.equal(sync.isExternalContribution(event('PushEvent', '2', 'octocat/dotfiles')), false);
  });

  test("the namespace is matched on the whole owner segment, not on a prefix of it", () => {
    // 'octo' is a prefix of 'octocat', and a startsWith() without the trailing slash would drop
    // every contribution a user makes to any organisation whose name begins with their login.
    assert.equal(
      sync.isExternalContribution({ actor: { login: 'octo' }, repo: { name: 'octocat/hub' } }),
      true
    );
  });

  test("an event with no repository name, and one with no actor login, are both dropped", () => {
    // Neither is a contribution that can be attributed, and both would otherwise reach
    // startsWith() on undefined and throw out of the filter, taking the whole feed with them.
    assert.equal(sync.isExternalContribution({ actor: { login: 'octocat' }, repo: {} }), false);
    assert.equal(sync.isExternalContribution({ actor: {}, repo: { name: 'michelin/tool' } }), false);
    assert.equal(sync.isExternalContribution({}), false);
  });
});

describe("syncInstallation", () => {
  /**
   * Wire the collaborators of one nominal sync
   *
   * `transaction` really invokes its callback, handing it the same recorder the pool-level
   * functions use: the jobs compose their units out of functions that take a `run` as their last
   * argument, and a transaction that did not call its body would make every write disappear.
   * @param {Object} feed - What fetchPublicEvents resolves to
   * @param {Object} [over] - Per-test overrides, merged last
   */
  const wire = (feed, over = {}) => {
    behaviours = {
      fetchPublicEvents: async () => feed,
      appOctokit: () => ({ request: async () => { throw new Error('the fake octokit is never called directly'); } }),
      transaction: async (work) => work((...args) => globalThis.__jobFakes.record('run', args)),
      ensureRepository: async (fullName, githubId) => ({ id: 42, created: false, full_name: fullName, github_id: githubId }),
      insertPullRequestEventIfNotExists: async () => true,
      insertPushEventIfNotExists: async () => true,
      // `user` is the author, and it is what decides whether the pull request is a measured
      // contribution - it matches claimedInstallation().user_login here, so the nominal path
      // below is the one where the person opened it themselves.
      pullRequestById: async () => ({ number: 1, state: 'open', user: { login: 'octocat' } }),
      recordPullRequestSnapshot: async () => undefined,
      upsertPullRequest: async () => undefined,
      refreshPullRequest: async () => false,
      ...over,
    };
  };

  test("a feed answering 304 is reported unchanged, and nothing downstream is touched", async () => {
    wire({ notModified: true, events: [], etag: null });

    const stats = await sync.syncInstallation(claimedInstallation({ events_etag: 'W/"abc"' }));

    assert.equal(stats.notModified, true);
    assert.equal(stats.changed, false);
    assert.equal(stats.etag, null, 'a 304 carries no fresh ETag, and the stored one must be kept');
    assert.equal(countOf('ensureRepository'), 0);
  });

  test("a new pull request event is hydrated once and written as a snapshot beside the row", async () => {
    wire({ notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: 'W/"new"' });

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.deepEqual(
      { prs: stats.prs, pushes: stats.pushes, changed: stats.changed, skipped: stats.skipped },
      { prs: 1, pushes: 0, changed: true, skipped: 0 }
    );
    assert.equal(countOf('pullRequestById'), 1);
    assert.equal(countOf('recordPullRequestSnapshot'), 1);
    assert.equal(countOf('upsertPullRequest'), 1);
    assert.equal(stats.etag, 'W/"new"');
  });

  test("the pull request is fetched by the repository id in the envelope, never by its name", async () => {
    // The feed reaches back thirty days and a repository renamed since answers a 301 at best,
    // a bare 404 after a transfer. The id in the same envelope has neither problem.
    wire({ notModified: false, events: [event('PullRequestEvent', '7', 'michelin/tool')], etag: null });

    await sync.syncInstallation(claimedInstallation());

    const [, githubRepoId, number] = argsOf('pullRequestById');

    assert.equal(githubRepoId, 907);
    assert.equal(number, 7);
  });

  test("a known pull request event is not re-hydrated - that lookup is the bulk of the API budget", async () => {
    // insertPullRequestEventIfNotExists returning false is the ledger saying it has seen this
    // event before. The feed returns the same three hundred entries every run, so re-hydrating
    // a known event turns one API call per new contribution into three hundred per tick.
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null },
      { insertPullRequestEventIfNotExists: async () => false }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('pullRequestById'), 0, 'the hydration call must not go out');
    assert.equal(countOf('recordPullRequestSnapshot'), 0);
    assert.equal(countOf('upsertPullRequest'), 0);
    assert.equal(stats.prs, 0);
    assert.equal(stats.changed, false, 'a feed of events already recorded is not a change');
  });

  test("a stored pull request event is re-hydrated unless the ledger says it is also complete", async () => {
    // The fix this branch exists for, in the only place a test can see it. The ledger row is
    // committed before the hydrating fetch, so a fetch that failed - a 403 at the rate limit, a
    // 5xx, a socket hung up - leaves the event stored with an empty snapshot and no
    // github_pull_requests row. Skipping on `isNew` alone made that permanent: no later run ever
    // fetched the contribution again. So both halves decide, and only both together skip.
    const ledgerAnswers = [
      { isNew: true, hydrated: false, hydrates: true, why: 'a new event has nothing stored yet' },
      { isNew: true, hydrated: true, hydrates: true, why: 'new wins - there is a fresh event to describe' },
      { isNew: false, hydrated: false, hydrates: true, why: 'seen but empty is the repair path' },
      { isNew: false, hydrated: true, hydrates: false, why: 'seen and complete is the API budget saved' },
    ];

    for (const { isNew, hydrated, hydrates, why } of ledgerAnswers) {
      calls = [];
      wire(
        { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null },
        { insertPullRequestEventIfNotExists: async () => ({ isNew, hydrated }) }
      );

      const stats = await sync.syncInstallation(claimedInstallation());
      const expected = hydrates ? 1 : 0;
      const reason = `isNew=${isNew}, hydrated=${hydrated}: ${why}`;

      assert.equal(countOf('pullRequestById'), expected, reason);
      assert.equal(countOf('recordPullRequestSnapshot'), expected, reason);
      assert.equal(countOf('upsertPullRequest'), expected, reason);
      assert.equal(stats.prs, expected, reason);
      assert.equal(stats.skipped, 0, 'no combination of the two flags is an error');
    }
  });

  test("an event on somebody else's pull request is kept in the ledger and left out of the contributions", async () => {
    // The feed returns what the person DID. Assigning, labelling, merging or reviewing somebody
    // else's pull request is one of the ten PullRequestEvent actions besides `opened`, and it
    // lands in the maintainer's own feed - so an enrolled maintainer of a busy project collects
    // every contributor's pull request as if it were theirs. Measured on production: 407 of the
    // 1,144 stored pull requests were dependabot's.
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'tchiotludo/akhq')], etag: null },
      { pullRequestById: async () => ({ number: 3212, state: 'open', user: { login: 'xusc' } }) }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('upsertPullRequest'), 0, 'it is not this person\'s contribution');
    assert.equal(stats.prs, 0);
    assert.equal(stats.others, 1, 'counted apart, not dropped silently');
    assert.equal(stats.changed, true, 'the feed did move - the ledger grew by one event');
  });

  test("somebody else's pull request refreshes the author's row, in the snapshot's transaction", async () => {
    // A reopen or a merge by a maintainer is only in the maintainer's feed, and the poll stopped
    // reading the author's row the day it stored `closed`. This is the only way the row learns.
    const reopened = { id: 5001, number: 3212, state: 'open', user: { login: 'xusc' } };

    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'tchiotludo/akhq')], etag: null },
      { pullRequestById: async () => reopened }
    );

    await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('refreshPullRequest'), 1);
    assert.equal(argsOf('refreshPullRequest')[0], reopened, 'refreshed from the hydration response itself');
    assert.equal(typeof argsOf('refreshPullRequest')[1], 'function', 'inside the transaction, beside the snapshot');
    assert.equal(countOf('upsertPullRequest'), 0, 'refreshing is not inserting');
  });

  test("the person's own pull request is upserted, never merely refreshed", async () => {
    wire({ notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null });

    await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('upsertPullRequest'), 1);
    assert.equal(countOf('refreshPullRequest'), 0);
  });

  test("the snapshot of somebody else's pull request is still written - the ledger keeps everything", async () => {
    // Two reasons, and the first is a bug waiting to happen. `hydrated` is read off
    // `title IS NOT NULL` on the ledger row, so an event whose snapshot is skipped looks
    // unhydrated for ever and every later run re-fetches it: on the production figures that is
    // 407 wasted hydrations per sync, permanently. The second is the point of the table - the
    // snapshot is the archive of a pull request this person reviewed or merged, kept so the
    // report can show that work the day it is asked for.
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'tchiotludo/akhq')], etag: null },
      { pullRequestById: async () => ({ number: 3212, state: 'open', user: { login: 'xusc' } }) }
    );

    await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('recordPullRequestSnapshot'), 1);
  });

  test("the author is compared case-insensitively - GitHub logins are", async () => {
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null },
      { pullRequestById: async () => ({ number: 1, state: 'open', user: { login: 'OctoCat' } }) }
    );

    const stats = await sync.syncInstallation(claimedInstallation({ user_login: 'octocat' }));

    assert.equal(countOf('upsertPullRequest'), 1);
    assert.equal(stats.prs, 1);
  });

  test("a pull request whose author GitHub no longer names is not attributed to the person syncing", async () => {
    // A deleted account answers with no user at all. Attributing it to whoever's feed surfaced
    // it would be a contribution invented out of an absence.
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null },
      { pullRequestById: async () => ({ number: 1, state: 'open', user: null }) }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('upsertPullRequest'), 0);
    assert.equal(countOf('recordPullRequestSnapshot'), 1, 'the event is still archived');
    assert.equal(stats.others, 1);
  });

  test("an event stored without its snapshot is fetched again, and the row it never got is written", async () => {
    // The repair itself, asserted on the writes rather than on a counter: what the failed fetch
    // left behind is an event row with no snapshot and no pull request row, and the run that
    // finds it has to produce both.
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null },
      { insertPullRequestEventIfNotExists: async () => ({ isNew: false, hydrated: false }) }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('pullRequestById'), 1, 'the contribution is fetched again');
    assert.equal(countOf('recordPullRequestSnapshot'), 1);
    assert.equal(countOf('upsertPullRequest'), 1);
    assert.equal(stats.prs, 1);
    assert.equal(stats.changed, true, 'a hole filled in is a change - the dashboard figure moved');
  });

  test("a known push event is recorded once and never counted twice", async () => {
    wire(
      { notModified: false, events: [event('PushEvent', '2', 'michelin/tool')], etag: null },
      { insertPushEventIfNotExists: async () => false }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(stats.pushes, 0);
    assert.equal(stats.changed, false);
  });

  test("a repository created by the event's own transaction is counted once", async () => {
    wire(
      { notModified: false, events: [event('PushEvent', '2', 'michelin/tool')], etag: null },
      { ensureRepository: async () => ({ id: 42, created: true }) }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(stats.repositories, 1);
    assert.equal(stats.pushes, 1);
  });

  test("only PullRequestEvent and PushEvent are processed - every other type is dropped unwritten", async () => {
    // GitHub's feed carries some twenty event types. Anything the switch does not name must
    // reach no writer at all: an IssuesEvent has no pull request to hydrate and no push to
    // record, and treating one as either writes a row the schema has no meaning for.
    wire({
      notModified: false,
      events: [
        event('IssuesEvent', '3', 'michelin/tool'),
        event('WatchEvent', '4', 'michelin/tool'),
        event('IssueCommentEvent', '5', 'michelin/tool'),
        event('CreateEvent', '6', 'michelin/tool'),
      ],
      etag: null,
    });

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('ensureRepository'), 0, 'not even the repository row is written');
    assert.equal(countOf('insertPullRequestEventIfNotExists'), 0);
    assert.equal(countOf('insertPushEventIfNotExists'), 0);
    assert.deepEqual(
      { prs: stats.prs, pushes: stats.pushes, changed: stats.changed, skipped: stats.skipped },
      { prs: 0, pushes: 0, changed: false, skipped: 0 }
    );
  });

  test("an event in the actor's own namespace never reaches the writers", async () => {
    wire({
      notModified: false,
      events: [event('PushEvent', '1', 'octocat/dotfiles'), event('PushEvent', '2', 'michelin/tool')],
      etag: null,
    });

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('insertPushEventIfNotExists'), 1);
    assert.equal(argsOf('ensureRepository')[0], 'michelin/tool');
    assert.equal(stats.pushes, 1);
  });

  test("one throwing event is counted as skipped and the events after it are still processed", async () => {
    // A deleted fork or a repository turned private throws on hydration. Without the per-event
    // catch that failure leaves the loop, and every event behind it in the feed - the newest
    // ones, since the feed is newest-first - is lost with no record that it existed.
    const events = [
      event('PullRequestEvent', '1', 'michelin/first'),
      event('PullRequestEvent', '2', 'michelin/second'),
      event('PullRequestEvent', '3', 'michelin/third'),
    ];

    wire(
      { notModified: false, events, etag: null },
      {
        pullRequestById: async (octokit, githubRepoId) => {
          if (githubRepoId === 902) {
            throw httpError(404, 'Not Found');
          }

          return { number: 1, state: 'open', user: { login: 'octocat' } };
        },
      }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(stats.skipped, 1);
    assert.equal(stats.prs, 2, 'the event before the failure and the event after it are both kept');
    assert.deepEqual(
      calls.filter((call) => call.name === 'pullRequestById').map((call) => call.args[1]),
      [901, 902, 903],
      'the loop reached the third event'
    );
  });

  test("the feed and the hydrations share one client, so one token is minted per sync", async () => {
    // Every client mints its own installation token against the app-level budget.
    const client = { request: async () => { throw new Error('the fake octokit is never called directly'); } };

    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: null },
      { appOctokit: () => client }
    );

    await sync.syncInstallation(claimedInstallation());

    assert.equal(countOf('appOctokit'), 1);
    assert.equal(argsOf('fetchPublicEvents')[0], client);
    assert.equal(argsOf('pullRequestById')[0], client);
  });

  test("a failure in the ledger write is isolated exactly as a failure in the hydration is", async () => {
    // The catch wraps the whole body, not the API call: a foreign key violation on one event
    // must not lose the rest of the feed either.
    wire(
      {
        notModified: false,
        events: [event('PushEvent', '1', 'michelin/first'), event('PushEvent', '2', 'michelin/second')],
        etag: null,
      },
      {
        insertPushEventIfNotExists: async (pushEvent) => {
          if (pushEvent.id === '1') {
            throw new Error('insert or update on table violates foreign key constraint');
          }

          return true;
        },
      }
    );

    const stats = await sync.syncInstallation(claimedInstallation());

    assert.equal(stats.skipped, 1);
    assert.equal(stats.pushes, 1);
  });

  test("an event that failed for a transient reason holds the fresh ETag back", async () => {
    // The ledger row is committed before the hydration, so the repair path re-fetches a failed
    // event - but only on a run that reads the feed. Storing this run's ETag earns the next run a
    // 304, and the event is never offered again. A null keeps the stored ETag, which this 200 has
    // just proved stale.
    const transient = [
      ['a 5xx', httpError(502, 'Bad Gateway')],
      ['a rate limit', httpError(403, 'API rate limit exceeded')],
      ['a 429', httpError(429, 'Too Many Requests')],
      ['a socket hung up', new Error('socket hang up')],
      ['a token that could not be minted', mintError()],
    ];

    for (const [why, error] of transient) {
      calls = [];
      wire(
        { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: 'W/"new"' },
        { pullRequestById: async () => { throw error; } }
      );

      const stats = await sync.syncInstallation(claimedInstallation({ events_etag: 'W/"old"' }));

      assert.equal(stats.skipped, 1, why);
      assert.equal(stats.etag, null, `${why} must not advance the ETag`);
    }
  });

  test("a database error on an event holds the fresh ETag back too", async () => {
    wire(
      { notModified: false, events: [event('PushEvent', '1', 'michelin/tool')], etag: 'W/"new"' },
      { insertPushEventIfNotExists: async () => { throw new Error('could not save push event 1'); } }
    );

    const stats = await sync.syncInstallation(claimedInstallation({ events_etag: 'W/"old"' }));

    assert.equal(stats.skipped, 1);
    assert.equal(stats.etag, null);
  });

  test("an event gone for good still lets the ETag advance - or the feed is re-read for ever", async () => {
    for (const status of [404, 410, 451]) {
      calls = [];
      wire(
        {
          notModified: false,
          events: [event('PullRequestEvent', '1', 'michelin/gone'), event('PullRequestEvent', '2', 'michelin/tool')],
          etag: 'W/"new"',
        },
        {
          pullRequestById: async (octokit, githubRepoId) => {
            if (githubRepoId === 901) {
              throw httpError(status, 'Gone');
            }

            return { number: 2, state: 'open', user: { login: 'octocat' } };
          },
        }
      );

      const stats = await sync.syncInstallation(claimedInstallation({ events_etag: 'W/"old"' }));

      assert.equal(stats.skipped, 1, `${status}`);
      assert.equal(stats.etag, 'W/"new"', `a ${status} answers the same next run`);
    }
  });

  test("the ETag held back is what run() hands to markSyncSucceeded", async () => {
    wire(
      { notModified: false, events: [event('PullRequestEvent', '1', 'michelin/tool')], etag: 'W/"new"' },
      {
        claimInstallationsForSync: async () => [{
          ...claimedInstallation({ events_etag: 'W/"old"' }),
          sync_interval_minutes: 15, sync_error_count: 0, sync_404_count: 0,
        }],
        pullRequestById: async () => { throw httpError(502, 'Bad Gateway'); },
        markSyncSucceeded: async () => undefined,
      }
    );

    await sync.run();

    assert.equal(argsOf('markSyncSucceeded')[1].etag, null);
  });

  test("run() releases with the claim it took, and a release the row no longer expects is no failure", async () => {
    // The release is fenced on the lease, so it needs the claim itself, not its id. Dropped, it
    // resolves false - the row was re-enrolled, renamed or claimed again meanwhile - and must not
    // be retried as a failed sync on top of the outcome that replaced it.
    const claimed = {
      ...claimedInstallation(), sync_interval_minutes: 15, sync_error_count: 0, sync_404_count: 0,
      lease: '2026-11-04 10:00:00.123456+01',
    };

    wire({ notModified: true, events: [], etag: null }, {
      claimInstallationsForSync: async () => [claimed],
      markSyncSucceeded: async () => false,
    });

    await sync.run();

    assert.equal(argsOf('markSyncSucceeded')[0].lease, claimed.lease);
    assert.equal(countOf('markSyncFailed'), 0);
  });
});

describe("noteEvent", () => {
  test("the repository row is written before the ledger row, inside one transaction", async () => {
    // Forced by a foreign key, and the order is the whole reason this is one unit: a crash
    // between the two would leave a repository row for an event nothing recorded.
    behaviours = {
      transaction: async (work) => work((...args) => globalThis.__jobFakes.record('run', args)),
      ensureRepository: async () => ({ id: 42, created: true }),
      insertPushEventIfNotExists: async () => true,
    };

    const noted = await sync.noteEvent(
      event('PushEvent', '1', 'michelin/tool'),
      (...args) => globalThis.__jobFakes.record('insertPushEventIfNotExists', args)
    );

    // hydrated: true for a push - nothing describes one, so a stored row is already
    // everything there will ever be. The pull request writer is the one that can answer false.
    assert.deepEqual(noted, { repositoryId: 42, created: true, isNew: true, hydrated: true });
    assert.deepEqual(
      calls.map((call) => call.name),
      ['transaction', 'ensureRepository', 'insertPushEventIfNotExists']
    );
    assert.equal(argsOf('ensureRepository')[1], 901, 'the repository is keyed on its GitHub id');
  });
});

describe("pollPullRequest", () => {
  /** A row of claimPullRequestsForPoll, with only the columns pollPullRequest reads */
  const claimedPullRequest = (overrides = {}) => ({
    id: 10,
    installation_id: 555,
    github_id: 901,
    repository_id: 42,
    number: 7,
    full_name: 'michelin/tool',
    state: 'open',
    ...overrides,
  });

  /**
   * Wire a poll whose single API call fails
   * @param {Error} error - What fetchPullRequest rejects with
   */
  const failingWith = (error) => {
    behaviours = {
      fetchPullRequest: async () => { throw error; },
      upsertPullRequest: async () => undefined,
    };
  };

  test("a pull request that changed state reports the change and is written back", async () => {
    behaviours = {
      fetchPullRequest: async () => ({ number: 7, state: 'closed' }),
      upsertPullRequest: async () => undefined,
    };

    const result = await poll.pollPullRequest(claimedPullRequest());

    assert.deepEqual(result, { changed: true, gone: false });
    assert.deepEqual(argsOf('fetchPullRequest'), [555, 901, 7], 'by repository id, not by name');
    assert.equal(argsOf('upsertPullRequest')[1], 42);
  });

  test("a pull request whose state did not move is not a change, however much else moved", async () => {
    // Comments and pushes move updated_at without telling this application anything, and only a
    // state change earns the fast interval.
    behaviours = {
      fetchPullRequest: async () => ({ number: 7, state: 'open', comments: 41, updated_at: '2026-09-04T00:00:00Z' }),
      upsertPullRequest: async () => undefined,
    };

    const result = await poll.pollPullRequest(claimedPullRequest());

    assert.deepEqual(result, { changed: false, gone: false });
    assert.equal(countOf('upsertPullRequest'), 1, 'the snapshot is refreshed either way');
  });

  test("a 404 is permanent: the pull request is gone and goes to the poll ceiling", async () => {
    failingWith(httpError(404, 'Not Found'));

    assert.deepEqual(await poll.pollPullRequest(claimedPullRequest()), { changed: false, gone: true });
    assert.equal(countOf('upsertPullRequest'), 0, 'nothing is written for a row that no longer exists');
  });

  test("a 410 is permanent too - a repository can be gone rather than merely missing", async () => {
    failingWith(httpError(410, 'Gone'));

    assert.deepEqual(await poll.pollPullRequest(claimedPullRequest()), { changed: false, gone: true });
  });

  test("a 403 is a rate limit and must rethrow into the error backoff, never read as gone", async () => {
    // The single most expensive thing this classification can get wrong. Read as permanent, an
    // hour of rate limiting pushes every pull request in the batch to the maximum interval and
    // the application quietly stops tracking them - with no error anywhere, because "gone" is a
    // success. Widening the condition to `error.status >= 400` does exactly that.
    failingWith(httpError(403, 'API rate limit exceeded'));

    await assert.rejects(() => poll.pollPullRequest(claimedPullRequest()), /rate limit/);
  });

  test("a 5xx is GitHub being unwell and must rethrow into the error backoff", async () => {
    failingWith(httpError(500, 'Internal Server Error'));

    await assert.rejects(() => poll.pollPullRequest(claimedPullRequest()), { status: 500 });
  });

  test("an error with no status at all - a socket hang up - must rethrow", async () => {
    // A network failure carries no HTTP status, so any classification reading `error.status`
    // with a loose comparison decides on undefined. It has to leave by the throwing path.
    failingWith(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await assert.rejects(() => poll.pollPullRequest(claimedPullRequest()), /socket hang up/);
  });

  test("a 401 and a 429 are not permanent either - only 404 and 410 are", async () => {
    for (const status of [400, 401, 422, 429, 502, 503]) {
      calls = [];
      failingWith(httpError(status, `HTTP ${status}`));

      await assert.rejects(
        () => poll.pollPullRequest(claimedPullRequest()),
        { status },
        `${status} must not be read as gone`
      );
    }
  });
});

describe("the poll run, when a subject fails", () => {
  /** A claimed row with what run() reads off it */
  const claimedRow = (id) => ({
    id, number: id, installation_id: 555, github_id: 901, repository_id: 42, full_name: 'michelin/tool',
    state: 'open', poll_interval_minutes: 15, poll_error_count: 0,
  });

  test("a token that cannot be minted is a failure to retry, never a pull request gone", async () => {
    // Read as gone, the row would be pushed to the poll ceiling as a success - with no error
    // anywhere - every time an installation is uninstalled between the claim and the poll.
    behaviours = {
      claimPullRequestsForPoll: async () => [claimedRow(1)],
      fetchPullRequest: async () => { throw mintError(); },
      markPollFailed: async () => undefined,
    };

    await poll.run();

    assert.equal(countOf('markPollSucceeded'), 0, 'a gone verdict is recorded through markPollSucceeded');
    assert.equal(countOf('markPollFailed'), 1);
  });

  test("a release that fails is reported and the run moves on to the next subject", async () => {
    behaviours = {
      claimPullRequestsForPoll: async () => [claimedRow(1), claimedRow(2)],
      fetchPullRequest: async () => { throw httpError(502, 'Bad Gateway'); },
      markPollFailed: async ({ id }) => {
        if (id === 1) {
          throw new Error('could not record a failed poll of pull request row 1');
        }
      },
    };

    await poll.run();

    assert.deepEqual(calls.filter((call) => call.name === 'markPollFailed').map((call) => call.args[0].id), [1, 2]);
  });

  test("a poll is released with the claim it took, and a release the row no longer expects is no failure", async () => {
    behaviours = {
      claimPullRequestsForPoll: async () => [{ ...claimedRow(1), lease: '2026-11-04 10:00:00.123456+01' }],
      fetchPullRequest: async () => ({ number: 1, state: 'open' }),
      upsertPullRequest: async () => undefined,
      markPollSucceeded: async () => false,
    };

    await poll.run();

    assert.equal(argsOf('markPollSucceeded')[0].lease, '2026-11-04 10:00:00.123456+01', 'the fence needs the lease, not the id');
    assert.equal(countOf('markPollFailed'), 0);
  });
});

describe("the sync run, when an installation fails", () => {
  /** A claimed installation with what run() reads off it */
  const claimedRow = (overrides = {}) => ({
    id: 1, installation_id: 555, user_login: 'octocat', events_etag: null, last_synced_at: null,
    sync_interval_minutes: 15, sync_error_count: 0, sync_404_count: 0, ...overrides,
  });

  /**
   * Wire one sync run whose feed fails
   * @param {Array<Object>} claimed - What the claim hands out
   * @param {Error} error - What the feed rejects with
   */
  const failing = (claimed, error) => {
    behaviours = {
      claimInstallationsForSync: async () => claimed,
      appOctokit: () => ({}),
      fetchPublicEvents: async () => { throw error; },
      markSyncFailed: async () => undefined,
    };
  };

  /** markSyncFailed's arguments, as { disableReason, notFound } per call */
  const verdicts = () => calls
    .filter((call) => call.name === 'markSyncFailed')
    .map(({ args }) => ({ disableReason: args[3], notFound: args[4] }));

  test("a run of 404s from the feed retires the account at the threshold", async () => {
    failing([claimedRow({ sync_error_count: 2, sync_404_count: SCHEDULING.SYNC_DISABLE_AFTER_404 - 1 })], httpError(404, 'Not Found'));

    await sync.run();

    assert.deepEqual(verdicts(), [{ disableReason: 'account gone', notFound: true }]);
  });

  test("a 404 after failures of another kind starts a new run instead of completing one", async () => {
    // The bug this counter exists for: sync_error_count counts timeouts and 5xx too, so reading
    // the verdict off it retired an account on its first 404 after a bad afternoon.
    failing([claimedRow({ sync_error_count: 10, sync_404_count: 0 })], httpError(404, 'Not Found'));

    await sync.run();

    assert.deepEqual(verdicts(), [{ disableReason: null, notFound: true }]);
  });

  test("any other failure breaks the run of 404s and never retires as 'account gone'", async () => {
    failing([claimedRow({ sync_error_count: 2, sync_404_count: 2 })], httpError(502, 'Bad Gateway'));

    await sync.run();

    assert.deepEqual(verdicts(), [{ disableReason: null, notFound: false }]);
  });

  test("a token that cannot be minted is not a 404 from the feed", async () => {
    // It is about the installation, not the account: an uninstall between the claim and the
    // sync, or a development instance holding another App's installation ids.
    failing([claimedRow({ sync_error_count: 2, sync_404_count: 2 })], mintError());

    await sync.run();

    assert.deepEqual(verdicts(), [{ disableReason: null, notFound: false }]);
  });

  test("a release that fails is reported and the run moves on to the next installation", async () => {
    failing([claimedRow({ id: 1 }), claimedRow({ id: 2, user_login: 'hubber' })], httpError(502, 'Bad Gateway'));
    behaviours.markSyncFailed = async ({ id }) => {
      if (id === 1) {
        throw new Error('could not record a failed sync of installation row 1');
      }
    };

    await sync.run();

    assert.deepEqual(calls.filter((call) => call.name === 'markSyncFailed').map((call) => call.args[0].id), [1, 2]);
  });

  test("a failed sync is released with the claim it took, retirement verdict and all", async () => {
    // The verdict was read off this claim's counts, so it is the claim's lease that decides
    // whether it still applies: a rename or a re-enrollment since then has reset them.
    failing([claimedRow({ sync_404_count: SCHEDULING.SYNC_DISABLE_AFTER_404 - 1, lease: '2026-11-04 10:00:00.123456+01' })], httpError(404, 'Not Found'));
    behaviours.markSyncFailed = async () => false;

    await sync.run();

    assert.equal(argsOf('markSyncFailed')[0].lease, '2026-11-04 10:00:00.123456+01');
    assert.deepEqual(verdicts(), [{ disableReason: 'account gone', notFound: true }]);
  });
});

describe("the repository refresh run, when a repository fails", () => {
  /** A claimed repository with what run() reads off it */
  const claimedRow = (overrides = {}) => ({
    id: 42, installation_id: 555, github_id: 901, full_name: 'michelin/tool', stargazers_count: 12,
    etag: null, refresh_error_count: 0, refresh_404_count: 0, ...overrides,
  });

  /**
   * Wire one refresh run whose request fails
   * @param {Array<Object>} claimed - What the claim hands out
   * @param {Error} error - What fetchRepository rejects with
   */
  const failing = (claimed, error) => {
    behaviours = {
      claimRepositoriesForRefresh: async () => claimed,
      fetchRepository: async () => { throw error; },
      markRefreshFailed: async () => undefined,
      markRepositoryGone: async () => undefined,
    };
  };

  test("a run of 404s by id marks the repository gone at the threshold", async () => {
    failing([claimedRow({ refresh_error_count: 2, refresh_404_count: SCHEDULING.REPO_GONE_AFTER_404 - 1 })], httpError(404, 'Not Found'));

    await repositories.run();

    assert.equal(countOf('markRepositoryGone'), 1);
    assert.equal(countOf('markRefreshFailed'), 0);
  });

  test("a 404 after failures of another kind is the first of a run, not the last", async () => {
    // refresh_error_count counts timeouts too. A repository that timed out twice and then
    // answered one 404 is not three 404s, and the mark is one-way.
    failing([claimedRow({ refresh_error_count: 5, refresh_404_count: 0 })], httpError(404, 'Not Found'));

    await repositories.run();

    assert.equal(countOf('markRepositoryGone'), 0);
    assert.equal(argsOf('markRefreshFailed')[3], true, 'counted as a 404, so the next one extends the run');
  });

  test("a token that cannot be minted never marks a repository gone", async () => {
    failing([claimedRow({ refresh_error_count: 2, refresh_404_count: 2 })], mintError());

    await repositories.run();

    assert.equal(countOf('markRepositoryGone'), 0);
    assert.equal(argsOf('markRefreshFailed')[3], false, 'and it breaks the run of 404s');
  });

  test("a row with no installation to read it with goes back in the queue, and a failed release does not end the run", async () => {
    // Both release paths are guarded: before, this one awaited its write bare, and a single
    // database error there aborted the refresh of every repository after it.
    behaviours = {
      claimRepositoriesForRefresh: async () => [claimedRow({ id: 1, installation_id: null }), claimedRow({ id: 2 })],
      markRefreshFailed: async ({ id }) => {
        if (id === 1) {
          throw new Error('could not record a failed refresh of repository row 1');
        }
      },
      fetchRepository: async () => ({ notModified: true, repository: null, etag: null }),
      markRefreshUnchanged: async () => undefined,
    };

    await repositories.run();

    assert.equal(countOf('fetchRepository'), 1, 'only the row with an installation is fetched');
    assert.equal(argsOf('markRefreshUnchanged')[0].id, 2, 'the run reached the second repository');
  });
});

describe("displayName", () => {
  test("a name that cannot be split is null rather than an error - the request goes by id", () => {
    assert.deepEqual(poll.displayName('michelin/tool'), { owner: 'michelin', name: 'tool' });
    assert.equal(poll.displayName('michelin/tool/extra'), null);
    assert.equal(poll.displayName('michelin'), null);
    assert.equal(poll.displayName(null), null);
    assert.equal(poll.displayName(undefined), null);
  });
});

describe("refreshRepository", () => {
  /** A row of claimRepositoriesForRefresh, with only the columns refreshRepository reads */
  const claimedRepository = (overrides = {}) => ({
    id: 42,
    installation_id: 555,
    github_id: 901,
    full_name: 'michelin/tool',
    stargazers_count: 12,
    etag: 'W/"stored"',
    ...overrides,
  });

  /**
   * Wire a refresh whose conditional request came back with a repository
   * @param {Object} repository - The body GitHub answered with
   */
  const answering = (repository) => {
    behaviours = {
      fetchRepository: async () => ({ notModified: false, repository, etag: 'W/"fresh"' }),
      transaction: async (work) => work((...args) => globalThis.__jobFakes.record('run', args)),
      markRefreshSucceeded: async () => true,
      recordRename: async () => undefined,
    };
  };

  test("a 304 is unchanged: the row is rescheduled and nothing is counted as a change", async () => {
    // The counter exists to say whether the popularity figures are moving. A 304 means they did
    // not move at all, so counting one as a change would report a tick's worth of activity for
    // a population that did nothing.
    behaviours = {
      fetchRepository: async () => ({ notModified: true, repository: null, etag: null }),
      markRefreshUnchanged: async () => undefined,
    };

    const result = await repositories.refreshRepository(claimedRepository());

    assert.deepEqual(result, { changed: false, renamed: false });
    assert.equal(countOf('markRefreshUnchanged'), 1);
    assert.equal(countOf('markRefreshSucceeded'), 0, 'there is no body to write');
    assert.equal(countOf('transaction'), 0);
    assert.equal(argsOf('markRefreshUnchanged')[0].id, 42);
  });

  test("the stored ETag is what makes the request conditional", async () => {
    answering({ full_name: 'michelin/tool', stargazers_count: 12 });

    await repositories.refreshRepository(claimedRepository());

    assert.deepEqual(argsOf('fetchRepository'), [555, 901, 'W/"stored"']);
  });

  test("a rename is written with its predecessor kept, in the same transaction as the new name", async () => {
    // GitHub exposes no rename history, so this row is the only record that the old name ever
    // referred to this repository. Writing the new name without it loses the link for good, and
    // writing them separately can lose it to a crash between the two statements.
    answering({ full_name: 'michelin/renamed-tool', stargazers_count: 12 });

    const result = await repositories.refreshRepository(claimedRepository());

    assert.equal(result.renamed, true);
    assert.equal(countOf('recordRename'), 1);
    assert.deepEqual(argsOf('recordRename').slice(0, 3), [42, 'michelin/tool', 'michelin/renamed-tool']);
    assert.deepEqual(
      calls.map((call) => call.name),
      ['fetchRepository', 'transaction', 'markRefreshSucceeded', 'recordRename']
    );
  });

  test("a refresh the row no longer expected records no rename - the run holding it now does", async () => {
    answering({ full_name: 'michelin/renamed-tool', stargazers_count: 12 });
    behaviours.markRefreshSucceeded = async () => false;

    const claimed = claimedRepository({ lease: '2026-11-04 10:00:00.123456+01' });
    const result = await repositories.refreshRepository(claimed);

    assert.equal(argsOf('markRefreshSucceeded')[0], claimed, 'the fence needs the claim, lease included');
    assert.equal(result.renamed, false);
    assert.equal(countOf('recordRename'), 0, 'the rename would be written down twice, once by each run');
  });

  test("a repository still called what it was called records no rename", async () => {
    answering({ full_name: 'michelin/tool', stargazers_count: 12 });

    const result = await repositories.refreshRepository(claimedRepository());

    assert.equal(result.renamed, false);
    assert.equal(countOf('recordRename'), 0);
    assert.equal(countOf('markRefreshSucceeded'), 1);
  });

  test("only the star count decides `changed` - a new description is not news", async () => {
    answering({ full_name: 'michelin/tool', stargazers_count: 12, description: 'rewritten this morning' });

    assert.equal((await repositories.refreshRepository(claimedRepository())).changed, false);

    calls = [];
    answering({ full_name: 'michelin/tool', stargazers_count: 13 });

    assert.equal((await repositories.refreshRepository(claimedRepository())).changed, true);
  });
});

describe("reconcile", () => {
  /**
   * Wire a reconciliation against a live installation list
   * @param {Array<Object>} live - What GET /app/installations answered with
   * @param {Object} [over] - Per-test overrides, merged last
   */
  const wireReconcile = (live, over = {}) => {
    behaviours = {
      listAppInstallations: async () => live,
      listKnownInstallationIds: async () => new Set(live.map((installation) => installation.id)),
      reconcileInstallationStates: async () => 0,
      refreshStaleLogins: async () => [],
      markMissingInstallationsDeleted: async () => 0,
      purgeJobRuns: async () => 0,
      countInstallationStates: async () => ({ active: 7 }),
      ...over,
    };
  };

  test("github reporting no installation at all skips the run rather than deleting every installation", async () => {
    // The single most destructive thing this job could do. An empty GET /app/installations is a
    // GitHub hiccup, an expired JWT or a truncated page - never twelve hundred people
    // uninstalling between two ticks - and the deletion pass takes "absent from the live list"
    // as authoritative. Without this guard one bad response marks the entire table deleted, and
    // a deleted row is never synchronized again.
    wireReconcile([], {
      // Nothing past the guard has a behaviour: the recorder throws on any call this test did
      // not expect, so a guard that stopped guarding fails here rather than passing quietly.
      listKnownInstallationIds: undefined,
      reconcileInstallationStates: undefined,
      refreshStaleLogins: undefined,
      markMissingInstallationsDeleted: undefined,
      purgeJobRuns: undefined,
    });

    const state = await reconcile.run();

    assert.deepEqual(
      calls.map((call) => call.name),
      ['listAppInstallations', 'countInstallationStates'],
      'the run stops at the empty list, and reports the state it did not touch'
    );
    assert.deepEqual(state, { active: 7 }, 'the summary still describes the system, so the skip is visible');
  });

  test("a live list that is not empty does reach the deletion pass, with the ids github reported", async () => {
    // The other direction of the same guard: skipping is only safe because it is conditional.
    wireReconcile([{ id: 555, account: { login: 'octocat' } }, { id: 556, account: { login: 'hubber' } }]);

    await reconcile.run();

    assert.equal(countOf('markMissingInstallationsDeleted'), 1);
    assert.deepEqual(argsOf('markMissingInstallationsDeleted')[0], [555, 556]);
  });
});

describe("the Bree entry point", () => {
  test("a job loaded as process.argv[1] - which is how Bree starts one - does run", () => {
    // The direction whose failure is silent. `import.meta.url === pathToFileURL(argv[1]).href`
    // is what keeps an import from running a job, and the tests above depend on it; but the same
    // line is what makes every scheduled job execute at all, and a mistake in it - a guard
    // narrowed, an href compared against a path, a condition inverted - stops all four jobs with
    // nothing in the logs, because a job that never starts writes no line saying so.
    //
    // The run this observes happened at import time, above: see the comment there for why it
    // cannot happen inside this test.
    assert.deepEqual(
      entryPointCalls,
      ['listAppInstallations', 'countInstallationStates', 'closePool'],
      'run() executed, and runJob() wrapped it - the pool is drained on the way out'
    );
  });
});
