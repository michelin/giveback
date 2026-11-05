import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { read, filesUnder, dashboardServices, withoutComments, fn, functions } from "../test-support/sources.js";
import { snapshotOf } from "../test-support/fixtures/snapshot.js";
import { operatorSnapshotOf, subjectOf } from "../test-support/fixtures/ops.js";

// A database nobody listens on, read by src/db/index.js at import, as in dashboard.test.js: the
// routes below must answer before any query, and one that queried fails here rather than running
// against whatever local database the pool's defaults reach.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "9";

const { runPage, report, css, script, chartIn, legendIn, plain } = await import("../test-support/dashboardPage.js");
const ops = await import("../src/services/dashboardOps.js");
const db = await import("../src/db/dashboard.js");
const service = await import("../src/services/dashboardService.js");
const manual = await import("../src/services/manualContributionService.js");

describe("the enrollment address never leaves the operator tier", () => {
  // The page is readable by every enrolled user, and this block is what makes that safe. One
  // read in db/dashboard.js carries an address; everything else in the file may be published.
  const OPERATOR_TIER = ['listUsers'];

  // Columns nothing in this file may read, at any tier. They identify a person or carry a
  // capability, and no panel needs them.
  //
  // merged_by was let out of this list once, for the bot-merge figure - saying "merged BY US"
  // cannot be done without reading who merged - and held to "countable, never returnable"
  // instead. The figure is gone, and so is the exemption.
  const FORBIDDEN_EVERYWHERE = ['user_name', 'actor', 'events_etag', 'merged_by'];

  const source = withoutComments(read('src/db/dashboard.js'));

  for (const column of FORBIDDEN_EVERYWHERE) {
    test(`nothing reads ${column}`, () => {
      assert.doesNotMatch(source, new RegExp(`\\b${column}\\b`));
    });
  }

  test("only the operator tier reads user_enrollment_email_address", () => {
    // The property that matters is not "this column is unused" - one function needs it - but
    // "no other query can emit it". A panel reaching for the address is how a page built for
    // the whole population quietly becomes a list of who works here.
    const offenders = [...functions(source)]
      .filter(([name]) => !OPERATOR_TIER.includes(name))
      .filter(([, body]) => /\buser_enrollment_email_address\b/.test(body))
      .map(([name]) => name);

    assert.deepEqual(offenders, [], `the address is emitted outside ${OPERATOR_TIER.join(' and ')}`);
  });

  test("the operator tier is exactly what the service gates", () => {
    // Two reads and every write. Anything added to OPERATOR_TIER above without a gate here
    // would be an exemption granted in this file and never enforced in that one.
    //
    // The reads are gated by who is sent them at all, not by a redaction afterwards: they belong
    // to the Operations tab, which is read in one place, past the operator check.
    const opsSnapshot = fn(read('src/services/dashboardOps.js'), 'getOpsSnapshot');
    const serviceSource = read('src/services/dashboardService.js');
    const snapshot = fn(serviceSource, 'getSnapshot');

    assert.match(opsSnapshot, /listUsers\(\)/, 'the account list is read somewhere else now - gate it there');
    assert.match(opsSnapshot, /listRecentFailures\(/, 'the failure causes are read somewhere else now - gate them there');
    // The head of each queue carries every subject's last error, for the track's tooltip.
    assert.match(opsSnapshot, /listNextSubjects\(\)/, 'the queue and its errors are read somewhere else now - gate them there');

    const callers = filesUnder('src', '.js').filter((file) => withoutComments(read(file)).includes('getOpsSnapshot('));

    assert.deepEqual(callers, ['src/services/dashboardService.js'],
      'the operational snapshot is read from somewhere that does not check the tier');
    // The tier the gate decided on the account id, never one worked out again from a login.
    assert.deepEqual(withoutComments(serviceSource).match(/getSnapshot\([^)]*\)/g).filter((call) => !call.startsWith('getSnapshot(viewer')),
      ['getSnapshot(login, req.isOperator)', 'getSnapshot(req.dashboardLogin, req.isOperator)']);
    assert.match(snapshot, /if \(!operator\) \{\s*return base;\s*\}[\s\S]*getOpsSnapshot\(/,
      'a reader must leave with the base before anything operational is read');

    // Every write is on the same tier, checked before anything else the handler does: their
    // buttons are drawn from a tab only an operator is sent.
    assert.match(
      serviceSource,
      /handlePostDashboardUserSync[\s\S]{0,300}if \(!req\.isOperator\)/,
      'the force-sync route is not gated'
    );

    const manualSource = read('src/services/manualContributionService.js');
    const handlers = [...manualSource.matchAll(/^export async function (handle\w+)/gm)].map((m) => m[1]);

    assert.ok(handlers.length >= 4, `only ${handlers.length} manual-entry handlers found - the pattern stopped matching`);

    for (const name of handlers) {
      assert.match(fn(manualSource, name), /^[^{]*\{\s*if \(refuseUnlessOperator\(req, res\)\) \{\s*return;\s*\}/,
        `${name} does not refuse a reader before doing anything else`);
    }
  });
});

describe("the one route that writes", () => {
  /** @returns {Object} A response that records what a handler answered */
  const jsonResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set() { return this; },
  });

  test("is a POST, behind the gate the page is behind", () => {
    // POST is the defence, not decoration: the session cookie is SameSite=Lax, which a browser
    // withholds from a cross-site POST and sends on a cross-site GET. As a GET this would fire
    // from an <img> on any page an operator happens to open.
    const index = read('src/index.js');

    assert.match(
      index,
      /express\.post\("\/dashboard\/users\/:userId\/sync", requireDashboardAccess, handlePostDashboardUserSync\)/,
      'the force-sync route must be a POST and must be gated'
    );
    assert.doesNotMatch(index, /express\.get\("\/dashboard\/users/);
  });

  test("refuses anything that is not an account id, without asking the database", async () => {
    // No database in this suite, so reaching one would fail the test by itself - which is the
    // point: the guard has to come before the query, not after it.
    for (const userId of ['not-a-number', '', '-1', '0', '1.5']) {
      const res = jsonResponse();

      await service.handlePostDashboardUserSync(
        { params: { userId }, dashboardLogin: 'operator-one', isOperator: true },
        res
      );

      assert.equal(res.statusCode, 400, `${JSON.stringify(userId)} was accepted as an account id`);
    }
  });
});

describe("a reader asking for an operator's route", () => {
  // The tier is checked first, so these answer without a database: reaching one would fail the
  // test by itself, which is the point.
  /** @returns {Object} A response that records what a handler answered */
  const jsonResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set() { return this; },
  });

  const ROUTES = [
    ['GET /dashboard/manual', manual.handleGetManualContributions],
    ['POST /dashboard/manual/lookup', manual.handlePostManualLookup],
    ['POST /dashboard/manual', manual.handlePostManualContribution],
    ['DELETE /dashboard/manual/:id', manual.handleDeleteManualContribution],
    ['POST /dashboard/users/:userId/sync', service.handlePostDashboardUserSync],
  ];

  for (const [route, handler] of ROUTES) {
    test(`${route} answers 404, as if it did not exist`, async () => {
      const res = jsonResponse();

      await handler({
        isOperator: false,
        dashboardLogin: 'a-reader',
        params: { id: '-5', userId: '5' },
        body: { url: 'https://github.com/acme/widget/pull/7' },
      }, res);

      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { error: 'not found' });
    });
  }
});

describe("the page is told which job is running", () => {
  // The tick bar cannot show a position mid-run, so it has to know. Asked of Bree, whose
  // workers Map is keyed by job name, rather than inferred from job_runs - which only learns
  // a run happened once it has finished, which is exactly too late.
  test("from the scheduler's own workers, not from the run history", () => {
    const bree = read('src/services/breeService.js');

    assert.match(bree, /running: bree\.workers\?\.has\(name\) \?\? false/, 'per-job running must come from Bree');
  });

  test("and it reaches each job in the snapshot", () => {
    const service = dashboardServices();

    assert.match(service, /scheduler\.jobs\.map\(\(\{ name, cron, running \}\)/, 'the flag must be carried through');
    assert.match(service, /running: Boolean\(running\)/);
  });
});

describe("the operational figures count what a PERSON opened", () => {
  const dashboard = read('src/db/dashboard.js');

  test("and every one of them counts what a PERSON opened", () => {
    // The same rule as the report's, on the two reads of this file that publish a pull request
    // figure. The queue reads are deliberately absent: POLLABLE already requires an enrolled
    // author and no bot has an installation, so a second predicate there would cost the index
    // and say nothing.
    const COUNT_PULL_REQUESTS = [
      'listUsers',
      'getDetectionLatency',
    ];

    for (const name of COUNT_PULL_REQUESTS) {
      assert.match(fn(dashboard, name), /\$\{BY_A_PERSON\}/, `${name} counts a bot as a contributor`);
    }

    assert.match(dashboard, /import \{ IS_OWN, BY_A_PERSON \} from "\.\/predicates\.js";/,
      'the report\'s own definition, not a copy of it');
  });
});

describe("the queue is drawn on the scheduler's own ladder", () => {
  test("which nothing that draws or reads it writes down", () => {
    // Derived from SCHEDULING by intervalLadder(), never spelled out: a ladder written down would
    // go on drawing the old one the day a bound moved. The tiers are the payload's; the track's
    // axis and the windows its lanes are counted in are one constant beside the query that counts
    // them, sent to the page, which draws what it is sent.
    for (const file of [...filesUnder('views', '.js'), ...filesUnder('views', '.ejs'), ...filesUnder('src/db', '.js')]) {
      assert.doesNotMatch(withoutComments(read(file)), /\[15, 30/, `${file} writes a ladder of its own`);
    }

    assert.match(read('src/services/dashboardOps.js'), /tiers: intervalLadder\(bounds\)/);
    assert.match(read('src/db/dashboard.js'), /export const QUEUE_EDGES_MINUTES = Object\.freeze\(intervalLadder\(\{/);
    assert.match(fn(read('src/services/dashboardOps.js'), 'getOpsSnapshot'), /edges: QUEUE_EDGES_MINUTES/);

    for (const file of [...filesUnder('views', '.js'), ...filesUnder('views', '.ejs')]) {
      assert.doesNotMatch(withoutComments(read(file)), /QUEUE_EDGES/, `${file} keeps an axis of its own`);
    }
  });

  test("the lower of the two floors doubling to the higher of the two ceilings", () => {
    // One axis for both lanes, so one ladder for both queues: at the shipped bounds, both 15 to 240.
    assert.deepEqual(db.QUEUE_EDGES_MINUTES, [15, 30, 60, 120, 240]);
  });

  test("and every card draws the same forty-eight runs, production's four hours", () => {
    assert.match(read('src/db/job_runs.js'), /export const SPARKLINE_RUNS = 48;/);
    assert.match(fn(read('src/services/dashboardOps.js'), 'getOpsSnapshot'), /sparklineRuns: SPARKLINE_RUNS/);
    // The page reads the length it was sent, and keeps no fallback of its own to drift from it.
    assert.doesNotMatch(read('views/dashboard/ops.js'), /\?\? 48|sparklineRuns \?\?/);
  });
});

describe("one word for a job, on its card and in the tile", () => {
  const run = (outcome, counters = {}) => ({ outcome, counters, durationMs: 100, error: null, startedAt: new Date().toISOString() });

  test("failing, when the last run that did something failed", () => {
    assert.equal(ops.jobState({ running: false, runs: [run('ok'), run('failed'), run('idle')] }), 'failing');
  });

  test("failing too, when it claimed subjects and failed every one - the run said ok", () => {
    // The failure a status light hides: the run completes, reports ok, collects nothing.
    assert.equal(ops.jobState({ running: false, runs: [run('ok', { claimed: 41, failed: 41 })] }), 'failing');
  });

  test("but a few failed subjects are the parc, not the job", () => {
    // The case that once painted a card amber over 5 subjects out of 444: not a state any more.
    assert.equal(ops.jobState({ running: false, runs: [run('ok', { claimed: 444, failed: 5 })] }), 'ok');
  });

  test("running while Bree has a worker for it, and failing wins over that", () => {
    assert.equal(ops.jobState({ running: true, runs: [run('ok')] }), 'running');
    assert.equal(ops.jobState({ running: true, runs: [run('failed')] }), 'failing');
  });

  test("idle when its last run found nothing to do, ok otherwise", () => {
    assert.equal(ops.jobState({ running: false, runs: [run('ok'), run('idle')] }), 'idle');
    assert.equal(ops.jobState({ running: false, runs: [run('ok'), run('skipped')] }), 'ok');
    // Claimed nothing is not an outage: no division, and no red on a first day.
    assert.equal(ops.jobState({ running: false, runs: [run('ok', { claimed: 0, failed: 0 })] }), 'ok');
    assert.equal(ops.jobState({ running: false, runs: [] }), 'ok');
  });

  test("and the Failing jobs tile counts exactly the cards whose pill says failing", async () => {
    const snapshot = operatorSnapshotOf();

    snapshot.ops.jobs.push({ ...snapshot.ops.jobs[0], name: 'sync_repositories' }, { ...snapshot.ops.jobs[1], name: 'reconcile_installations', state: 'idle' });

    const { elements } = await runPage(snapshot);
    const pills = (elements.get('o-jobs').innerHTML.match(/<span class="pill failing">/g) ?? []).length;

    assert.equal(pills, 2);
    assert.match(tileOf(elements, 'failing'), new RegExp(`<span class="v">${pills}</span> <small><span>of 4</span>`));
    assert.match(tileOf(elements, 'failing'), /sync_contributions, sync_repositories/);
  });
});

/** One tile of the row, by its key. */
const tileOf = (elements, key) => new RegExp(`<div class="tile[^"]*"[^>]*data-tile="${key}">[\\s\\S]*?</dd></div>`)
  .exec(elements.get('o-tiles').innerHTML)?.[0] ?? '';

/** What the track wrote, in the order it wrote it. */
const textsOf = (painted) => painted.filter((call) => call.op === 'fillText').map((call) => call.args[0]);

/**
 * The track's tokens as drawn, in the order they were: each where it is, how big, and in what
 * colour it was filled. A token is a disc of 2.6, or 3.4 when claimed, filled straight after; a
 * claim's ring is 2.6 wider, and stroked.
 */
const tokensOf = (painted) => painted.flatMap((call, i) => (call.op === 'arc' && call.args[2] < 4
  ? [{ x: call.args[0], y: call.args[1], r: call.args[2], fill: painted[i + 1].fillStyle }]
  : []));

describe("the Operations tab runs", () => {
  test("on a populated snapshot, every block on its component", async () => {
    const run = await runPage(operatorSnapshotOf());
    const { elements, errors, painted } = run;

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('view-ops').hidden, false, 'an operator opens on the Operations tab');
    assert.equal((elements.get('o-tiles').innerHTML.match(/<div class="tile/g) ?? []).length, 4);
    assert.match(elements.get('o-jobs').innerHTML, /sync_contributions[\s\S]*poll_non_closed_pull_requests/);
    assert.equal(tokensOf(painted).length, 4, 'one token per subject at the head of its queue');
    assert.match(elements.get('o-next').innerHTML, /dev-user-1[\s\S]*acme\/one#12/);
    assert.match(elements.get('o-capacity-canvas').getAttribute('aria-label'), /^Subjects: on schedule 54, overdue 4, claimed 1 \(oldest 1[23]\ss\), in backoff 3$/);
    assert.deepEqual(legendIn(run, 'o-latency'), ['circle one merge', 'line p50 25\u00a0min', 'dash p90 55\u00a0min']);
    assert.deepEqual(legendIn(run, 'o-capacity').map((item) => item.replace(/1[23]\u00a0s/, '12\u00a0s')),
      ['square on schedule 54', 'square overdue 4', 'square claimed 1 oldest 12\u00a0s', 'square in backoff 3']);
    assert.match(elements.get('o-runs-rows').innerHTML, /reconcile_installations/);
    assert.match(elements.get('o-users-rows').innerHTML, /dev-user-1[\s\S]*dev\.one@acme\.com/);
    assert.match(elements.get('m-list-none').innerHTML, /Nothing recorded by hand\./);
  });

  test("with the copy each panel is subtitled by", async () => {
    const { elements, html } = await runPage(operatorSnapshotOf());

    assert.match(html, /<h2>The queue<\/h2>\s*<p class="panel-sub">Nothing is scheduled per user: the jobs drain whatever has reached the line<\/p>/);
    assert.equal(elements.get('o-capacity-sub').textContent, '62 subjects tracked');
    assert.equal(elements.get('o-latency-sub').textContent, 'From merge to record, 40 records over 30 days');
    assert.equal(elements.get('o-runs-sub').textContent, 'Last 2 runs, idle runs left out');
    assert.equal(elements.get('o-users-sub').textContent, '2 accounts');
  });

  test("on a first boot, where every table is still empty", async () => {
    // The moment somebody is most likely to open the page, and the one with the most nulls.
    const none = { tracked: 0, overdue: 0, overdueOnFloor: 0, claimed: 0, oldestClaimAt: null, backoff: 0, onSchedule: 0 };
    const zeros = [0, 0, 0, 0, 0, 0, 0];
    const { elements, errors, painted } = await runPage(operatorSnapshotOf({
      jobs: [],
      subjects: { sync: none, poll: none, oldestLate: null },
      queue: { ...operatorSnapshotOf().ops.queue, shape: { sync: zeros, poll: zeros }, subjects: { sync: [], poll: [] } },
      next: [],
      latency: { ...operatorSnapshotOf().ops.latency, points: [], window: { n: 0, p50: null, p90: null, p99: null } },
      runs: [],
      users: [],
    }));

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    // Each says what it is, rather than showing a bare dash: a first boot is exactly when
    // somebody looks and concludes the thing is broken.
    assert.match(elements.get('o-jobs').innerHTML, /No job is scheduled in this process\./);
    // The track still draws its lanes, its axis and the line, and says there is nothing on them.
    assert.deepEqual(tokensOf(painted), []);
    assert.deepEqual(textsOf(painted).filter((text) => /queued/.test(text)), ['0 queued, 0 due', '0 queued, 0 due']);
    assert.ok(textsOf(painted).includes('NOW'));
    assert.equal(elements.get('o-queue-unit').textContent, '');
    assert.match(elements.get('o-next').innerHTML, /Nothing is waiting to be claimed\./);
    assert.match(elements.get('o-capacity-none').innerHTML, /Nothing tracked\./);
    assert.match(elements.get('o-latency-none').innerHTML, /No merge recorded in the last 30 days\./);
    assert.match(elements.get('o-runs-none').innerHTML, /No run recorded yet\./);
    assert.match(elements.get('o-users-none').innerHTML, /Nobody has enrolled yet\./);
    assert.equal(elements.get('o-users-rows').innerHTML, '');

    for (const key of ['overdue', 'claimed', 'failing']) {
      assert.match(tileOf(elements, key), /<div class="tile zero"[\s\S]*<span class="v">0<\/span>/, `${key} is not a zero`);
    }

    assert.match(tileOf(elements, 'lateness'), /<div class="tile zero"[\s\S]*<span class="v">none<\/span>/);
  });

  test("and says how much of the queue it draws, when that is not all of it", async () => {
    // The head of each queue is drawn and the rest counted: a silent cap reads as "this is
    // everything".
    const { elements, painted } = await runPage(operatorSnapshotOf());

    assert.equal(elements.get('o-queue-unit').textContent, 'showing the next 4 of 62 queued');
    assert.deepEqual(textsOf(painted).filter((text) => /beyond/.test(text)), ['+37 beyond', '+21 beyond']);

    // All of it drawn: nothing to say.
    const whole = operatorSnapshotOf();

    whole.ops.queue.shape = { sync: [1, 1, 0, 0, 0, 0, 1], poll: [0, 1, 0, 0, 0, 0, 0] };

    const drawn = await runPage(whole);

    assert.equal(drawn.elements.get('o-queue-unit').textContent, '');
    assert.deepEqual(textsOf(drawn.painted).filter((text) => /beyond|showing/.test(text)), []);
  });

  test("with a counter that is not a number, from an older version of the app", async () => {
    // job_runs.counters is jsonb written by whichever version of the app recorded the run, so
    // the page reads rows it did not write. An array in there rendered as a bare key with no
    // value after it - seen locally, on rows left by a process holding a stale module.
    const { elements, errors } = await runPage(operatorSnapshotOf({
      runs: [{ job: "sync_contributions", outcome: "ok", durationMs: 120,
        counters: { claimed: 2, failed: 1, failures: [] }, error: null, startedAt: new Date().toISOString() }],
    }));

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    // Each counter a fragment of the line, its dot in the box before it: a wrapped line of
    // counters never starts on a dot.
    assert.match(elements.get('o-runs-rows').innerHTML, /<span>claimed\u00a02<\/span> <span>failed\u00a01<\/span>/);
    assert.doesNotMatch(elements.get('o-runs-rows').innerHTML, /failures/, 'a non-numeric counter was rendered');
  });

  test("marks each hand-recorded row with its forge, and never with a badge that draws nothing", () => {
    const source = script();

    // ownBadge() answers an empty string for anything that is not one of our own repositories,
    // which is most of what gets recorded by hand: the column began with a gap and nothing
    // said why. A call that can render nothing is worse than no call at all.
    assert.doesNotMatch(source, /ownBadge\(false\)/,
      'a badge called with a constant false draws nothing - use the forge mark');
    assert.match(source, /marks\.forge\(row\.forge\)/);

    // Both marks have a path, or one forge silently draws an empty box.
    assert.match(source, /FORGE_MARKS = \{[\s\S]*?github: '<path[\s\S]*?gitlab: '<path/);

    // And the shape tells them apart, not a hue: --sync and --poll already say ours and elsewhere
    // on the same rows, and a forge wearing one of them reads as a scope.
    assert.match(css(), /\.forgemark \{[^}]*fill: var\(--ink-dim\)/);
    assert.doesNotMatch(css(), /\.forgemark\.[a-z]/, 'a rule per forge is a hue per forge');
  });

  test("draws the manual entry only inside the tab only an operator is rendered", async () => {
    // The tab is what is withheld, not the panel: every route behind it answers 404 to a reader
    // without the tier, so the page leaving it out is a courtesy and never the thing that stops
    // somebody.
    const operator = await runPage(operatorSnapshotOf());

    assert.match(operator.html, /id="view-ops"[\s\S]*id="m-look"/);

    const reader = await runPage(snapshotOf());

    assert.doesNotMatch(reader.html, /id="m-look"/,
      'a reader is not rendered a form whose every route would refuse them');
  });

  test("gives the operator the tab before there is anything in it", async () => {
    // Gated on the tier, not on the presence of rows: an operator who has recorded nothing yet
    // is exactly the operator who needs the form.
    const { html, elements, errors, fetched } = await runPage(operatorSnapshotOf(), undefined, { manual: [] });

    assert.deepEqual(errors.map((e) => `${e.phase}: ${e.error.message}`), []);
    assert.match(html, /data-view="ops"/);
    // Read when the tab opens, and said when there is nothing in it.
    assert.ok(fetched.some((call) => call.url === '/dashboard/manual'), 'the list was never asked for');
    assert.match(elements.get('m-list-none').innerHTML, /<b>Nothing recorded by hand\.<\/b>/);
    assert.equal(elements.get('m-list-tools').innerHTML, '', 'no chips over nothing');
  });

  test("and lists what was recorded, by forge, a page at a time", async () => {
    const recorded = Array.from({ length: 60 }, (_, i) => ({
      pullRequestId: -1 - i, number: 1600 + i, title: `Change ${i}`, url: `https://gitlab.com/group/project/-/merge_requests/${1600 + i}`,
      repo: 'group/project', login: 'dev-user-1', mergedAt: '2026-01-09T00:00:00.000Z', commits: i === 0 ? null : 3,
      forge: i < 50 ? 'gitlab' : 'github',
    }));
    const { elements } = await runPage(operatorSnapshotOf(), undefined, { manual: recorded });

    assert.match(elements.get('m-list-tools').innerHTML, /data-value="gitlab"[^>]*>GitLab <b>50<\/b>/);
    assert.match(elements.get('m-list-count').textContent, /^60 of 60 contributions match\.$/);
    assert.equal((elements.get('m-list-rows').innerHTML.match(/<li /g) ?? []).length, 10);
    assert.match(elements.get('m-list-pages').innerHTML, /1–10 of 60/);
    // Credited to an enrolled GitHub login, whichever forge it was merged on: shown by that face.
    assert.match(elements.get('m-list-rows').innerHTML, /<span>group\/project !1600<\/span> <span>merged Jan 9, 2026<\/span> <span><img class="avatar" style="--size: 20px"[^>]*\/dev-user-1\?s=40">dev-user-1<\/span>/);
    assert.match(elements.get('m-list-rows').innerHTML, /<button type="button" class="drop" data-drop="-2" data-focus-key="drop:-2">Remove<\/button>/);
  });

  test("and says so when what was recorded by hand could not be read", async () => {
    // Otherwise the panel is its title alone, which reads as still loading.
    const { elements, errors } = await runPage(operatorSnapshotOf(), undefined, { manual: null });

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('m-list').innerHTML, '<div class="nothing"><b>Could not read what was recorded by hand.</b></div>');
  });

  test("and says so when the run history could not be read", async () => {
    // A database whose schema predates job_runs. Empty sparklines must not be mistaken for a
    // scheduler that has stopped.
    const { elements, errors } = await runPage(operatorSnapshotOf({ runs: [] }, { degraded: ['run history'] }));

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('notice').innerHTML, 'Showing the page without run history: its table is missing.');
  });

  test("hides nothing itself: what is shown is decided by the server", () => {
    // A tripwire, one per script: something this tab starts hiding is a new element for the
    // [hidden] rule to cover, and has to be listed where the rule is tested.
    assert.equal((read('views/dashboard/ops.js').match(/\.hidden = /g) ?? []).length, 0);
  });
});

describe("the tiles and the blocks under them say the same thing", () => {
  test("Overdue is the bar's overdue segment, and Claimed its claimed one", async () => {
    const run = await runPage(operatorSnapshotOf());
    const { elements } = run;
    const labels = chartIn(run, 'o-capacity').data.datasets.map((dataset) => dataset.label);
    const segment = (label) => labels.map((text) => new RegExp(`^${label} (\\d+)`).exec(text)?.[1]).find(Boolean);

    assert.match(tileOf(elements, 'overdue'), new RegExp(`<span class="v">${segment('overdue')}</span> <small><span>of 62 tracked</span>`));
    assert.match(tileOf(elements, 'overdue'), /1 on the floor tier/);
    // One claim is one subject, not "1 subjects".
    assert.match(tileOf(elements, 'claimed'), new RegExp(`<span class="v">${segment('claimed')}</span> <small><span>subject under lease</span>`));
    assert.match(tileOf(elements, 'claimed'), /oldest claim 1[23]\ss/);
    assert.ok(labels.some((text) => /^claimed 1 \(oldest 1[23]\ss\)$/.test(text)), 'the bar names the oldest claim too');
  });

  test("and the track's lanes count every subject the tiles track", async () => {
    const snapshot = operatorSnapshotOf();
    const { painted } = await runPage(snapshot);
    const queued = textsOf(painted).filter((text) => /queued/.test(text)).map((text) => Number(/^(\d+) queued/.exec(text)[1]));

    assert.deepEqual(queued, [snapshot.ops.subjects.sync.tracked, snapshot.ops.subjects.poll.tracked]);
  });

  test("and the oldest lateness names its subject and its rung", async () => {
    const { elements } = await runPage(operatorSnapshotOf());

    assert.match(tileOf(elements, 'lateness'), /<div class="tile late"[\s\S]*<span class="v">30\smin<\/span>[\s\S]*<span>dev-user-1<\/span> <span>15\smin tier<\/span>/);
  });

  test("and with nothing overdue, says none rather than a dash", async () => {
    const { elements } = await runPage(operatorSnapshotOf({ subjects: { ...operatorSnapshotOf().ops.subjects, oldestLate: null } }));

    assert.match(tileOf(elements, 'lateness'), /^<div class="tile zero"[\s\S]*<span class="v">none<\/span><\/dd>/);
  });
});

describe("a job card", () => {
  test("says when the job last ran, when it runs next, and how its last runs went", async () => {
    const { elements } = await runPage(operatorSnapshotOf());
    const card = /<article[\s\S]*?<\/article>/.exec(elements.get('o-jobs').innerHTML)[0];

    assert.match(card, /<span class="pill failing">failing<\/span>/);
    assert.match(card, /<span>cron <code>\*\/30 \* \* \* \* \*<\/code><\/span> <span>last ran <span id="o-job-0-ago"><\/span><\/span>/);
    assert.equal(elements.get('o-job-0-ago').textContent, 'just now');
    assert.match(elements.get('o-job-0-next').textContent, /^in (19|20)\ss$/);
    assert.equal(elements.get('o-job-1-next').textContent, 'schedule unreadable');
    // Forty-eight slots, the missing ones a hairline, each run as tall as it took, and the tally
    // a screen reader is read.
    assert.match(card, /<div class="spark" role="img" aria-label="Last 2 runs: 1 failed, 1 idle">(<i class="gap"><\/i>){46}<i class="idle" style="height:[\d.]+px" title="idle in 41\sms"><\/i><i class="failed" style="height:42\.0px" title="failed in 2\.1\ss"><\/i><\/div>/);
    // The next run on the right of its label, written by the clock.
    assert.match(card, /<p class="job-line job-next"><span>next run<\/span><span class="at" id="o-job-0-next"><\/span><\/p>/);
    // Production's line of the last 24 hours, each figure in bold, a failed run in its colour.
    assert.match(card, new RegExp('<p class="job-stats"><span><b>288</b> runs in 24\\sh</span> <span class="failing"><b>1</b> runs failed</span> '
      + '<span><b>0</b>/451 subjects failed</span> <span><b>50</b> idle</span> <span>avg <b>1\\.5\\ss</b></span> '
      + '<span>peak <b>6\\.1\\ss</b></span></p>'));
  });

  test("needs no key under the cards: production had none, and each bar says what it was", async () => {
    const { elements, html } = await runPage(operatorSnapshotOf());

    assert.doesNotMatch(html, /o-jobs-legend|spark-key/);
    assert.equal(elements.get('o-jobs-legend'), undefined);
    assert.ok([...elements.get('o-jobs').innerHTML.matchAll(/<i class="(ok|failed|idle|skipped|unknown)"[^>]*>/g)]
      .every(([bar]) => / title="[a-z]+ in [^"]+"/.test(bar)), 'a bar that does not say what it was');
  });

  test("draws a run as tall as it took, square-rooted, whatever its outcome", async () => {
    const { elements } = await runPage(operatorSnapshotOf({
      jobs: [{ ...operatorSnapshotOf().ops.jobs[1], runs: [
        { outcome: 'ok', durationMs: 100, startedAt: new Date(Date.now() - 120_000).toISOString() },
        { outcome: 'ok', durationMs: 10_000, startedAt: new Date(Date.now() - 60_000).toISOString() },
        { outcome: 'skipped', durationMs: 5, startedAt: new Date().toISOString() },
      ] }],
    }));
    const card = elements.get('o-jobs').innerHTML;

    // 4 px at nothing, 42 px at the longest: 4 + 38 * sqrt(100 / 10000) is 7.8.
    assert.match(card, /<i class="ok" style="height:7\.8px"[^>]*><\/i><i class="ok" style="height:42\.0px"[^>]*><\/i><i class="skipped" style="height:4\.8px"/);
  });

  test("colours the subjects that failed by how many got through", async () => {
    const job = operatorSnapshotOf().ops.jobs[1];
    const day = (subjectsFailed, subjectsClaimed) => ({ ...job, window: { ...job.window, runs: 1, subjectsFailed, subjectsClaimed } });
    const { elements } = await runPage(operatorSnapshotOf({ jobs: [day(5, 444), day(444, 444)] }));
    const cards = elements.get('o-jobs').innerHTML.split('</article>');

    assert.match(cards[0], /<span class="degraded"><b>5<\/b>\/444 subjects failed<\/span>/, 'a few of many is the parc');
    assert.match(cards[1], /<span class="failing"><b>444<\/b>\/444 subjects failed<\/span>/, 'none got through');
  });

  test("that is failing gives the reason, or says that nothing recorded one", async () => {
    const [failing, fine] = operatorSnapshotOf().ops.jobs;
    const { elements } = await runPage(operatorSnapshotOf({ jobs: [failing, { ...failing, name: 'unexplained', lastError: null }, fine] }));
    const cards = elements.get('o-jobs').innerHTML.split('</article>');

    assert.match(cards[0], /<p class="cause">Bad credentials<\/p>/);
    assert.match(cards[1], /<p class="cause">no cause recorded<\/p>/, 'a failure with no cause must say it has none');
    assert.doesNotMatch(cards[2], /class="cause"/, 'a card that is not failing has no cause to give');
  });

  test("is sent to no reader", async () => {
    // The causes were the operator tier's, and now the whole card is.
    const { html, errors } = await runPage(snapshotOf());

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.doesNotMatch(html, /id="o-jobs"/);
  });

  test("with a hostile job name, cron and run error, escaped in the job card", async () => {
    // A run's error message can quote a git ref, and a git ref is named by whoever opened
    // the pull request. Unescaped, that is stored XSS aimed at whoever operates the bot.
    //
    // All three in one card, counted rather than merely absent: the card draws the name, the
    // cron and the error through three separate esc() calls, and a doesNotMatch would still
    // pass with two of them stripped as long as the third payload was the one that landed.
    const hostile = '<img src=x onerror=alert(1)>';
    const { elements, errors } = await runPage(operatorSnapshotOf({
      jobs: [{ ...operatorSnapshotOf().ops.jobs[0], name: hostile, cron: hostile, lastError: hostile }],
    }));

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.doesNotMatch(elements.get('o-jobs').innerHTML, /<img/i);
    assert.equal((elements.get('o-jobs').innerHTML.match(/&lt;img/g) ?? []).length, 3,
      'the name, the cron and the error must each be escaped');
  });
});

describe("a job card shows how close its next run is", () => {
  const cycle = (fromMs, toMs, running = false) => {
    const snapshot = operatorSnapshotOf();

    Object.assign(snapshot.ops.jobs[0], {
      running,
      runs: [{ outcome: "ok", durationMs: 100, startedAt: new Date(Date.now() - fromMs).toISOString() }],
      nextRunAt: new Date(Date.now() + toMs).toISOString(),
    });

    return snapshot;
  };

  test("the bar is at its width the moment the card is drawn", async () => {
    // The defect this pins: the cards used to be born empty and slide back out on every
    // refresh - a permanent animation. The width is written before the first paint, so there
    // is no earlier width to transition from.
    const { elements } = await runPage(cycle(60_000, 60_000), undefined, { drainIntervals: false });
    const width = Number.parseFloat(elements.get('o-job-0-tick').style.width);

    assert.ok(width > 45 && width < 55, `expected about half, got ${width}`);
  });

  test("and it is filled to where the cycle actually is", async () => {
    // A quarter of the way: the run started a minute ago, the next is three minutes out.
    const { elements } = await runPage(cycle(60_000, 180_000));
    const filled = Number.parseFloat(elements.get('o-job-0-tick').style.width);

    assert.ok(filled > 22 && filled < 28, `expected about a quarter, got ${filled}`);
  });

  test("a scheduled job that has never run yet gets no bar", async () => {
    // A fresh database, a job that has not run inside the retention window, or the run history
    // read degrading: the countdown still shows; the bar has no start.
    const snapshot = operatorSnapshotOf();

    for (const job of snapshot.ops.jobs) {
      job.runs = [];
      job.nextRunAt = new Date(Date.now() + 120_000).toISOString();
    }

    const { elements, errors } = await runPage(snapshot);

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.deepEqual([0, 1].map((k) => elements.get(`o-job-${k}-tick`).style.width), ['0.00%', '0.00%']);
    assert.match(elements.get('o-job-0-next').textContent, /^in /);
  });

  test("a job with no schedule and no history gets no bar to fill", async () => {
    // A full bar would read as "about to fire", which is the one thing it must not say.
    const { elements } = await runPage(operatorSnapshotOf());

    assert.equal(elements.get('o-job-1-tick').style.width, '0.00%');
  });

  test("a running job stops claiming a position and says it is working", async () => {
    // A run's row reaches job_runs only when it ENDS, so mid-run the bar's start still names
    // the previous run while nextRunAt has moved on a whole period. The cycle here is exactly
    // half elapsed - the number that defect produced - and the bar must not be drawn at it.
    const { elements } = await runPage(cycle(150_000, 150_000, true));

    assert.match(elements.get('o-jobs').innerHTML, /<i class="job-tick" id="o-job-0-tick" data-running="1">/);
    assert.match(elements.get('o-jobs').innerHTML, /<i class="job-tick" id="o-job-1-tick" data-running="0">/);
    assert.equal(elements.get('o-job-0-tick').style.width, '100%', 'a running bar is a full track, not a position');
  });

  test("the countdown and the bar move every second, between two snapshots", async () => {
    const { elements, intervals } = await runPage(cycle(60_000, 60_000), undefined, { drainIntervals: false });
    const second = intervals.find((interval) => interval.ms === 1000).fn;

    elements.get('o-job-0-tick').style.width = '';
    elements.get('o-job-0-next').textContent = '';
    second();

    assert.ok(Number.parseFloat(elements.get('o-job-0-tick').style.width) > 45);
    assert.match(elements.get('o-job-0-next').textContent, /^in /);
  });

  test("a card acknowledges its own tick, and only its own", async () => {
    // Looked at before the intervals drain, so this is genuinely the FIRST render: every job
    // is new then, and three cards pulsing on open is noise rather than information.
    const quiet = await runPage(operatorSnapshotOf(), undefined, { drainIntervals: false });

    assert.doesNotMatch(quiet.elements.get('o-jobs').innerHTML, /just-ran/, 'the first render must be quiet');

    const first = operatorSnapshotOf();
    const { elements, sandbox, intervals } = await runPage(first);
    const fresh = operatorSnapshotOf();

    fresh.ops.jobs[0].runs = [...first.ops.jobs[0].runs, { outcome: "ok", durationMs: 120, startedAt: new Date(Date.now() + 60_000).toISOString() }];
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => fresh, text: async () => '' });

    await intervals.find((i) => i.ms === 5000).fn();

    const cards = [...elements.get('o-jobs').innerHTML.matchAll(/<article class="([^"]*)"/g)].map((m) => m[1]);

    assert.match(cards[0], /just-ran/, 'the job that ran does not say so');
    assert.doesNotMatch(cards[1], /just-ran/, 'a job that did not run must stay still');
  });
});

describe("the queue", () => {
  const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  const head = (overrides) => ({ at: null, claimed: false, errors: 0, intervalMinutes: 15, label: 'dev-user-9', sub: null, lastError: null, ...overrides });
  /** The fixture with these at the head of the sync queue, and nothing in the poll one. */
  const withHeads = (sync) => operatorSnapshotOf({
    queue: { ...operatorSnapshotOf().ops.queue, shape: { sync: [sync.length, 0, 0, 0, 0, 0, 0], poll: [0, 0, 0, 0, 0, 0, 0] }, subjects: { sync, poll: [] } },
  });
  /** A token's tooltip, as a pointer over it leaves it. */
  const hover = (elements, token, type = 'pointermove') => {
    elements.get('o-track').handlers[type]({ clientX: token.x, clientY: token.y });

    return elements.get('o-track-tip');
  };
  const palette = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(read('public/base.css'))[1];

  test("draws each queue in a lane of its own, on the ladder the scheduler climbs", async () => {
    // Wide enough for every step's label: the stub measures each at 64px, and a label that would
    // run into the one before it is left out.
    const WIDE = { width: 1440, height: 268 };
    const { painted } = await runPage(operatorSnapshotOf(), WIDE);

    assert.deepEqual(textsOf(painted), [
      '-30 min', '-15 min', '+15 min', '+30 min', '+1 h', '+2 h', '+4 h',
      'Installations', '40 queued, 14 due, showing the next 3', '+37 beyond',
      'Pull requests', '22 queued, 6 due, showing the next 1', '+21 beyond',
      'NOW',
    ]);

    // The ladder the page is sent is the one it draws: nothing of it is written in the page.
    const other = operatorSnapshotOf();

    Object.assign(other.ops.queue, { edges: [10, 20, 40, 80], shape: { sync: [14, 2, 2, 1, 3, 18], poll: [6, 1, 2, 0, 1, 12] } });
    assert.deepEqual(textsOf((await runPage(other, WIDE)).painted).slice(0, 6), ['-30 min', '-15 min', '+10 min', '+20 min', '+40 min', '+80 min']);
  });

  test("leaves out an axis label that would run into the one before it, on a phone's width", async () => {
    const { painted } = await runPage(operatorSnapshotOf(), { width: 320, height: 216 });
    const axis = painted.filter((call) => call.op === 'fillText' && /^[-+]\d+ (min|h)$/.test(call.args[0]));
    // 64px each, as the stub measures them; the first starts on its line, the others centre on theirs.
    const spans = axis.map((call, i) => (i === 0 ? [call.args[1], call.args[1] + 64] : [call.args[1] - 32, call.args[1] + 32]));

    assert.equal(axis[0].args[0], '-30 min', 'the start of the axis is always named');
    assert.ok(axis.length < 7, 'something had to give at this width');
    assert.ok(spans.every(([left], i) => i === 0 || left >= spans[i - 1][1] + 8), 'no two labels overlap');
  });

  test("gives each step of the ladder the same width, the quarter hour as much as the last two hours", async () => {
    // A linear axis to four hours would spend four fifths of its width on an empty tail.
    const { painted } = await runPage(operatorSnapshotOf());
    const grid = painted.filter((call) => call.op === 'moveTo' && call.args[1] === 25).map((call) => call.args[0]);
    const [past, half, ...future] = grid.slice(0, 7);
    const step = (future[0] - past) / 2;

    assert.ok(Math.abs(half - past - step / 2) < 1e-9, 'the past is one step, its middle marked');
    assert.ok(future.every((x, i) => i === 0 || Math.abs(x - future[i - 1] - step) < 1e-9), `uneven steps: ${future}`);
    // NOW one step in, where the past ends.
    assert.equal(grid.at(-1), past + step);
  });

  test("draws each subject at its due time, a ring on a claim and the failure colour on one backing off", async () => {
    const { painted } = await runPage(operatorSnapshotOf());
    const [unscheduled, held, failing, polled] = tokensOf(painted);
    const nowX = painted.filter((call) => call.op === 'moveTo' && call.args[1] === 25).at(-1).args[0];

    // Never scheduled is due, exactly as the claims read it: on the line.
    assert.equal(unscheduled.x, nowX);
    assert.ok(held.x < nowX && failing.x > nowX && polled.x > failing.x, 'overdue left of the line, the rest in the order they fall due');
    assert.deepEqual([unscheduled, held, failing, polled].map((token) => token.fill),
      [palette('sync'), palette('sync'), palette('fail'), palette('fail')]);
    // Held by a worker: a larger disc, and a ring in the colour of now.
    assert.equal(held.r, 3.4);

    const rings = painted.filter((call) => call.op === 'arc' && call.args[2] > 4);

    assert.deepEqual(rings.map((call) => call.args.slice(0, 3)), [[held.x, held.y, 6]]);
    assert.equal(painted[painted.indexOf(rings[0]) + 1].strokeStyle, palette('now'));
  });

  test("paints only the page's palette, read from its tokens", async () => {
    // A canvas takes no var(): its colours are read off the tokens once, never written down, so
    // the legend under it stays its key whatever base.css says.
    const { painted } = await runPage(operatorSnapshotOf());
    const tokens = [...read('public/base.css').matchAll(/--[\w-]+:\s*(#[0-9a-f]{6});/g)].map((m) => m[1]);
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
    const colours = new Set(painted.flatMap((call) => [call.fillStyle, call.strokeStyle]).filter(Boolean));
    const foreign = [...colours].filter((colour) => !tokens.includes(colour) && !tokens.some((hex) => colour.startsWith(`rgba(${rgb(hex)},`)));

    assert.ok(colours.size >= 5, `only ${colours.size} colours painted`);
    assert.deepEqual(foreign, [], 'these are colours no token names');
    assert.doesNotMatch(withoutComments(read('views/dashboard/ops.js')), /#[0-9a-f]{3,8}\b/i, 'a colour written in the script');
  });

  describe("stays inside its canvas", () => {
    // The bug this exists for was visible and nothing caught it: the NOW marker was drawn at
    // y=4 with the default alphabetic baseline, so its ascender reached y≈-3 and the label was
    // sliced off above the top edge, glow included. Geometry is checkable, so it is checked.
    const SIZES = [
      { width: 1080, height: 268 },
      { width: 760, height: 268 },
      { width: 480, height: 216 },
      { width: 320, height: 216 },
      // Narrower than any real layout, and the width at which the old fixed right gutter and
      // the floored span drew the whole axis past the right edge.
      { width: 200, height: 216 },
    ];

    for (const size of SIZES) {
      test(`at ${size.width}x${size.height}`, async () => {
        const { painted, errors } = await runPage(operatorSnapshotOf(), size);
        // Text needs room for its own ascender and descender either side of the baseline: 11px
        // is the one size on the canvas.
        const points = painted.flatMap(({ op, args }) => ({
          moveTo: [[args[0], args[1], 0]],
          lineTo: [[args[0], args[1], 0]],
          arc: [[args[0] - args[2], args[1] - args[2], 0], [args[0] + args[2], args[1] + args[2], 0]],
          fillRect: [[args[0], args[1], 0], [args[0] + args[2], args[1] + args[3], 0]],
          fillText: [[args[1], args[2], 6]],
        })[op] ?? []);
        const outside = points.filter(([x, y, margin]) => x < -0.5 || x > size.width + 0.5 || y - margin < -0.5 || y + margin > size.height + 0.5);

        assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
        assert.ok(points.length > 20, `only ${points.length} points painted`);
        assert.deepEqual(outside.slice(0, 6), [], `${outside.length} of ${points.length} points left the ${size.width}x${size.height} canvas`);
      });
    }

    test("the NOW marker is drawn wholly inside the top edge", async () => {
      const { painted } = await runPage(operatorSnapshotOf());
      const marker = painted.find((call) => call.op === 'fillText' && /^(NOW|CLAIMED)$/.test(call.args[0]));

      // Centred, not hung off a baseline: 11px of text centred at y needs y >= 6 to clear the
      // edge, and the whole point of the fix was to stop depending on font metrics.
      assert.ok(marker.args[2] >= 8, `the marker sits at y=${marker.args[2]}, too close to the top edge`);
    });
  });

  test("is sized to its box on the frame after the box changed, and drawn only while its tab shows", async () => {
    // Hidden, the canvas is 0 wide, and the window's resize is not what shows it again.
    const { elements, painted, frames } = await runPage(operatorSnapshotOf(), undefined, { hash: '#mine' });

    assert.deepEqual(painted, [], 'drawn behind another tab');

    await elements.get('tabs').handlers.click({ target: { dataset: { view: 'ops' } } });
    frames.at(-1)(Date.now());

    // Twice the box, the ratio being capped at two.
    assert.deepEqual([elements.get('o-track').width, elements.get('o-track').height], [2160, 536]);
    assert.equal(tokensOf(painted).length, 4);
  });

  test("says CLAIMED on the line when a run that did something is recorded, and NOW otherwise", async () => {
    const { painted, frames, intervals, sandbox } = await runPage(operatorSnapshotOf());
    const refresh = intervals.find((interval) => interval.ms === 5000).fn;
    const marker = () => {
      painted.length = 0;
      frames.at(-1)(Date.now());

      return textsOf(painted).at(-1);
    };

    // The same newest run, read again, is no news.
    await refresh();
    assert.equal(marker(), 'NOW');

    const fresh = operatorSnapshotOf();

    fresh.ops.runs = [{ ...fresh.ops.runs[0], startedAt: new Date(Date.now() + 60_000).toISOString() }, ...fresh.ops.runs];
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => fresh, text: async () => '' });
    await refresh();

    assert.equal(marker(), 'CLAIMED');
  });

  test("keeps still for a reader who asked for less motion: redrawn each second, and never flashed", async () => {
    const { painted, frames, intervals, sandbox } = await runPage(operatorSnapshotOf(), undefined, { reducedMotion: true });

    assert.equal(frames.length, 0, 'an animation loop under reduced motion');
    assert.equal(tokensOf(painted).length > 0, true, 'and nothing drawn in its place');

    const fresh = operatorSnapshotOf();

    fresh.ops.runs = [{ ...fresh.ops.runs[0], startedAt: new Date(Date.now() + 60_000).toISOString() }, ...fresh.ops.runs];
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => fresh, text: async () => '' });
    await intervals.find((interval) => interval.ms === 5000).fn();
    painted.length = 0;
    intervals.find((interval) => interval.ms === 1000).fn();

    assert.equal(tokensOf(painted).length, 4, 'the second redraws it');
    assert.equal(textsOf(painted).at(-1), 'NOW');
  });

  test("hovering a token fills the tooltip beside it with everything that subject says", async () => {
    const { elements, painted } = await runPage(operatorSnapshotOf());
    const [unscheduled, held, failing, polled] = tokensOf(painted);
    const tip = hover(elements, polled);

    assert.match(tip.innerHTML, new RegExp('^<b>acme/one#12</b><i>opened by dev-user-1</i><span>due in 1[12]\\smin</span>'
      + '<span>7 commits</span><span>opened 1\\sd ago</span><span>last polled 1\\sh ago</span><span>every 30\\smin</span>'
      + '<span class="bad">1 failure in a row, backing off</span><span class="bad">Bad gateway</span>$'));
    assert.ok(tip.classList.contains('show'));
    // Beside the token and above it, inside the panel.
    assert.equal(tip.style.left, `${polled.x + 14}px`);
    assert.equal(tip.style.top, `${polled.y - 60 - 10}px`);

    assert.match(hover(elements, unscheduled).innerHTML, /^<b>dev-user-1<\/b><span>due now<\/span><span>every 15\smin<\/span>$/);
    assert.match(hover(elements, held).innerHTML,
      /^<b>dev-user-2<\/b><i>last synced 2\sh ago<\/i><span>overdue by 2\smin<\/span><span>every 15\smin<\/span><span class="now">held by a worker right now<\/span>$/);
    // A tap, there being no hover under a finger.
    assert.match(hover(elements, failing, 'pointerdown').innerHTML,
      /<span>due in 8\smin<\/span><span>every 4\sh<\/span><span class="bad">5 failures in a row, backing off<\/span><span class="bad">Not Found<\/span>$/);
  });

  test("flips the tooltip to the left of a token near the right edge", async () => {
    const { elements, painted } = await runPage(withHeads([head({ at: at(239) })]));
    const [token] = tokensOf(painted);

    assert.equal(hover(elements, token).style.left, `${token.x - 14 - 120}px`);
  });

  test("hides it between two tokens, and when the pointer leaves the canvas", async () => {
    const { elements, painted } = await runPage(operatorSnapshotOf());
    const canvas = elements.get('o-track');
    const tip = hover(elements, tokensOf(painted)[3]);

    canvas.handlers.pointermove({ clientX: 1, clientY: 1 });
    assert.equal(tip.classList.contains('show'), false, 'nothing within reach of the pointer');

    hover(elements, tokensOf(painted)[3]);
    canvas.handlers.pointerleave();
    assert.equal(tip.classList.contains('show'), false);
  });

  test("with a hostile subject label and error, escaped in the tooltip and the next twelve", async () => {
    // A branch name is chosen by whoever opened the pull request, and GitHub's error can quote it.
    const hostile = '<img src=x onerror=alert(1)>';
    const { elements, errors, painted } = await runPage(operatorSnapshotOf({
      ...withHeads([head({ label: hostile, lastError: hostile, errors: 1 })]).ops,
      next: [subjectOf({ label: hostile })],
    }));
    const tip = hover(elements, tokensOf(painted)[0]);

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);

    for (const el of [tip, elements.get('o-next')]) {
      assert.doesNotMatch(el.innerHTML, /<img/i, `#${el.id} drew the label as markup`);
      assert.match(el.innerHTML, /&lt;img/, `#${el.id} did not draw the label at all`);
    }

    assert.equal((tip.innerHTML.match(/&lt;img/g) ?? []).length, 2, 'the label and the error must each be escaped');
  });

  test("is keyed by a legend in the tokens its canvas reads", async () => {
    const { html } = await runPage(operatorSnapshotOf());
    const rule = (swatch) => new RegExp(`\\.legend b\\.${swatch} \\{[^}]*\\}`).exec(css())?.[0] ?? '';

    assert.match(html, /<span><b class="q-sync"><\/b>installation to sync<\/span>\s*<span><b class="q-poll"><\/b>pull request to poll<\/span>\s*<span><b class="q-ring"><\/b>held by a worker<\/span>\s*<span><b class="q-fail"><\/b>in error backoff<\/span>\s*<span id="o-queue-unit"><\/span>/);
    assert.match(rule('q-sync'), /var\(--sync\)/);
    assert.match(rule('q-poll'), /var\(--poll\)/);
    assert.match(rule('q-ring'), /box-shadow: 0 0 0 2px var\(--now\)/);
    assert.match(rule('q-fail'), /var\(--fail\)/);
  });

  test("lists the next twelve in the fold under it, each labelled with its queue", async () => {
    const { elements, html } = await runPage(operatorSnapshotOf());

    assert.match(html, /<details class="fold">\s*<summary>The next 12 subjects, in the order they will be claimed<\/summary>/);
    assert.doesNotMatch(html, /<details class="fold" open/, 'the fold starts closed');
    assert.match(elements.get('o-next').innerHTML, /<span class="q-rank">1<\/span><span class="q-kind sync">sync<\/span>[\s\S]*dev-user-1[\s\S]*<span class="q-kind poll">poll<\/span>[\s\S]*1 failure in a row/);
  });

  test("calls a subject in the fold overdue only once a run has come round, as the tiles count it", async () => {
    // Due two minutes ago on a five-minute tick: waiting for the next run, on schedule.
    const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
    const { elements } = await runPage(operatorSnapshotOf({
      next: [subjectOf({ dueAt: at(-6) }), subjectOf({ id: 2, label: 'dev-user-2', dueAt: at(-2) })],
    }));
    const [late, waiting] = elements.get('o-next').innerHTML.split('</li>');

    assert.match(late, /6\smin overdue/);
    assert.match(waiting, /due 2\smin ago/);
  });
});

describe("detection latency", () => {
  test("draws every merge, and a level for each window figure once its sample is met", async () => {
    const latency = (window) => runPage(operatorSnapshotOf({ latency: { ...operatorSnapshotOf().ops.latency, window } }));
    const run = await latency({ n: 40, p50: 1500, p90: 3300, p99: 9000 });
    const chart = chartIn(run, 'o-latency');
    const { token } = run.sandbox.Dash;
    const { from, points } = operatorSnapshotOf().ops.latency;

    // Forty dots in minutes, then p50 solid and p90 dashed across the whole axis, in one ink;
    // p99 needs a hundred merges.
    assert.equal(chart.config.type, 'scatter');
    assert.equal(chart.data.datasets[0].data.length, 40);
    assert.deepEqual(plain(chart.data.datasets[0].data[0]), { x: Date.parse(points[0].at), y: points[0].seconds / 60 });
    assert.deepEqual(plain(chart.data.datasets.slice(1).map((dataset) => [dataset.label, dataset.borderColor, dataset.borderDash, dataset.data])),
      [['p50', token('ink-dim'), [], [{ x: Date.parse(from), y: 25 }, { x: Date.parse(from) + 30 * 86_400_000, y: 25 }]],
        ['p90', token('ink-dim'), [6, 4], [{ x: Date.parse(from), y: 55 }, { x: Date.parse(from) + 30 * 86_400_000, y: 55 }]]]);
    assert.deepEqual(legendIn(run, 'o-latency'), ['circle one merge', 'line p50 25\u00a0min', 'dash p90 55\u00a0min'], 'no p99 yet');
    assert.equal(chart.options.scales.y.title.text, 'Latency (min)');
    assert.match(run.elements.get('o-latency-canvas').getAttribute('aria-label'), /\d{2}:\d{2}: 10\u00a0min\./);

    const hundred = await latency({ n: 120, p50: 1500, p90: 3300, p99: 9000 });

    assert.equal(legendIn(hundred, 'o-latency').at(-1), 'note: p99 2\u00a0h 30\u00a0min', 'a window figure with no level, under the legend');
  });

  test("still draws a handful of merges, without the levels their sample cannot carry", async () => {
    // Two merges: each is a dot, and not even the window has a median to draw.
    const { points } = operatorSnapshotOf().ops.latency;
    const run = await runPage(operatorSnapshotOf({
      latency: { ...operatorSnapshotOf().ops.latency, points: points.slice(0, 2), window: { n: 2, p50: 1500, p90: 3300, p99: null } },
    }));

    assert.equal(chartIn(run, 'o-latency').data.datasets.length, 1);
    assert.deepEqual(legendIn(run, 'o-latency'), ['circle one merge']);
    assert.equal(run.elements.get('o-latency-none').innerHTML, '');
  });
});

describe("recent runs", () => {
  test("are a list with one chip for the failed, each failed row giving its cause", async () => {
    const { elements } = await runPage(operatorSnapshotOf());
    const rows = elements.get('o-runs-rows').innerHTML;

    assert.match(elements.get('o-runs-tools').innerHTML, /data-value="failed"[^>]*>failed <b>1<\/b>/);
    assert.match(rows, /<span class="name">reconcile_installations<\/span>[\s\S]*<span class="cause">Integration not found<\/span>[\s\S]*<span class="pill failed">failed<\/span>/);
    assert.match(rows, /<span class="pill ok">ok<\/span>/);
  });

  test("ten to a page", async () => {
    const runs = Array.from({ length: 100 }, (_, i) => ({ ...operatorSnapshotOf().ops.runs[0], startedAt: new Date(Date.now() - i * 60_000).toISOString() }));
    const { elements } = await runPage(operatorSnapshotOf({ runs }));

    assert.equal((elements.get('o-runs-rows').innerHTML.match(/<li /g) ?? []).length, 10);
    assert.match(elements.get('o-runs-pages').innerHTML, /1–10 of 100/);
  });

  test("and a filter with nothing in it says so", async () => {
    const { elements } = await runPage(operatorSnapshotOf({ runs: operatorSnapshotOf().ops.runs.slice(0, 1) }));

    elements.get('o-runs').handlers.click({ target: { closest: () => ({ closest: (selector) => (selector === '[data-facet]' ? { dataset: { facet: 'outcome' } } : null), dataset: { value: 'failed' }, matches: () => false }) } });

    assert.match(elements.get('o-runs-none').innerHTML, /No failed run among the last 1\./);
  });
});

describe("the enrolled accounts", () => {
  const user = (overrides) => ({
    userId: 7, login: 'someone', email: 'someone@acme.com', state: 'installed', stateSince: '2026-02-24T09:15:00.000Z', disabledReason: null,
    enrolledAt: '2026-02-20T08:00:00.000Z', lastSyncedAt: null, pullRequests: 0, merged: 0, ...overrides,
  });
  const since = (ms) => new Date(Date.now() - ms).toISOString();

  test("say how long each has been stuck, from the date its own state carries", async () => {
    const { elements } = await runPage(operatorSnapshotOf({
      users: [
        user({ userId: 1, login: 'still-here' }),
        user({ userId: 2, login: 'held', state: 'suspended', stateSince: since((3 * 24 + 2) * 3_600_000) }),
        user({ userId: 3, login: 'never-verified', state: 'pending', stateSince: since(12 * 86_400_000) }),
        // The only state that can legitimately have no date: it left before the column existed.
        user({ userId: 4, login: 'long-gone', state: 'uninstalled', stateSince: null }),
        user({ userId: 5, login: 'given-up', state: 'disabled', stateSince: since(3_600_000), disabledReason: 'account gone' }),
      ],
    }));
    const stuck = [...elements.get('o-users-rows').innerHTML.matchAll(/<\/td><td class="num">([^<]*)<\/td><td class="num">[A-Z][a-z]{2} \d/g)]
      .map((m) => m[1].replace(/\s/g, ' '));

    // Alphabetical, as the table opens.
    assert.deepEqual(stuck, ['1 h', '3 d 2 h', '—', 'enrolled 12 d', '—']);
    assert.match(elements.get('o-users-rows').innerHTML, /<span class="acct-state disabled">disabled<\/span><div class="mail">account gone<\/div>/);
  });

  test("carry a chip per state, disabled included, counted over everybody", async () => {
    const { elements } = await runPage(operatorSnapshotOf());
    const chips = elements.get('o-users-filters').innerHTML;

    for (const [state, count] of [['all', 2], ['installed', 1], ['pending', 0], ['suspended', 0], ['uninstalled', 0], ['disabled', 1]]) {
      assert.match(chips, new RegExp(`data-value="${state}"[^>]*>${state} <b(?: class="zero")?>${count}</b>`), `no ${state} chip`);
    }
  });

  test("show the account by its face, and its sync as a force button on an installed row only", async () => {
    const { elements } = await runPage(operatorSnapshotOf());
    const rows = elements.get('o-users-rows').innerHTML.split('</tr>');

    // By the account id, which a rename does not change, as the lookup's author is.
    assert.match(rows[0], /<img class="avatar" style="--size: 24px"[^>]* src="https:\/\/avatars\.githubusercontent\.com\/u\/583231\?s=48"><div><div>dev-user-1<\/div><div class="mail">dev\.one@acme\.com<\/div>/);
    assert.match(withoutComments(read('views/dashboard/ops.js')), /marks\.face\(f\.author, 32, f\.authorId\)/, 'the author a lookup finds');
    assert.match(rows[0], /<button type="button" class="force" data-force="583231" data-focus-key="force:583231">Force sync<\/button>/);
    assert.match(rows[0], /<td class="num">Feb 20, 2026<\/td><td class="num">17<\/td><td class="num">14<\/td><td class="num">1\sh ago<\/td>/);
    assert.doesNotMatch(rows[1], /class="force"/);
    assert.match(rows[1], /no verified address/);
  });

  test("mark the reader's own row", async () => {
    const { elements } = await runPage(operatorSnapshotOf({}, { viewer: 'Dev-User-1' }));
    const [mine, theirs] = elements.get('o-users-rows').innerHTML.split('</tr>');

    assert.match(mine, /^<tr class="yours">[\s\S]*dev-user-1<span class="chip">you<\/span>/);
    assert.doesNotMatch(theirs, /yours|>you</);
  });

  test("keep the search, the chip, the sort and the scroll across three refreshes", async () => {
    const { elements, intervals, sandbox } = await runPage(operatorSnapshotOf({
      users: [user({ userId: 1, login: 'aa', email: null, merged: 3 }), user({ userId: 2, login: 'ab', email: null, merged: 9 }),
        user({ userId: 3, login: 'zz', email: null }), user({ userId: 4, login: 'ac', email: null, state: 'pending', stateSince: since(60_000) })],
    }));
    const chip = { dataset: { value: 'installed' }, closest: (selector) => (selector === '[data-facet]' ? { dataset: { facet: 'state' } } : null) };
    const header = { closest: (selector) => (selector === 'button[data-sort]' ? { dataset: { sort: 'merged' } } : null) };
    const refresh = intervals.find((interval) => interval.ms === 5000).fn;

    elements.get('o-users-q').value = 'A';
    elements.get('o-users-q').handlers.input();
    elements.get('o-users-filters').handlers.click({ target: { closest: (selector) => (selector === 'button' ? chip : null) } });
    // Twice: the second click on the same header turns the order round.
    await elements.get('o-users').handlers.click({ target: header });
    await elements.get('o-users').handlers.click({ target: header });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await refresh();
    }

    const logins = [...elements.get('o-users-rows').innerHTML.matchAll(/<div><div>([a-z]+)</g)].map((m) => m[1]);

    assert.deepEqual(logins, ['ab', 'aa'], 'installed, matching "a", most merged first');
    assert.equal(elements.get('o-users-q').value, 'A', 'the box is never redrawn');
    assert.equal(sandbox.Dash.state.lists['o-users'].facets.state, 'installed');
    assert.match(elements.get('o-users-head').innerHTML, /<th aria-sort="descending" class="num"><button type="button" data-sort="merged" data-focus-key="sort:merged">Merged<span aria-hidden="true"> ↓<\/span><\/button><\/th>/);
    assert.equal((elements.get('o-users-head').innerHTML.match(/aria-sort/g) ?? []).length, 1);
    assert.equal(elements.get('o-users-count').textContent, '2 of 4 accounts match.');
    // The table scrolls inside a box the script never writes: its scroll position is the
    // browser's to keep.
    assert.equal(elements.get('o-users-rows').innerHTML.includes('users-wrap'), false);
  });

  test("ten to a page, back to the first on a search, a chip or a sort", async () => {
    const users = Array.from({ length: 25 }, (_, i) => user({ userId: i + 1, login: `u${String(i).padStart(2, '0')}`, email: null, merged: i }));
    const { elements, intervals, sandbox } = await runPage(operatorSnapshotOf({ users }));
    const logins = () => [...elements.get('o-users-rows').innerHTML.matchAll(/<div><div>([a-z0-9]+)</g)].map((m) => m[1]);
    const next = { dataset: { page: '1' }, closest: (selector) => (selector === 'button[data-page]' ? next : null) };
    const chip = { dataset: { value: 'installed' }, closest: (selector) => (selector === '[data-facet]' ? { dataset: { facet: 'state' } } : null) };
    const header = { closest: (selector) => (selector === 'button[data-sort]' ? { dataset: { sort: 'merged' } } : null) };
    const state = () => sandbox.Dash.state.lists['o-users'];

    assert.deepEqual(logins(), ['u00', 'u01', 'u02', 'u03', 'u04', 'u05', 'u06', 'u07', 'u08', 'u09']);
    assert.match(elements.get('o-users-pages').innerHTML, /<span id="o-users-pages-range">1–10 of 25<\/span>/);
    // The counter says what the search and the chip let through, every page of it.
    assert.equal(elements.get('o-users-count').textContent, '25 of 25 accounts match.');

    elements.get('o-users-pages').handlers.click({ target: next });
    elements.get('o-users-pages').handlers.click({ target: next });
    await intervals.find((interval) => interval.ms === 5000).fn();
    assert.deepEqual(logins(), ['u20', 'u21', 'u22', 'u23', 'u24'], 'the last page, kept through a refresh');

    for (const change of [
      () => elements.get('o-users-q').handlers.input(),
      () => elements.get('o-users-filters').handlers.click({ target: { closest: (selector) => (selector === 'button' ? chip : null) } }),
      () => elements.get('o-users').handlers.click({ target: header }),
    ]) {
      state().page = 2;
      await change();
      assert.equal(state().page, 0);
    }
  });

  test("scroll inside their panel, not across the page", () => {
    // Measured at 393px once: a seven-column table 617px wide made the whole DOCUMENT scroll
    // sideways. The wrapper is in the template, so a refresh never resets how far it scrolled.
    assert.match(read('views/dashboard/ops.ejs'), /<div class="users-wrap">\s*<table class="users" id="o-users">/);
    assert.match(css(), /\.users-wrap \{[^}]*overflow-x: auto/, 'the wrapper is decoration without it');
    // Without a floor the browser crushes the columns rather than scrolling them.
    assert.match(css(), /\.users-wrap \.users \{[^}]*min-width:/);
  });
});

describe("the handlers the page installs are called", () => {
  // The stub records a handler without ever invoking it, which is how a mousemove handler
  // calling a function that did not exist passed every check in this file and still broke in a
  // browser. Everything below calls them.

  test("the force button posts to the account whose row it is on", async () => {
    const { elements, fetched } = await runPage(operatorSnapshotOf());
    const button = { disabled: false, textContent: 'Force sync', dataset: { force: '583231' } };

    await elements.get('o-users').handlers.click({ target: { closest: (selector) => (selector === 'button[data-force]' ? button : null) } });

    assert.ok(
      fetched.some((call) => call.method === 'POST' && call.url === '/dashboard/users/583231/sync'),
      `no force reached the server, only ${JSON.stringify(fetched)}`
    );
    assert.equal(button.textContent, 'Queued');
    // Disabled on the way in, so a double click is one force and not two.
    assert.equal(button.disabled, true);
  });

  test("a refused force says so on the button rather than silently", async () => {
    const { elements, sandbox, document } = await runPage(operatorSnapshotOf());
    const focused = [];
    const button = { disabled: false, textContent: 'Force sync', dataset: { force: '1' }, focus: () => focused.push('force') };

    sandbox.fetch = async () => ({ ok: false, status: 409, json: async () => ({}) });
    // Disabled while it had the focus, the button dropped it to the page.
    document.activeElement = null;

    await elements.get('o-users').handlers.click({ target: { closest: (selector) => (selector === 'button[data-force]' ? button : null) } });

    assert.equal(button.textContent, 'Not syncable');
    // And it can be tried again: a row whose markup did not change is not redrawn, so nothing
    // else would ever enable it. The focus is back on it, to try again from where it was.
    assert.equal(button.disabled, false);
    assert.deepEqual(focused, ['force']);

    // A reader who has moved on meanwhile keeps their place.
    sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
    document.activeElement = elements.get('o-users-q');
    await elements.get('o-users').handlers.click({ target: { closest: (selector) => (selector === 'button[data-force]' ? button : null) } });

    assert.equal(button.textContent, 'Refused');
    assert.equal(button.disabled, false);
    assert.deepEqual(focused, ['force']);
  });

  test("a forge picked sets the address it expects, and which of the two is pressed", async () => {
    const { elements } = await runPage(operatorSnapshotOf());

    await elements.get('view-ops').handlers.click({ target: { closest: (selector) => (selector === '[data-forge]' ? { dataset: { forge: 'gitlab' } } : null) } });

    assert.equal(elements.get('m-url').placeholder, 'https://gitlab.com/group/project/-/merge_requests/123');
    assert.equal(elements.get('m-gitlab').getAttribute('aria-pressed'), 'true');
    assert.equal(elements.get('m-github').getAttribute('aria-pressed'), 'false');
  });
});

describe("what the bot has recorded", () => {
  const rowsOf = (html) => [...html.matchAll(/<div class="inventory-row"><dt>([^<]*)<\/dt><dd>(?:<span class="inventory-share">([^<]*)<\/span>)?([^<]*)<\/dd><\/div>/g)]
    .map(([, label, share, value]) => [label, value, share ?? null]);

  test("is two columns of rows, each figure with what it splits into", async () => {
    const { elements, errors, html } = await runPage(operatorSnapshotOf());
    const drawn = elements.get('o-inventory').innerHTML;
    const columns = [...drawn.matchAll(/<dl class="inventory-col">([\s\S]*?)<\/dl>/g)].map(([, column]) => column);

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.match(html, /<h2>What the bot has recorded<\/h2>\s*<p class="panel-sub">Everything stored, bots included<\/p>/);
    assert.equal(columns.length, 2);
    assert.deepEqual(columns.map((column) => rowsOf(column).length), [6, 5], 'the longer column first');
    assert.deepEqual(rowsOf(drawn), [
      ['Pull requests recorded', '1,234', '1,200 by people, 34 by bots'],
      ['Merged', '980', null],
      ['Commits in those pull requests', '5,321', null],
      ['Repositories tracked', '410', '38 ours'],
      ['Distinct authors', '75', null],
      ['Accounts enrolled', '73 / 81', 'active / ever'],
      ['Events processed', '11,500', '2,400 pull request, 9,100 push'],
      ['Recorded by hand', '6', null],
      ['Repository renames detected', '4', null],
      ['Collecting since', 'Sep 14, 2025', null],
      ['Added in the last 7 days', '12', null],
    ]);
  });

  test("says so when nothing is recorded, and when it could not be read", async () => {
    const empty = {
      pullRequests: 0, byPeople: 0, byBots: 0, merged: 0, commits: 0, authors: 0, byHand: 0, since: null, lastWeek: 0,
      repositories: 0, repositoriesOurs: 0, accounts: 0, accountsActive: 0, pullRequestEvents: 0, pushEvents: 0, renames: 0,
    };

    for (const [inventory, fact] of [[empty, 'Nothing recorded yet.'], [null, 'The inventory could not be read.']]) {
      const { elements, errors } = await runPage(operatorSnapshotOf({ inventory }));

      assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
      assert.match(elements.get('o-inventory').innerHTML, new RegExp(`^<div class="nothing"><b>${fact.replace('.', '\\.')}</b>`));
    }
  });

  test("is read for an operator alone, and tolerated like its neighbours", () => {
    const snapshot = fn(read('src/services/dashboardOps.js'), 'getOpsSnapshot');

    assert.match(snapshot, /getInventory\(\)\.catch\(tolerate\(degraded, 'the inventory', null\)\)/);
    assert.match(snapshot, /^\s*inventory,$/m);
    assert.deepEqual(filesUnder('src', '.js').filter((file) => withoutComments(read(file)).includes('getInventory(')),
      ['src/services/dashboardOps.js'], 'the inventory is read somewhere that does not check the tier');
  });
});

describe("the settings", () => {
  test("are drawn row by row, each value a chip under its label and over its variables", async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const snapshot = operatorSnapshotOf();

    snapshot.ops.settings[0].items[0].values.push(hostile);

    const { elements, errors } = await runPage(snapshot);
    const html = elements.get('o-settings').innerHTML;
    const rows = html.split('<div class="settings-row">').filter(Boolean);

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^<p class="settings-head">What counts as ours<\/p>/);
    assert.match(rows[0], /<span class="setting-label">Repositories we own<\/span><div class="setting-values"><span>acme<\/span><span>acme-labs<\/span>/);
    assert.match(rows[0], /<span class="setting-env"><code>OWN_GITHUB_ORGS<\/code><\/span>/);
    // An empty list says so, rather than a label over nothing.
    assert.match(rows[0], /<span class="none">no host is read<\/span>/);
    // A number in its unit, and two variables for a floor and a ceiling.
    assert.match(rows[1], /<span>15\smin<\/span><span>4\sh<\/span><\/div><span class="setting-env"><code>SYNC_MIN_INTERVAL_MINUTES<\/code> <code>SYNC_MAX_INTERVAL_MINUTES<\/code>/);
    assert.match(rows[1], /<span>200 subjects<\/span>/);
    assert.match(rows[1], /<span>7 days<\/span>/);
    assert.doesNotMatch(html, /<img/);
  });

  test("are read from the running process, and never a secret", () => {
    // Every variable a setting names is one the constants read, so the panel cannot name a
    // variable nothing reads - and none of them is a credential, whatever is added next.
    const constants = read('src/utils/constants.js');
    const snapshot = fn(read('src/services/dashboardOps.js'), 'getOpsSnapshot');
    const settings = /const SETTINGS = Object\.freeze\(\[([\s\S]*?)\n\]\);/.exec(read('src/services/dashboardOps.js'))[1];
    const names = [...settings.matchAll(/env: \[([^\]]*)\]/g)].flatMap(([, list]) => [...list.matchAll(/'([A-Z_]+)'/g)].map(([, name]) => name));

    assert.ok(names.length >= 15, `only ${names.length} variables found - the pattern stopped matching`);

    for (const name of names) {
      assert.match(constants, new RegExp(`process\\.env\\.${name}\\b|intFromEnv\\('${name}'`), `${name} is read by nothing`);
      assert.doesNotMatch(name, /SECRET|TOKEN|KEY|PASSWORD|PRIVATE|LOGINS/, `${name} is not a setting to show`);
    }

    // In the operational half, which only an operator is sent.
    assert.match(snapshot, /settings: SETTINGS/);

    // What counts as ours is back in one place, this one: never a panel of its own again, in any
    // template or script, beside the footnote that says it to every reader.
    assert.deepEqual([...filesUnder('src', '.js'), ...filesUnder('views', '.js'), ...filesUnder('views', '.ejs')]
      .filter((file) => withoutComments(read(file)).includes('What counts as ours')), ['src/services/dashboardOps.js']);
  });
});
