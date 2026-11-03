import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { read, dashboardServices, withoutComments, fn, functions } from "../test-support/sources.js";
import { parseOwnGithubOrgs } from "../src/utils/constants.js";
import { runPage, runDocument, renderPage, report, chartIn, legendIn, plain } from "../test-support/dashboardPage.js";
import { snapshotOf } from "../test-support/fixtures/snapshot.js";
import { operatorSnapshotOf } from "../test-support/fixtures/ops.js";
import { reportOf } from "../test-support/fixtures/collective.js";
import { mineOf } from "../test-support/fixtures/mine.js";

describe("the contribution report", () => {
  test("is served whole: public pull requests, and whether the poll still reads the waiting ones", () => {
    // Every panel it feeds names a pull request that is public on github.com. What the page
    // withholds is the operational detail beside it, and none of that is in this payload but one
    // fact, said on the row in words: that the poll no longer reads a pull request still waiting.
    const source = dashboardServices();

    assert.match(source, /res\.json\(\{ \.\.\.report, now:/);
    assert.doesNotMatch(source, /visibleReport/, 'the redaction is gone, not bypassed');
    // What is served is the report and nothing kept beside it.
    assert.doesNotMatch(fn(read('src/services/dashboardReport.js'), 'handleGetDashboardContributions'), /standings/,
      'the full standings stay on the server');
  });

  test("the route is a GET behind the same gate, and separate from the snapshot", () => {
    // Separate because it is on a different clock: cached for a minute, where the snapshot must
    // never be. Folding it into /dashboard/data would put ten reads of the pull request table on a
    // five-second loop, per reader.
    const index = read('src/index.js');

    assert.match(
      index,
      /express\.get\("\/dashboard\/contributions", requireDashboardAccess, handleGetDashboardContributions\)/
    );

    assert.match(dashboardServices(), /REPORT_TTL_MS/);
  });
});

describe("the contribution report reads no more than it draws", () => {
  // Not a privacy tier - the report is served whole to every reader - but a shape: four
  // queries answer "who and where", and the ones that answer "how many" must stay aggregate.
  // A summary reaching for a login is a GROUP BY that lost its grouping.
  // listContributionsForLogin is the fifth, and the only one that is not about the parc: it
  // answers one reader about themselves, so a login in its WHERE and a project name in its
  // SELECT are the question, not a leak. It emits nothing about anybody else.
  const DETAIL_QUERIES = ['getTopContributors', 'getTopProjects', 'getBiggestFish',
    'listPendingPullRequests', 'listContributionsForLogin'];

  // Identifies a person or carries a capability, and no panel in the report has ever needed it.
  const FORBIDDEN_EVERYWHERE = ['user_enrollment_email_address', 'user_name', 'merged_by', 'actor', 'events_etag'];

  const source = withoutComments(read('src/db/contributions.js'));

  for (const column of FORBIDDEN_EVERYWHERE) {
    test(`nothing reads ${column}`, () => {
      assert.doesNotMatch(source, new RegExp(`\\b${column}\\b`));
    });
  }

  test("only the detail queries select a login or a repository name", () => {
    // A column may still appear outside that tier where it is consumed rather than emitted: in
    // count(DISTINCT) to produce a number, in a predicate or a GROUP BY that it never leaves, and
    // in split_part() to decide whether a row is ours. Anywhere else - a select list above all,
    // `SELECT p.opened_by AS login` - it is on its way to a reader. Qualified or case-folded,
    // not bare: `p.` alone once exempted every column of the table.
    const CONSUMED_NOT_EMITTED = new RegExp([
      String.raw`count\(DISTINCT (lower\()?(p|gi)\.$`,
      String.raw`(\bWHERE|\bAND|\bOR|=)\s*(lower\()?(p|gi)\.$`,
      String.raw`GROUP BY\s*(lower\()?(p|gi)\.$`,
      String.raw`split_part\(\s*(r\.)?$`,
    ].join('|'));
    // The row shape every aggregate reads FROM: its columns are the outer query's input, and the
    // outer query is what this guard reads. The one fragment exempt, named.
    const SHAPE = 'CONTRIBUTIONS';
    const offenders = [];
    const scan = (name, body) => {
      for (const column of ['opened_by', 'user_login', 'full_name']) {
        for (const match of body.matchAll(new RegExp(`(.{0,26})\\b${column}\\b`, 'g'))) {
          if (!CONSUMED_NOT_EMITTED.test(match[1])) {
            offenders.push(`${name} emits ${column} (…${match[1].trim()}${column})`);
          }
        }
      }
    };
    const fragments = new Map([...functions(source)].filter(([, body]) => !body.includes('queryText = `')));
    const aggregates = [...functions(source)]
      .filter(([name, body]) => body.includes('queryText = `') && !DETAIL_QUERIES.includes(name));
    // Counted, and asserted below. The marker is a local variable name: renaming `queryText` to
    // `sql` is a harmless refactor that made every function skip, and a loop over nothing ends
    // in `assert.deepEqual([], [])` - a privacy guard that passes having read no SQL at all.
    const builders = [...functions(source)].filter(([, body]) => body.includes('queryText = `')).length;

    for (const [name, body] of aggregates) {
      scan(name, body);
    }

    // What an aggregate interpolates is its SQL too: FOLLOWED is selected `AS followed`, so a
    // login it grew into would leave the server under that name, with no literal in any body.
    const interpolated = [...fragments.keys()]
      .filter((name) => name !== SHAPE && aggregates.some(([, body]) => body.includes(`\${${name}}`)));

    for (const name of interpolated) {
      scan(name, fragments.get(name));
    }

    assert.ok(builders >= 6, `only ${builders} query builders found - the 'queryText = \`' marker stopped matching`);
    assert.ok(interpolated.includes('FOLLOWED'), 'the fragment the ages select is no longer read by this guard');
    assert.deepEqual(offenders, [], 'an aggregate query is emitting a name');
  });

  test("and the reads the shared figures added are held to both rules", () => {
    // The merge times, the contributors by month and the ages of what is open count what a person
    // opened; the standings name people, so they are a detail query - and only ever leave the
    // server four at a time.
    for (const name of ['getMergeTimes', 'getContributorSeries', 'getOpenAges', 'getTopContributors']) {
      assert.match(functions(source).get(name) ?? '', /\$\{BY_A_PERSON\}/, `${name} counts a bot`);
    }

    assert.ok(DETAIL_QUERIES.includes('getTopContributors'));

    for (const name of ['getMergeTimes', 'getContributorSeries', 'getOpenAges']) {
      assert.ok(!DETAIL_QUERIES.includes(name), `${name} is an aggregate, held to the aggregate rule`);
    }
  });

  test("the ecosystem story excludes our own repositories, and says so in every query", () => {
    // The whole point of the split. Without the exclusion a heavily maintained internal project
    // tops the ranking of a report about open source, and nothing on the page looks wrong.
    // The trophy is the last query that EXCLUDES: a famous external project is the claim it
    // makes, and our own repository in that slot would be a trophy for maintaining ourselves.
    // The two rankings used to exclude too, and dropped a person's whole month in silence when
    // their merges were internal - they split now, like the totals.
    assert.match(functions(source).get('getBiggestFish') ?? '', /NOT \(\$\{IS_OWN\}\)/,
      'getBiggestFish must exclude repositories we own');

    for (const name of ['getTopContributors', 'getTopProjects']) {
      assert.doesNotMatch(functions(source).get(name) ?? '', /NOT \(\$\{IS_OWN\}\)/,
        `${name} must split on ownership, not filter on it`);
    }

    // The other two tell both stories rather than dropping one, so they group by ownership
    // instead of filtering on it - and listPendingPullRequests keeps everything, because a pull
    // request rotting on one of our own repositories is its own kind of problem.
    // The tag itself moved into the shared CONTRIBUTIONS shape, so a query gets it either by
    // spelling it or by reading from that constant. Both are the split; neither is a filter.
    assert.match(source, /const CONTRIBUTIONS = `[\s\S]*?\$\{IS_OWN\} AS own/,
      'the shared contribution shape must carry the ownership tag');

    for (const name of ['getContributionSummary', 'getMonthlySeries', 'getContributorSeries', 'getTopContributors']) {
      const body = functions(source).get(name) ?? '';

      assert.ok(/\$\{IS_OWN\} AS own/.test(body) || /\$\{CONTRIBUTIONS\}/.test(body),
        `${name} must split rather than filter`);
      assert.doesNotMatch(body, /NOT \(\$\{IS_OWN\}\)/);
    }

    const pending = functions(source).get('listPendingPullRequests') ?? '';

    assert.match(pending, /\$\{IS_OWN\} AS own/, 'listPendingPullRequests must flag ownership, not lose it');
    assert.doesNotMatch(pending, /NOT \(\$\{IS_OWN\}\)/);
  });

  test("every figure in the report counts what a PERSON opened", () => {
    // 'Bot' is GitHub's own word for the account behind the pull request, and one busy
    // repository produces hundreds of dependency bumps. When this was added, 407 of the 1,144
    // stored pull requests were a bot's and 325 of those counted as merged contributions -
    // every panel of the report was reading them as the company's work.
    //
    // Asserted on every query builder rather than on a list of names: a panel added later gets
    // the predicate or fails here, which is the only way a filter of this kind survives.
    // One exemption, named and reasoned: getContributionTotals counts exactly what BY_A_PERSON
    // drops - the bot pull requests the footnote states - so filtering it would count nothing.
    // Every other figure here is about what people wrote.
    const COUNTS_EVERYTHING = ['getContributionTotals'];

    const missing = [...functions(source)]
      .filter(([name]) => !COUNTS_EVERYTHING.includes(name))
      .filter(([, body]) => body.includes('queryText = `'))
      .filter(([, body]) => !body.includes('${BY_A_PERSON}'))
      .map(([name]) => name);

    assert.deepEqual(missing, [], 'these count a bot as a contributor');

    for (const name of COUNTS_EVERYTHING) {
      assert.doesNotMatch(functions(source).get(name) ?? '', /\$\{BY_A_PERSON\}/,
        `${name} counts what the predicate drops - filtering it would zero it`);
    }
  });

  test("and it keeps the rows rather than filtering them out of existence", () => {
    // The narrowing is a read, never a delete. What a bot opened and a person merged is real
    // maintenance work, and it can only become a figure later if the rows are still there.
    assert.match(read('src/db/predicates.js'), /export const BY_A_PERSON = "p\.user_type = 'User'";/);
    assert.match(source, /import \{ IS_OWN, BY_A_PERSON \} from "\.\/predicates\.js";/,
      'one definition, shared with the Operations tab, or the two answer by two rules');
  });

  test("and it asks that question of one name only: the current one", () => {
    // A constant, not a function taking a column. A column parameter would let a caller point
    // the ownership test at the copy frozen on the contribution, and a repository transferred
    // out of an owned organisation would then count as ours for ever.
    assert.match(read('src/db/predicates.js'), /export const IS_OWN = "lower\(split_part\(r\.full_name, '\/', 1\)\) = ANY\(\$1\)";/);
  });

  test("nothing here reads a frozen name, and no aggregate groups on one", () => {
    // dest_repo and the four popularity columns on a contribution are what was true the day it
    // was seen. There is exactly one legitimate way to read one - as the fallback behind the
    // repository's own figure - and no legitimate way to join, group or filter on it: a
    // repository renamed between two contributions carries two frozen names and is one project.
    assert.doesNotMatch(source, /\bdest_repo\b/, 'the current name comes from the registry');
    assert.doesNotMatch(source, /GROUP BY[^\n]*p\.(dest_repo|stargazers_count|forks_count)/);
    assert.doesNotMatch(source, /JOIN[^\n]*=\s*p\.dest_repo/);
    assert.doesNotMatch(source, /LEFT JOIN github_repositories/,
      'the link is NOT NULL behind a foreign key, so a LEFT JOIN only hides the day it stops being');
  });

  test("every query decides ownership from the configured list, never from a hard-coded name", () => {
    // The README promises nothing in this application is Michelin-specific, and a report that
    // said "michelin" in SQL would quietly make that false.
    assert.doesNotMatch(source.toLowerCase(), /'michelin|"michelin/);
    assert.match(read('src/db/predicates.js'), /= ANY\(\$1\)/);

    let builders = 0;

    for (const [name, body] of functions(source)) {
      if (!body.includes('queryText = `')) {
        continue;
      }

      builders += 1;

      // The list travels exactly where ownership is decided - by the tag, or the shape that
      // carries it. Passed to a query that reads no $1, PostgreSQL refuses the extra parameter.
      if (/\$\{(IS_OWN|CONTRIBUTIONS)\}/.test(body)) {
        assert.match(body, /owners\(\)/, `${name} must pass the owned-organisation list`);
      } else {
        assert.doesNotMatch(body, /owners\(\)/, `${name} passes a list it never reads`);
      }
    }

    assert.ok(builders >= 6, `only ${builders} query builders found - the 'queryText = \`' marker stopped matching`);

    // And the list it passes is the configured one. Returning an empty array here would make
    // every repository external and the split would vanish without a single test going red.
    assert.match(source, /const owners = \(\) => \[OWN_GITHUB_ORGS\];/);
  });

  test("the owned-organisation list is parsed the way the documentation promises", () => {
    // Owners, never owner/repo: the comparison is against the owner segment of a full name, so
    // a value written as "acme/widget" has to reduce to "acme" rather than never matching.
    assert.deepEqual(parseOwnGithubOrgs('Acme, acme-labs ,@acme'), ['acme', 'acme-labs']);
    assert.deepEqual(parseOwnGithubOrgs('acme/widget'), ['acme']);
    // Empty is a valid answer and the default: everything measured is then external.
    assert.deepEqual(parseOwnGithubOrgs(undefined), []);
    assert.deepEqual(parseOwnGithubOrgs(' , ,'), []);
  });
});

describe("a contribution is a pull request", () => {
  test("its commits are counted from pull requests, never from pushes", () => {
    // Both tables have a commits_count and they mean different things: commits pushed to a
    // repository, against commits contained in a pull request. Mixing them into one panel puts
    // two populations under one label, and the number that results answers no question.
    //
    // The whole file, not one read: every query here is the report, and the commit bands are
    // the one figure now that reads the column at all.
    const source = read('src/db/contributions.js');

    assert.doesNotMatch(withoutComments(source), /github_push_events/, 'the report must not read the push table');
    assert.match(fn(source, 'getMergeTimes'), /SELECT p\.commits_count,/,
      "the commit bands must read the pull request's own count");
  });
});

describe("the report reads popularity from the repository, not from the contributions", () => {
  const contributions = read('src/db/contributions.js');

  test("and it reaches it through the link, spelled once", () => {
    // One constant, interpolated by every query here. Spelled out six times it would be six
    // chances to write `r.full_name = p.dest_repo`, which is a join on a name.
    assert.match(contributions,
      /const REGISTRY = 'INNER JOIN github_repositories r ON r\.id = p\.repository_id';/);
  });

  test("no aggregate picks one snapshot out of many", () => {
    // In production the same repository carried up to seven different star counts - one per
    // contribution, each frozen at its own last poll - and max() silently returned the highest.
    // Measured on the imported data: the trophy said jdx/mise at 33,224 when the real biggest
    // was upstash/context7 at 61,407.
    //
    // Both rankings group by the repository row. The trophies rank on stars, so they must read
    // them; and every read of a star count, wherever one is added, reads the repository's own.
    for (const name of ['getTopProjects', 'getBiggestFish']) {
      const body = fn(contributions, name);

      assert.match(body, /\$\{REGISTRY\}/, `${name} must read the repository`);
      assert.match(body, /GROUP BY r\.id/, `${name} must group by the repository row, not by a name`);
    }

    assert.match(fn(contributions, 'getBiggestFish'), /stargazers_count/, 'the trophies rank on stars');

    const starred = [...functions(withoutComments(contributions))].filter(([, body]) => /\bstargazers_count\b/.test(body));

    assert.ok(starred.length > 0);

    for (const [name, body] of starred) {
      assert.match(body, /coalesce\(r\.stargazers_count, max\(p\.stargazers_count\)\)/,
        `${name} may fall back to the snapshot, but only behind the repository - and the repository's own figure needs no max(), grouping by its primary key makes it functionally dependent`);
    }
  });
});

describe("a hand-entered contribution is not chased on github.com", () => {
  // A contribution made on another forge belongs in the report and exists nowhere on GitHub.
  // Left indistinguishable from a detected one, the poll fails on it every run until the
  // backoff retires it, and the repository refresh retires a repository that was never wrong.
  const polling = read('src/db/polling.js');
  const initSql = read('init.sql');

  test("the column defaults to what every existing row is", () => {
    // NOT NULL with a default, so adding it to a live table needs no backfill and no window
    // where a row has no origin.
    assert.match(initSql, /origin VARCHAR\(16\) NOT NULL DEFAULT 'github'/);
  });

  test("the poll claims only what the bot detected", () => {
    assert.match(fn(polling, 'claimPullRequestsForPoll'), /AND pr\.origin = 'github'/);
  });

  test("the poll index carries that predicate too", () => {
    // A predicate in the query and not in the index makes the index unusable for it, and
    // nothing fails - the scan just quietly becomes sequential.
    const index = initSql.slice(initSql.indexOf('idx_pull_requests_due_for_poll'));

    assert.match(index.slice(0, index.indexOf(';')), /origin = 'github'/);
  });

  test("but the report still counts it", () => {
    // The reason it was entered in the first place. The rule is that nothing in the report may
    // FILTER on origin - it used to be enforced as "the word never appears", which was the same
    // thing while nothing read the column. The personal tab reads it now, to label a row as
    // hand-recorded, and FOLLOWED to tag what the poll still reads, so the rule is spelled the
    // way it was always meant.
    const contributions = read('src/db/contributions.js');

    for (const [name, body] of functions(contributions)) {
      if (!/\borigin\b/.test(body)) {
        continue;
      }

      assert.ok(['listContributionsForLogin', 'FOLLOWED'].includes(name),
        `${name} reads origin - only the personal list may, to label a row, and FOLLOWED, to tag one`);

      if (name === 'FOLLOWED') {
        continue;
      }

      // The SQL only, and only what comes after WHERE: selecting the column is labelling,
      // putting it in a predicate is a figure that counts one origin and drops the other.
      const sql = body.match(/queryText = `([\s\S]*?)`/)?.[1] ?? '';

      assert.ok(sql.length > 0, 'the query could not be read - has queryText been renamed?');
      assert.doesNotMatch(sql.slice(sql.search(/\bWHERE\b/)), /\borigin\b/,
        'origin may be selected, never filtered on');
    }

    // And the tag is only ever a tag: selected as `followed`, never a predicate a row can fail.
    const tagged = [...withoutComments(contributions).matchAll(/\$\{FOLLOWED\}(.{0,12})/g)].map((match) => match[1]);

    assert.ok(tagged.length >= 2, 'the ages and the oldest pull requests both say what the poll reads');
    assert.deepEqual(tagged.filter((after) => !/^ AS followed\b/.test(after)), [], 'FOLLOWED is filtered on');
  });
});

/** Let every read the page started settle, and the drawing that follows it. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Markup with its tags taken out, the way a screen reader is left with it. */
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Every chart the tab draws, by its host. */
const CHARTS = ['r-who', 'r-months', 'r-ours', 'r-elsewhere', 'r-time', 'r-commits', 'r-ages'];

/** "Sep": the month the fixture's figures are cut on, which is this one. */
const THIS_MONTH = new Date().toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });

// The reader's own rows as GET /dashboard/mine sends them, as far as this tab reads them: two
// merges on acme/widget (11), a pull request still open there, and a merge on a project that is
// not on the ranking.
const mineOfOperator = () => ({
  login: 'the-operator',
  contributions: [
    { id: 1, repositoryId: 11, merged: true, state: 'closed' },
    { id: 2, repositoryId: 11, merged: true, state: 'closed' },
    { id: 3, repositoryId: 11, merged: false, state: 'open' },
    { id: 4, repositoryId: 99, merged: true, state: 'closed' },
  ],
  now: new Date().toISOString(),
});

/**
 * Open the report's tab the way a reader does, and let its reads settle
 *
 * Through the tab bar's own click handler rather than by calling the loader: the report is
 * fetched BECAUSE the tab was activated, and that wiring is the part worth testing. An operator,
 * who opens on Operations, so nothing of this tab is drawn before the click.
 */
const openReport = async (report, { snapshot = operatorSnapshotOf(), mine = mineOfOperator() } = {}) => {
  const run = await runPage(snapshot, undefined, { report, mine });

  run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'collective' } } });
  await settle();

  return {
    ...run,
    html: (id) => run.elements.get(id)?.innerHTML ?? '',
    chart: (id) => chartIn(run, id),
    aria: (id) => run.elements.get(`${id}-canvas`)?.getAttribute('aria-label'),
    labels: (id) => plain(chartIn(run, id).data.datasets.map((dataset) => dataset.label)),
    legend: (id) => legendIn(run, id),
  };
};

/** A chip of a list, pressed the way a click reaches its delegated handler. */
const press = (run, list, facet, value) => {
  const chip = { dataset: { value }, closest: (selector) => ({ button: chip, '[data-facet]': { dataset: { facet } } })[selector] ?? null };

  run.elements.get(list).handlers.click({ target: chip });
};

const nothingAtAll = () => {
  const zero = { opened: 0, merged: 0, closedUnmerged: 0, stillOpen: 0, repositories: 0 };
  const untimed = {
    merged: 0, timed: 0, p50Seconds: null, p90Seconds: null,
    durations: { under1d: 0, days1to7: 0, days7to30: 0, over30d: 0 },
    commits: { counted: 0, one: 0, twoToThree: 0, fourToNine: 0, tenPlus: 0 },
  };
  const waiting = { open: 0, under7d: 0, days7to30: 0, days30to90: 0, over90d: 0, notFollowed: 0 };
  const fixture = reportOf();

  return reportOf({
    summary: { external: zero, own: zero, all: zero },
    bots: { byABot: 0, mergedByABot: 0 },
    mergeTimes: untimed,
    months: [],
    contributorSeries: fixture.contributorSeries.map((row) => ({ ...row, contributors: 0, firstTime: 0 })),
    contributors: { month: fixture.contributors.month, of: 0, rows: [] },
    installedAccounts: 0,
    openAges: waiting,
    projects: [],
    biggestFish: [],
    pending: [],
  });
};

describe("the contribution report", () => {
  test("is offered to both tiers", async () => {
    // It is what the enrolled population gets back for having installed the app, so gating the
    // whole thing would defeat it.
    for (const [tier, snapshot] of [
      ['operator', operatorSnapshotOf()],
      ['reader', snapshotOf()],
    ]) {
      const { html, errors } = await runPage(snapshot, undefined, { report: reportOf() });

      assert.equal(errors.length, 0, `the ${tier} page threw:\n${report(errors)}`);
      assert.match(html, /data-view="collective"/,
        `the contribution tab was withheld from a ${tier}`);
    }
  });

  test("opens on the report the server already built, for a reader with nothing of their own", async () => {
    // Somebody who never installed the app, or has not contributed yet: an empty Me would be the
    // wrong first screen, and the report the page is seeded with is the right one.
    const { elements, errors, fetched } = await runPage(snapshotOf(), undefined, { report: reportOf(), drainIntervals: false });

    await settle();

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('view-collective').hidden, false);
    assert.match(elements.get('r-tiles').innerHTML, /data-tile="merged"><dt>Merged<\/dt><dd><span class="v">6<\/span>/);
    assert.deepEqual(fetched.filter((call) => call.url === '/dashboard/contributions'), []);
  });

  test("and with the reader's own rows, so its marks cost no round trip", async () => {
    // Opening here means nothing of their own is recorded, and that answer travels in the page:
    // the tab is drawn at once, marks and all, rather than after asking /dashboard/mine.
    const mine = mineOf({ contributions: [] });
    const html = await renderPage(snapshotOf(), { mine, report: reportOf() });
    const run = await runDocument(html, snapshotOf(), undefined, { mine, report: reportOf(), drainIntervals: false });

    await settle();

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.equal(JSON.parse(/id="seed-mine">([\s\S]*?)<\/script>/.exec(html)[1]).login, mine.login);
    assert.equal(run.elements.get('view-collective').hidden, false);
    assert.equal(run.elements.get('view-collective').getAttribute('aria-busy'), 'false');
    assert.notEqual(run.elements.get('r-projects-rows')?.innerHTML ?? '', '');
    assert.deepEqual(run.fetched.filter((call) => /^\/dashboard\/(mine|contributions)$/.test(call.url)), []);
  });

  test("hides only the bars a report has nothing to divide into", () => {
    // A tripwire, one per script: something this tab starts hiding is a new element for the
    // [hidden] rule to cover. Neither starts hidden, and neither carries a class that sets display.
    assert.equal((read('views/dashboard/collective.js').match(/\.hidden = /g) ?? []).length, 2);

    for (const [id, tag] of [['r-sizes', '<div id="r-sizes">'], ['r-ages', '<div class="bar-row" id="r-ages">']]) {
      assert.ok(read('views/dashboard/collective.ejs').includes(tag), `${id} is not in the markup as it was when this was checked`);
    }
  });

  test("is fetched on activation and not on the five-second loop", async () => {
    // Ten reads of the pull request table. On the snapshot's loop this would run twelve times a
    // minute per reader, for figures that move at most every five minutes.
    const { fetched, intervals } = await openReport(reportOf());
    const before = fetched.filter((call) => call.url.startsWith('/dashboard/contributions')).length;
    const snapshots = fetched.filter((call) => call.url.startsWith('/dashboard/data')).length;

    assert.equal(before, 1, `the report was fetched ${before} times on activation`);

    // The refresh loop, run again with the tab open - which is the state that would put the
    // report on it. Draining before the tab was activated proves nothing.
    for (const { fn } of intervals) {
      await fn();
    }

    const after = fetched.filter((call) => call.url.startsWith('/dashboard/contributions')).length;

    assert.equal(after, 1, `the five-second loop fetched the report ${after - before} more time(s)`);
    // Nor the reader's own rows, which are on the same window and came with the page.
    assert.equal(fetched.filter((call) => call.url === '/dashboard/mine').length, 0);
    // And the loop does not fall back on the snapshot either: that is the Operations tab's, and
    // polled only while it is the one showing.
    const polled = fetched.filter((call) => call.url.startsWith('/dashboard/data')).length - snapshots;

    assert.equal(polled, 0, `the report's tab polled the snapshot ${polled} time(s)`);
  });

  test("draws every panel for every reader, because the report has no tier", async () => {
    // The report used to have a tier of its own. It does not: each pull request it names is
    // public on github.com, and the page it feeds is read by the population it is about.
    for (const snapshot of [operatorSnapshotOf(), snapshotOf({ viewer: 'someone-else' })]) {
      const run = await openReport(reportOf(), { snapshot, mine: null });

      assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);

      for (const id of ['r-tiles', 'r-pending-rows', 'r-fish', 'r-projects-rows', 'r-contributors']) {
        assert.notEqual(run.html(id), '', `${id} was not drawn`);
      }

      for (const id of CHARTS) {
        assert.ok(run.chart(id), `${id} was not drawn`);
      }
    }

    // Nothing in the tab starts hidden waiting for a tier that no longer exists.
    assert.doesNotMatch(read('views/dashboard/collective.ejs'), /id="r-[^"]*"[^>]*\shidden/);
  });

  test("shows every person it names by their face, through the one helper", async () => {
    // Wherever a login stands for somebody - the three biggest, the oldest waiting, this month's
    // top - their avatar is beside it, by that login; a project is nobody, and has none.
    const run = await openReport(reportOf());
    const faces = (id) => [...run.html(id).matchAll(/<img class="avatar" style="--size: (\d+)px"[^>]*src="https:\/\/avatars\.githubusercontent\.com\/([^"?]+)\?s=(\d+)"/g)]
      .map(([, size, who, fetched]) => `${who} ${size}/${fetched}`);

    assert.deepEqual(faces('r-fish').slice(0, 2), ['alice 28/56', 'bob 28/56'], 'the top three larger, fetched at twice the size');
    assert.deepEqual(faces('r-pending-rows'), ['alice 20/40', 'bob 20/40', 'carol 20/40', 'ghost 20/40']);
    assert.deepEqual(faces('r-contributors'), ['alice 24/48', 'nolongerhere 24/48']);
    assert.deepEqual(faces('r-projects-rows'), []);
    assert.match(run.html('r-fish'), /<img class="avatar"[^>]* alt="" loading="lazy" referrerpolicy="no-referrer" /);
  });
});

describe("the report's four tiles", () => {
  test("say each figure with its base", async () => {
    const run = await openReport(reportOf());
    const tiles = run.html('r-tiles').split('</div>').filter(Boolean).map(textOf);

    assert.deepEqual(tiles, [
      'Merged 6 of 7 judged 86% merge rate',
      `Contributors 2 in ${THIS_MONTH} 1 first-time 12 accounts installed`,
      // 259,200 seconds is three days; no p90 below ten timed.
      'Time to merge 3 d median',
      'Projects 5 touched 1 ours 4 elsewhere',
    ]);
    assert.match(run.html('r-tiles'), /--tint: var\(--poll\)" data-tile="merged"/);
  });

  test("and a p90 once there are enough merges to have one", async () => {
    const fixture = reportOf();
    const run = await openReport(reportOf({
      mergeTimes: { ...fixture.mergeTimes, p90Seconds: 3 * 86_400 + 7200 },
    }));

    assert.match(textOf(run.html('r-tiles')), /Time to merge 3 d median p90 3 d 2 h/);
  });

  test("with nothing to count, say zero - and a median that cannot be taken, a dash", async () => {
    const run = await openReport(nothingAtAll());
    const html = run.html('r-tiles');

    assert.equal((html.match(/class="tile zero"/g) ?? []).length, 4);
    assert.doesNotMatch(html, /class="sub"/, 'a zero has no sub-line');
    assert.match(textOf(html), /Time to merge — median/);
  });
});

describe("who is contributing", () => {
  test("is two lanes over the last eight months, the merged one dashed, the month running", async () => {
    const run = await openReport(reportOf());
    const chart = run.chart('r-who');
    const { token } = run.sandbox.Dash;

    assert.equal(run.elements.get('r-who-sub').textContent, 'Last 8 months');
    assert.equal(chart.data.labels.length, 8);
    // Two scales stacked one above the other, never two on one plot.
    assert.deepEqual(['y0', 'y1'].map((axis) => [chart.options.scales[axis].stack, chart.options.scales[axis].title.text]),
      [['lanes', 'Contributors'], ['lanes', 'Pull requests merged']]);
    assert.match(run.html('r-who'), /<div class="plot tall"/);
    // One ink for both: a lane of one series is not a scope.
    assert.deepEqual(plain(chart.data.datasets.map((dataset) => [dataset.yAxisID, dataset.borderColor, dataset.borderDash])),
      [['y0', token('ink-dim'), []], ['y1', token('ink-dim'), [6, 4]]]);
    assert.ok(chart.data.datasets.every((dataset) => dataset.pointBackgroundColor.at(-1) === token('panel')), 'the month running, open');
  });

  test("reads the merged lane off the month series, and says this month in its legend", async () => {
    const run = await openReport(reportOf());
    const chart = run.chart('r-who');
    const { callbacks } = chart.options.plugins.tooltip;
    const month = (i) => [callbacks.label({ datasetIndex: 0, dataIndex: i }), callbacks.label({ datasetIndex: 1, dataIndex: i }),
      ...callbacks.footer([{ dataIndex: i }])].join(', ');

    // Three months ago nothing merged; two months ago 1 elsewhere and 2 on ours; then 5; then 1.
    assert.equal(month(5), 'contributors 3, merged 3, 2 first-time');
    assert.equal(month(6), 'contributors 4, merged 5, 1 first-time');
    assert.match(month(7), new RegExp(`^contributors 2, merged 1, 1 first-time, to ${THIS_MONTH} \\d+$`));
    assert.match(run.aria('r-who'), new RegExp(`: contributors 2, merged 1, 1 first-time, to ${THIS_MONTH} \\d+$`));
    // First-time this month, and over the last six: each newcomer once, in their first month.
    assert.deepEqual(run.legend('r-who'), [`line contributors 2 in ${THIS_MONTH}`, `dash merged 1 in ${THIS_MONTH}`,
      `note: 1 first-time in ${THIS_MONTH}, 4 over 6 months`]);
  });

  test("with nobody in the window, is one empty state", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.chart('r-who'), undefined);
    assert.equal(run.elements.get('r-who-plot').hidden, true);
    assert.equal(run.html('r-who-none'), '<div class="nothing"><b>No pull request opened in the last 8 months.</b></div>');
  });
});

describe("month by month", () => {
  test("is four series on one scale: the hue says whose, the dash says merged", async () => {
    const run = await openReport(reportOf());
    const chart = run.chart('r-months');
    const { token } = run.sandbox.Dash;

    // Ours is the installation blue and elsewhere the teal, as on every scope mark of the page.
    // Each a flow: its total is the sum of the months drawn.
    assert.deepEqual(plain(chart.data.datasets.map((dataset) => [dataset.label, dataset.borderColor, dataset.borderDash])), [
      ['ours opened', token('sync'), []], ['ours merged', token('sync'), [6, 4]],
      ['elsewhere opened', token('poll'), []], ['elsewhere merged', token('poll'), [6, 4]],
    ]);
    assert.deepEqual(run.legend('r-months'), ['line ours opened 6', 'dash ours merged 7', 'line elsewhere opened 4', 'dash elsewhere merged 2']);
    assert.deepEqual(Object.keys(chart.options.scales), ['x', 'y0'], 'four series, one scale');
    assert.ok(chart.options.scales.y0.beginAtZero && chart.options.scales.y0.ticks.precision === 0, 'from zero, in whole ones');
    assert.equal(chart.data.labels.length, 3, 'a period per month');
    assert.match(run.elements.get('r-months-sub').textContent, /^Opened and merged since [A-Z][a-z]{2} \d{4}$/);
  });

  test("with nothing recorded, says so instead of drawing a flat line", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.chart('r-months'), undefined);
    assert.match(run.html('r-months-none'), /No pull request recorded yet\./);
    assert.equal(run.elements.get('r-months-sub').textContent, 'Opened and merged');
  });
});

describe("outcome by scope", () => {
  test("is one bar per scope, and none for the whole", async () => {
    const run = await openReport(reportOf());

    assert.equal(run.html('r-ours-head'), 'Ours <span class="base">2 pull requests, rates over 1 judged</span>');
    assert.equal(run.html('r-elsewhere-head'), 'Elsewhere <span class="base">9 pull requests, rates over 6 judged</span>');
    assert.ok(run.chart('r-ours') && run.chart('r-elsewhere'));
  });

  test("puts the rates on the verdicts, over what was judged, which the base says once", async () => {
    // Still open has no verdict: in the denominator it would read as a refusal.
    const run = await openReport(reportOf());

    assert.deepEqual(run.legend('r-elsewhere'), ['circle merged 5 83%', 'square open 3', 'triangle closed 1 17%']);
    assert.deepEqual(run.labels('r-elsewhere'), ['merged 5 (83%)', 'open 3', 'closed 1 (17%)'], 'and the tooltip says the same');
    // Ours has nothing closed: out of its bar, still in its legend, dimmed.
    assert.deepEqual(run.legend('r-ours'), ['circle merged 1 100%', 'square open 1', 'triangle closed 0 0% (dimmed)']);
    assert.deepEqual(plain(run.chart('r-ours').data.datasets[2].data), [null]);
  });

  test("says nothing of a rate while nothing has been judged", async () => {
    const fixture = reportOf();
    const run = await openReport(reportOf({
      summary: { ...fixture.summary, own: { ...fixture.summary.own, merged: 0, closedUnmerged: 0, stillOpen: 2 } },
    }));

    assert.equal(run.html('r-ours-head'), 'Ours <span class="base">2 pull requests, none judged yet</span>');
    assert.deepEqual(run.legend('r-ours'), ['circle merged 0 (dimmed)', 'square open 2', 'triangle closed 0 (dimmed)']);
  });

  test("merges what the Merged tile counts, and nothing else", async () => {
    // The tile and the two bars read the same summary: ours and elsewhere partition it.
    const run = await openReport(reportOf());
    const merged = ['r-ours', 'r-elsewhere'].map((id) => run.chart(id).data.datasets[0].data[0]);

    assert.equal(merged.reduce((sum, n) => sum + n, 0), 6);
    assert.match(run.html('r-tiles'), /<span class="v">6<\/span>/);
  });

  test("says of an empty scope that nothing was opened there", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.html('r-ours-none'), '<div class="nothing"><b>Nothing opened on ours.</b></div>');
    assert.equal(run.html('r-elsewhere-none'), '<div class="nothing"><b>Nothing opened elsewhere.</b></div>');
  });
});

describe("time to merge and size", () => {
  test("bands the merges by time and by commits, each over what could be measured", async () => {
    const run = await openReport(reportOf());
    const { token } = run.sandbox.Dash;

    assert.equal(run.html('r-time-head'), 'Time to merge <span class="base">6 of 6 merged, timed</span>');
    assert.equal(run.aria('r-time'), 'Time to merge: < 1 d 2, 1–7 d 2, 7–30 d 1, > 30 d 1');
    assert.equal(run.html('r-commits-head'), 'Commits per pull request <span class="base">5 of 6 merged, counted</span>');
    assert.equal(run.aria('r-commits'), 'Commits per pull request: 1 commit 2, 2–3 commits 2, 4–9 commits 1, 10+ commits 0');
    // Short to long, in the four band hues, and each a square: no outcome's shape.
    for (const id of ['r-time', 'r-commits']) {
      assert.deepEqual(plain(run.chart(id).data.datasets.map((dataset) => dataset.backgroundColor)), ['ok', 'poll', 'sync', 'warn'].map(token));
    }
    assert.deepEqual(run.legend('r-commits'), ['square 1 commit 2', 'square 2–3 commits 2', 'square 4–9 commits 1', 'square 10+ commits 0 (dimmed)']);
    assert.match(run.html('r-commits-legend'), /^<li style="--key: var\(--ok\)">/, 'each key in its band\'s hue');
  });

  test("with no merge, is one empty state rather than two", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.html('r-sizes-none'), '<div class="nothing"><b>No merged pull request yet.</b></div>');
    assert.equal(run.elements.get('r-sizes').hidden, true);
    assert.deepEqual([run.chart('r-time'), run.chart('r-commits')], [undefined, undefined]);
  });
});

describe("awaiting a verdict", () => {
  test("bands everything open by age, and counts what nobody polls in the base, never as a band", async () => {
    const run = await openReport(reportOf());

    assert.equal(run.elements.get('r-pending-sub').textContent, '4 open, oldest first');
    // The count is the panel's line: the base says only what is not polled.
    assert.equal(run.html('r-ages-head'), 'Age <span class="base">1 no longer polled</span>');
    assert.equal(run.aria('r-ages'), 'Age: < 7 d 1, 7–30 d 0, 30–90 d 1, > 90 d 2');
    assert.equal(run.chart('r-ages').data.datasets.length, 4, 'four bands and nothing else');
    assert.equal(run.elements.get('r-ages').hidden, false);
  });

  test("with nothing open, has no bar: the list says so, once", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.elements.get('r-ages').hidden, true);
    assert.equal(run.chart('r-ages'), undefined);
    assert.match(run.html('r-pending-none'), /No pull request is waiting for a verdict\./);
  });

  test("then lists the oldest, each with its repository, its author and how long it has waited", async () => {
    const run = await openReport(reportOf());
    const rows = run.html('r-pending-rows').split('</li>').filter(Boolean);

    assert.equal(rows.length, 4);
    assert.match(rows[0], /<a class="name" href="https:\/\/github\.com\/kubernetes\/kubernetes\/pull\/3"[^>]*>document the flags<\/a>/);
    // A box per fragment, set apart by the line's gap: a narrow row breaks between two of them.
    assert.match(rows[0], /<span class="meta"><span>kubernetes\/kubernetes #3<\/span> <span><img class="avatar"[^>]*>alice<\/span><\/span><\/span><span class="score">200\u00a0d<\/span>/);
    // The author nobody polls any more: said on the row, in words.
    assert.match(rows[1], /<span>hashicorp\/terraform #14<\/span> <span><img class="avatar"[^>]*>bob<\/span> <span>no longer polled<\/span>/);
    assert.equal((run.html('r-pending-rows').match(/no longer polled/g) ?? []).length, 1);
    // The badge on our own repository, and on nothing else.
    assert.match(rows[3], /<span class="meta"><span><img class="own-badge"[^>]*>acme\/widget #18<\/span> <span><img class="avatar"[^>]*>ghost<\/span><\/span>/);
    assert.equal((run.html('r-pending-rows').match(/own-badge/g) ?? []).length, 1);
    assert.equal(run.elements.get('r-pending-count').textContent, '4 of 4 pull requests match.');
  });

  test("filters the oldest by scope, and keeps the choice across refreshes", async () => {
    const run = await openReport(reportOf());

    assert.match(run.html('r-pending-tools'), /data-value="ours" [^>]*>ours <b>1<\/b>.*data-value="else" [^>]*>elsewhere <b>3<\/b>/);

    press(run, 'r-pending', 'scope', 'else');

    const refresh = run.intervals.find((interval) => interval.ms === 5000).fn;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await refresh();
    }

    assert.equal(run.elements.get('r-pending-count').textContent, '3 of 4 pull requests match.');
    assert.match(run.html('r-pending-tools'), /aria-pressed="true" data-value="else"/);
  });

  test("with nothing open, says so once", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.html('r-ages'), '');
    assert.equal(run.html('r-pending-none'), '<div class="nothing"><b>No pull request is waiting for a verdict.</b></div>');
    assert.equal(run.html('r-pending-tools'), '');
  });
});

describe("the biggest ones we got into", () => {
  test("are ranked, the first set larger, with who got something in", async () => {
    const html = (await openReport(reportOf())).html('r-fish');
    const rows = html.split('</li>').filter((row) => row.includes('<li'));

    assert.match(html, /^<ol class="rank fish">/);
    assert.equal(rows.length, 2);
    // Keyed by the project, so a redraw gives focus back to the link a keyboard was on.
    assert.match(rows[0], /<li data-focus-key="fish:21"><span class="place">1<\/span><span class="grow"><span class="repo"><a href="https:\/\/github\.com\/kubernetes\/kubernetes"/);
    // The stars are the meta line's, not a display figure of their own.
    assert.match(rows[0], /<span class="meta"><span><b class="stars">108,000<\/b> stars<\/span> <span>4 merged<\/span> <span>first in Apr 2026<\/span><\/span>/);
    assert.match(rows[1], /first in Nov 2025/);
    // Everyone, not the first of them: the panel exists to say who.
    assert.equal((rows[0].match(/class="face"/g) ?? []).length, 2);
    assert.match(rows[0], /<span class="face"><img class="avatar" style="--size: 28px"[^>]*src="https:\/\/avatars\.githubusercontent\.com\/alice\?s=56"><b>alice<\/b><small>×3<\/small><\/span>/);
  });

  test("count a person once across the three, whatever the case of their login", async () => {
    const html = (await openReport(reportOf())).html('r-fish');

    assert.match(html, /<p class="table-count">3 people, 6 pull requests merged across these 2 projects<\/p>$/);
  });

  test("name a project with no address of its own, rather than link one built from its name", async () => {
    // The refresh stores the address; a project it has not read yet, or never can - one on
    // another forge - has none, and github.com/{name} would be a guess.
    const fixture = reportOf();
    const unread = (project) => ({ ...project, repo: 'gitlab-org/gitlab', url: null });
    const run = await openReport(reportOf({
      biggestFish: [unread(fixture.biggestFish[0])],
      projects: [unread(fixture.projects[0])],
    }));

    assert.match(run.html('r-fish'), /<span class="repo">gitlab-org\/gitlab<\/span>/);
    assert.match(run.html('r-projects-rows'), /<span class="name">gitlab-org\/gitlab<\/span>/);
    assert.doesNotMatch(run.html('r-fish') + run.html('r-projects-rows'), /<a /);
  });

  test("say so when nothing has been merged outside ours", async () => {
    assert.equal((await openReport(nothingAtAll())).html('r-fish'),
      '<div class="nothing"><b>No pull request merged outside ours yet.</b></div>');
  });
});

describe("the most contributed projects", () => {
  test("are the top of every project with a merge, each with its stars, its people and how its pull requests went", async () => {
    const run = await openReport(reportOf(), { mine: null });
    const rows = run.html('r-projects-rows').split('</li>').filter(Boolean);

    assert.equal(run.elements.get('r-projects-sub').textContent, 'Top 2 of 7, on merged pull requests');
    assert.match(rows[0], /<span class="meta"><span>112,004 stars<\/span> <span>2 of us<\/span><\/span><\/span>/);
    // Production's three counts, merged, still open and closed without a merge, in that order,
    // each named by its pictogram and a zero faded.
    assert.match(rows[0], new RegExp('<span class="score gits"><span class="git merged" title="4 merged"><svg viewBox="0 0 12 12" role="img" aria-label="merged">'
      + '<path d="M5 3\\.5[^"]*"/></svg><b>4</b></span><span class="git open" title="1 still open">[\\s\\S]*?<b>1</b></span>'
      + '<span class="git closed zero" title="0 closed without a merge">[\\s\\S]*?<b>0</b></span></span>$'));
    // A project no refresh has read yet has no star count to give, and says nothing of one.
    assert.match(rows[1], /<span class="meta"><span>1 of us<\/span><\/span>/);
    assert.match(rows[1], /<span class="git closed" title="2 closed without a merge">/);
    assert.match(rows[1], /<span class="name"><img class="own-badge"[^>]*><a href="https:\/\/github\.com\/acme\/widget"/);
    assert.match(run.html('r-projects-tools'), /data-facet="scope"/);
  });

  test("mark the reader's own, from their merges there", async () => {
    // Two merges on acme/widget, one pull request still open there, and a merge on a project
    // that is not ranked: only the merges on a ranked project count.
    const rows = (await openReport(reportOf())).html('r-projects-rows').split('</li>').filter(Boolean);

    assert.match(rows[1], /<span class="grow yours">/);
    assert.match(rows[1], /<span class="chip">you<\/span><span class="meta"><span>1 of us<\/span> <span>2 yours<\/span><\/span>/);
    assert.doesNotMatch(rows[0], /yours|class="chip"/);
  });

  test("are drawn once both reads are in, and unmarked when the reader's own cannot be read", async () => {
    // A page opened without the reader's own rows, which the tab then waits on.
    const run = await runDocument(await renderPage(operatorSnapshotOf(), { report: reportOf() }), operatorSnapshotOf(), undefined,
      { report: reportOf(), mine: mineOfOperator(), drainIntervals: false });
    const answer = run.sandbox.fetch;
    let release = null;

    run.sandbox.fetch = (url, options) => (url === '/dashboard/mine'
      ? new Promise((resolve) => { release = () => resolve(answer(url, options)); })
      : answer(url, options));
    run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'collective' } } });
    await settle();

    assert.equal(run.elements.get('r-projects-rows'), undefined, 'drawn before the reader\'s own rows were in');
    assert.equal(run.elements.get('view-collective').getAttribute('aria-busy'), 'true', 'waiting, and not saying so');

    release();
    await settle();

    assert.match(run.elements.get('r-projects-rows').innerHTML, /class="grow yours"/);
    assert.equal(run.elements.get('view-collective').getAttribute('aria-busy'), 'false');

    const unread = await openReport(reportOf(), { mine: null });

    assert.equal(unread.errors.length, 0);
    assert.doesNotMatch(unread.html('r-projects-rows'), /yours|class="chip"/);
    assert.notEqual(unread.html('r-tiles'), '', 'the report is drawn all the same');
  });

  test("and keep them from the reader's last good read when a later one fails", async () => {
    // As the report itself does: a flaky read must not blink the marks off and on every refresh.
    const snapshot = operatorSnapshotOf({}, { limits: { ...operatorSnapshotOf().limits, reportTtlMs: 0 } });
    const run = await openReport(reportOf(), { snapshot });
    const answer = run.sandbox.fetch;
    let failed = 0;

    assert.match(run.html('r-projects-rows'), /class="grow yours"/);

    // Every read is a new one, the window being zero, and each of the reader's own now fails.
    run.sandbox.fetch = (url, options) => {
      if (url !== '/dashboard/mine') return answer(url, options);

      failed += 1;

      return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'could not be read' }) });
    };

    const refresh = run.intervals.find((interval) => interval.ms === 5000).fn;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await refresh();
      await settle();
    }

    assert.ok(failed > 0, "the reader's own rows were never read again");
    assert.match(run.html('r-projects-rows'), /<span class="grow yours">/);
    assert.match(run.html('r-projects-rows'), /<span>2 yours<\/span>/);
  });

  test("say so when nothing has been merged", async () => {
    const run = await openReport(nothingAtAll());

    assert.equal(run.html('r-projects-none'), '<div class="nothing"><b>No merged pull request yet.</b></div>');
    assert.equal(run.elements.get('r-projects-sub').textContent, 'On merged pull requests');
  });
});

describe("this month's contributors", () => {
  test("are the top of the month on what they opened, each split ours and elsewhere by its glyph", async () => {
    const run = await openReport(reportOf());
    const html = run.html('r-contributors');

    assert.equal(run.elements.get('r-contributors-sub').textContent, `All 2, on pull requests opened in ${THIS_MONTH}`);
    assert.match(html, /^<ol class="rank"><li><img class="avatar" style="--size: 24px"[^>]*\/alice\?s=48"><span class="grow"><span class="name">alice<\/span>/);
    assert.match(html, new RegExp(`<span class="meta"><span>3 opened in ${THIS_MONTH}</span></span>`));
    assert.match(html, /<span class="score scopes"><span class="scope-mark"><img src="\/images\/company_logo\.svg" alt="ours"><b>1<\/b><\/span>/);
    // nolongerhere has nothing on ours: that half recedes rather than sitting level.
    assert.match(html, /<span class="scope-mark zero"><img src="\/images\/company_logo\.svg" alt="ours"><b>0<\/b><\/span>/);
  });

  test("mark the reader's own row, and never add one for them", async () => {
    const fixture = reportOf();
    const four = { ...fixture.contributors, of: 9, rows: ['alice', 'bob', 'carol', 'dave'].map((login) => ({ login, opened: 2, ours: 1, elsewhere: 1 })) };
    const alice = await openReport(reportOf({ contributors: four }), { snapshot: snapshotOf({ viewer: 'Alice' }), mine: null });

    assert.match(alice.html('r-contributors'),
      /^<ol class="rank"><li class="yours"><img class="avatar"[^>]*><span class="grow"><span class="name">alice<\/span><span class="chip">you<\/span>/);
    assert.equal(alice.elements.get('r-contributors-sub').textContent, `Top 4 of 9, on pull requests opened in ${THIS_MONTH}`);

    const other = await openReport(reportOf({ contributors: four }), { snapshot: snapshotOf({ viewer: 'zed' }), mine: null });

    assert.equal((other.html('r-contributors').match(/<li/g) ?? []).length, 4, 'a fifth row would name the reader');
    assert.doesNotMatch(other.html('r-contributors'), /yours|class="chip"/);
  });

  test("say so when nobody has opened anything this month", async () => {
    assert.equal((await openReport(nothingAtAll())).html('r-contributors'),
      `<div class="nothing"><b>No pull request opened in ${THIS_MONTH} yet.</b></div>`);
  });
});

describe("the report's tab before and without its report", () => {
  test("draws nothing, empty or not, while the report is still being read", async () => {
    const run = await runPage(operatorSnapshotOf(), undefined, { mine: mineOfOperator(), drainIntervals: false });
    const answer = run.sandbox.fetch;

    // A read of the report that never answers: waiting is not the same as empty.
    run.sandbox.fetch = (url, options) => (url === '/dashboard/contributions' ? new Promise(() => {}) : answer(url, options));
    run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'collective' } } });
    await settle();

    assert.equal(run.elements.get('view-collective').getAttribute('aria-busy'), 'true');

    for (const id of ['r-tiles', ...CHARTS, 'r-sizes-none', 'r-pending', 'r-fish', 'r-projects', 'r-contributors']) {
      assert.equal(run.elements.get(id)?.innerHTML ?? '', '', `${id} was drawn before there was anything to draw`);
    }
  });

  test("and when it could not be read, leaves the panels to the notice", async () => {
    const run = await runPage(snapshotOf(), undefined, { report: null });

    await settle();

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.equal(run.elements.get('r-tiles')?.innerHTML ?? '', '');
    assert.match(run.elements.get('notice').innerHTML, /Could not read the contribution report\./);
  });

  test("but draws what it last read when a later read fails", async () => {
    const stale = snapshotOf({ limits: { ...snapshotOf().limits, reportTtlMs: 0 } });
    // Seeded, then asked again at once - the window is zero - and that read fails.
    const run = await runDocument(await renderPage(stale, { report: reportOf() }), stale, undefined, { report: null });

    await settle();

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.match(run.elements.get('r-tiles').innerHTML, /<span class="v">6<\/span>/);
    assert.match(run.elements.get('notice').innerHTML, /showing the last successful read/);
  });
});
