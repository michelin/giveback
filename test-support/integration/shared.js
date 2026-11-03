import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hydrated } from "./context.js";
import { percentile } from "../../src/utils/percentile.js";

// The reads that need an argument to be a read at all, and the two named otherwise.
const ARGUMENTS = {
  'installations.isEnrolledUser': ['octocat'],
  'installations.forceSyncNow': [1],
  'contributions.listContributionsForLogin': ['octocat'],
};

const READ = /^(get|list|count|summarise|measure)[A-Z]/;

/** What the dashboard's tiles, footnote and ranks share, against real SQL. */
export const register = ({ db, oneRow, contribute }) => {
  describe("every read-only query", () => {
    // A SELECT is parsed whether or not it matches a row, so calling each of these against the
    // empty schema costs one round trip and catches exactly what no source-text assertion can:
    // a column renamed in init.sql, a table dropped, a $n index that no longer lines up.
    //
    // Found rather than listed, by the names reads are given, and called with their defaults: a
    // read added to src/db/ is parsed here without anybody remembering to add it.
    const reads = () => [
      ...Object.entries(db)
        .filter(([, exports]) => exports && typeof exports === 'object')
        .flatMap(([area, exports]) => Object.entries(exports)
          .filter(([name, value]) => typeof value === 'function' && READ.test(name))
          .map(([name, read]) => [`${area}.${name}`, read])),
      ['installations.isEnrolledUser', db.installations.isEnrolledUser],
      ['installations.forceSyncNow', db.installations.forceSyncNow],
    ].map(([name, read]) => [name, () => read(...(ARGUMENTS[name] ?? []))]);

    test("parses against the schema init.sql describes", async () => {
      const found = reads();
      const broken = [];

      // One in every module that has reads, rather than a count: a count is broken by every read
      // deleted on purpose, and this only by the naming no longer matching.
      for (const area of ['contributions', 'dashboard', 'jobRuns', 'installations', 'pullRequests']) {
        assert.ok(found.some(([name]) => name.startsWith(`${area}.`)), `no read found in db.${area} - the naming stopped matching`);
      }

      for (const [name, read] of found) {
        try {
          await read();
        } catch (error) {
          broken.push(`${name}: ${error.cause?.message ?? error.message}`);
        }
      }

      assert.deepEqual(broken, [], `PostgreSQL refused ${broken.length} of the application's own reads`);
    });
  });

  /** A merged pull request opened `days` before it was merged, by a person unless told otherwise. */
  const merged = (id, days, overrides = {}) => {
    const mergedAt = new Date(Date.now() - 86_400_000);

    return contribute({
      id,
      number: id,
      state: 'closed',
      merged: true,
      merged_at: mergedAt.toISOString(),
      created_at: new Date(mergedAt.getTime() - days * 86_400_000).toISOString(),
      ...overrides,
    });
  };

  describe("how long merges take, and how big they are", () => {
    test("counts a person's merges, times what can be timed, and bands both", async () => {
      // Twelve merged by people, at 0.5 to 45 days; one by a bot, which no figure may see.
      const days = [0.5, 0.5, 2, 3, 5, 6, 8, 10, 20, 29, 40, 45];

      for (const [i, taken] of days.entries()) {
        await merged(8000 + i, taken, { commits: [1, 2, 3, 4, 9, 10, 12, 1, 0, 2, 5, 7][i] });
      }

      await merged(8100, 1, { user: { login: 'dependabot[bot]', type: 'Bot' } });

      const all = await db.contributions.getMergeTimes();

      assert.equal(all.merged, 12, "a bot's merge is not a person's");
      assert.equal(all.timed, 12);

      // percentile_cont, and the page's own interpolation, agree to the second.
      const seconds = days.map((taken) => taken * 86_400);

      assert.ok(Math.abs(all.p50Seconds - percentile(seconds, 0.5)) < 1);
      assert.ok(Math.abs(all.p90Seconds - percentile(seconds, 0.9)) < 1);

      assert.deepEqual({ ...all.durations }, { under1d: 2, days1to7: 4, days7to30: 4, over30d: 2 });
      // "1" is at most one: an entry by hand may carry a zero.
      assert.deepEqual({ ...all.commits }, { counted: 12, one: 3, twoToThree: 3, fourToNine: 4, tenPlus: 2 });
    });

    test("leaves out what cannot be timed, and gates the percentiles on what can", async () => {
      await merged(8200, 2);
      await merged(8201, 3);
      // Opened after it was merged, by the clocks involved: no duration.
      await merged(8202, -1);
      // Typed by hand from a GitLab merge request: no opening date, and no commit count.
      await merged(8203, 2, { created_at: null, commits: null });

      const all = await db.contributions.getMergeTimes();

      assert.equal(all.merged, 4);
      assert.equal(all.timed, 2);
      assert.equal(all.commits.counted, 3, 'a merge with no commit count is left out of the commits, and said to be');
      assert.equal(all.p50Seconds, null, 'two timed merges have no median');
      assert.equal(all.p90Seconds, null);
      assert.equal(all.durations.days1to7, 2);
    });

    test("and an empty table answers zeroes and nothing to divide", async () => {
      const all = await db.contributions.getMergeTimes();

      assert.equal(all.merged, 0);
      assert.equal(all.p50Seconds, null);
      assert.equal(all.commits.counted, 0);
    });
  });

  describe("the contributors' standings", () => {
    test("are one row per person, whatever the case of their login, with nobody's installation joined", async () => {
      // This instant is in this UTC month whenever the query runs; a minute ago is not, in the
      // first minute of a month. Half an hour before the UTC month began is already this month
      // in Paris, the zone this run's sessions are in: it tells a UTC cut from the session's.
      const now = new Date();
      const thisMonth = now.toISOString();
      const lastUtcMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 30 * 60_000).toISOString();
      const lastYear = new Date(Date.now() - 400 * 86_400_000).toISOString();

      await contribute({ id: 8300, number: 1, user: { login: 'Octocat', type: 'User' }, created_at: lastYear, merged: true, merged_at: lastYear, state: 'closed' });
      await contribute({ id: 8301, number: 2, user: { login: 'octocat', type: 'User' }, created_at: thisMonth });
      await contribute({ id: 8302, number: 3, user: { login: 'hubot', type: 'User' }, created_at: lastYear });
      await contribute({ id: 8303, number: 4, user: { login: 'renovate[bot]', type: 'Bot' }, created_at: thisMonth });
      await contribute({ id: 8304, number: 5, user: { login: 'late-one', type: 'User' }, created_at: lastUtcMonth });

      const standings = await db.contributions.getTopContributors();

      assert.deepEqual(standings.map((row) => row.who), ['hubot', 'late-one', 'octocat'], 'no bot, and one octocat');

      const octocat = standings.find((row) => row.who === 'octocat');

      assert.equal(octocat.login, 'octocat', "shown as their newest pull request spells it");
      assert.equal(octocat.mergedEver, 1);
      assert.equal(octocat.openedMonth, 1, 'this calendar month, in UTC');
      // acme is not in OWN_GITHUB_ORGS under test: the month is all elsewhere, and a swap of the
      // two halves would show here, not only in their sum.
      assert.equal(octocat.elsewhereMonth, 1);
      assert.equal(octocat.oursMonth, 0);
      assert.equal(standings.find((row) => row.who === 'hubot').openedMonth, 0);
      assert.equal(standings.find((row) => row.who === 'late-one').openedMonth, 0, 'last month in UTC, whatever the session says');
    });
  });

  describe("who counts as a contributor", () => {
    test("is a login counted once whatever its case, and never a bot", async () => {
      // The footnote's own definition, which the Contributors tile reads off the months of who
      // contributed: opened_by keeps whatever case GitHub wrote that day, and one person is one
      // contributor - and one newcomer, in the month of their first pull request.
      const now = new Date().toISOString();

      await contribute({ id: 8800, number: 1, user: { login: 'Octocat', type: 'User' }, created_at: now, state: 'closed', merged: true, merged_at: now });
      await contribute({ id: 8801, number: 2, user: { login: 'octocat', type: 'User' }, created_at: now });
      await contribute({ id: 8802, number: 3, user: { login: 'renovate[bot]', type: 'Bot' }, created_at: now });

      const month = (await db.contributions.getContributorSeries()).at(-1);

      assert.equal((await db.contributions.getContributionSummary()).all.opened, 2);
      assert.equal(month.contributors, 1);
      assert.equal(month.firstTime, 1);
    });
  });

  describe("one person's rows, as the Me tab lists them", () => {
    test("carry the project's row, the closing date and the forge", async () => {
      const closed = '2026-03-10T10:00:00.000Z';
      const repository = await contribute({ id: 8400, number: 40, state: 'closed', closed_at: closed });

      const [row] = await db.contributions.listContributionsForLogin('octocat');

      assert.equal(row.repositoryId, Number(repository));
      assert.ok(row.closedAt instanceof Date, 'pg answers a Date for a timestamptz');
      assert.equal(row.closedAt.toISOString(), closed);
      assert.equal(row.forge, 'github');
      assert.equal(row.merged, false);
    });

    test("newest first by whatever became of each, open ones among them at their opening", async () => {
      await contribute({ id: 8500, number: 50, created_at: '2026-01-01T00:00:00.000Z', state: 'closed', closed_at: '2026-05-01T00:00:00.000Z' });
      await contribute({ id: 8501, number: 51, created_at: '2026-03-01T00:00:00.000Z' });
      await contribute({
        id: 8502, number: 52, created_at: '2026-02-01T00:00:00.000Z', state: 'closed',
        merged: true, merged_at: '2026-04-01T00:00:00.000Z', closed_at: '2026-04-01T00:00:00.000Z',
      });

      const rows = await db.contributions.listContributionsForLogin('octocat');

      assert.deepEqual(rows.map((row) => row.number), [50, 52, 51]);
      assert.equal((await oneRow(`SELECT count(*)::int AS n FROM github_pull_requests`)).n, 3);
    });
  });

  describe("what the report names", () => {
    // Served whole to every reader, so it names no more people than a panel shows: four of this
    // month's contributors, never the standings they are cut from.
    const opening = async (count) => {
      for (let i = 0; i < count; i += 1) {
        await contribute({ id: 8700 + i, number: i, user: { login: `person-${i}`, type: 'User' }, created_at: new Date().toISOString() });
      }
    };

    test("is this month's top four, out of however many there are, and never the standings", async () => {
      const { getReport, getStandings } = await import("../../src/services/dashboardReport.js");

      await opening(6);

      const report = JSON.parse(JSON.stringify(await getReport()));

      assert.equal(report.contributors.rows.length, 4);
      assert.equal(report.contributors.of, 6, 'the list is a top four of all six');
      assert.equal(report.contributors.month, new Date().toISOString().slice(0, 7));
      assert.equal('standings' in report, false);
      assert.equal((await getStandings()).length, 6, 'kept beside it, on the server');
    });

    test("and at most ten of the pull requests still waiting", async () => {
      // A module of its own, by its address: the one above holds a report built a moment ago.
      const { getReport } = await import("../../src/services/dashboardReport.js?pending");

      await opening(12);

      assert.ok((await getReport()).pending.length <= 10, 'the whole backlog, with its authors, is not the report\'s to publish');
    });
  });

  describe("what the report leaves out", () => {
    test("is counted, bots and all, and how many of those were merged", async () => {
      const { id } = await db.repositories.ensureRepository('acme/widget', 9001);

      await db.pullRequests.upsertPullRequest(hydrated({ id: 8600 }), id);
      await db.pullRequests.upsertPullRequest(hydrated({
        id: 8601, user: { login: 'dependabot[bot]', type: 'Bot' }, merged: true, merged_at: '2026-01-03T10:00:00.000Z', state: 'closed',
      }), id);
      await db.pullRequests.upsertPullRequest(hydrated({ id: 8602, user: { login: 'renovate[bot]', type: 'Bot' } }), id);

      assert.deepEqual(await db.contributions.getContributionTotals(), { byABot: 2, mergedByABot: 1 });
    });
  });
};
