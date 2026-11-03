import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { read, filesUnder, withoutComments } from "../test-support/sources.js";
import { runDocument, renderPage, report, rulesOf, legendIn, plain } from "../test-support/dashboardPage.js";
import { snapshotOf } from "../test-support/fixtures/snapshot.js";
import { mineOf } from "../test-support/fixtures/mine.js";
import { reportOf } from "../test-support/fixtures/collective.js";

/**
 * The shared components, through views/dashboard/core.js alone
 *
 * Each test runs the script in a document of its own: the three islands it reads as it loads,
 * whatever host elements the test draws into, and nothing of any tab.
 */
const load = async (body = '', { snapshot = snapshotOf(), seed = {}, ...options } = {}) => {
  const island = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value ?? null)}</script>`;
  const html = `${island('snapshot', snapshot)}${island('seed-mine', seed.mine)}${island('seed-report', seed.report)}`
    + `${body}<script src="/dashboard/assets/chart.js"></script><script src="/dashboard/assets/core.js"></script>`;
  const run = await runDocument(html, snapshot, undefined, { drainIntervals: false, ...options });

  assert.equal(run.errors.length, 0, `core.js threw:\n${report(run.errors)}`);

  return { ...run, Dash: run.sandbox.Dash };
};

/** Markup with its tags taken out: what a screen reader or a reader is left with. */
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** A duration as written: every number held to its unit by a no-break space. */
const nb = (text) => text.replace(/(\d) (?=[a-z])/g, '$1\u00a0');

describe("every figure and date is printed one way", () => {
  test("counts, numbers, ordinals and shares", async () => {
    const { fmt } = (await load()).Dash;

    for (const [call, expected] of [
      [fmt.n(2840), '2,840'], [fmt.n(0), '0'], [fmt.n(null), '—'], [fmt.n(undefined), '—'],
      [fmt.num(1664, 'github'), '#1664'], [fmt.num(1664, 'gitlab'), '!1664'],
      [fmt.pct(85, 100), '85%'], [fmt.pct(300, 300), '100%'], [fmt.pct(0, 300), '0%'],
      // Never a rounded 100% or 0%: 299 of 300 is not all of them, and 1 of 300 is not none.
      [fmt.pct(299, 300), '99%'], [fmt.pct(1, 300), '1%'], [fmt.pct(3, 0), '—'],
      [fmt.plural(1, 'run', 'runs'), '1 run'], [fmt.plural(2840, 'run', 'runs'), '2,840 runs'],
    ]) {
      assert.equal(call, expected);
    }
  });

  test("an ordinal is right on the ranks that catch a naive implementation", async () => {
    // The teens are the exception, and 21 is the one that proves the exception ended.
    const { fmt } = (await load()).Dash;

    for (const [rank, expected] of [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
      [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd'], [101, '101st'], [111, '111th'], [112, '112th']]) {
      assert.equal(fmt.ordinal(rank), expected, `rank ${rank}`);
    }
  });

  test("dates and months in UTC, whatever the shape they arrive in", async () => {
    const { fmt } = (await load()).Dash;

    // Late on the 4th in UTC is the 5th in Paris, and the page says the 4th: the server cuts
    // its months and days in UTC too.
    assert.equal(fmt.date('2026-09-04T23:30:00Z'), 'Sep 4, 2026');
    assert.equal(fmt.date(new Date('2026-09-14T00:00:00Z')), 'Sep 14, 2026', 'pg hands back Dates');
    assert.equal(fmt.date(null), '—', 'never the epoch a new Date(null) would be');
    assert.equal(fmt.month('2026-04'), 'Apr 2026');
    assert.equal(fmt.monthName('2026-09'), 'Sep', 'the month a figure is cut on, alone');
    assert.equal(fmt.day('2026-09-14'), 'Sep 14');
    assert.deepEqual(['2025-11', '2025-12', '2026-01', '2026-02'].map((_, i, keys) => fmt.monthAxis(keys, i)),
      ['Nov 2025', 'Dec', 'Jan 2026', 'Feb'], 'the year on the first point and on every January');
  });

  test("durations in two units at most, truncated, and an age in one", async () => {
    const { fmt } = (await load()).Dash;
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;

    for (const [ms, expected] of [
      [340, '340 ms'], [12_400, '12 s'], [18 * MIN + 30_000, '18 min'], [HOUR, '1 h'], [90 * MIN, '1 h 30 min'],
      [3 * DAY + 2 * HOUR + 59 * MIN, '3 d 2 h'], [2 * DAY, '2 d'], [-1, '—'], [Number.NaN, '—'],
    ]) {
      assert.equal(fmt.span(ms), nb(expected), `${ms} ms`);
    }

    // A narrow tile breaks "1 d 4 h" between its two units, never between a number and its own.
    assert.equal(fmt.span(DAY + 4 * HOUR), '1\u00a0d 4\u00a0h');

    assert.equal(fmt.age(5 * HOUR + 59 * MIN), nb('5 h'));
    assert.equal(fmt.age(6 * DAY + 23 * HOUR), nb('6 d'));
    assert.equal(fmt.age(143 * DAY), nb('143 d'));
    // What the server measures in seconds reads as any other duration.
    assert.equal(fmt.seconds(3 * 86_400 + 7200), nb('3 d 2 h'));
    assert.equal(fmt.tier(15), nb('15 min'));
    assert.equal(fmt.tier(240), nb('4 h'));
    assert.equal(fmt.tier(360), nb('6 h'));
  });

  test("and what is relative to now, on the server's clock", async () => {
    // A browser five minutes fast still reads "due in 3 min": the skew comes from the snapshot.
    const serverNow = Date.now() - 5 * 60_000;
    const { Dash } = await load('', { snapshot: snapshotOf({ now: new Date(serverNow).toISOString() }) });
    const { fmt } = Dash;
    const at = (ms) => new Date(Dash.now() + ms).toISOString();

    assert.equal(fmt.until(at(3 * 60_000 + 500)), nb('due in 3 min'));
    assert.equal(fmt.until(at(-(3 * 60_000 + 500))), nb('3 min overdue'));
    assert.equal(fmt.ago(at(-(2 * 60_000 + 1000))), nb('2 min ago'));
    assert.equal(fmt.ago(at(-10_000)), 'just now');
    assert.match(fmt.time(at(0)), /^\d{2}:\d{2}:\d{2}$/, 'today, the clock alone');
    assert.equal(fmt.time('2020-09-22T14:32:05Z'), 'Sep 22, 14:32', 'another day, the day as well');
  });
});

describe("the thresholds are the snapshot's", () => {
  test("and a percentile is gated on them", async () => {
    const { stats } = (await load()).Dash;

    assert.deepEqual({ ...stats.MIN }, { p50: 3, p90: 10, p99: 100 });
    assert.equal(stats.gate('p50', 42, 2), null, 'two values have no median');
    assert.equal(stats.gate('p50', 42, 3), 42);
    assert.equal(stats.gate('p90', 42, 9), null);
    assert.equal(stats.gate('p90', 42, 10), 42);
  });
});

describe("a class made from data is one the stylesheet knows", () => {
  test("anything off the list is 'unknown', and every list is frozen", async () => {
    const { VOCAB, cls } = (await load()).Dash;

    assert.equal(cls(VOCAB.OUTCOMES, 'merged'), 'merged');
    assert.equal(cls(VOCAB.OUTCOMES, '"><img src=x>'), 'unknown');
    assert.ok(Object.values(VOCAB).every(Object.isFrozen) && Object.isFrozen(VOCAB));
  });
});

describe("the three outcomes are told apart three ways", () => {
  const style = read('views/dashboard/core.css');

  test("by a shape, a word and a hue", async () => {
    const { marks } = (await load()).Dash;

    assert.match(marks.outcome('merged'), /<svg viewBox="0 0 12 12" aria-hidden="true"><circle [^>]*\/><\/svg>merged<\/span>$/);
    assert.match(marks.outcome('open'), /<rect [^>]*\/><\/svg>open<\/span>$/);
    assert.match(marks.outcome('closed'), /<path d="M6 1\.25 [^"]*Z"\/><\/svg>closed<\/span>$/, 'a triangle');
    // A count in place of the word: the shape says which outcome it counts, out loud too.
    assert.match(marks.outcome('merged', '128'), /<svg viewBox="0 0 12 12" role="img" aria-label="merged"><circle [^>]*\/><\/svg>128<\/span>$/);

    // Closed sat in the muted blue-grey the idle jobs use and disappeared into the row. Three
    // outcomes, three hues, none of them the neighbour's.
    assert.match(style, /\.outcome\.merged svg \{ fill: var\(--poll\); \}/);
    assert.match(style, /\.outcome\.open svg \{ fill: var\(--warn\); \}/);
    assert.match(style, /\.outcome\.closed svg \{ fill: var\(--fail\); \}/);
  });

  test("and no class is defined from scratch in two places", () => {
    // .state was once an outcome and an account state, and .scope a panel's grid and a count's
    // glyph: two rules for one name, and whichever came last won. The page's own sheets, that is:
    // base.css is the chassis they extend on purpose, a rule at a time.
    const bases = filesUnder('views/dashboard', '.css')
      .flatMap((file) => rulesOf(read(file)).filter((rule) => rule.at === null).flatMap((rule) => rule.selectors)
        .filter((selector) => /^\.[\w-]+$/.test(selector)).map((selector) => `${selector} (${file})`));
    const names = bases.map((entry) => entry.split(' ')[0]);

    assert.deepEqual(bases.filter((entry) => names.filter((name) => name === entry.split(' ')[0]).length > 1), []);
  });
});

describe("the marks say what they are without their colour", () => {
  test("a forge by its shape, a scope by its glyph, a person by their face", async () => {
    const { marks } = (await load()).Dash;

    assert.match(marks.forge('gitlab'), /^<svg class="forgemark" viewBox="0 0 16 16" role="img" aria-label="gitlab"><title>gitlab<\/title><path /);
    assert.match(marks.scope('ours', 3), /^<span class="scope-mark"><img src="\/images\/company_logo\.svg" alt="ours"><b>3<\/b><\/span>$/);
    assert.match(marks.scope('else', 0), /^<span class="scope-mark zero"><svg [^>]*aria-label="elsewhere"/, 'a zero is dimmed');
    // By the login, or by the account id where there is one, which outlives a rename; drawn round
    // at its size and fetched at twice it, lazily, with no referrer; a question mark with neither.
    assert.equal(marks.face('octo cat', 20), '<img class="avatar" style="--size: 20px" alt="" loading="lazy" referrerpolicy="no-referrer" '
      + 'src="https://avatars.githubusercontent.com/octo%20cat?s=40">');
    assert.match(marks.face('octocat', 32, 583231), / src="https:\/\/avatars\.githubusercontent\.com\/u\/583231\?s=64">$/);
    assert.match(marks.face('octocat'), /style="--size: 24px"/, 'a row\'s size unless told otherwise');
    assert.equal(marks.face(null, 32), '<span class="avatar monogram" style="--size: 32px" aria-hidden="true">?</span>');

    // Every face on the page is this one's: a second way to draw one is a second size, ring and
    // referrer to keep in step.
    assert.deepEqual(filesUnder('views/dashboard', '.js').filter((file) => file !== 'views/dashboard/core.js')
      .filter((file) => /avatars\.githubusercontent|class="avatar|class="monogram/.test(withoutComments(read(file)))), []);
    assert.equal(marks.chip('<you>'), '<span class="chip">&lt;you&gt;</span>');
    assert.equal(marks.ownBadge(), '<img class="own-badge" src="/images/company_logo.svg" alt="ours">');
  });
});

describe("a row's name", () => {
  test("links to the forge in a new tab, and is its text alone without an address", async () => {
    const { name } = (await load()).Dash.ui;

    assert.equal(name('https://github.com/acme/widget/pull/3', 'Fix <b>it</b>'),
      '<a class="name" href="https://github.com/acme/widget/pull/3" target="_blank" rel="noreferrer">Fix &lt;b&gt;it&lt;/b&gt;</a>');
    assert.equal(name(null, 'acme/widget'), '<span class="name">acme/widget</span>');
    // An address is the forge's, quoted into an attribute: escaped like any other text.
    assert.match(name('https://x.test/"onmouseover="alert(1)', 't'), /href="https:\/\/x\.test\/&quot;onmouseover=&quot;alert\(1\)"/);
  });
});

describe("an empty state is a fact and at most one hint", () => {
  test("escaped, like everything else written into the page", async () => {
    const { ui } = (await load()).Dash;

    assert.equal(ui.nothing('No pull request yet.', 'They appear here once <merged>.'),
      '<div class="nothing"><b>No pull request yet.</b><span>They appear here once &lt;merged&gt;.</span></div>');
    assert.equal(ui.nothing('Nothing.'), '<div class="nothing"><b>Nothing.</b></div>');
  });
});

describe("a row of tiles", () => {
  const draw = async (list) => {
    const run = await load('<dl class="tiles" id="t-tiles"></dl>');

    run.Dash.ui.tiles(run.document.getElementById('t-tiles'), list);

    return run.elements.get('t-tiles').innerHTML;
  };

  test("is the markup the spec gives a tile", async () => {
    const html = await draw([{ key: 'merged', label: 'Merged', value: '29', base: 'of 34 judged', sub: ['85% merge rate'], tint: 'poll' }]);

    // The spec's, with a space between the value and its base - copied or spoken, the tile reads
    // "29 of 34 judged" - and each fragment of the base and of the sub-line in a box of its own.
    assert.equal(html, '<div class="tile" style="--tint: var(--poll)" data-tile="merged"><dt>Merged</dt>'
      + '<dd><span class="v">29</span> <small><span>of 34 judged</span></small><p class="sub"><span>85% merge rate</span></p></dd></div>');
    assert.equal(textOf(html), 'Merged 29 of 34 judged 85% merge rate');
  });

  test("says a zero and a missing value apart, and zero wins over late", async () => {
    const html = await draw([
      { key: 'a', label: 'Overdue', value: '0', base: 'of 40 tracked', sub: ['2 on the floor tier'], tint: 'now', late: true },
      { key: 'b', label: 'Time to merge', value: null, base: 'median · 2 merged', sub: ['everyone\'s median 3 d'], tint: 'sync' },
      { key: 'c', label: 'Oldest lateness', value: '18 min', sub: ['octocat', 'sync · 1 h tier'], tint: 'now', late: true },
    ]);
    const tiles = html.split('</div>');

    // Zero: the figure, its base, no sub-line, and never late.
    assert.match(tiles[0], /^<div class="tile zero"[^>]*>.*<span class="v">0<\/span> <small><span>of 40 tracked<\/span><\/small><\/dd>$/);
    // Below its threshold: a dash, its base, and whatever the sub-line still has to say.
    assert.match(tiles[1], /class="tile zero"[\s\S]*<span class="v">—<\/span> <small><span>median<\/span> <span>2 merged<\/span><\/small><p class="sub"><span>everyone&#39;s median 3 d<\/span><\/p>/,
      'a base breaks between its fragments too');
    // No dot between two boxes: the line's gap sets them apart, so a line that wraps never
    // leaves a separator hanging at the end of one.
    assert.match(tiles[2], /class="tile late"[\s\S]*<p class="sub"><span>octocat<\/span> <span>sync · 1 h tier<\/span><\/p>/,
      'the sub-line is one line, its fragments a box each');
  });

  test("and a tint off the list paints nothing rather than anything", async () => {
    assert.match(await draw([{ key: 'x', label: 'X', value: '1', tint: 'red; background: url(x)' }]), /--tint: var\(--unknown\)/);
  });
});

describe("every chart is themed once, from the tokens", () => {
  test("its type, its inks and its tooltip, and no motion for a reader who asked for none", async () => {
    const { Dash, Chart } = await load();
    const { defaults } = Chart;

    assert.equal(defaults.font.family, Dash.token('sans'));
    assert.equal(defaults.font.size, 12);
    assert.equal(defaults.color, Dash.token('ink-mute'));
    assert.equal(defaults.borderColor, Dash.token('line-soft'));
    assert.equal(defaults.maintainAspectRatio, false, 'a chart takes the height of its box');
    assert.equal(defaults.plugins.legend, undefined, 'no legend to theme: the page writes each');
    assert.equal(defaults.plugins.tooltip.enabled, false, 'the tooltip is written in the page, not painted in the canvas');
    assert.equal(typeof defaults.plugins.tooltip.external, 'function');

    // Its theme is the stylesheet's: the panel's own colours, its title bold at 600.
    const style = read('views/dashboard/core.css');

    assert.match(style, /\.chart-tip \{[^}]*background: var\(--panel-2\)/);
    assert.match(style, /\.chart-tip b \{[^}]*font-weight: 500;/, 'the heaviest Plex Sans loaded: a 600 is synthesised');
    assert.equal(defaults.animation, undefined);
    assert.match(Dash.token('sans'), /^'IBM Plex Sans'/);

    assert.equal((await load('', { reducedMotion: true })).Chart.defaults.animation, false);
  });
});

describe("a stacked bar", () => {
  const draw = async (segments, extra = {}) => {
    const run = await load('<div class="bar-row" id="t-bar"></div>');
    const host = run.document.getElementById('t-bar');
    const bar = (more = {}) => run.Dash.ui.stackedBar(host, { title: 'Outcome', base: '41 pull requests · 34 judged', segments, ...extra, ...more });

    bar();

    return { ...run, host, bar, part: (name) => run.elements.get(`t-bar-${name}`) };
  };

  const OUTCOMES = [
    { key: 'merged', label: 'merged', n: 29, note: '85%' },
    { key: 'open', label: 'open', n: 7 },
    { key: 'closed', label: 'closed', n: 5, note: '15%' },
  ];

  test("is one bar as wide as its total, under its title and its base", async () => {
    const { charts, host, part } = await draw(OUTCOMES);
    const [chart] = charts;

    assert.equal(part('head').innerHTML, 'Outcome <span class="base">41 pull requests · 34 judged</span>');
    assert.match(host.innerHTML, /<div class="plot" id="t-bar-plot"><canvas id="t-bar-canvas" role="img"><\/canvas><\/div>/);
    assert.match(host.innerHTML, /<\/canvas><\/div><ul class="legend-list" id="t-bar-legend">/, 'the legend under the canvas, in the page');
    assert.equal(chart.config.type, 'bar');
    assert.equal(chart.options.indexAxis, 'y', 'lying down');
    assert.deepEqual(plain(chart.data.labels), ['Outcome'], 'one bar');
    assert.ok(chart.options.scales.x.stacked && chart.options.scales.y.stacked);
    assert.equal(chart.options.scales.x.max, 41, 'ending at the total, never at a round number past it');
    assert.deepEqual(plain(chart.data.datasets.map((dataset) => dataset.data)), [[29], [7], [5]]);
  });

  test("keys every segment by its count and its rate, in the legend, the tooltip and its name alike", async () => {
    const run = await draw(OUTCOMES);
    const [chart] = run.charts;
    const labels = chart.data.datasets.map((dataset) => dataset.label);

    // The canvas draws no legend of its own: the page's is text, off the same segments.
    assert.deepEqual(plain(chart.options.plugins.legend), { display: false });
    assert.deepEqual(legendIn(run, 't-bar'), ['circle merged 29 85%', 'square open 7', 'triangle closed 5 15%']);
    // Its key, its label, its value, its share: a space between each, as it is copied or read.
    const first = '<li style="--key: var(--poll)"><svg class="legend-key" viewBox="0 0 12 12" aria-hidden="true">'
      + '<circle cx="6" cy="6" r="4.5"/></svg><span class="legend-label">merged</span> <b>29</b> <small>85%</small>';

    assert.equal(run.part('legend').innerHTML.split('</li>')[0], first);
    assert.deepEqual(plain(labels), ['merged 29 (85%)', 'open 7', 'closed 5 (15%)']);
    assert.deepEqual(chart.data.datasets.map((dataset) => chart.options.plugins.tooltip.callbacks.label({ dataset })), labels);
    assert.equal(run.part('canvas').getAttribute('aria-label'), 'Outcome: merged 29 (85%), open 7, closed 5 (15%)');
  });

  test("tells the three outcomes apart by a shape as well as a hue, and keys anything else by a square", async () => {
    const run = await draw(OUTCOMES);
    const { Dash } = run;

    assert.deepEqual(plain(run.charts[0].data.datasets.map((dataset) => dataset.backgroundColor)), ['poll', 'warn', 'fail'].map(Dash.token));
    assert.deepEqual([...run.part('legend').innerHTML.matchAll(/--key: var\(--([\w-]+)\)/g)].map((m) => m[1]), ['poll', 'warn', 'fail'],
      'each key in the hue of its segment');

    const bands = await draw([{ key: 'b1', label: '< 1 d', n: 3 }, { key: 'ours', label: 'ours', n: 2 }]);

    assert.deepEqual(legendIn(bands, 't-bar'), ['square < 1 d 3', 'square ours 2']);
  });

  test("leaves a zero out of the bar and in the legend, dimmed", async () => {
    const run = await draw([{ key: 'merged', label: 'merged', n: 4 }, { key: 'closed', label: 'closed', n: 0 }]);

    assert.deepEqual(plain(run.charts[0].data.datasets.map((dataset) => [dataset.label, dataset.data])),
      [['merged 4', [4]], ['closed 0', [null]]], 'nothing to draw');
    assert.deepEqual(legendIn(run, 't-bar'), ['circle merged 4', 'triangle closed 0 (dimmed)'], 'still keyed');
  });

  test("keeps a slice too thin to see at 4px, which is why a zero is left out rather than drawn", async () => {
    const [chart] = (await draw([{ key: 'merged', label: 'merged', n: 243 }, { key: 'open', label: 'open', n: 1 }])).charts;

    assert.deepEqual(plain(chart.data.datasets.map((dataset) => [dataset.data, dataset.minBarLength])), [[[243], 4], [[1], 4]]);
  });

  test("and a bar of nothing is its empty state, under its title", async () => {
    const { charts, part } = await draw([{ key: 'ours', label: 'ours', n: 0 }], { empty: { fact: 'Nothing opened on ours.' } });

    assert.deepEqual(charts, [], 'no chart of nothing');
    assert.equal(part('plot').hidden, true);
    assert.equal(part('legend').innerHTML, '', 'and nothing to key');
    assert.equal(part('none').innerHTML, '<div class="nothing"><b>Nothing opened on ours.</b></div>');
    assert.match(part('head').innerHTML, /^Outcome /);
  });

  test("with a key off the list painted --ink-mute", async () => {
    const { charts, Dash } = await draw([{ key: 'red', label: 'x', n: 1 }]);

    assert.equal(charts[0].data.datasets[0].backgroundColor, Dash.token('ink-mute'));
  });

  test("is updated in place on a refresh, never made again", async () => {
    const { charts, bar, part } = await draw(OUTCOMES);

    bar({ segments: [{ ...OUTCOMES[0], n: 30 }, OUTCOMES[1], OUTCOMES[2]], base: '42 pull requests · 35 judged' });

    assert.equal(charts.length, 1);
    assert.deepEqual(charts[0].updates, ['none'], 'without animation');
    assert.deepEqual(plain(charts[0].data.datasets[0].data), [30]);
    assert.equal(charts[0].options.scales.x.max, 42);
    assert.match(part('head').innerHTML, /42 pull requests · 35 judged/);
    assert.match(part('canvas').getAttribute('aria-label'), /^Outcome: merged 30 /);
  });
});

describe("a line chart", () => {
  const chartOf = (overrides = {}) => ({
    x: ['2026-06', '2026-07', '2026-08', '2026-09'].map((key) => ({ key, label: key.slice(5), title: key })),
    running: { note: 'to Sep 23' },
    lanes: [{
      label: 'Pull requests',
      unit: 'count',
      series: [
        { key: 'opened', label: 'opened', hue: 'ink-dim', values: [2, 0, 5, 1] },
        { key: 'merged', label: 'merged', hue: 'poll', dash: true, values: [1, null, 3, 0] },
      ],
    }],
    ...overrides,
  });

  const draw = async (chart, options) => {
    const run = await load('<div id="t-chart"></div>', options);
    const host = run.document.getElementById('t-chart');
    const redraw = (next) => run.Dash.ui.lineChart(host, next);

    redraw(chart);

    return { ...run, host, redraw, chart: run.charts[0], part: (name) => run.elements.get(`t-chart-${name}`) };
  };

  test("draws each series in its hue, the merged one dashed, and a gap as a gap", async () => {
    const { chart, Dash } = await draw(chartOf());

    assert.equal(chart.config.type, 'line');
    assert.deepEqual(plain(chart.data.labels), ['06', '07', '08', '09']);
    assert.deepEqual(plain(chart.data.datasets.map((dataset) => [dataset.label, dataset.borderColor, dataset.borderDash])),
      [['opened', Dash.token('ink-dim'), []], ['merged', Dash.token('poll'), [6, 4]]]);
    assert.deepEqual(plain(chart.options.plugins.legend), { display: false });
    assert.deepEqual(plain(chart.data.datasets[1].data), [1, null, 3, 0], 'never a zero where there is nothing');
    assert.ok(chart.data.datasets.every((dataset) => dataset.spanGaps === undefined), "Chart.js's own default: a null breaks the line");
    assert.equal(chart.data.datasets[0].stepped, false);
  });

  test("names every value to a screen reader, off the table its tooltip reads", async () => {
    const { chart, part, host } = await draw(chartOf());
    const { callbacks } = chart.options.plugins.tooltip;

    assert.match(host.innerHTML, /<canvas id="t-chart-canvas" role="img"><\/canvas>/);
    assert.equal(part('canvas').getAttribute('aria-label'), 'opened. merged. 2026-06: opened 2, merged 1. 2026-07: opened 0, merged —. '
      + '2026-08: opened 5, merged 3. 2026-09: opened 1, merged 0, to Sep 23');
    assert.equal(chart.options.interaction.mode, 'index', 'one tooltip for the whole period');
    assert.equal(callbacks.title([{ dataIndex: 1 }]), '2026-07');
    assert.equal(callbacks.label({ datasetIndex: 1, dataIndex: 2 }), 'merged 3');
    assert.deepEqual(plain(callbacks.footer([{ dataIndex: 3 }])), ['to Sep 23'], 'the period still running says it is one');
    assert.deepEqual(plain(callbacks.footer([{ dataIndex: 2 }])), []);
  });

  test("draws the period still running open, and a point only where no line reaches", async () => {
    const { chart, Dash } = await draw(chartOf());
    const [opened, merged] = chart.data.datasets;

    assert.deepEqual(plain(opened.pointRadius), [0, 0, 0, 3.5]);
    // The first merged value has a gap after it: no line reaches it.
    assert.deepEqual(plain(merged.pointRadius), [3.5, 0, 0, 3.5]);
    assert.deepEqual(plain(opened.pointBackgroundColor), [...Array(3).fill(Dash.token('ink-dim')), Dash.token('panel')]);

    const still = await draw(chartOf({ running: undefined }));

    assert.deepEqual(plain(still.chart.data.datasets[0].pointRadius), [0, 0, 0, 0], 'no period running, no open point');
  });

  test("steps along, then up", async () => {
    const { chart } = await draw(chartOf({ lanes: [{ label: 'x', unit: 'count', series: [
      { key: 'total', label: 'total', hue: 'poll', mode: 'step', values: [0, 1, 1, 1] },
    ] }] }));

    assert.equal(chart.data.datasets[0].stepped, true, "Chart.js's 'before': along at the old value, then up at the new");
  });

  test("names the year on the first label it keeps, and on the first it keeps in each year after it", async () => {
    const { Dash } = await load();
    // What Chart.js left of an axis it thinned: every `every`-th period, from `from`.
    const axisOf = async (start, length, from, every) => {
      const keys = Array.from({ length }, (_, i) => new Date(Date.UTC(2025, start + i, 1)).toISOString().slice(0, 7));
      const { chart } = await draw(chartOf({
        running: undefined,
        x: Dash.chart.months(keys),
        lanes: [{ label: 'x', unit: 'count', series: [{ key: 'a', label: 'a', hue: 'sync', values: keys.map(() => 1) }] }],
      }));
      const ticks = keys.flatMap((_, i) => (i >= from && (i - from) % every === 0 ? [{ value: i, label: chart.data.labels[i] }] : []));

      chart.options.scales.x.beforeFit({ ticks });

      return ticks.map((tick) => tick.label);
    };

    // April 2025, the point that carries the year, is not kept: May, the first that is, says it.
    assert.deepEqual(await axisOf(3, 18, 1, 2), ['May 2025', 'Jul', 'Sep', 'Nov', 'Jan 2026', 'Mar', 'May', 'Jul', 'Sep']);
    // Neither January is kept: March names each year.
    assert.deepEqual(await axisOf(0, 21, 2, 3), ['Mar 2025', 'Jun', 'Sep', 'Dec', 'Mar 2026', 'Jun', 'Sep']);

    // A day's full name is wider than any label the thinning made room for: it stays short.
    const { chart } = await draw(chartOf({ x: ['2026-09-13', '2026-09-14'].map((key) => ({ key, label: key.slice(5), title: `${key} in full` })) }));
    const ticks = [{ value: 0, label: '09-13' }];

    chart.options.scales.x.beforeFit({ ticks });
    assert.equal(ticks[0].label, '09-13');
  });

  test("stacks its lanes, each on a scale of its own, and never puts two scales on one plot", async () => {
    const { chart, host } = await draw(chartOf({ lanes: [
      { label: 'Contributors', unit: 'count', series: [{ key: 'people', label: 'contributors', hue: 'ink-dim', values: [1, 2, 3, 4] }] },
      { label: 'Merged', unit: 'count', series: [{ key: 'merged', label: 'merged', hue: 'ink-dim', dash: true, values: [0, 1, 0, 2] }] },
    ] }));
    const { scales } = chart.options;

    assert.deepEqual(plain(chart.data.datasets.map((dataset) => dataset.yAxisID)), ['y0', 'y1']);
    assert.deepEqual([scales.y0.stack, scales.y1.stack], ['lanes', 'lanes'], 'one above the other');
    assert.deepEqual([scales.y0.title.text, scales.y1.title.text], ['Contributors', 'Merged']);
    assert.ok([scales.y0, scales.y1].every((scale) => scale.beginAtZero && scale.ticks.precision === 0), 'counted from zero, in whole ones');
    assert.ok(scales.y0.weight > scales.y1.weight, 'the first lane on top: Chart.js places the heavier first');
    // The zero of the lane on top is where the top of the one under it is written.
    assert.deepEqual([0, 1].map((i) => scales.y0.ticks.callback(i * 1000, i)), ['', '1,000']);
    assert.deepEqual([0, 1].map((i) => scales.y1.ticks.callback(i * 1000, i)), ['0', '1,000']);
    assert.match(host.innerHTML, /<div class="plot tall"/, 'a lane taller');
  });

  test("labels a duration lane in one unit, and scales its values to it", async () => {
    const { chart, part } = await draw(chartOf({
      running: undefined,
      lanes: [{ label: 'p50 · p90', unit: 'duration', series: [{ key: 'p50', label: 'p50', hue: 'ink-dim', values: [600, 1200, null, 2400] }] }],
    }));

    assert.equal(chart.options.scales.y0.title.text, 'p50 · p90 (min)');
    assert.deepEqual(plain(chart.data.datasets[0].data), [10, 20, null, 40], '2,400 seconds is 40 on a lane in minutes');
    assert.equal(chart.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataIndex: 0 }), nb('p50 10 min'), 'and said as a duration');
    assert.match(part('canvas').getAttribute('aria-label'), new RegExp(`2026-08: ${nb('p50 —')}\\.`));
  });

  test("an empty chart is one empty state, never a flat zero line, until it has something", async () => {
    const flat = chartOf({ lanes: [{ label: 'x', unit: 'count', series: [{ key: 'a', label: 'a', hue: 'sync', values: [0, 0, null, 0] }] }], empty: { fact: 'Nothing yet.' } });
    const { charts, redraw, part } = await draw(flat);

    assert.deepEqual(charts, []);
    assert.equal(part('plot').hidden, true);
    assert.equal(part('none').innerHTML, '<div class="nothing"><b>Nothing yet.</b></div>');

    redraw(chartOf());
    assert.equal(charts.length, 1);
    assert.equal(part('plot').hidden, false);
    assert.equal(part('none').innerHTML, '');
  });

  test("keys each series by a line in its own hue and dash, in the page, with its total and its notes", async () => {
    const run = await draw(chartOf({
      lanes: [{ label: 'x', unit: 'count', series: [
        { key: 'a', label: 'seen', hue: 'sync', values: [1, 2, 3, 4] },
        { key: 'b', label: 'never', hue: 'poll', dash: true, values: [null, null, null, null] },
      ] }],
      legend: [{ series: 'a', value: '10', share: 'in Sep' }, { series: 'b', value: '0' }, { note: '2 with no date' }],
    }));

    // A dash the canvas legend could not show: its key is drawn in the series' own dash.
    assert.deepEqual(legendIn(run, 't-chart'), ['line seen 10 in Sep', 'dash never 0 (dimmed)', 'note: 2 with no date'],
      'a series of gaps stays keyed, dimmed, and undrawn');
    assert.match(run.part('legend').innerHTML, /<li class="zero" style="--key: var\(--poll\)"><svg class="legend-key line" viewBox="0 0 24 4" aria-hidden="true">(?:<line [^>]*stroke-dasharray="6 4"\/>)<\/svg>/);
    assert.deepEqual(plain(run.chart.data.datasets[1].data), [null, null, null, null]);
    assert.equal(run.chart.options.plugins.subtitle, undefined, 'the notes are the page\'s too');
    assert.match(run.part('canvas').getAttribute('aria-label'), /^seen 10 in Sep\. never 0\. 2 with no date\. 2026-06: seen 1, never —\./);

    // With no legend given, each series by its name alone.
    assert.deepEqual(legendIn(await draw(chartOf()), 't-chart'), ['line opened', 'dash merged']);
  });

  test("is updated in place on a refresh, never made again", async () => {
    const { charts, redraw, part } = await draw(chartOf());

    redraw(chartOf({ running: { note: 'to Sep 24' } }));

    assert.equal(charts.length, 1);
    assert.deepEqual(charts[0].updates, ['none'], 'without animation');
    assert.deepEqual(plain(charts[0].options.plugins.tooltip.callbacks.footer([{ dataIndex: 3 }])), ['to Sep 24'], 'reading the new table');
    assert.match(part('canvas').getAttribute('aria-label'), /to Sep 24$/);
  });
});

describe("a filtered list", () => {
  const rows = [
    { id: 1, repo: 'b/two', state: 'merged', scope: 'ours' },
    { id: 2, repo: 'a/one', state: 'open', scope: 'else' },
    { id: 3, repo: 'b/two', state: 'merged', scope: 'else' },
    { id: 4, repo: 'c/three', state: 'closed', scope: 'ours' },
    { id: 5, repo: 'a/one', state: 'merged', scope: 'else' },
  ];

  const listOf = (overrides = {}) => ({
    id: 't-list',
    noun: ['pull request', 'pull requests'],
    rows,
    key: (row) => String(row.id),
    facets: [
      { key: 'state', label: 'State', values: ['merged', 'open', 'closed'].map((value) => ({ value, label: value })), of: (row) => row.state },
      { key: 'scope', label: 'Scope', values: [{ value: 'ours', label: 'ours' }, { value: 'else', label: 'elsewhere' }], of: (row) => row.scope },
    ],
    groupBy: { label: 'repository', of: (row) => row.repo, head: (repo, size) => `${repo} · ${size}` },
    render: (row) => `<a href="#${row.id}">${row.repo}</a>`,
    empty: { fact: 'No pull request is recorded.' },
    none: 'No pull request matches these filters.',
    ...overrides,
  });

  test("combines its facets and counts every chip over everyone", async () => {
    const { list } = (await load()).Dash;
    const picked = list.select(rows, listOf(), { facets: { state: 'merged', scope: 'else' }, group: 'none' });

    assert.deepEqual(picked.rows.map((row) => row.id), [3, 5], 'merged AND elsewhere');
    assert.deepEqual({ ...picked.counts.state }, { all: 5, merged: 3, open: 1, closed: 1 }, 'whatever the other facet says');
    assert.deepEqual({ ...picked.counts.scope }, { all: 5, ours: 2, else: 3 });
    assert.equal(picked.total, 5);
  });

  test("groups by size then name, keeps the order inside, and gives it back on none", async () => {
    const { list } = (await load()).Dash;
    const grouped = list.select(rows, listOf(), { facets: {}, group: 'by' });
    const flat = list.select(rows, listOf(), { facets: {}, group: 'none' });

    // Array.from: what the script built belongs to its own realm, and strict equality says so.
    assert.deepEqual(Array.from(grouped.rows, (row) => row.id), [2, 5, 1, 3, 4], 'a/one and b/two have two each, c/three one');
    assert.deepEqual(Object.fromEntries(grouped.groups), { 'b/two': 2, 'a/one': 2, 'c/three': 1 }, 'each group\'s size');
    assert.deepEqual(Array.from(flat.rows, (row) => row.id), [1, 2, 3, 4, 5]);
  });

  /** A list of `count` rows drawn into its host, and a page button pressed the way a click reaches it. */
  const paged = async (count, overrides = {}) => {
    const run = await load('<div id="t-list"></div>');
    const host = run.document.getElementById('t-list');
    const draw = (more = {}) => run.Dash.ui.filteredList(host, listOf({ rows: Array.from({ length: count }, (_, i) => ({ ...rows[i % 5], id: i })), ...overrides, ...more }));
    const turn = (step) => {
      const button = { dataset: { page: String(step) }, closest: (selector) => (selector === 'button[data-page]' ? button : null) };

      run.elements.get('t-list-pages').handlers.click({ target: button });
    };
    const ids = () => [...run.elements.get('t-list-rows').innerHTML.matchAll(/<li data-focus-key="t-list:(\d+)">/g)].map((m) => Number(m[1]));

    draw();

    return { run, host, draw, turn, ids, pages: () => run.elements.get('t-list-pages').innerHTML };
  };

  test("shows ten rows a page, between a Previous and a Next disabled at their ends", async () => {
    const { run, turn, ids, pages } = await paged(25);

    assert.deepEqual(ids(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(pages(), '<div class="pager">'
      + '<button type="button" data-page="-1" data-focus-key="page:-1" aria-label="Previous page" aria-describedby="t-list-pages-range" disabled>‹ Previous</button>'
      + '<span id="t-list-pages-range">1–10 of 25</span>'
      + '<button type="button" data-page="1" data-focus-key="page:1" aria-label="Next page" aria-describedby="t-list-pages-range">Next ›</button></div>');

    turn(1);
    assert.deepEqual(ids(), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.match(pages(), /aria-label="Previous page" aria-describedby="t-list-pages-range">‹ Previous<\/button><span id="t-list-pages-range">11–20 of 25<\/span>/);

    turn(1);
    assert.deepEqual(ids(), [20, 21, 22, 23, 24]);
    assert.match(pages(), /21–25 of 25<\/span><button [^>]*aria-label="Next page"[^>]* disabled>Next ›<\/button>/);
    // The counter says what the chips let through, whatever page is showing.
    assert.equal(run.elements.get('t-list-count').textContent, '25 of 25 pull requests match.');

    turn(-1);
    assert.deepEqual(ids(), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("has no controls while everything fits on one page", async () => {
    const { ids, pages } = await paged(10);

    assert.equal(ids().length, 10);
    assert.equal(pages(), '');
  });

  test("keeps its page through a refresh, and comes back inside a list that shrank", async () => {
    const { run, draw, turn, ids, pages } = await paged(25);

    turn(1);
    turn(1);
    draw();
    assert.deepEqual(ids(), [20, 21, 22, 23, 24], 'the same page, drawn again');

    draw({ rows: Array.from({ length: 15 }, (_, i) => ({ ...rows[i % 5], id: i })) });
    assert.equal(run.Dash.state.lists['t-list'].page, 1);
    assert.deepEqual(ids(), [10, 11, 12, 13, 14]);
    assert.match(pages(), /11–15 of 15/);
  });

  test("goes back to its first page on a chip or a group-by", async () => {
    const { run, host, turn, ids } = await paged(60);

    for (const [value, holder] of [['open', { '[data-facet]': { dataset: { facet: 'state' } } }], ['by', { '[data-groupby]': {} }]]) {
      const chip = { dataset: { value }, closest: (selector) => (selector === 'button' ? chip : holder[selector] ?? null) };

      turn(1);
      assert.equal(run.Dash.state.lists['t-list'].page, 1);
      host.handlers.click({ target: chip });
      assert.equal(run.Dash.state.lists['t-list'].page, 0, `pressing ${value} left the page where it was`);
    }

    assert.equal(ids()[0], 1, 'the first open row of the first group');
  });

  test("cuts its groups where a page ends, and says the head again of one it takes up", async () => {
    // Twelve in one repository, three in another: the first runs over into the second page.
    const { run, turn } = await paged(15, { groupBy: { label: 'repository', of: (row) => (row.id < 12 ? 'a/big' : 'b/small'), head: (repo, size) => `${repo} · ${size}` } });
    const heads = () => [...run.elements.get('t-list-rows').innerHTML.matchAll(/<p class="group-head" id="[^"]+">([^<]*)</g)].map((m) => m[1]);
    const press = { dataset: { value: 'by' }, closest: (selector) => (selector === 'button' ? press : selector === '[data-groupby]' ? {} : null) };

    run.document.getElementById('t-list').handlers.click({ target: press });
    assert.deepEqual(heads(), ['a/big · 12']);
    assert.equal((run.elements.get('t-list-rows').innerHTML.match(/<li data-focus-key/g) ?? []).length, 10);

    turn(1);
    assert.deepEqual(heads(), ['a/big · 12', 'b/small · 3']);
    assert.equal((run.elements.get('t-list-rows').innerHTML.match(/<li data-focus-key/g) ?? []).length, 5);
  });

  test("hands the focus to the other button when the one pressed reaches its end", async () => {
    const { run, turn } = await paged(15);
    const el = run.elements.get('t-list-pages');
    const focused = [];
    const control = (step) => ({
      getAttribute: () => `page:${step}`, querySelector: () => null, matches: () => true,
      get disabled() { return new RegExp(`data-page="${step}"[^>]* disabled`).test(el.innerHTML); },
      focus: () => focused.push(step),
    });

    el.querySelectorAll = () => [control(-1), control(1)];
    turn(1);
    assert.deepEqual(focused, [-1], 'Next is disabled on the last page: the focus is on Previous');

    turn(-1);
    assert.deepEqual(focused, [-1, 1], 'and Previous on the first: the focus is on Next');
  });

  test("is drawn into its host with its chips, its counter and its pages", async () => {
    const run = await load('<div id="t-list"></div>');
    const host = run.document.getElementById('t-list');
    const many = Array.from({ length: 60 }, (_, i) => ({ ...rows[i % 5], id: i }));

    run.Dash.ui.filteredList(host, listOf({ rows: many }));

    const tools = run.elements.get('t-list-tools').innerHTML;

    // The group is named by its label; the word beside the chips is for the eye, not said twice.
    assert.match(tools, /<div class="filters" role="group" aria-label="State" data-facet="state"><span class="k" aria-hidden="true">State<\/span>/);
    assert.equal((tools.match(/aria-pressed="true"/g) ?? []).length, 3, 'exactly one pressed chip per facet, and the group-by');
    assert.match(tools, /<button type="button" aria-pressed="true" data-value="all" data-focus-key="facet:state:all">all <b>60<\/b><\/button>/);
    assert.match(tools, /data-value="none" data-focus-key="group:none">none<\/button>/);
    assert.match(tools, /data-value="by" data-focus-key="group:by">by repository<\/button>/);
    assert.equal((run.elements.get('t-list-rows').innerHTML.match(/<li /g) ?? []).length, 10);
    assert.equal(run.elements.get('t-list-count').textContent, '60 of 60 pull requests match.');
    assert.match(run.elements.get('t-list-pages').innerHTML, /<span id="t-list-pages-range">1–10 of 60<\/span>/);

    // A chip, pressed the way a click reaches the delegated handler.
    const chip = { dataset: { value: 'open' }, closest: (selector) => (selector === 'button' ? chip : selector === '[data-facet]' ? { dataset: { facet: 'state' } } : null) };

    host.handlers.click({ target: chip });

    assert.deepEqual({ ...run.Dash.state.lists['t-list'].facets }, { state: 'open' });
    assert.equal(run.elements.get('t-list-count').textContent, '12 of 60 pull requests match.');
    assert.match(run.elements.get('t-list-pages').innerHTML, /1–10 of 12/, 'the pages count what the chips let through');
    // A live region only once it has something to say: the first fill is not news.
    assert.equal(run.elements.get('t-list-count').getAttribute('aria-live'), 'polite');
  });

  test("gives the focus back to the chip that was pressed", async () => {
    // Pressing a chip redraws every chip: the one under the keyboard is replaced by a new one,
    // and without a key to find it by the focus would fall to the top of the page.
    const run = await load('<div id="t-list"></div>');
    const host = run.document.getElementById('t-list');

    run.Dash.ui.filteredList(host, listOf());

    const tools = run.elements.get('t-list-tools');
    const key = { getAttribute: () => 'facet:state:open' };
    const chip = {
      dataset: { value: 'open' },
      closest: (selector) => ({ button: chip, '[data-facet]': { dataset: { facet: 'state' } }, '[data-focus-key]': key })[selector] ?? null,
    };
    const redrawn = { getAttribute: () => 'facet:state:open', querySelector: () => null, matches: () => true, focus() { run.document.activeElement = this; } };

    tools.contains = (node) => node === chip;
    tools.querySelectorAll = () => [redrawn];
    run.document.activeElement = chip;
    host.handlers.click({ target: chip });

    assert.match(tools.innerHTML, /aria-pressed="true" data-value="open" data-focus-key="facet:state:open"/);
    assert.equal(run.document.activeElement, redrawn, 'the focus is on the chip with the same key, drawn anew');
  });

  test("counts without a noun when the list names none", async () => {
    const run = await load('<p id="t-count"></p>');
    const el = run.document.getElementById('t-count');

    run.Dash.ui.counter(el, 3, 10, '');
    assert.equal(el.textContent, '3 of 10 match.');
    run.Dash.ui.counter(el, 12, 41, 'pull requests');
    assert.equal(el.textContent, '12 of 41 pull requests match.');
  });

  test("says when the chips match nothing, and when there is nothing at all", async () => {
    const run = await load('<div id="t-list"></div><div id="t-empty"></div>');
    const empty = listOf({ id: 't-empty', rows: [] });

    run.Dash.state.lists['t-list'] = { facets: { state: 'closed', scope: 'else' }, group: 'none', page: 0 };
    run.Dash.ui.filteredList(run.document.getElementById('t-list'), listOf());
    run.Dash.ui.filteredList(run.document.getElementById('t-empty'), empty);

    assert.equal(run.elements.get('t-list-none').innerHTML, '<div class="nothing"><b>No pull request matches these filters.</b></div>');
    assert.equal(run.elements.get('t-list-count').textContent, '0 of 5 pull requests match.');
    // An empty population is one empty state: no chips to press, no counter over nothing.
    assert.equal(run.elements.get('t-empty-tools').innerHTML, '');
    assert.equal(run.elements.get('t-empty-none').innerHTML, '<div class="nothing"><b>No pull request is recorded.</b></div>');
    assert.equal(run.elements.get('t-empty-count').textContent, '');
    assert.equal(run.elements.get('t-empty-pages').innerHTML, '');
  });
});

describe("a redraw that changes nothing does nothing", () => {
  test("and one that changes something gives the focus back", async () => {
    const { Dash, document } = await load();
    let writes = 0;
    let focused = null;
    let options = null;
    const row = {
      getAttribute: () => 'list:7', querySelector: () => null, matches: () => true,
      focus(given) { focused = 'row 7'; options = given; },
    };
    const el = {
      html: '',
      get innerHTML() { return this.html; },
      set innerHTML(value) { writes += 1; this.html = value; },
      contains: (node) => node === document.activeElement,
      querySelectorAll: () => [row],
    };

    assert.equal(Dash.dom.swap(el, '<li data-focus-key="list:7">7</li>'), true);
    assert.equal(Dash.dom.swap(el, '<li data-focus-key="list:7">7</li>'), false, 'the same markup is not written again');
    assert.equal(writes, 1);

    document.activeElement = { closest: () => ({ getAttribute: () => 'list:7' }) };
    Dash.dom.swap(el, '<li data-focus-key="list:7">7 changed</li>');

    assert.equal(writes, 2);
    assert.equal(focused, 'row 7', 'focus comes back to the element with the same key');
    assert.deepEqual({ ...options }, { preventScroll: true }, 'and without moving the page');
  });
});

describe("a tab's data is read once, and kept for the report's window", () => {
  test("seeded, it is ready without a request", async () => {
    const { Dash, fetched } = await load('', { seed: { mine: mineOf() } });
    const state = await Dash.data.load('mine');

    assert.equal(state.status, 'ready');
    assert.equal(state.data.login, 'the-operator');
    assert.deepEqual(fetched, []);
  });

  test("unseeded, it is loading until one request answers, however many ask", async () => {
    const { Dash, fetched } = await load('', { report: reportOf() });

    assert.equal(Dash.data.peek('report').status, 'loading');

    const [first, second] = await Promise.all([Dash.data.load('report'), Dash.data.load('report')]);

    assert.equal(fetched.length, 1, 'one request in flight');
    assert.equal(first, second);
    assert.equal(first.status, 'ready');
    await Dash.data.load('report');
    assert.equal(fetched.length, 1, 'and none again inside the window');
  });

  test("a failed read is an error, with or without what was read before", async () => {
    const lost = await load('', { mine: null });

    assert.deepEqual({ ...(await lost.Dash.data.load('mine')) }, { status: 'error', data: null, readAt: 0 });

    // The window over at once, so the seeded copy is read again - and the read fails.
    const stale = await load('', { snapshot: snapshotOf({ limits: { ...snapshotOf().limits, reportTtlMs: 0 } }), seed: { report: reportOf() }, report: null });
    const state = await stale.Dash.data.load('report');

    assert.equal(state.status, 'error');
    assert.ok(state.data.summary, 'what was drawn stays drawn');
  });

  test("and a 401 signs the page out", async () => {
    const { Dash } = await load('', { mine: 401 });
    let signedOut = 0;

    Dash.signOut = () => { signedOut += 1; };
    await Dash.data.load('mine');

    assert.equal(signedOut, 1);
  });
});

describe("the page, once signed out", () => {
  test("stops both loops and says how to sign in again", async () => {
    // A reader opening on the report, whose first read of it is answered 401.
    const { elements, intervals, errors } = await runDocument(await renderPage(snapshotOf()), snapshotOf(), undefined, { report: 401 });

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    // The read never came back with anything, and nothing will read again: not loading.
    assert.equal(elements.get('view-collective').getAttribute('aria-busy'), 'false');
    assert.ok(intervals.length === 2 && intervals.every((interval) => interval.cleared), 'a loop still runs');
    assert.equal(elements.get('notice').innerHTML, 'Session expired. <a href="/dashboard/login">sign in</a>');
    // And the badge that says the page is current no longer says it is.
    assert.ok(elements.get('heartbeat').classList.contains('stale'));
    assert.equal(elements.get('heartbeat-text').textContent, 'signed out');
  });

  test("and leaves no tab waiting on a read that will never come", async () => {
    // Me, never read before - opened on, or switched to - and answered 401.
    const { elements, errors } = await runDocument(await renderPage(snapshotOf(), { landing: 'mine' }), snapshotOf(), undefined, { mine: 401 });

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('heartbeat-text').textContent, 'signed out');
    assert.equal(elements.get('view-mine').getAttribute('aria-busy'), 'false');
  });
});
