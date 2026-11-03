import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { hydrated } from "./context.js";
import { percentile } from "../../src/utils/percentile.js";

/** The Operations tab's reads, and recording a contribution by hand - one of its two writes - against real SQL. */
export const register = ({ db, rowsOf, oneRow, enrol, contribute, expireLease }) => {
  /** Set columns of one installation, by its login, in SQL relative to the database's clock. */
  const setInstallation = (login, assignments) =>
    rowsOf(`UPDATE github_installations SET ${assignments} WHERE user_login = $1`, [login]);

  /** Set columns of one pull request, by its GitHub id. */
  const setPullRequest = (id, assignments, params = []) =>
    rowsOf(`UPDATE github_pull_requests SET ${assignments} WHERE pull_request_id = $1`, [id, ...params]);

  describe("the state of every subject in both queues", () => {
    test("is one state each - claimed, then overdue, then in backoff, then on schedule - adding up to what is tracked", async () => {
      const logins = ['claimed-one', 'dead-worker', 'overdue-one', 'overdue-high', 'never-synced', 'failing-one', 'fine-one', 'just-due', 'retired', 'octocat', 'overdue-failing'];

      for (const [i, login] of logins.entries()) {
        await enrol(login, { userId: i + 1, installationId: 100 + i });
      }

      // Every lease the table holds is a dead worker's, then one is a live one.
      await setInstallation('dead-worker', "sync_claimed_at = CURRENT_TIMESTAMP, next_sync_at = CURRENT_TIMESTAMP - interval '30 minutes'");
      await expireLease('github_installations', 'sync_claimed_at');
      await setInstallation('claimed-one', "sync_claimed_at = CURRENT_TIMESTAMP - interval '20 seconds', next_sync_at = CURRENT_TIMESTAMP - interval '1 hour'");
      await setInstallation('overdue-one', "next_sync_at = CURRENT_TIMESTAMP - interval '1 hour'");
      await setInstallation('overdue-high', "next_sync_at = CURRENT_TIMESTAMP - interval '2 hours', sync_interval_minutes = 240");
      // Never scheduled: late since it was recorded, three hours ago - the longest of all.
      await setInstallation('never-synced', "next_sync_at = NULL, sync_interval_minutes = NULL, created_timestamp = CURRENT_TIMESTAMP - interval '3 hours'");
      await setInstallation('failing-one', "next_sync_at = CURRENT_TIMESTAMP + interval '1 hour', sync_error_count = 2");
      await setInstallation('fine-one', "next_sync_at = CURRENT_TIMESTAMP + interval '1 hour'");
      // Fell due since the last tick: waiting for the next one, which is on schedule.
      await setInstallation('just-due', "next_sync_at = CURRENT_TIMESTAMP - interval '10 seconds'");
      await setInstallation('retired', "sync_disabled_at = CURRENT_TIMESTAMP, next_sync_at = CURRENT_TIMESTAMP - interval '5 hours'");
      await setInstallation('octocat', "next_sync_at = CURRENT_TIMESTAMP + interval '2 hours'");
      // Late and failing, on the floor's interval the jobs leave as it was: it waits its error
      // backoff, which the queue draws two rungs up - not on the floor.
      await setInstallation('overdue-failing', "next_sync_at = CURRENT_TIMESTAMP - interval '1 hour', sync_error_count = 2, sync_interval_minutes = 15");

      // octocat's pull requests: one under a live lease, one due in half an hour, one never
      // polled since it was recorded two hours ago, one closed.
      await contribute({ id: 7001, number: 1 });
      await contribute({ id: 7002, number: 2 });
      await contribute({ id: 7004, number: 4 });
      await contribute({ id: 7003, number: 3, state: 'closed', closed_at: '2026-01-03T10:00:00.000Z' });
      await setPullRequest(7001, 'poll_claimed_at = CURRENT_TIMESTAMP');
      await setPullRequest(7002, "next_poll_at = CURRENT_TIMESTAMP + interval '30 minutes'");
      await setPullRequest(7004, "next_poll_at = NULL, poll_interval_minutes = NULL, created_timestamp = CURRENT_TIMESTAMP - interval '2 hours'");

      const { sync, poll, oldestLate } = await db.dashboard.getSubjectStates();
      const claim = await oneRow(`SELECT sync_claimed_at FROM github_installations WHERE user_login = 'claimed-one'`);

      assert.deepEqual({ ...sync, oldestClaimAt: null }, {
        tracked: 10, overdue: 5, overdueOnFloor: 3, claimed: 1, oldestClaimAt: null, backoff: 1, onSchedule: 3,
      });
      assert.equal(sync.claimed + sync.overdue + sync.backoff + sync.onSchedule, sync.tracked, 'a subject in two states, or in none');
      assert.ok(sync.oldestClaimAt instanceof Date);
      assert.deepEqual(sync.oldestClaimAt, claim.sync_claimed_at);
      assert.deepEqual({ ...poll, oldestClaimAt: null }, {
        tracked: 3, overdue: 1, overdueOnFloor: 1, claimed: 1, oldestClaimAt: null, backoff: 0, onSchedule: 1,
      });
      assert.equal(poll.claimed + poll.overdue + poll.backoff + poll.onSchedule, poll.tracked);

      const recorded = await oneRow(`SELECT created_timestamp FROM github_installations WHERE user_login = 'never-synced'`);

      assert.equal(oldestLate.label, 'never-synced');
      assert.equal(oldestLate.kind, 'sync');
      assert.deepEqual(oldestLate.dueAt, recorded.created_timestamp, 'never scheduled: late since it was recorded');
      assert.equal(oldestLate.interval, null);
    });

    test("and an empty schema answers two queues of zeros, with nobody late", async () => {
      const { sync, poll, oldestLate } = await db.dashboard.getSubjectStates();

      for (const queue of [sync, poll]) {
        assert.deepEqual(queue, { tracked: 0, overdue: 0, overdueOnFloor: 0, claimed: 0, oldestClaimAt: null, backoff: 0, onSchedule: 0 });
      }

      assert.equal(oldestLate, null);
    });
  });

  describe("the shape of the queue", () => {
    test("counts each queue due now, then up to each edge of the ladder, then beyond - every subject tracked, once", async () => {
      const edges = db.dashboard.QUEUE_EDGES_MINUTES;
      // Never scheduled and overdue are both due now; then one a minute inside each edge, and one
      // past the last.
      const due = ['NULL', "CURRENT_TIMESTAMP - interval '5 minutes'",
        ...edges.map((minutes) => `CURRENT_TIMESTAMP + make_interval(mins => ${minutes - 1})`),
        `CURRENT_TIMESTAMP + make_interval(mins => ${edges.at(-1) + 60})`];

      for (const [i, when] of due.entries()) {
        const login = i === 0 ? 'octocat' : `user-${i}`;

        await enrol(login, { userId: i + 1, installationId: 100 + i });
        await setInstallation(login, `next_sync_at = ${when}`);
      }

      // Retired: in no queue a run drains.
      await enrol('retired', { userId: 50, installationId: 150 });
      await setInstallation('retired', 'sync_disabled_at = CURRENT_TIMESTAMP, next_sync_at = NULL');
      // octocat's pull requests: one never polled, and one closed, out of the queue for good.
      await contribute({ id: 7001, number: 1 });
      await contribute({ id: 7002, number: 2, state: 'closed', closed_at: '2026-01-03T10:00:00.000Z' });
      await setPullRequest(7001, 'next_poll_at = NULL');

      const { sync, poll } = await db.dashboard.getQueueShape();
      const states = await db.dashboard.getSubjectStates();

      assert.deepEqual(sync, [2, ...edges.map(() => 1), 1]);
      assert.deepEqual(poll, [1, ...edges.map(() => 0), 0]);
      assert.equal(sync.reduce((all, count) => all + count, 0), states.sync.tracked, 'the lanes count what the tiles track');
      assert.equal(poll.reduce((all, count) => all + count, 0), states.poll.tracked);
    });

    test("and an empty schema answers two queues of zeros, one per window", async () => {
      const zeros = Array(db.dashboard.QUEUE_EDGES_MINUTES.length + 2).fill(0);

      assert.deepEqual(await db.dashboard.getQueueShape(), { sync: zeros, poll: zeros });
    });
  });

  describe("the head of each queue", () => {
    test("is the claims' own order, never scheduled first, with a claim only under a live lease", async () => {
      for (const [i, login] of ['later', 'overdue', 'dead-worker', 'unscheduled', 'held', 'retired'].entries()) {
        await enrol(login, { userId: i + 1, installationId: 100 + i });
      }

      await setInstallation('dead-worker', "sync_claimed_at = CURRENT_TIMESTAMP, next_sync_at = CURRENT_TIMESTAMP - interval '1 hour'");
      await expireLease('github_installations', 'sync_claimed_at');
      await setInstallation('later', "next_sync_at = CURRENT_TIMESTAMP + interval '1 hour'");
      await setInstallation('overdue', "next_sync_at = CURRENT_TIMESTAMP - interval '5 minutes', sync_error_count = 2, last_sync_error = 'Not Found', last_synced_at = CURRENT_TIMESTAMP - interval '3 hours'");
      await setInstallation('unscheduled', 'next_sync_at = NULL');
      await setInstallation('held', 'next_sync_at = NULL, sync_claimed_at = CURRENT_TIMESTAMP');
      await setInstallation('retired', 'next_sync_at = NULL, sync_disabled_at = CURRENT_TIMESTAMP');

      const { sync } = await db.dashboard.listNextSubjects();
      const overdue = sync.find((subject) => subject.label === 'overdue');

      // NULL first, a tie broken by the id; a claim is still in the queue, a retirement is not.
      assert.deepEqual(sync.map((subject) => subject.label), ['unscheduled', 'held', 'dead-worker', 'overdue', 'later']);
      assert.deepEqual(sync.map((subject) => subject.claimed), [false, true, false, false, false], 'a dead worker holds nothing');
      assert.equal(sync[0].at, null, 'never scheduled: due, as the claims read it');
      assert.ok(overdue.at instanceof Date);
      assert.ok(overdue.sub instanceof Date, 'when it last synced');
      assert.deepEqual({ ...overdue, at: null, sub: null }, {
        at: null, claimed: false, errors: 2, intervalMinutes: 15, label: 'overdue', sub: null, lastError: 'Not Found',
      });
      assert.deepEqual((await db.dashboard.listNextSubjects(2)).sync.map((subject) => subject.label), ['unscheduled', 'held']);
    });

    test("names a pull request by its repository's current name and its number, with what its tooltip says", async () => {
      await enrol('octocat');
      await contribute({ id: 7101, number: 42 });
      await setPullRequest(7101, "next_poll_at = CURRENT_TIMESTAMP + interval '5 minutes', poll_error_count = 3, poll_interval_minutes = 60, "
        + "last_poll_error = 'Bad gateway', last_polled_at = CURRENT_TIMESTAMP - interval '1 hour'");

      const [subject] = (await db.dashboard.listNextSubjects()).poll;

      for (const key of ['at', 'openedAt', 'lastPolledAt']) {
        assert.ok(subject[key] instanceof Date, `${key} is not a date`);
      }

      assert.deepEqual({ ...subject, at: null, openedAt: null, lastPolledAt: null }, {
        at: null, claimed: false, errors: 3, intervalMinutes: 60, label: 'acme/widget#42', sub: 'octocat', commits: 3,
        openedAt: null, lastPolledAt: null, lastError: 'Bad gateway',
      });
    });

    test("and is empty on both queues when nothing is tracked", async () => {
      assert.deepEqual(await db.dashboard.listNextSubjects(), { sync: [], poll: [] });
    });
  });

  describe("the next subjects to claim", () => {
    test("are both claims' own order, interleaved by due time, and nothing under a live lease", async () => {
      for (const [i, login] of ['unscheduled', 'overdue', 'later', 'held', 'octocat'].entries()) {
        await enrol(login, { userId: i + 1, installationId: 100 + i });
      }

      await setInstallation('unscheduled', 'next_sync_at = NULL');
      await setInstallation('overdue', "next_sync_at = CURRENT_TIMESTAMP - interval '5 minutes'");
      await setInstallation('later', "next_sync_at = CURRENT_TIMESTAMP + interval '1 hour'");
      await setInstallation('held', 'next_sync_at = NULL, sync_claimed_at = CURRENT_TIMESTAMP');
      await setInstallation('octocat', "next_sync_at = CURRENT_TIMESTAMP + interval '2 hours'");
      await contribute({ id: 7201, number: 5 });
      await setPullRequest(7201, 'next_poll_at = NULL');

      const next = await db.dashboard.listNextToClaim();

      // NULL first, as each claim orders it, the sync queue taking a tie.
      assert.deepEqual(next.map((subject) => subject.label), ['unscheduled', 'acme/widget#5', 'overdue', 'later', 'octocat']);
      assert.deepEqual((await db.dashboard.listNextToClaim(3)).map((subject) => subject.label), ['unscheduled', 'acme/widget#5', 'overdue']);
    });
  });

  describe("the detection latency", () => {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    // percentile_cont and the page's interpolation agree, to the last bits of a float.
    const same = (measured, computed, message) => (computed === null
      ? assert.equal(measured, null, message)
      : assert.ok(Math.abs(measured - computed) < 1e-6, `${message}: ${measured} against ${computed}`));

    /** A merge seen happen: recorded open, merged at `mergedAt`, noticed `seconds` later. */
    const seen = async (id, mergedAt, seconds, overrides = {}) => {
      await contribute({ id, number: id, state: 'closed', merged: true, merged_at: iso(mergedAt), ...overrides });
      await setPullRequest(id, 'merged_at = $2, state_changed_at = $3, created_timestamp = $4',
        [iso(mergedAt), iso(mergedAt + seconds * 1000), iso(mergedAt - 86_400_000)]);
    };

    test("is every merge this application saw happen, and the window over them, from a UTC midnight", async () => {
      const recent = now - 60_000;
      const today = new Date(now);
      const at = (daysBack, hours, minutes) => Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysBack, hours, minutes);
      // 23:30 UTC yesterday: already today in Paris, the zone this run's sessions are in.
      const lateEvening = at(1, 23, 30);
      // Half an hour into the window's first UTC day, and half an hour before it: the window
      // opens at that day's UTC midnight, not at the session's.
      const firstDay = at(29, 0, 30);
      const seeds = [[7301, recent, 60], [7302, recent, 120], [7303, recent, 180], [7304, lateEvening, 600], [7309, firstDay, 240]];

      for (const [id, mergedAt, seconds] of seeds) {
        await seen(id, mergedAt, seconds);
      }

      await seen(7310, at(30, 23, 30), 60);

      // First seen already merged: the two dates are one statement's, and measure nothing.
      await contribute({ id: 7305, number: 7305, state: 'closed', merged: true, merged_at: iso(recent - 3_600_000) });
      // Noticed before it happened, by the clocks involved.
      await seen(7306, recent, -30);
      // A bot's, noticed through somebody else's feed.
      await seen(7307, recent, 90, { user: { login: 'dependabot[bot]', type: 'Bot' } });
      // Outside the thirty days.
      await seen(7308, now - 40 * 86_400_000, 60);

      const { from, days, points, window } = await db.dashboard.getDetectionLatency();
      const kept = [...seeds].sort((a, b) => a[1] - b[1] || a[2] - b[2]);

      assert.equal(days, 30);
      assert.equal(from, `${iso(firstDay).slice(0, 10)}T00:00:00.000Z`, 'the first day, at its UTC midnight');
      assert.deepEqual(points.map((point) => point.at), kept.map(([, mergedAt]) => iso(mergedAt).replace(/\.\d{3}Z$/, 'Z')),
        'oldest first, each at its merge in UTC');
      kept.forEach(([, , seconds], i) => same(points[i].seconds, seconds, `merge ${i} latency`));

      const all = seeds.map(([, , seconds]) => seconds);

      assert.equal(window.n, 5, 'the window counts its own merges, and nothing from the evening before it');
      same(window.p50, percentile(all, 0.5), 'the window p50');
      // Ungated: the page holds each figure to its own threshold.
      same(window.p99, percentile(all, 0.99), 'the window p99');
    });

    test("and an empty table answers no merge, not zeros", async () => {
      const { days, points, window } = await db.dashboard.getDetectionLatency();

      assert.equal(days, 30);
      assert.deepEqual(points, []);
      assert.deepEqual(window, { n: 0, p50: null, p90: null, p99: null });
    });
  });

  describe("the Operations payload", () => {
    test("names a failing subject by the rung of its backoff, and the cause of a job that failed every subject", async () => {
      const { getOpsSnapshot } = await import("../../src/services/dashboardOps.js");

      for (const [i, login] of ['failed-twice', 'failed-five-times'].entries()) {
        await enrol(login, { userId: i + 1, installationId: 100 + i });
      }

      // Next to be claimed, each on the interval the jobs leave as it was when a sync fails.
      await setInstallation('failed-twice', "next_sync_at = CURRENT_TIMESTAMP + interval '5 minutes', sync_error_count = 2, sync_interval_minutes = 15");
      await setInstallation('failed-five-times', "next_sync_at = CURRENT_TIMESTAMP + interval '10 minutes', sync_error_count = 5, sync_interval_minutes = 15");
      // A run that said ok, and failed the one subject it claimed.
      await db.jobRuns.recordJobRun({
        job: 'sync_contributions', outcome: 'ok', durationMs: 900, counters: { claimed: 1, failed: 1 },
        failures: [{ subject: 'failed-twice', status: 404, message: 'Not Found' }],
      });

      const degraded = new Set();
      const { next, queue, jobs } = await getOpsSnapshot(degraded);
      const card = jobs.find((job) => job.name === 'sync_contributions');

      assert.deepEqual([...degraded], []);
      // Two failures in a row wait 60 min, on that rung; five wait 360, past the 240 ceiling: the band.
      assert.deepEqual(next.map(({ label, minutes, tier }) => [label, minutes, tier]),
        [['failed-twice', 60, 60], ['failed-five-times', 360, 360]]);
      // The track draws the same two, on the axis the query counted them on.
      assert.deepEqual(queue.edges, db.dashboard.QUEUE_EDGES_MINUTES);
      assert.deepEqual(queue.shape.sync, [0, 2, ...queue.edges.map(() => 0)], 'both inside the first window');
      assert.deepEqual(queue.subjects.sync.map(({ label, errors }) => [label, errors]), [['failed-twice', 2], ['failed-five-times', 5]]);
      assert.equal(card.state, 'failing');
      assert.equal(card.lastError, 'failed-twice: 404 Not Found');
    });
  });

  describe("a job's last 24 hours", () => {
    test("count its runs, its failures, its idle runs, its subjects and how long the runs that did something took", async () => {
      const { getOpsSnapshot } = await import("../../src/services/dashboardOps.js");

      // A day and an hour ago: outside the window.
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'failed', durationMs: 99_000, error: 'old' });
      await rowsOf(`UPDATE job_runs SET started_at = CURRENT_TIMESTAMP - interval '25 hours'`);
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'ok', durationMs: 900, counters: { claimed: 3, failed: 1 } });
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'idle', durationMs: 40, counters: { claimed: 0 } });
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'failed', durationMs: 20, error: 'boom' });

      const day = (await db.jobRuns.summariseJobRuns(24)).get('sync_contributions');

      // The average leaves the idle run out, as a 40 ms run would hide a slow one; the peak does not.
      assert.deepEqual(day, { runs: 3, failed: 1, idle: 1, avgDurationMs: 460, maxDurationMs: 900, subjectsFailed: 1, subjectsClaimed: 3 });

      const { jobs } = await getOpsSnapshot(new Set());

      assert.deepEqual(jobs.find((job) => job.name === 'sync_contributions').window, day);
      assert.deepEqual(jobs.find((job) => job.name === 'sync_repositories').window,
        { runs: 0, failed: 0, idle: 0, avgDurationMs: 0, maxDurationMs: 0, subjectsFailed: 0, subjectsClaimed: 0 }, 'no run is every count at zero');
      assert.equal(jobs.find((job) => job.name === 'sync_contributions').runs.length, 4, 'the sparkline keeps the old run');
    });
  });

  describe("the enrolled accounts", () => {
    test("count a person's pull requests whatever the case of the login they were opened with", async () => {
      const id = await enrol('OctoCat');

      await contribute({ id: 7401, number: 1 });
      await contribute({ id: 7402, number: 2, state: 'closed', merged: true, merged_at: '2026-01-03T10:00:00.000Z' });
      await contribute({ id: 7403, number: 3, user: { login: 'octocat', type: 'Bot' } });

      const [before] = await db.dashboard.listUsers();
      const recorded = await oneRow(`SELECT created_timestamp FROM github_installations`);

      assert.equal(before.login, 'OctoCat');
      assert.deepEqual([before.pullRequests, before.merged], [2, 1], "hydrated() opens as octocat, the account is OctoCat, and a bot's is nobody's");
      assert.deepEqual(before.enrolledAt, recorded.created_timestamp);
      assert.equal(before.lastSyncedAt, null);

      await db.installations.markSyncSucceeded(id, { intervalMinutes: 30, delaySeconds: 600, etag: null });

      assert.ok((await db.dashboard.listUsers())[0].lastSyncedAt instanceof Date);
    });
  });

  describe("what the bot has recorded", () => {
    // Parsed at import, as the Overall suite does it: the list is extended here and put back after.
    const OURS = 'our-org';
    let owned;

    before(async () => {
      ({ OWN_GITHUB_ORGS: owned } = await import("../../src/utils/constants.js"));
      owned.push(OURS);
    });

    after(() => {
      owned.splice(owned.indexOf(OURS), 1);
    });

    test("counts every table whole, bots and every owner included", async () => {
      const { getOpsSnapshot } = await import("../../src/services/dashboardOps.js");

      await enrol('octocat', { userId: 1, installationId: 42 });
      await enrol('gone', { userId: 2, installationId: 43 });
      await setInstallation('gone', 'installation_deleted = true');

      // One author in two cases, a bot, and a contribution recorded by hand a month ago.
      const widget = await contribute({ id: 7501, number: 1, commits: 3 });

      await contribute({ id: 7502, number: 2, commits: 5, state: 'closed', merged: true, merged_at: '2026-01-03T10:00:00.000Z', user: { login: 'OctoCat', type: 'User' } });
      await contribute({ id: 7503, number: 3, commits: 1, user: { login: 'dependabot[bot]', type: 'Bot' } });

      const { id: tool } = await db.repositories.ensureRepository(`${OURS}/tool`, 9002);

      await db.pullRequests.upsertPullRequest(hydrated({ id: 7504, number: 4, commits: 2, user: { login: 'hubber', type: 'User' } }), tool);
      await setPullRequest(7504, "origin = 'manual', created_timestamp = CURRENT_TIMESTAMP - interval '30 days'");

      await rowsOf(`INSERT INTO github_pull_request_events (number, action, repository_id) VALUES (1, 'opened', $1), (2, 'closed', $1)`, [widget]);
      await rowsOf(`INSERT INTO github_push_events (push_id, repository_id) VALUES (1, $1)`, [widget]);
      await db.repositories.recordRename(widget, 'acme/gadget', 'acme/widget');

      const { since } = await oneRow(`SELECT min(created_timestamp) AS since FROM github_pull_requests`);
      const inventory = await db.dashboard.getInventory();

      assert.ok(inventory.since instanceof Date);
      assert.deepEqual(inventory, {
        pullRequests: 4, byPeople: 3, byBots: 1, merged: 1, commits: 11, authors: 3, byHand: 1, since, lastWeek: 3,
        repositories: 2, repositoriesOurs: 1, accounts: 2, accountsActive: 1, pullRequestEvents: 2, pushEvents: 1, renames: 1,
      });
      assert.deepEqual((await getOpsSnapshot(new Set())).inventory, inventory, 'the Operations payload carries it as read');
    });

    test("and an empty schema answers zeros, collecting since nothing", async () => {
      assert.deepEqual(await db.dashboard.getInventory(), {
        pullRequests: 0, byPeople: 0, byBots: 0, merged: 0, commits: 0, authors: 0, byHand: 0, since: null, lastWeek: 0,
        repositories: 0, repositoriesOurs: 0, accounts: 0, accountsActive: 0, pullRequestEvents: 0, pushEvents: 0, renames: 0,
      });
    });
  });

  describe("the recent runs", () => {
    test("leave out the idle ones", async () => {
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'idle', durationMs: 40, counters: { claimed: 0 } });
      await db.jobRuns.recordJobRun({ job: 'sync_contributions', outcome: 'ok', durationMs: 900, counters: { claimed: 3 } });
      await db.jobRuns.recordJobRun({ job: 'poll_non_closed_pull_requests', outcome: 'failed', durationMs: 20, error: 'boom' });

      assert.deepEqual((await db.jobRuns.listRecentRuns()).map((run) => run.outcome).sort(), ['failed', 'ok']);
    });
  });

  describe("a contribution recorded by hand", () => {
    const manual = (overrides = {}) => ({
      id: -123456789,
      number: 1664,
      title: 'Add azure data disk management',
      url: 'https://gitlab.com/gitlab-org/toolkit/-/merge_requests/1664',
      fullName: 'gitlab-org/toolkit',
      openedBy: 'octocat',
      openedAt: '2026-01-02T00:00:00.000Z',
      mergedAt: '2026-01-09T00:00:00.000Z',
      mergedBy: null,
      commits: 16,
      changedFiles: 21,
      stars: 238,
      ...overrides,
    });

    test("a project on another forge gets one row, however many times it is recorded", async () => {
      // The reason idx_repositories_foreign_full_name had to exist: github_id is the conflict
      // target of the other insert, two NULLs are distinct in a partial unique index, so without
      // its own target an id-less insert conflicts with nothing and every recording adds a row.
      const first = await db.repositories.ensureForeignRepository('gitlab-org/toolkit');
      const again = await db.repositories.ensureForeignRepository('gitlab-org/toolkit');
      // And the case a browser produces: a path pasted out of a URL bar keeps its capitals.
      const shouted = await db.repositories.ensureForeignRepository('GitLab-Org/Toolkit');

      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.equal(again.id, first.id);
      assert.equal(shouted.id, first.id, 'a forge path differing only in case is one project');
    });

    test("and it is out of the refresh queue for ever, having no id to be read by", async () => {
      await db.repositories.ensureForeignRepository('gitlab-org/toolkit');

      const claimed = await db.repositories.claimRepositoriesForRefresh();

      assert.deepEqual(claimed.filter((row) => row.full_name === 'gitlab-org/toolkit'), []);
    });

    test("is written merged, closed and manual, whatever the caller passes", async () => {
      const { id } = await db.repositories.ensureForeignRepository('gitlab-org/toolkit');

      const { recorded } = await db.pullRequests.upsertManualContribution(manual(), id);

      assert.equal(recorded, true);

      const [row] = (await db.contributions.listPendingPullRequests()).filter((p) => p.number === 1664);

      // Merged and closed, so it is not pending anything: the panel that lists open work must
      // never show one of these.
      assert.equal(row, undefined);

      const [stored] = (await db.pullRequests.listManualContributions())
        .filter((c) => c.pullRequestId === -123456789);

      assert.equal(stored.repo, 'gitlab-org/toolkit');
      assert.equal(stored.login, 'octocat');
      assert.equal(stored.forge, 'gitlab', 'the forge is read off the address, not stored twice');
    });

    test("is never claimed by the poll, which has nothing to fetch for it", async () => {
      const { id } = await db.repositories.ensureForeignRepository('gitlab-org/toolkit');

      await db.pullRequests.upsertManualContribution(manual(), id);

      const claimed = await db.polling.claimPullRequestsForPoll();

      assert.deepEqual(claimed.filter((row) => row.number === 1664), [],
        'origin = manual is what keeps a merge request on another forge out of the queue');
    });

    test("recording the same address twice updates the one row", async () => {
      const { id } = await db.repositories.ensureForeignRepository('gitlab-org/toolkit');

      await db.pullRequests.upsertManualContribution(manual(), id);
      const second = await db.pullRequests.upsertManualContribution(manual({ title: 'A better title' }), id);

      assert.equal(second.recorded, false, 'the second is an update, and says so');

      const rows = await db.pullRequests.listManualContributions();

      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, 'A better title');
    });

    test("removing one cannot reach a contribution the sync collected", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      // A synced row, and a hand-recorded one carrying the id somebody might mistype.
      await db.pullRequests.upsertPullRequest(hydrated({ id: 5001 }), id);
      await db.pullRequests.upsertManualContribution(manual({ id: -999, fullName: 'acme/widget' }), id);

      assert.equal(await db.pullRequests.deleteManualContribution(5001), false,
        'the DELETE is scoped to origin = manual, or a mistyped id reaches a row the feed will never offer again');
      assert.equal(await db.pullRequests.deleteManualContribution(-999), true);
      assert.deepEqual(await db.pullRequests.listManualContributions(), []);
    });
  });
};
