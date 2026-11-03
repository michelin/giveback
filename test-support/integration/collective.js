import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { hydrated } from "./context.js";

const DAY = 86_400_000;

/** An instant `days` before now, as the hydration payload spells it. */
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

/** The 10th, at noon in UTC, k calendar months before this one: never the first instant of a month. */
const monthsAgo = (k) => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 10, 12)).toISOString();
};

// The one owner the report's "ours" branch is exercised with. Nothing else under test is ours:
// acme, which the rest of the suite writes to, stays elsewhere.
const OURS = 'our-org';

/** The contribution report, against real SQL. */
export const register = ({ db, rowsOf, oneRow, enrol }) => {
  /**
   * A pull request on a repository of its own, as the sync writes one
   * @param {string} fullName - The repository, `owner/name`
   * @param {Object} overrides - The hydration payload's fields, and `stars` for the repository's
   * @returns {Promise<number>} The repository's row
   */
  const on = async (fullName, { stars = 10, ...overrides } = {}) => {
    // A github id per name, stable across calls, so a second pull request lands on the same row.
    const githubId = 10_000 + [...fullName].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    const { id } = await db.repositories.ensureRepository(fullName, githubId);

    await db.pullRequests.upsertPullRequest(
      hydrated({ ...overrides, base: { ref: 'main', repo: { full_name: fullName, stargazers_count: stars } } }),
      id
    );

    return id;
  };

  describe("a bot's pull request", () => {
    // The report counts what a PERSON opened. Asserted against real SQL rather than on the
    // source text, because the source-text guard can only see that the predicate is spelt
    // somewhere in the query - not that PostgreSQL drops the row.
    //
    // Kept in the table on purpose: what a bot opened and a person merged is real maintenance
    // work, and it can only become a figure later if the row is still there.
    const dependabot = { id: 6001, number: 9, user: { login: 'dependabot[bot]', type: 'Bot' } };

    test("is stored, and counted by no figure the report publishes", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.pullRequests.upsertPullRequest(hydrated(), id);
      await db.pullRequests.upsertPullRequest(
        hydrated({ ...dependabot, merged: true, merged_at: '2026-01-03T10:00:00.000Z', state: 'closed' }),
        id
      );

      assert.equal(
        (await oneRow(`SELECT count(*)::int AS n FROM github_pull_requests`)).n,
        2,
        'the row is kept - this is a narrowing of what is read, never of what is stored'
      );

      // Counted once, by the one read that exists to say how much the report leaves out.
      assert.deepEqual(await db.contributions.getContributionTotals(), { byABot: 1, mergedByABot: 1 });

      // The report, by contrast, counts only what a person opened.
      assert.equal((await db.contributions.getContributionSummary()).all.opened, 1,
        "the bot's pull request is not a contribution");

      const summary = await db.contributions.getContributionSummary();

      assert.equal(summary.external.opened + summary.own.opened, 1);

      const pending = await db.contributions.listPendingPullRequests();

      assert.deepEqual(pending.map((pr) => pr.login), ['octocat'], 'awaiting a verdict counts people');
      assert.equal((await db.contributions.getOpenAges()).open, 1);
    });

    test("does not put a bot on the leaderboard or in the per-account columns", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await enrol('octocat', { userId: 1, installationId: 101 });
      await db.pullRequests.upsertPullRequest(
        hydrated({ merged: true, merged_at: new Date().toISOString(), state: 'closed' }),
        id
      );
      await db.pullRequests.upsertPullRequest(
        hydrated({ ...dependabot, merged: true, merged_at: new Date().toISOString(), state: 'closed' }),
        id
      );

      assert.deepEqual(
        (await db.contributions.getTopContributors()).map((who) => who.login),
        ['octocat']
      );

      const octocat = (await db.dashboard.listUsers()).find((user) => user.login === 'octocat');

      assert.equal(octocat.merged, 1, "the bot's merge must not be added to a person's row");
    });
  });

  describe("the months of the report", () => {
    test("are cut in UTC, the calendar the page names them in, whatever the session's zone", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      // Half an hour before this month began in UTC is already this month in Paris, the zone
      // this run's sessions are in: the page labels it last month, so last month is where it is
      // counted. Relative to now, so the month stays inside the series' window on any date.
      const now = new Date();
      const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 30 * 60_000);
      const key = (at) => at.toISOString().slice(0, 7);

      await db.pullRequests.upsertPullRequest(hydrated({ id: 7101, created_at: before.toISOString() }), id);

      const months = await db.contributions.getMonthlySeries();

      assert.equal(months.find((row) => row.month === key(before))?.opened, 1);
      assert.equal(months.find((row) => row.month === key(now))?.opened, 0);

      // And so are the months of who contributed.
      const people = await db.contributions.getContributorSeries();

      assert.equal(people.find((row) => row.month === key(before))?.contributors, 1);
      assert.equal(people.at(-1).contributors, 0);
    });
  });

  describe("the composition of what was collected", () => {
    // The invariant that makes each scope drawable as a bar: the three outcomes partition the
    // base exactly, and the two scopes partition the whole - which is what lets the Merged tile
    // count exactly what the two bars under it merged. A segment missing from a partition is a
    // bar that does not fill its track, and nothing on the page would say which slice went.
    test("each bar adds up to its own base", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.pullRequests.upsertPullRequest(
        hydrated({ id: 7001, merged: true, merged_at: '2026-02-01T00:00:00.000Z', state: 'closed' }), id);
      await db.pullRequests.upsertPullRequest(
        hydrated({ id: 7002, merged: false, state: 'closed', closed_at: '2026-02-02T00:00:00.000Z' }), id);
      await db.pullRequests.upsertPullRequest(hydrated({ id: 7003, state: 'open' }), id);
      // A bot's, merged - and no bar here may see it.
      await db.pullRequests.upsertPullRequest(
        hydrated({ id: 7004, user: { login: 'dependabot[bot]', type: 'Bot' },
          merged: true, merged_at: '2026-02-03T00:00:00.000Z', state: 'closed' }), id);

      const { all, own, external } = await db.contributions.getContributionSummary();

      assert.equal(all.opened, 3, 'the bot must be out of every facet');
      assert.equal(all.merged, 1);

      for (const [name, half] of [['all', all], ['own', own], ['external', external]]) {
        assert.equal(
          half.merged + half.stillOpen + half.closedUnmerged,
          half.opened,
          `the three outcomes must partition ${name}, or its bar has a hole in it`
        );
      }

      assert.equal(own.opened + external.opened, all.opened);
      assert.equal(own.merged + external.merged, all.merged);
    });

    test("an empty table answers zeroes rather than dividing by nothing", async () => {
      const { all } = await db.contributions.getContributionSummary();

      assert.equal(all.opened, 0);
      assert.equal(all.merged, 0);
    });
  });

  describe("the reads of the Overall tab", () => {
    // OWN_GITHUB_ORGS is parsed when constants.js is first imported - statically, by this suite,
    // before any environment could be set - and every query reads the parsed list when it runs.
    // So the list is extended for these tests, and put back after them.
    let owned;

    before(async () => {
      ({ OWN_GITHUB_ORGS: owned } = await import("../../src/utils/constants.js"));
      owned.push(OURS);
    });

    after(() => {
      owned.splice(owned.indexOf(OURS), 1);
    });

    test("ours and elsewhere, told apart by every read that splits them", async () => {
      // Relative to now, so all three land in this month: the series' last row, whatever the date.
      const now = new Date().toISOString();

      await on(`${OURS}/tool`, { id: 9601, number: 1, created_at: now, state: 'closed', merged: true, merged_at: now });
      await on(`${OURS}/tool`, { id: 9602, number: 2, created_at: now });
      await on('acme/widget', { id: 9603, number: 3, created_at: now });

      // The hues of Month by month: a swap of the two FILTERs would draw ours as elsewhere.
      assert.deepEqual({ ...(await db.contributions.getMonthlySeries()).at(-1) },
        { month: now.slice(0, 7), opened: 1, merged: 0, ownOpened: 2, ownMerged: 1 });

      // The Ours bar of Outcome by scope, and the partition the Merged tile relies on.
      const { all, own, external } = await db.contributions.getContributionSummary();

      assert.deepEqual({ ...own }, { opened: 2, merged: 1, closedUnmerged: 0, stillOpen: 1, repositories: 1 });
      assert.equal(external.opened, 1);
      assert.equal(own.opened + external.opened, all.opened);
      assert.equal(own.merged + external.merged, all.merged);

      // The badge on the oldest waiting, and the scope facet that filters on it.
      const pending = await db.contributions.listPendingPullRequests();

      assert.deepEqual(Object.fromEntries(pending.map((pr) => [pr.number, pr.own])), { 2: true, 3: false });
    });

    test("who is contributing: eight months to this one, a person once a month, a newcomer once", async () => {
      await on('acme/widget', { id: 9001, number: 1, user: { login: 'Octocat', type: 'User' }, created_at: monthsAgo(2) });
      // The same person, spelled otherwise: one contributor this month, and not a newcomer.
      await on('acme/widget', { id: 9002, number: 2, user: { login: 'octocat', type: 'User' }, created_at: new Date().toISOString() });
      await on(`${OURS}/tool`, { id: 9003, number: 3, user: { login: 'octocat', type: 'User' }, created_at: new Date().toISOString() });
      await on('acme/widget', { id: 9004, number: 4, user: { login: 'hubot', type: 'User' }, created_at: new Date().toISOString() });
      // Somebody whose first pull request is older than the window: active, never new in it.
      await on('acme/widget', { id: 9005, number: 5, user: { login: 'old-timer', type: 'User' }, created_at: monthsAgo(14) });
      await on('acme/widget', { id: 9006, number: 6, user: { login: 'old-timer', type: 'User' }, created_at: monthsAgo(1) });
      await on('acme/widget', { id: 9007, number: 7, user: { login: 'renovate[bot]', type: 'Bot' }, created_at: new Date().toISOString() });

      const series = await db.contributions.getContributorSeries();

      assert.equal(series.length, 8);
      assert.equal(series.at(-1).month, new Date().toISOString().slice(0, 7), 'this month last');
      assert.deepEqual(series.slice(-3).map(({ contributors, firstTime }) => [contributors, firstTime]),
        [[1, 1], [1, 0], [2, 1]], 'octocat new two months ago, old-timer active last month, hubot new this one');
      assert.equal(series.slice(0, -3).reduce((sum, row) => sum + row.contributors, 0), 0, 'a quiet month is a zero, not a gap');
      assert.equal((await db.contributions.getContributorSeries(3)).length, 3);
    });

    test("the ages of what is open, and what the poll no longer reads, are the poll's own", async () => {
      await enrol('octocat', { userId: 1, installationId: 101 });
      await enrol('suspended-one', { userId: 2, installationId: 102 });
      await rowsOf(`UPDATE github_installations SET installation_suspended = true WHERE user_login = 'suspended-one'`);

      await on('acme/widget', { id: 9101, number: 1, created_at: ago(2) });
      await on('acme/widget', { id: 9102, number: 2, created_at: ago(20) });
      await on('acme/widget', { id: 9103, number: 3, created_at: ago(60) });
      await on(`${OURS}/tool`, { id: 9104, number: 4, created_at: ago(120) });
      // Its author suspended, and one who never installed: neither is polled any more.
      await on('acme/widget', { id: 9105, number: 5, created_at: ago(10), user: { login: 'suspended-one', type: 'User' } });
      await on('acme/widget', { id: 9106, number: 6, created_at: ago(200), user: { login: 'nobody-here', type: 'User' } });
      // Enrolled as octocat, opened as Octocat: the claim joins on the exact login, so the poll
      // never reads it - and the page must not say it does.
      await on('acme/widget', { id: 9109, number: 9, created_at: ago(15), user: { login: 'Octocat', type: 'User' } });
      // Closed, so not waiting; a bot's, so not a person's.
      await on('acme/widget', { id: 9107, number: 7, created_at: ago(5), state: 'closed', closed_at: ago(1) });
      await on('acme/widget', { id: 9108, number: 8, created_at: ago(5), user: { login: 'renovate[bot]', type: 'Bot' } });

      const all = await db.contributions.getOpenAges();

      assert.deepEqual({ ...all }, { open: 7, under7d: 1, days7to30: 3, days30to90: 1, over90d: 2, notFollowed: 3 });

      // What the page says is polled is exactly what the poll claims.
      const followed = (await db.contributions.listPendingPullRequests(20)).filter((pr) => pr.followed).map((pr) => pr.number);
      const claimed = (await db.polling.claimPullRequestsForPoll()).map((pr) => pr.number);

      assert.deepEqual(followed.sort(), claimed.sort());
      assert.equal(followed.length, all.open - all.notFollowed);
    });

    test("the oldest waiting are ten at most, oldest first, each once whatever the installations say", async () => {
      // Two installations for one login: user_login is not unique, and a join on it would list
      // the pull request twice.
      await enrol('octocat', { userId: 1, installationId: 101 });
      await enrol('octocat', { userId: 3, installationId: 103 });

      for (let i = 0; i < 12; i += 1) {
        await on('acme/widget', { id: 9200 + i, number: 100 + i, created_at: ago(30 - i) });
      }

      const pending = await db.contributions.listPendingPullRequests();

      assert.equal(pending.length, 10);
      assert.deepEqual(pending.map((pr) => pr.number), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
      assert.ok(pending.every((pr) => pr.followed && pr.openedAt instanceof Date && pr.url.startsWith('https://github.com/')));
    });

    test("the biggest ones we got into: the three most starred outside ours, with each person once", async () => {
      const merged = (id, when, login = 'octocat') => ({
        id, number: id, state: 'closed', merged: true, merged_at: when, created_at: when, user: { login, type: 'User' },
      });

      const first = ago(40);

      await on('big/four', { stars: 400, ...merged(9301, first, 'Octocat') });
      await on('big/four', { stars: 400, ...merged(9302, ago(10), 'octocat') });
      await on('big/four', { stars: 400, ...merged(9303, ago(20), 'hubot') });
      await on('big/three', { stars: 300, ...merged(9304, ago(30)) });
      await on('big/two', { stars: 200, ...merged(9305, ago(30)) });
      await on('big/one', { stars: 100, ...merged(9306, ago(30)) });
      // Ours, however famous: a trophy for maintaining ourselves is not one.
      await on(`${OURS}/famous`, { stars: 1_000_000, ...merged(9307, ago(30)) });
      // Famous and only proposed: an intention, not a trophy.
      await on('big/open', { stars: 999, id: 9308, number: 9308, created_at: ago(3) });
      // The address a refresh stores; the other two have not been refreshed.
      await rowsOf(`UPDATE github_repositories SET html_url = 'https://github.com/big/four' WHERE full_name = 'big/four'`);

      const fish = await db.contributions.getBiggestFish();

      assert.deepEqual(fish.map((project) => [project.repo, project.url, project.stars, project.merged]),
        [['big/four', 'https://github.com/big/four', 400, 3], ['big/three', null, 300, 1], ['big/two', null, 200, 1]]);
      assert.deepEqual(fish[0].contributors.map((who) => [who.login, who.merged]), [['octocat', 2], ['hubot', 1]],
        'one octocat, under the spelling of their newest pull request');
      assert.ok(fish[0].firstMergedAt instanceof Date);
      assert.equal(fish[0].firstMergedAt.toISOString(), first);
      assert.equal(typeof fish[0].repositoryId, 'number');
    });

    test("the most contributed projects: the top of every one with a merge, each person once, with how the rest went", async () => {
      const merged = (id, login = 'octocat') => ({
        id, number: id, state: 'closed', merged: true, merged_at: ago(3), created_at: ago(5), user: { login, type: 'User' },
      });

      await on(`${OURS}/tool`, merged(9401));
      await on(`${OURS}/tool`, merged(9402));
      await on(`${OURS}/tool`, merged(9403, 'hubot'));
      await on('acme/widget', merged(9404, 'Octocat'));
      await on('acme/widget', merged(9405, 'octocat'));
      await on('acme/widget', { id: 9406, number: 9406, created_at: ago(2) });
      // Closed without a merge: neither merged nor still open.
      await on('acme/widget', { id: 9409, number: 9409, state: 'closed', merged: false, created_at: ago(4) });
      await on('lonely/one', { stars: 77, ...merged(9407) });
      // Nothing merged: not on a ranking of merges.
      await on('only/open', { id: 9408, number: 9408, created_at: ago(2) });
      // A refresh has read this one: its star count is today's, whatever the pull requests froze.
      await rowsOf(`UPDATE github_repositories SET html_url = 'https://github.com/acme/widget', stargazers_count = 4321 WHERE full_name = 'acme/widget'`);

      const projects = await db.contributions.getTopProjects();

      assert.deepEqual(projects.map(({ repo, url, own, merged: count, people, of }) => [repo, url, own, count, people, of]), [
        [`${OURS}/tool`, null, true, 3, 2, 3],
        ['acme/widget', 'https://github.com/acme/widget', false, 2, 1, 3],
        ['lonely/one', null, false, 1, 1, 3],
      ]);
      assert.deepEqual(projects.map(({ repo, stars, stillOpen, closedUnmerged }) => [repo, stars, stillOpen, closedUnmerged]), [
        [`${OURS}/tool`, 10, 0, 0],
        ['acme/widget', 4321, 1, 1],
        ['lonely/one', 77, 0, 0],
      ], 'the snapshot on the pull request only until a refresh has read the repository');

      const top = await db.contributions.getTopProjects(1);

      assert.equal(top.length, 1);
      assert.equal(top[0].of, 3, 'every project with a merge, not the ones shown');
    });

    test("and the report puts them together: one count of this month's people, and the accounts installed", async () => {
      // A module of its own, by its address: another test's report may be cached a moment ago.
      const { getReport } = await import("../../src/services/dashboardReport.js?collective");

      await enrol('octocat', { userId: 1, installationId: 101 });
      await enrol('hubot', { userId: 2, installationId: 102 });
      await db.installations.insertPendingInstallation({ id: 3, login: 'not-yet' }, 103);
      await on('acme/widget', { id: 9501, number: 1, created_at: new Date().toISOString() });
      await on('acme/widget', { id: 9502, number: 2, created_at: new Date().toISOString(), user: { login: 'hubot', type: 'User' } });

      const report = JSON.parse(JSON.stringify(await getReport()));

      // The Contributors tile, the list of the month and the reader's monthly rank all count the
      // same people: whoever opened something this month.
      assert.equal(report.contributorSeries.at(-1).contributors, report.contributors.of);
      assert.equal(report.contributors.of, 2);
      assert.equal(report.installedAccounts, (await db.installations.countInstallationStates()).active);
      assert.equal(report.installedAccounts, 2);
      assert.equal(report.openAges.open, report.summary.all.stillOpen);
    });

    test("and an empty table answers every read without dividing by nothing", async () => {
      assert.equal((await db.contributions.getContributorSeries()).length, 8);
      assert.deepEqual({ ...(await db.contributions.getOpenAges()) },
        { open: 0, under7d: 0, days7to30: 0, days30to90: 0, over90d: 0, notFollowed: 0 });
      assert.deepEqual(await db.contributions.getBiggestFish(), []);
      assert.deepEqual(await db.contributions.getTopProjects(), []);
      assert.deepEqual(await db.contributions.listPendingPullRequests(), []);
    });
  });
};
