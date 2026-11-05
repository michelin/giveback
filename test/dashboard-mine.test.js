import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runPage, runDocument, renderPage, report, markup, chartIn, legendIn, plain } from "../test-support/dashboardPage.js";
import { read, withoutComments, fn } from "../test-support/sources.js";
import { snapshotOf } from "../test-support/fixtures/snapshot.js";
import { operatorSnapshotOf } from "../test-support/fixtures/ops.js";
import { mineOf } from "../test-support/fixtures/mine.js";

const service = await import("../src/services/dashboardMine.js");

const DAY = 86_400_000;

describe("your own contributions, summarised from the rows themselves", () => {
  // Dates, as pg hands back every timestamptz: the one shape this function is given in
  // production. Fed strings, a suite once passed over a curve that came back empty on real data.
  const at = (iso) => new Date(iso);
  const NOW = at('2026-09-17T12:00:00Z');

  const pr = (over = {}) => ({
    id: 1,
    merged: true,
    state: 'closed',
    openedAt: at('2026-08-01T09:00:00Z'),
    mergedAt: at('2026-08-20T09:00:00Z'),
    closedAt: at('2026-08-20T09:00:00Z'),
    repo: 'acme/widget',
    repositoryId: 1,
    commits: 1,
    own: false,
    recordedByHand: false,
    ...over,
  });
  const open = (over = {}) => pr({ merged: false, state: 'open', mergedAt: null, closedAt: null, ...over });
  const closed = (over = {}) => pr({ merged: false, mergedAt: null, closedAt: at('2026-08-25T09:00:00Z'), ...over });

  /** A pull request merged `days` after it was opened. */
  const took = (days) => pr({ openedAt: at('2026-01-01T00:00:00Z'), mergedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + days * DAY) });

  test("counts the three outcomes apart, and judges only what got a verdict", () => {
    const summary = service.summariseMine([pr(), closed(), open()], NOW);

    assert.equal(summary.merged, 1);
    assert.equal(summary.closedUnmerged, 1);
    assert.equal(summary.open, 1);
    // Two of three, not one of three: the open one has no verdict, and counting it as a
    // refusal would read as one.
    assert.equal(summary.decided, 2);
  });

  test("says where every one of them went, a project counted by the row and never by the name", () => {
    // Open and closed ones too, the same base as the outcome bar. Two pull requests to one
    // repository renamed between them carry two names and one id.
    const summary = service.summariseMine([
      pr({ own: true, repositoryId: 1, repo: 'acme/widget' }),
      pr({ own: true, repositoryId: 1, repo: 'acme/gadget' }),
      open({ repositoryId: 2 }),
      closed({ repositoryId: 3 }),
    ], NOW);

    assert.deepEqual(summary.where, { ours: { prs: 2, repositories: 1 }, elsewhere: { prs: 2, repositories: 2 } });
  });

  test("adds up what was opened and what was merged, and only ever moves on a month that did something", () => {
    const summary = service.summariseMine([
      pr({ openedAt: at('2026-08-01T09:00:00Z'), mergedAt: at('2026-08-29T10:00:00Z') }),
      open({ openedAt: at('2026-07-10T09:00:00Z') }),
      pr({ openedAt: at('2026-05-02T09:00:00Z'), mergedAt: at('2026-05-14T10:00:00Z') }),
    ], NOW);

    assert.deepEqual(summary.series.map((point) => `${point.month}:${point.opened}+${point.landed}=${point.openedTotal}/${point.total}`), [
      '2026-05:1+1=1/1', '2026-06:0+0=1/1', '2026-07:1+0=2/1', '2026-08:1+1=3/2', '2026-09:0+0=3/2',
    ], 'the months between are kept at the totals they were, never dropped and never grown');
  });

  test("and starts at the first pull request opened, not at the first merge nor at the window's edge", () => {
    // A run of months at zero before somebody's first reads as idleness, where in fact they had
    // not arrived; and a curve of merges alone started at the first merge.
    const summary = service.summariseMine([pr({ openedAt: at('2026-06-20T09:00:00Z'), mergedAt: at('2026-09-01T10:00:00Z') })], NOW);

    assert.deepEqual(summary.series.map((point) => point.month), ['2026-06', '2026-07', '2026-08', '2026-09']);
    assert.equal(summary.earlier, 0);
  });

  test("carries what fell before the window into both totals, rather than starting again", () => {
    const summary = service.summariseMine([
      // Twenty-six and twenty-five months back: outside the 24 the curve draws.
      pr({ openedAt: at('2024-06-01T09:00:00Z'), mergedAt: at('2024-07-01T10:00:00Z') }),
      pr({ openedAt: at('2024-08-20T09:00:00Z'), mergedAt: at('2026-09-01T10:00:00Z') }),
      pr({ openedAt: at('2026-09-01T09:00:00Z'), mergedAt: at('2026-09-02T10:00:00Z') }),
    ], NOW);

    assert.equal(summary.series.length, 24);
    assert.equal(summary.earlier, 2, 'opened before it, one of them merged inside it');
    // One merged before the window, the other inside it.
    assert.deepEqual({ ...summary.series[0] }, { month: '2024-10', opened: 0, landed: 0, openedTotal: 2, total: 1 },
      'the part that is not drawn is still part of each total');
    assert.equal(summary.series.at(-1).openedTotal, 3);
    assert.equal(summary.series.at(-1).total, 3);

    // A merge typed in with no opening date, landed before the window: counted in at the start of
    // the merged curve, so among the earlier ones too.
    const undated = service.summariseMine([
      pr({ openedAt: null, mergedAt: at('2024-05-01T10:00:00Z'), recordedByHand: true }),
      pr({ openedAt: at('2026-09-01T09:00:00Z'), mergedAt: at('2026-09-02T10:00:00Z') }),
    ], NOW);

    assert.equal(undated.earlier, 1);
    assert.deepEqual([undated.series[0].openedTotal, undated.series[0].total], [0, 1]);
  });

  test("keeps a merge with no opening date in the merged curve only, and says how many", () => {
    // A merge request typed in by hand may carry no opening date: it landed in a month, and
    // was opened in none the page knows.
    const summary = service.summariseMine([
      pr({ openedAt: null, mergedAt: at('2026-03-10T10:00:00Z'), recordedByHand: true }),
      pr({ openedAt: at('2026-05-01T09:00:00Z'), mergedAt: at('2026-05-02T10:00:00Z') }),
    ], NOW);

    assert.equal(summary.undated, 1);
    assert.equal(summary.series[0].month, '2026-03', 'the curve starts at the first pull request, whichever date it has');
    assert.deepEqual([summary.series[0].openedTotal, summary.series[0].total], [0, 1]);
    assert.deepEqual([summary.series.at(-1).openedTotal, summary.series.at(-1).total], [1, 2]);
  });

  test("finds the oldest open pull request over the values, never off the order", () => {
    // The rows arrive newest first by whatever became of each, so the last is not the oldest,
    // and a merged one opened earlier is not waiting for anything.
    const summary = service.summariseMine([
      open({ openedAt: at('2026-07-01T09:00:00Z') }),
      open({ openedAt: at('2025-01-05T09:00:00Z') }),
      pr({ openedAt: at('2024-01-01T09:00:00Z') }),
    ], NOW);

    assert.equal(summary.oldestOpenAt, '2025-01-05T09:00:00.000Z');
    assert.equal(service.summariseMine([pr()], NOW).oldestOpenAt, null);
  });

  test("times a merge only where it can be timed, and gates both percentiles on how many were", () => {
    // No opening date, and a merge before its opening: merged, and not timed.
    const untimed = [pr({ openedAt: null }), pr({ openedAt: at('2026-08-21T09:00:00Z') })];

    assert.deepEqual({ ...service.summariseMine([took(1), took(2), ...untimed], NOW).timeToMerge },
      { merged: 4, timed: 2, p50Seconds: null, p90Seconds: null }, 'two values have no median');
    assert.deepEqual({ ...service.summariseMine([took(1), took(2), took(3)], NOW).timeToMerge },
      { merged: 3, timed: 3, p50Seconds: 2 * 86_400, p90Seconds: null }, 'three have one, and no p90');

    const nine = service.summariseMine(Array.from({ length: 9 }, (_, i) => took(i + 1)), NOW).timeToMerge;
    const ten = service.summariseMine(Array.from({ length: 10 }, (_, i) => took(i + 1)), NOW).timeToMerge;

    assert.equal(nine.p90Seconds, null, 'nine values have no p90');
    // percentile_cont's interpolation, the report's own: 5.5 and 9.1 days of 1 to 10.
    assert.equal(ten.p50Seconds, 5.5 * 86_400);
    assert.ok(Math.abs(ten.p90Seconds - 9.1 * 86_400) < 1e-6);
  });

  test("answers for somebody with nothing, without pretending it is a zero", () => {
    const summary = service.summariseMine([], NOW);

    assert.deepEqual(summary.series, [], 'no series at all, rather than a flat line at zero');
    assert.equal(summary.oldestOpenAt, null);
    assert.deepEqual({ ...summary.timeToMerge }, { merged: 0, timed: 0, p50Seconds: null, p90Seconds: null });
    assert.deepEqual(summary.where, { ours: { prs: 0, repositories: 0 }, elsewhere: { prs: 0, repositories: 0 } });
  });
});

describe("where you stand", () => {
  const standings = [
    { who: 'ada', mergedEver: 9, openedMonth: 0 },
    { who: 'bob', mergedEver: 4, openedMonth: 3 },
    { who: 'cyd', mergedEver: 4, openedMonth: 1 },
    { who: 'dee', mergedEver: 1, openedMonth: 3 },
    { who: 'eve', mergedEver: 0, openedMonth: 2 },
  ];

  test("since day one on what was merged, and in the month on what was opened in it", () => {
    // Whatever the case of the login asked about: opened_by is matched lower-cased everywhere.
    assert.deepEqual(service.rankOf(standings, 'Cyd', '2026-09'),
      { ever: { position: 2, of: 4 }, month: { position: 4, of: 4, month: '2026-09' } });
  });

  test("a tie shares its place, and the next place is skipped", () => {
    assert.deepEqual(service.rankOf(standings, 'bob', '2026-09').ever, { position: 2, of: 4 });
    assert.deepEqual(service.rankOf(standings, 'dee', '2026-09'),
      { ever: { position: 4, of: 4 }, month: { position: 1, of: 4, month: '2026-09' } });
  });

  test("with no place since day one before a first merge, and none in a month with nothing opened", () => {
    assert.deepEqual(service.rankOf(standings, 'eve', '2026-09'), { ever: null, month: { position: 3, of: 4, month: '2026-09' } });
    assert.deepEqual(service.rankOf(standings, 'ada', '2026-09'), { ever: { position: 1, of: 4 }, month: null });
    assert.deepEqual(service.rankOf(standings, 'nobody', '2026-09'), { ever: null, month: null });
  });

  test("is read beside the rows and never instead of them: a report that cannot be read leaves them served", () => {
    // The landing rule reads buildMine(). Were the report's failure to fail it too, a reader with
    // rows would land on Overall and GET /dashboard/mine would answer 503. No database
    // under test can fail one of the two reads and not the other, so this is read off the source.
    const body = withoutComments(fn(read('src/services/dashboardMine.js'), 'buildMine'));

    assert.match(body, /Promise\.all\(\[\s*listContributionsForLogin\(login\),\s*Promise\.all\(\[getStandings\(\),\s*getReport\(\)\]\)\.catch\(/,
      "the report's failure is no longer caught apart from the rows");
  });
});

/**
 * Open the reader's own tab the way a reader does, and let its fetch settle
 *
 * Through the tab bar's click handler: the payload is fetched BECAUSE the tab was activated,
 * and that wiring is half of what is worth testing. On an operator's page whose own rows were
 * not read with it - the seed is a read the page opens without when it fails - so there is a
 * fetch to be caused.
 */
const openMine = async (mine, snapshot = operatorSnapshotOf()) => {
  const run = await runDocument(await renderPage(snapshot), snapshot, undefined, { mine });

  run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'mine' } } });
  await settle();

  return run;
};

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Markup with its tags taken out: what a screen reader or a reader is left with. */
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** One tile of the row, as its class and its text. */
const tileOf = (run, key) => {
  const [, state, inner] = new RegExp(`<div class="tile([^"]*)"[^>]*data-tile="${key}">([\\s\\S]*?)</div>`)
    .exec(run.elements.get('y-tiles').innerHTML);

  return { state: state.trim(), text: textOf(inner) };
};

/** Everything the tab has drawn, whichever of its parts it went into. */
const drawn = (run) => [...run.elements.values()].filter((el) => /^y-/.test(el.id)).map((el) => el.innerHTML).join('');

/** A chip of the list, pressed the way a click reaches its delegated handler. */
const press = (run, facet, value) => {
  const chip = {
    dataset: { value },
    closest: (selector) => ({ button: chip, [facet === 'group' ? '[data-groupby]' : '[data-facet]']: { dataset: { facet } } })[selector] ?? null,
  };

  run.elements.get('y-list').handlers.click({ target: chip });
};

/** The next page of the list, pressed the way a click reaches its delegated handler. */
const nextPage = (run) => {
  const next = { dataset: { page: '1' }, closest: (selector) => (selector === 'button[data-page]' ? next : null) };

  run.elements.get('y-list-pages').handlers.click({ target: next });
};

/** A hundred and twenty of them: twelve pages. */
const many = () => Array.from({ length: 120 }, (_, i) => ({ ...mineOf().contributions[i % 3], id: 100 + i }));

describe("your own contributions, on the page", () => {
  test("is a tab every reader gets, operator or not", async () => {
    for (const [tier, snapshot] of [
      ['operator', operatorSnapshotOf()],
      ['reader', snapshotOf()],
    ]) {
      const { html, errors } = await runPage(snapshot);

      assert.equal(errors.length, 0, `the ${tier} page threw:\n${report(errors)}`);
      assert.match(html, /data-view="mine"/,
        `the tab was withheld from a ${tier}, and it is their own data`);
    }
  });

  test("opens on the rows the server already read, without asking for them again", async () => {
    // The landing rule read them to choose this tab; the page is seeded with that answer rather
    // than opening empty and fetching the same rows half a second later.
    const run = await runPage(snapshotOf(), undefined, { mine: mineOf() });

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.equal(run.elements.get('view-mine').hidden, false, 'a reader with rows opens on them');
    assert.equal(tileOf(run, 'merged').text, 'Merged 3 of 3 judged 100% merge rate');

    // And reads them again only once the report's window is over: three turns of the loop later,
    // still nothing asked.
    for (let turn = 0; turn < 3; turn += 1) {
      for (const { fn, ms } of run.intervals) if (ms === 5000) await fn();
    }

    assert.deepEqual(run.fetched.filter((call) => call.url === '/dashboard/mine'), []);
  });

  test("and, opened by hand, reads them once per report window however often the page comes round", async () => {
    const run = await openMine(mineOf());

    for (let turn = 0; turn < 3; turn += 1) {
      for (const { fn, ms } of run.intervals) if (ms === 5000) await fn();
    }

    assert.equal(run.fetched.filter((call) => call.url === '/dashboard/mine').length, 1);
  });

  test("hides only what it has to, and each of those is in the markup, hidden until the first read", () => {
    // The curve's band, the bars' panel and the list's subtitle, on a tab with no row at all.
    // Each carries a class that sets `display`, which is the whole reason the [hidden] rule is
    // !important - so a fourth is an element to add here, after checking that rule covers it.
    assert.equal((read('views/dashboard/mine.js').match(/\.hidden = /g) ?? []).length, 3,
      'the tab hides something new - add its id to the list below');

    for (const id of ['y-time', 'y-bars-panel', 'y-list-sub']) {
      assert.match(markup(), new RegExp(`<[^>]* id="${id}"[^>]* hidden>`), `${id} is hidden by the script but is not in the markup, hidden`);
    }
  });

  test("gives every figure of its four tiles a base, and every rank its window", async () => {
    const run = await openMine(mineOf());

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.deepEqual(['merged', 'open', 'time', 'rank'].map((key) => tileOf(run, key)), [
      { state: '', text: 'Merged 3 of 3 judged 100% merge rate' },
      // Zero is a figure: shown as one, with no sub-line to explain it.
      { state: 'zero', text: 'Awaiting a verdict 0' },
      // Three timed is a median and no p90: that needs ten.
      { state: '', text: "Time to merge 12 d median of 3 merged everyone's median 3 d" },
      // A place and what it is out of, read on one line.
      { state: 'inline', text: 'Rank 4th of 41 since day one 2nd of 23 in Sep' },
    ]);
    assert.match(run.elements.get('y-tiles').innerHTML, /data-tile="merged">/);
    assert.match(run.elements.get('y-tiles').innerHTML, /style="--tint: var\(--poll\)" data-tile="merged"/);
  });

  test("and says what it cannot give, rather than a figure it does not have", async () => {
    const run = await openMine(mineOf({
      summary: {
        ...mineOf().summary,
        merged: 0, decided: 0, open: 2, oldestOpenAt: new Date(Date.now() - 6 * DAY - 3_600_000).toISOString(),
        timeToMerge: { merged: 12, timed: 11, p50Seconds: 90_000, p90Seconds: 1_000_000 },
      },
      // No merge yet, and nothing opened this month; the report could not be read for everyone's.
      rank: { ever: null, month: null },
      everyone: null,
    }));

    assert.deepEqual(['merged', 'open', 'time', 'rank'].map((key) => tileOf(run, key)), [
      { state: 'zero', text: 'Merged 0 of 0 judged' },
      { state: '', text: 'Awaiting a verdict 2 oldest open 6 d' },
      { state: '', text: 'Time to merge 1 d 1 h median of 12 merged 11 timed p90 11 d 13 h' },
      { state: 'zero inline', text: 'Rank — since day one no merge yet' },
    ]);

    // The standings could not be read at all: no place, and no window to give one in.
    const unread = await openMine(mineOf({ rank: null }));

    assert.deepEqual(tileOf(unread, 'rank'), { state: 'zero inline', text: 'Rank —' });
  });

  test("adds up what was opened and what was merged, as two steps drawn from one table", async () => {
    const run = await openMine(mineOf());
    const chart = chartIn(run, 'y-curve');
    const { datasets } = chart.data;
    const { token } = run.sandbox.Dash;

    assert.equal(textOf(run.elements.get('y-curve-sub').textContent), 'Since May 2026');
    assert.deepEqual(plain(chart.data.labels), ['May 2026', 'Jun', 'Jul', 'Aug']);

    // Along, then up: a diagonal would claim growth through the months with nothing in them.
    // Merged is the dashed one, in its own hue, and each legend entry is where its total stands.
    assert.deepEqual(plain(datasets.map((dataset) => [dataset.label, dataset.stepped, dataset.borderColor, dataset.borderDash, dataset.data])), [
      ['opened', true, token('ink-dim'), [], [2, 2, 2, 3]],
      ['merged', true, token('poll'), [6, 4], [2, 2, 2, 3]],
    ]);
    assert.deepEqual(legendIn(run, 'y-curve'), ['line opened 3', 'dash merged 3']);

    // A point only on the month under way, drawn open: the step carries the rest.
    assert.deepEqual(plain(datasets.map((dataset) => dataset.pointRadius)), [[0, 0, 0, 3.5], [0, 0, 0, 3.5]]);

    // Every month named with every value it holds, and the month under way says it is one.
    const label = run.elements.get('y-curve-canvas').getAttribute('aria-label');

    assert.match(label, /^opened 3\. merged 3\. May 2026: /);
    assert.match(label, /\. Jun 2026: opened 0, 2 in total, merged 0, 2 in total\. /);
    assert.match(label, /\. Aug 2026: opened 1, 3 in total, merged 1, 3 in total, to [A-Z][a-z]{2} \d{1,2}$/);
  });

  test("and hands each month to the tooltip, in the words of the hover it replaced", async () => {
    const { callbacks } = chartIn(await openMine(mineOf()), 'y-curve').options.plugins.tooltip;

    assert.equal(callbacks.title([{ dataIndex: 0 }]), 'May 2026');
    assert.deepEqual([0, 1].map((datasetIndex) => callbacks.label({ datasetIndex, dataIndex: 0 })),
      ['opened 2, 2 in total', 'merged 2, 2 in total']);
    assert.match(plain(callbacks.footer([{ dataIndex: 3 }])).join(), /^to [A-Z][a-z]{2} \d{1,2}$/);
  });

  test("says what the window leaves out, and what has no month to be opened in", async () => {
    const run = await openMine(mineOf({ summary: { ...mineOf().summary, earlier: 12, undated: 2 } }));

    assert.equal(run.elements.get('y-curve-sub').textContent, 'Since May 2026, 12 earlier counted at the start');
    assert.equal(legendIn(run, 'y-curve').at(-1), 'note: 2 pull requests with no opening date', 'a note under the legend');
  });

  test("draws no curve of a total still at zero, and still names it", async () => {
    // Somebody whose pull requests are all still open: nothing merged yet, in any month.
    const series = mineOf().summary.series.map((point) => ({ ...point, landed: 0, total: 0 }));
    const run = await openMine(mineOf({ summary: { ...mineOf().summary, series } }));
    const [opened, merged] = chartIn(run, 'y-curve').data.datasets;

    assert.deepEqual(plain(opened.data), [2, 2, 2, 3]);
    assert.deepEqual(plain(merged.data), [null, null, null, null], 'a flat line along the axis is a curve of nothing');
    assert.equal(legendIn(run, 'y-curve')[1], 'dash merged 0 (dimmed)');
    assert.match(run.elements.get('y-curve-canvas').getAttribute('aria-label'), /merged 0, 0 in total/);
  });

  test("splits every one of them twice: by its outcome, and by its scope", async () => {
    const run = await openMine(mineOf());

    // A rate is over judged, which the base says once for every entry.
    assert.equal(run.elements.get('y-outcome-head').innerHTML, 'Outcome <span class="base">3 pull requests, rates over 3 judged</span>');
    assert.deepEqual(legendIn(run, 'y-outcome'), ['circle merged 3 100%', 'square open 0 (dimmed)', 'triangle closed 0 0% (dimmed)']);
    assert.equal(run.elements.get('y-outcome-canvas').getAttribute('aria-label'), 'Outcome: merged 3 (100%), open 0, closed 0 (0%)');
    assert.equal(run.elements.get('y-scope-head').innerHTML, 'Scope <span class="base">3 pull requests in 3 repositories</span>');
    assert.deepEqual(legendIn(run, 'y-scope'), ['square ours 1 in 1 repository', 'square elsewhere 2 in 2 repositories']);
  });

  test("lists every one of them, each with its forge, where it went and what became of it", async () => {
    const [first] = mineOf().contributions;
    const run = await openMine(mineOf({
      contributions: [
        ...mineOf().contributions,
        { ...first, id: 4, merged: false, state: 'open', mergedAt: null, closedAt: null, openedAt: new Date(Date.now() - 6 * DAY - 3_600_000).toISOString() },
        { ...first, id: 5, merged: false, state: 'closed', mergedAt: null, closedAt: '2026-08-11T09:00:00Z' },
      ],
    }));
    const rows = run.elements.get('y-list-rows').innerHTML;

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    // In the order they came: newest first, by whatever became of each.
    assert.deepEqual([...rows.matchAll(/data-focus-key="y-list:([^"]+)"/g)].map((match) => match[1]), ['1', '2', '-3', '4', '5']);
    // No ownership badge: the Scope bar says how much is ours, and a third mark on a row that
    // has a forge and an outcome was one too many. One recorded by hand is labelled, not hidden.
    assert.doesNotMatch(rows, /own-badge/);
    assert.match(rows, /class="forgemark" viewBox="0 0 16 16" role="img" aria-label="gitlab"/);
    assert.match(rows, /class="chip">manual</);
    assert.equal((rows.match(/class="chip"/g) ?? []).length, 1);
    assert.match(rows, /<a class="name" href="https:\/\/gitlab\.com\/gitlab-org\/toolkit\/-\/merge_requests\/1664" target="_blank" rel="noreferrer">Add azure data disk management<\/a>/);

    // Where it went, then what became of it: two fragments, so a narrow row breaks between them.
    // No-break spaces hold a date together, a figure to its unit and the dot to the repository:
    // a date never splits over two lines, and the dot never stands alone on one.
    for (const when of ['merged Aug\u00a020,\u00a02026', 'open for 6\u00a0d', 'closed without a merge Aug\u00a011,\u00a02026']) {
      assert.ok(rows.includes(`<span class="meta"><span>acme/widget</span> <span>${when}</span></span>`), `no row reads "${when}"`);
    }
    // The chip ends the meta line rather than taking a column, which on a phone was a third of
    // the title's width.
    assert.ok(rows.includes('<span class="meta"><span>gitlab-org/toolkit</span> <span>merged May\u00a09,\u00a02026</span> <span class="chip">manual</span></span></span><span class="outcome merged">'),
      'the manual chip is not at the end of its meta line');

    assert.equal(run.elements.get('y-list-sub').hidden, false, 'a list with rows says their order');

    for (const state of ['merged', 'open', 'closed']) {
      assert.match(rows, new RegExp(`class="outcome ${state}"><svg viewBox="0 0 12 12" aria-hidden="true">[^]*?</svg>${state}</span>`),
        `a ${state} row says so by shape and by word`);
    }

    assert.equal(run.elements.get('y-list-count').textContent, '5 of 5 pull requests match.');
  });

  test("filters them by state and by scope, and groups them by repository", async () => {
    const run = await openMine(mineOf());
    const tools = () => run.elements.get('y-list-tools').innerHTML;

    // Every chip counts over everybody, whatever the other chips say.
    assert.match(tools(), /data-value="merged" data-focus-key="facet:state:merged">merged <b>3<\/b>/);
    assert.match(tools(), /data-value="closed" data-focus-key="facet:state:closed">closed <b class="zero">0<\/b>/);
    assert.match(tools(), /data-value="ours" data-focus-key="facet:scope:ours">ours <b>1<\/b>/);
    assert.match(tools(), /data-value="elsewhere" data-focus-key="facet:scope:elsewhere">elsewhere <b>2<\/b>/);
    assert.match(tools(), /data-value="by" data-focus-key="group:by">by repository<\/button>/);

    press(run, 'scope', 'elsewhere');
    assert.equal(run.elements.get('y-list-count').textContent, '2 of 3 pull requests match.');

    press(run, 'group', 'by');
    assert.deepEqual([...run.elements.get('y-list-rows').innerHTML.matchAll(/<p class="group-head" id="[^"]+">([^<]*)</g)].map((match) => match[1]),
      ['acme/widget (1)', 'gitlab-org/toolkit (1)']);

    press(run, 'state', 'open');
    assert.match(run.elements.get('y-list-none').innerHTML, /No pull request matches these filters\./);
  });

  test("shows ten at a time", async () => {
    const run = await openMine(mineOf({ contributions: many() }));
    const ids = () => [...run.elements.get('y-list-rows').innerHTML.matchAll(/<li data-focus-key="y-list:(\d+)">/g)].map((m) => Number(m[1]));

    assert.deepEqual(ids(), Array.from({ length: 10 }, (_, i) => 100 + i));
    assert.match(run.elements.get('y-list-pages').innerHTML, /<span id="y-list-pages-range">1–10 of 120<\/span>/);
    assert.equal(run.elements.get('y-list-count').textContent, '120 of 120 pull requests match.');

    nextPage(run);
    assert.deepEqual(ids(), Array.from({ length: 10 }, (_, i) => 110 + i));
  });

  test("keeps its chips, its group, its page and its charts across three refreshes", async () => {
    const run = await openMine(mineOf({ contributions: many() }));

    press(run, 'state', 'merged');
    press(run, 'group', 'by');
    nextPage(run);

    const made = run.charts.length;
    const rows = run.elements.get('y-list-rows').innerHTML;

    for (let turn = 0; turn < 3; turn += 1) {
      run.sandbox.Dash.tabs.get('mine').render();
    }

    const state = run.sandbox.Dash.state.lists['y-list'];

    assert.deepEqual({ facets: { ...state.facets }, group: state.group, page: state.page }, { facets: { state: 'merged' }, group: 'by', page: 1 });
    assert.match(run.elements.get('y-list-tools').innerHTML, /aria-pressed="true" data-value="merged"/);
    assert.match(run.elements.get('y-list-tools').innerHTML, /aria-pressed="true" data-value="by"/);
    assert.equal(run.elements.get('y-list-rows').innerHTML, rows, 'the same second page, in its groups');
    // The curve and the two bars, each updated where it stands - a tooltip open on one stays open.
    assert.equal(run.charts.length, made);
    assert.deepEqual(['y-curve', 'y-outcome', 'y-scope'].map((id) => chartIn(run, id).updates.length), [3, 3, 3]);
  });

  test("and leaves the keyboard on its chip through three reads of the route", async () => {
    // A window of nothing, so every turn of the loop reads /dashboard/mine again and draws from
    // what came back: the chips are the same, so they are not written again under the focus.
    const snapshot = snapshotOf({ limits: { ...snapshotOf().limits, reportTtlMs: 0 } });
    const run = await runPage(snapshot, undefined, { mine: mineOf() });
    const tools = run.elements.get('y-list-tools');
    const chip = { closest: (selector) => (selector === '[data-focus-key]' ? { getAttribute: () => 'facet:state:merged' } : null) };
    const markupBefore = tools.innerHTML;
    const reads = () => run.fetched.filter((call) => call.url === '/dashboard/mine').length;
    let writes = 0;

    Object.defineProperty(tools, 'innerHTML', { get: () => markupBefore, set: () => { writes += 1; } });
    tools.contains = (node) => node === chip;
    run.document.activeElement = chip;

    const readsBefore = reads();

    for (let turn = 0; turn < 3; turn += 1) {
      for (const { fn, ms } of run.intervals) if (ms === 5000) await fn();
    }

    assert.equal(reads() - readsBefore, 3, 'the route was not read on every turn');
    assert.equal(writes, 0, 'the chips were written again under the keyboard');
    assert.equal(run.document.activeElement, chip);
  });

  test("counts one merged figure three ways, and the three agree", async () => {
    const run = await openMine(mineOf());
    const tile = /data-tile="merged"><dt>Merged<\/dt><dd><span class="v">([\d,]+)</.exec(run.elements.get('y-tiles').innerHTML)[1];
    const segment = /^Outcome: merged ([\d,]+) /.exec(run.elements.get('y-outcome-canvas').getAttribute('aria-label'))[1];
    const chip = /data-value="merged" data-focus-key="facet:state:merged">merged <b>([\d,]+)</.exec(run.elements.get('y-list-tools').innerHTML)[1];

    assert.equal(tile, '3');
    assert.equal(segment, tile, 'the Outcome bar merges another number than the tile');
    assert.equal(chip, tile, 'the merged chip counts another number than the tile');
  });

  test("never marks a row as ours: the Scope bar says it once", () => {
    assert.doesNotMatch(withoutComments(read('views/dashboard/mine.js')), /ownBadge|own-badge/);
  });
});

describe("your own contributions, in each of the four states a read leaves them", () => {
  test("waiting on the first read: busy, and nothing that says it is empty", async () => {
    // A page opened without its seed, whose rows are then read by the tab.
    const run = await runDocument(await renderPage(operatorSnapshotOf()), operatorSnapshotOf(), undefined, { mine: mineOf() });

    run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'mine' } } });

    const hidden = () => ['y-time', 'y-bars-panel', 'y-list-sub'].map((id) => run.document.getElementById(id).hidden);

    assert.equal(run.elements.get('view-mine').getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(drawn(run), /class="nothing"/);
    assert.deepEqual(hidden(), [true, true, true], 'no blank chart and no empty bar while it waits');

    await settle();

    assert.equal(run.elements.get('view-mine').getAttribute('aria-busy'), 'false');
    assert.match(drawn(run), /data-tile="rank"/);
    assert.deepEqual(hidden(), [false, false, false], 'and each is shown once there are rows');
  });

  test("read, with no row at all: one empty state, which says which of the two empty answers it is", async () => {
    const run = await openMine(mineOf({ contributions: [], summary: service.summariseMine([]), rank: { ever: null, month: null } }));

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.equal(run.elements.get('y-time').hidden, true, 'no curve of nothing');
    assert.equal(run.elements.get('y-bars-panel').hidden, true, 'and no bars of nothing');
    assert.equal(run.elements.get('y-list-sub').hidden, true, 'and no order for a list of nothing');

    // The list's panel stays, holding the one empty state. "You have not contributed" is the
    // wrong sentence: a person GitHub renamed without the bot following it matches nothing here,
    // and their history is under the old name.
    const none = run.elements.get('y-list-none').innerHTML;

    assert.match(none, /^<div class="nothing"><b>No pull request is recorded under the-operator\.<\/b>/);
    assert.match(none, /renamed/);
    // Visible, as W26 asks: the one empty state is the list's own, in a panel nothing hides.
    assert.equal(run.document.getElementById('y-list').hidden, false);
    assert.match(run.html, /<section class="panel">\s*<h2>Every one of them<\/h2>/, "the list's panel is hidden, and the empty state with it");
    assert.equal((drawn(run).match(/class="nothing"/g) ?? []).length, 1, 'one empty state for the whole tab');
    assert.equal(run.elements.get('y-list-tools').innerHTML, '', 'and no chip to press over nothing');
    assert.equal(tileOf(run, 'merged').text, 'Merged 0 of 0 judged');
  });

  test("unreadable, before anything was read: the panels wait, and the banner says why", async () => {
    const run = await openMine(null);

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.doesNotMatch(drawn(run), /class="nothing"/, 'a read that failed is not a person with nothing');
    assert.equal(run.document.getElementById('y-tiles').innerHTML, '');
    assert.equal(run.elements.get('notice').innerHTML, 'Could not read your contributions.');
  });

  test("unreadable, after a read that worked: what was read stays, and says it is not current", async () => {
    // A window of nothing, so every turn of the loop asks again - and is refused.
    const snapshot = snapshotOf({ limits: { ...snapshotOf().limits, reportTtlMs: 0 } });
    const run = await runDocument(await renderPage(snapshot, { mine: mineOf() }), snapshot, undefined, { mine: null });

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.ok(run.fetched.some((call) => call.url === '/dashboard/mine'), 'the route was never asked again');
    assert.equal(tileOf(run, 'merged').text, 'Merged 3 of 3 judged 100% merge rate');
    assert.equal(run.elements.get('notice').innerHTML, 'Could not read your contributions — showing the last successful read.');
  });
});
