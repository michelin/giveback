/**
 * The Overall tab: the contribution report, for everyone who installed the app
 *
 * Served to every reader. Drawn from GET /dashboard/contributions, or from the copy the page
 * was seeded with when it opened on this tab - and, for the two marks that are about the reader,
 * from who they are: the projects they got something merged into (their own rows) and their row
 * among this month's contributors (their login). Nothing in the report itself depends on who
 * reads it.
 */
(() => {
  'use strict';

  const { $, esc, fmt, cls, VOCAB, marks, ui } = Dash;

  // Both series end on the month the report was built in, which is still running.
  const running = (report) => ({ note: `to ${fmt.day(report.builtAt.slice(0, 10))}` });

  /** "Top 6 of 41" - or "All 4", when the ranking holds every one there is. */
  const topOf = (shown, of, measure) => (of === 0
    ? `On ${measure}`
    : `${shown < of ? `Top ${fmt.n(shown)} of ${fmt.n(of)}` : `All ${fmt.n(of)}`}, on ${measure}`);

  /**
   * A project by its name, linked to the address its refresh stored: never one built out of the
   * name, which a project on another forge would not answer at. Until it has one, just the name.
   */
  const link = (project) => (project.url
    ? `<a href="${esc(project.url)}" target="_blank" rel="noreferrer">${esc(project.repo)}</a>`
    : esc(project.repo));

  /** A row's meta line, as fragments. */
  const meta = (parts) => `<span class="meta">${ui.fragments(parts)}</span>`;

  const SCOPE = {
    key: 'scope',
    label: 'Scope',
    values: [{ value: 'ours', label: 'ours' }, { value: 'else', label: 'elsewhere' }],
    of: (row) => (row.own ? 'ours' : 'else'),
  };

  const drawTiles = (report) => {
    const { all, own, external } = report.summary;
    const month = report.contributorSeries.at(-1);
    const times = report.mergeTimes;
    const judged = all.merged + all.closedUnmerged;

    ui.tiles($('r-tiles'), [
      {
        key: 'merged', label: 'Merged', value: fmt.n(all.merged), base: `of ${fmt.n(judged)} judged`,
        sub: [`${fmt.pct(all.merged, judged)} merge rate`], tint: 'poll',
      },
      {
        key: 'contributors', label: 'Contributors', value: fmt.n(month.contributors), base: `in ${fmt.monthName(month.month)}`,
        sub: [`${fmt.n(month.firstTime)} first-time`, `${fmt.plural(report.installedAccounts, 'account', 'accounts')} installed`],
        tint: 'sync',
      },
      {
        key: 'time', label: 'Time to merge', value: times.p50Seconds === null ? null : fmt.seconds(times.p50Seconds), base: 'median',
        sub: times.p90Seconds === null ? [] : [`p90 ${fmt.seconds(times.p90Seconds)}`], tint: 'sync',
      },
      {
        key: 'projects', label: 'Projects', value: fmt.n(all.repositories), base: 'touched',
        sub: [`${fmt.n(own.repositories)} ours`, `${fmt.n(external.repositories)} elsewhere`], tint: 'sync',
      },
    ]);
  };

  /**
   * Who opened something each month, and what got merged: two lanes, one unit each
   *
   * The merges are the month series' own, ours and elsewhere together, so this lane and the chart
   * below it cannot disagree about a month.
   */
  const drawWho = (report) => {
    const series = report.contributorSeries;
    const keys = series.map((row) => row.month);
    const landed = new Map(report.months.map((row) => [row.month, row.merged + row.ownMerged]));
    const merged = keys.map((key) => landed.get(key) ?? 0);
    const current = series.at(-1);
    const month = fmt.monthName(current.month);
    const period = `the last ${fmt.n(series.length)} months`;
    // The last six, this one included: each newcomer is counted once, in their first month.
    const newcomers = series.slice(-6).reduce((sum, row) => sum + row.firstTime, 0);

    Dash.dom.text($('r-who-sub'), `Last ${fmt.n(series.length)} months`);

    ui.lineChart($('r-who'), {
      x: Dash.chart.months(keys).map((x, i) => ({ ...x, base: `${fmt.n(series[i].firstTime)} first-time` })),
      running: running(report),
      lanes: [
        {
          label: 'Contributors',
          unit: 'count',
          series: [{ key: 'contributors', label: 'contributors', hue: 'ink-dim', values: series.map((row) => row.contributors) }],
        },
        {
          label: 'Pull requests merged',
          unit: 'count',
          series: [{ key: 'merged', label: 'merged', hue: 'ink-dim', dash: true, values: merged }],
        },
      ],
      legend: [
        { series: 'contributors', value: fmt.n(current.contributors), share: `in ${month}` },
        { series: 'merged', value: fmt.n(merged.at(-1)), share: `in ${month}` },
        { note: `${fmt.n(current.firstTime)} first-time in ${month}, ${fmt.n(newcomers)} over 6 months` },
      ],
      empty: { fact: `No pull request opened in ${period}.` },
    });
  };

  /**
   * Opened and merged, ours and elsewhere: hue says whose repository, the dash says merged. Each
   * is a flow, so its legend total is the sum of the months drawn.
   */
  const drawMonths = (report) => {
    const { months } = report;
    const keys = months.map((row) => row.month);
    const series = [
      { key: 'ownOpened', label: 'ours opened', hue: 'sync', values: months.map((row) => row.ownOpened) },
      { key: 'ownMerged', label: 'ours merged', hue: 'sync', dash: true, values: months.map((row) => row.ownMerged) },
      { key: 'opened', label: 'elsewhere opened', hue: 'poll', values: months.map((row) => row.opened) },
      { key: 'merged', label: 'elsewhere merged', hue: 'poll', dash: true, values: months.map((row) => row.merged) },
    ];

    Dash.dom.text($('r-months-sub'), `Opened and merged${keys.length > 0 ? ` since ${fmt.month(keys[0])}` : ''}`);

    ui.lineChart($('r-months'), {
      x: Dash.chart.months(keys),
      running: running(report),
      lanes: [{ label: 'Pull requests', unit: 'count', series }],
      legend: series.map((one) => ({ series: one.key, value: fmt.n(one.values.reduce((sum, n) => sum + n, 0)) })),
      empty: { fact: 'No pull request recorded yet.' },
    });
  };

  /**
   * The three outcomes of one scope, each verdict with its rate: over what was judged, as the
   * bar's base says, so the legend need not say it on every entry.
   */
  const drawOutcomes = (report) => [
    ['r-ours', 'Ours', report.summary.own, 'Nothing opened on ours.'],
    ['r-elsewhere', 'Elsewhere', report.summary.external, 'Nothing opened elsewhere.'],
  ].forEach(([id, title, half, fact]) => {
    const judged = half.merged + half.closedUnmerged;
    const rate = (n) => (judged > 0 ? fmt.pct(n, judged) : undefined);

    ui.stackedBar($(id), {
      title,
      base: `${fmt.plural(half.opened, 'pull request', 'pull requests')}, ${judged > 0 ? `rates over ${fmt.n(judged)} judged` : 'none judged yet'}`,
      segments: [
        { key: 'merged', label: 'merged', n: half.merged, note: rate(half.merged) },
        { key: 'open', label: 'open', n: half.stillOpen },
        { key: 'closed', label: 'closed', n: half.closedUnmerged, note: rate(half.closedUnmerged) },
      ],
      empty: { fact },
    });
  });

  /** How long a merge took and how many commits it carried, each over what could be measured. */
  const drawSizes = (report) => {
    const { merged, timed, durations, commits } = report.mergeTimes;

    // No merge at all is one empty state for the pair, not one under each title.
    $('r-sizes').hidden = merged === 0;
    Dash.dom.swap($('r-sizes-none'), merged === 0 ? ui.nothing('No merged pull request yet.') : '');

    if (merged === 0) return;

    ui.stackedBar($('r-time'), {
      title: 'Time to merge',
      base: `${fmt.n(timed)} of ${fmt.n(merged)} merged, timed`,
      segments: [
        { key: 'b1', label: '< 1 d', n: durations.under1d },
        { key: 'b2', label: '1–7 d', n: durations.days1to7 },
        { key: 'b3', label: '7–30 d', n: durations.days7to30 },
        { key: 'b4', label: '> 30 d', n: durations.over30d },
      ],
      empty: { fact: 'None of them could be timed.' },
    });
    ui.stackedBar($('r-commits'), {
      title: 'Commits per pull request',
      base: `${fmt.n(commits.counted)} of ${fmt.n(merged)} merged, counted`,
      // Each band carries its unit, as the time bands do: a bare "1" beside its count of 292
      // reads as one figure, 1 292.
      segments: [
        { key: 'b1', label: '1 commit', n: commits.one },
        { key: 'b2', label: '2–3 commits', n: commits.twoToThree },
        { key: 'b3', label: '4–9 commits', n: commits.fourToNine },
        { key: 'b4', label: '10+ commits', n: commits.tenPlus },
      ],
      empty: { fact: 'None of them has a commit count.' },
    });
  };

  /**
   * How long everything open has waited, then the ten that have waited longest
   *
   * What the poll no longer reads is waiting too: counted in its band like the rest, said in the
   * base, and named on its row - never a band of its own, since it is no age.
   */
  const drawAwaiting = (report) => {
    const ages = report.openAges;
    const now = Dash.now();

    Dash.dom.text($('r-pending-sub'), `${fmt.n(ages.open)} open, oldest first`);

    // Nothing open, nothing to divide: the list below says so, once.
    $('r-ages').hidden = ages.open === 0;

    if (ages.open > 0) {
      ui.stackedBar($('r-ages'), {
        title: 'Age',
        // The count is the panel's line already: the base only says what it holds that is not polled.
        base: ages.notFollowed > 0 ? `${fmt.n(ages.notFollowed)} no longer polled` : undefined,
        segments: [
          { key: 'b1', label: '< 7 d', n: ages.under7d },
          { key: 'b2', label: '7–30 d', n: ages.days7to30 },
          { key: 'b3', label: '30–90 d', n: ages.days30to90 },
          { key: 'b4', label: '> 90 d', n: ages.over90d },
        ],
      });
    }

    // Every one of them came from GitHub: what is recorded by hand is merged work, never open.
    ui.filteredList($('r-pending'), {
      id: 'r-pending',
      noun: ['pull request', 'pull requests'],
      rows: report.pending,
      key: (row) => String(row.id),
      facets: [SCOPE],
      render: (row) => `<span class="grow">${ui.name(row.url, row.title)}${meta([
        `${row.own ? marks.ownBadge() : ''}${esc(row.repo)} ${esc(fmt.num(row.number, 'github'))}`,
        `${marks.face(row.login, 20)}${esc(row.login)}`,
        ...(row.followed ? [] : ['no longer polled']),
      ])}</span><span class="score">${esc(fmt.age(now - Date.parse(row.openedAt)))}</span>`,
      empty: { fact: 'No pull request is waiting for a verdict.' },
      none: 'No pull request matches this filter.',
    });
  };

  /** The three most-starred projects outside ours we got something merged into, and who did. */
  const drawBiggest = (report) => {
    const fish = report.biggestFish;

    if (fish.length === 0) {
      Dash.dom.swap($('r-fish'), ui.nothing('No pull request merged outside ours yet.'));
      return;
    }

    // People, not appearances: somebody in two of the three is one of them.
    const people = new Set(fish.flatMap((project) => project.contributors.map((who) => who.login.toLowerCase())));
    const merged = fish.reduce((sum, project) => sum + project.merged, 0);

    // Keyed by the project, so a refresh that redraws the three gives focus back to the link it was on.
    Dash.dom.swap($('r-fish'), `<ol class="rank fish">${fish.map((project, i) => `<li data-focus-key="fish:${project.repositoryId}">`
      + `<span class="place">${i + 1}</span><span class="grow"><span class="repo">${link(project)}</span>${meta([
        ...(project.stars === null ? [] : [`<b class="stars">${fmt.n(project.stars)}</b> ${project.stars === 1 ? 'star' : 'stars'}`]),
        `${fmt.n(project.merged)} merged`,
        `first in ${fmt.month(project.firstMergedAt.slice(0, 7))}`,
      ])}<span class="faces">${project.contributors.map((who) =>
        `<span class="face">${marks.face(who.login, 28)}<b>${esc(who.login)}</b><small>×${fmt.n(who.merged)}</small></span>`).join('')}</span>`
      + `</span></li>`).join('')}</ol>`
      + `<p class="table-count">${fmt.plural(people.size, 'person', 'people')}, `
      + `${fmt.plural(merged, 'pull request', 'pull requests')} merged across `
      + `${fish.length === 1 ? 'this project' : `these ${fmt.n(fish.length)} projects`}</p>`);
  };

  /**
   * The three outcomes as production drew them on a project's row: GitHub's own pictograms,
   * the merge's fork and join, the open branch, the closed one struck through. The shape says
   * which, the hue repeats it, and a zero recedes.
   */
  const GIT_ICONS = {
    merged: '<path d="M5 3.5a1.5 1.5 0 1 0-2 1.41V9.1a1.5 1.5 0 1 0 1 0V6.6c.5.6 1.2 1 2.1 1.1l1.4.2'
      + 'a1.5 1.5 0 1 0 0-1l-1.3-.2C5.5 6.6 5 6 5 5.2Z"/>',
    open: '<path d="M4 3.6a1.5 1.5 0 1 0-1 0v4.8a1.5 1.5 0 1 0 1 0Zm5 0a1.5 1.5 0 1 0-1 0V7a2 2 0 0'
      + '1-2 2H5v1h1a3 3 0 0 0 3-3Z"/>',
    closed: '<path d="M3.5 2.4a1.5 1.5 0 1 0-1 2.6v2a1.5 1.5 0 1 0 1 0V5a1.5 1.5 0 0 0 0-2.6ZM10 3.2'
      + 'l-.7-.7L8 3.8 6.7 2.5l-.7.7L7.3 4.5 6 5.8l.7.7L8 5.2l1.3 1.3.7-.7-1.3-1.3Z"/>',
  };

  /** One outcome's count: its pictogram, named out loud, then the figure. */
  const gitCount = (state, count, word) => `<span class="git ${cls(VOCAB.OUTCOMES, state)}${count === 0 ? ' zero' : ''}" title="${esc(`${fmt.n(count)} ${word}`)}">`
    + `<svg viewBox="0 0 12 12" role="img" aria-label="${esc(word)}">${GIT_ICONS[state] ?? ''}</svg><b>${fmt.n(count)}</b></span>`;

  /**
   * The projects with the most merged, the reader's own marked
   * @param {Map<number, number>} yours - The reader's merges, by project
   */
  const drawProjects = (report, yours) => {
    const rows = report.projects;

    Dash.dom.text($('r-projects-sub'), topOf(rows.length, rows[0]?.of ?? 0, 'merged pull requests'));

    ui.filteredList($('r-projects'), {
      id: 'r-projects',
      noun: ['project', 'projects'],
      rows,
      key: (row) => String(row.repositoryId),
      facets: [SCOPE],
      render: (row) => {
        const mine = yours.get(row.repositoryId) ?? 0;

        return `<span class="grow${mine > 0 ? ' yours' : ''}">`
          + `<span class="name">${row.own ? marks.ownBadge() : ''}${link(row)}</span>${mine > 0 ? marks.chip('you') : ''}`
          + `${meta([...(row.stars === null ? [] : [fmt.plural(row.stars, 'star', 'stars')]), `${fmt.n(row.people)} of us`,
            ...(mine > 0 ? [`${fmt.n(mine)} yours`] : [])])}</span>`
          // Merged, still open, closed without one, in that order: the order is the story.
          + `<span class="score gits">${gitCount('merged', row.merged, 'merged')}${gitCount('open', row.stillOpen, 'still open')}`
          + `${gitCount('closed', row.closedUnmerged, 'closed without a merge')}</span>`;
      },
      empty: { fact: 'No merged pull request yet.' },
      none: 'No project matches this filter.',
    });
  };

  /** The top of this month, on what was opened: the reader's own row says so, and adds none. */
  const drawContributors = (report) => {
    const { month, of, rows } = report.contributors;
    const name = fmt.monthName(month);
    const viewer = String(Dash.snapshot.viewer ?? '').toLowerCase();

    Dash.dom.text($('r-contributors-sub'), topOf(rows.length, of, `pull requests opened in ${name}`));

    Dash.dom.swap($('r-contributors'), rows.length === 0 ? ui.nothing(`No pull request opened in ${name} yet.`) : `<ol class="rank">${
      rows.map((who) => {
        const you = who.login.toLowerCase() === viewer;

        return `<li${you ? ' class="yours"' : ''}>${marks.face(who.login, 24)}`
          + `<span class="grow"><span class="name">${esc(who.login)}</span>${you ? marks.chip('you') : ''}`
          + `${meta([`${fmt.n(who.opened)} opened in ${esc(name)}`])}</span>`
          + `<span class="score scopes">${marks.scope('ours', who.ours)}${marks.scope('else', who.elsewhere)}</span></li>`;
      }).join('')
    }</ol>`);
  };

  /**
   * Draw what the report holds, once the reader's own rows are in as well
   *
   * Both reads settle before anything is drawn, so the projects are never drawn unmarked and then
   * marked. The reader's rows only mark: when they have never been read, nothing is marked and
   * the report is drawn all the same; when a later read fails, the marks stay those of the last
   * good one, as the report does. Outside any try: the reads never throw, and a throw here is a
   * bug in this tab.
   *
   * Only while the tab still shows once they settle, as only the tab showing is ever drawn: one
   * left in the meantime is drawn again when it is shown.
   */
  const draw = async () => {
    const [report, mine] = await Promise.all([Dash.data.load('report'), Dash.data.load('mine')]);

    if (!report.data || Dash.state.tab !== 'collective') return;

    const yours = new Map();

    for (const row of mine.data?.contributions ?? []) {
      if (row.merged) yours.set(row.repositoryId, (yours.get(row.repositoryId) ?? 0) + 1);
    }

    drawTiles(report.data);
    drawWho(report.data);
    drawMonths(report.data);
    drawOutcomes(report.data);
    drawSizes(report.data);
    drawAwaiting(report.data);
    drawBiggest(report.data);
    drawProjects(report.data, yours);
    drawContributors(report.data);
  };

  // On activation as well as on render: both reads start together, rather than the reader's own
  // after the report's.
  Dash.tab('collective', { activate: draw, render: draw });
})();
