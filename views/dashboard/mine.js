/**
 * The Me tab: what this application has recorded under the reader's own login
 *
 * Served to every reader. Drawn from GET /dashboard/mine, or from the copy the page was seeded
 * with when it opened on this tab: the rows, the figures the server read off them, and where the
 * reader stands among everybody.
 */
(() => {
  'use strict';

  const { $, esc, fmt, marks, ui } = Dash;

  /** What became of a pull request, in the words the outcome marks and the chips share. */
  const outcomeOf = (row) => (row.merged ? 'merged' : row.state === 'closed' ? 'closed' : 'open');

  /** A date in one piece: held by no-break spaces, as fmt.span holds a number to its unit. */
  const day = (value) => fmt.date(value).replaceAll(' ', '\u00a0');

  /** A total that never left zero is not drawn: a flat line along the axis is a curve of nothing. */
  const drawn = (values) => (values.some((value) => value > 0) ? values : values.map(() => null));

  const drawTiles = ({ summary, rank, everyone }) => {
    const { merged, open, decided, oldestOpenAt, timeToMerge: time } = summary;

    ui.tiles($('y-tiles'), [
      {
        key: 'merged', label: 'Merged', value: fmt.n(merged), base: `of ${fmt.n(decided)} judged`,
        sub: [decided > 0 && `${fmt.pct(merged, decided)} merge rate`], tint: 'poll',
      },
      {
        key: 'open', label: 'Awaiting a verdict', value: fmt.n(open),
        sub: [oldestOpenAt && `oldest open ${fmt.age(Dash.now() - Date.parse(oldestOpenAt))}`], tint: 'warn',
      },
      {
        key: 'time', label: 'Time to merge', value: time.p50Seconds === null ? null : fmt.seconds(time.p50Seconds),
        base: `median of ${fmt.n(time.merged)} merged${time.timed < time.merged ? ` · ${fmt.n(time.timed)} timed` : ''}`,
        // Everyone's only when the report could be read, and only once it has a median itself.
        sub: [time.p90Seconds !== null && `p90 ${fmt.seconds(time.p90Seconds)}`,
          Number.isFinite(everyone?.p50Seconds) && `everyone's median ${fmt.seconds(everyone.p50Seconds)}`],
        tint: 'sync',
      },
      {
        // No place before a first merge, and none at all when the standings could not be read.
        key: 'rank', label: 'Rank', value: rank?.ever ? fmt.place(rank.ever.position) : null, inline: true,
        base: rank?.ever && `of ${fmt.n(rank.ever.of)}`,
        sub: rank ? ['since day one', !rank.ever && 'no merge yet', rank.month
          && `${fmt.ordinal(rank.month.position)} of ${fmt.n(rank.month.of)} in ${fmt.monthName(rank.month.month)}`] : [],
        tint: 'sync',
      },
    ]);
  };

  const drawCurve = ({ summary }) => {
    const { series } = summary;
    const keys = series.map((point) => point.month);
    const last = series.at(-1);

    Dash.dom.text($('y-curve-sub'), `Since ${fmt.month(keys[0])}${
      summary.earlier > 0 ? `, ${fmt.n(summary.earlier)} earlier counted at the start` : ''}`);

    ui.lineChart($('y-curve'), {
      x: Dash.chart.months(keys),
      // The month under way has not finished adding up.
      running: { note: `to ${fmt.day(new Date(Dash.now()).toISOString().slice(0, 10))}` },
      lanes: [{
        label: 'Pull requests',
        unit: 'count',
        // A step: nothing grew during a month with nothing in it, and a slope would say it did.
        // A total still at zero keeps its legend entry.
        series: [
          { key: 'opened', label: 'opened', hue: 'ink-dim', mode: 'step', values: drawn(series.map((point) => point.openedTotal)) },
          { key: 'merged', label: 'merged', hue: 'poll', dash: true, mode: 'step', values: drawn(series.map((point) => point.total)) },
        ],
      }],
      legend: [
        { series: 'opened', value: fmt.n(last?.openedTotal) },
        { series: 'merged', value: fmt.n(last?.total) },
        ...(summary.undated > 0 ? [{ note: `${fmt.plural(summary.undated, 'pull request', 'pull requests')} with no opening date` }] : []),
      ],
      // What the month held, and what each total stood at afterwards.
      rows: (i) => [
        { key: 'opened', text: `opened ${fmt.n(series[i].opened)}, ${fmt.n(series[i].openedTotal)} in total` },
        { key: 'merged', text: `merged ${fmt.n(series[i].landed)}, ${fmt.n(series[i].total)} in total` },
      ],
    });
  };

  const drawBars = ({ contributions, summary }) => {
    const { merged, open, closedUnmerged, decided, where } = summary;
    const pullRequests = fmt.plural(contributions.length, 'pull request', 'pull requests');
    // Each rate over what was judged, which the base says once for the whole legend.
    const rate = (count) => (decided > 0 ? fmt.pct(count, decided) : undefined);
    const repositories = (count) => fmt.plural(count, 'repository', 'repositories');

    ui.stackedBar($('y-outcome'), {
      title: 'Outcome',
      base: `${pullRequests}, ${decided > 0 ? `rates over ${fmt.n(decided)} judged` : 'none judged yet'}`,
      segments: [
        { key: 'merged', label: 'merged', n: merged, note: rate(merged) },
        { key: 'open', label: 'open', n: open },
        { key: 'closed', label: 'closed', n: closedUnmerged, note: rate(closedUnmerged) },
      ],
    });
    ui.stackedBar($('y-scope'), {
      title: 'Scope',
      base: `${pullRequests} in ${repositories(where.ours.repositories + where.elsewhere.repositories)}`,
      segments: [
        { key: 'ours', label: 'ours', n: where.ours.prs, note: `in ${repositories(where.ours.repositories)}` },
        { key: 'else', label: 'elsewhere', n: where.elsewhere.prs, note: `in ${repositories(where.elsewhere.repositories)}` },
      ],
    });
  };

  /** What became of it and when, after the repository it went to. */
  const whenOf = (row) => {
    if (row.merged) return `merged ${day(row.mergedAt)}`;

    return row.state === 'closed'
      ? `closed without a merge ${day(row.closedAt)}`
      : `open for ${fmt.age(Dash.now() - Date.parse(row.openedAt))}`;
  };

  /**
   * One pull request: its forge, its title, where it went and what became of it
   *
   * No ownership badge: the Scope bar says how much is ours, and a third mark on a row that has
   * a forge and an outcome was one too many. One recorded by hand says so at the end of its meta
   * line: a column of its own would take a third of a phone's title width.
   */
  const renderRow = (row) => `${marks.forge(row.forge)}<span class="grow">${ui.name(row.url, row.title ?? '')}`
    + `<span class="meta">${ui.fragments([esc(row.repo), esc(whenOf(row))])}${row.recordedByHand ? ` ${marks.chip('manual')}` : ''}</span>`
    + `</span>${marks.outcome(outcomeOf(row))}`;

  const drawList = ({ login, contributions }) => ui.filteredList($('y-list'), {
    id: 'y-list',
    noun: ['pull request', 'pull requests'],
    rows: contributions,
    key: (row) => String(row.id),
    facets: [
      { key: 'state', label: 'State', values: ['merged', 'open', 'closed'].map((value) => ({ value, label: value })), of: outcomeOf },
      { key: 'scope', label: 'Scope', values: ['ours', 'elsewhere'].map((value) => ({ value, label: value })), of: (row) => (row.own ? 'ours' : 'elsewhere') },
    ],
    // By its current name, which the registry gives every row of one repository alike.
    groupBy: { label: 'repository', of: (row) => row.repo, head: (repo, size) => `${repo} (${fmt.n(size)})` },
    render: renderRow,
    // Which of the two it is matters, and only one of them is about the person. A login GitHub
    // has renamed since matches nothing here - opened_by is frozen - and telling somebody they
    // have never contributed when the rows are sitting under their old name is the worst
    // answer this page could give.
    empty: {
      fact: `No pull request is recorded under ${login}.`,
      hint: "Pull requests keep the login they were opened with; a renamed account's are under the old name.",
    },
    none: 'No pull request matches these filters.',
  });

  const renderMine = () => {
    const { data } = Dash.data.peek('mine');

    // Never read yet, or never readable: the panels wait, and none of them says it is empty.
    if (!data) return;

    // No row at all is one empty state, the list's: a curve and two bars of nothing would say
    // the same thing three more times, and the order of a list with nothing in it is no fact.
    const empty = data.contributions.length === 0;

    $('y-time').hidden = empty;
    $('y-bars-panel').hidden = empty;
    $('y-list-sub').hidden = empty;
    drawTiles(data);

    if (!empty) {
      drawCurve(data);
      drawBars(data);
    }

    drawList(data);
  };

  Dash.tab('mine', {
    // Whatever Dash.data holds: the seed the page opened with, or the last read of the route.
    activate: renderMine,
    render: renderMine,
  });
})();
