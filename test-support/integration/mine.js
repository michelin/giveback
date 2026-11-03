import { describe, test } from "node:test";
import assert from "node:assert/strict";

/** The Me tab's one query, against real SQL. */
export const register = ({ db, contribute }) => {
  describe("one person's own contributions", () => {
    test("are every row under that login, whatever its case, and nobody else's", async () => {
      await contribute({ id: 6001, number: 1, user: { login: 'Octocat', type: 'User' } });
      await contribute({ id: 6002, number: 2, user: { login: 'octocat', type: 'User' } });
      await contribute({ id: 6003, number: 3, user: { login: 'somebody-else', type: 'User' } });

      const mine = await db.contributions.listContributionsForLogin('OCTOCAT');

      assert.deepEqual(mine.map((row) => row.number).sort(), [1, 2],
        'opened_by is frozen and its case is whatever GitHub wrote that day');
    });

    test("never a bot's, so the figures agree with every other on the page", async () => {
      await contribute({ id: 6004, number: 4, user: { login: 'renovate[bot]', type: 'Bot' } });

      assert.deepEqual(await db.contributions.listContributionsForLogin('renovate[bot]'), []);
    });

    test("carry the project's CURRENT name and whether it is ours", async () => {
      await contribute({ id: 6005, number: 5, user: { login: 'octocat', type: 'User' } });

      const [mine] = await db.contributions.listContributionsForLogin('octocat');

      // acme is not in OWN_GITHUB_ORGS under test, so this is the ecosystem half.
      assert.equal(mine.repo, 'acme/widget');
      assert.equal(mine.own, false);
      assert.equal(mine.recordedByHand, false);
    });

    test("and say which ones an operator recorded by hand", async () => {
      const { id } = await db.repositories.ensureForeignRepository('gitlab-org/toolkit');

      await db.pullRequests.upsertManualContribution({
        id: -987654321,
        number: 42,
        title: 'Teach the toolkit to spin',
        url: 'https://gitlab.com/gitlab-org/toolkit/-/merge_requests/42',
        fullName: 'gitlab-org/toolkit',
        openedBy: 'octocat',
        openedAt: '2026-02-01T00:00:00.000Z',
        mergedAt: '2026-02-08T00:00:00.000Z',
        mergedBy: null,
        commits: 2,
        changedFiles: 3,
        stars: 5,
      }, id);

      const [mine] = await db.contributions.listContributionsForLogin('octocat');

      assert.equal(mine.recordedByHand, true, 'a hand-recorded contribution is labelled, not hidden');
      assert.equal(mine.merged, true);
      assert.equal(mine.repo, 'gitlab-org/toolkit');
      // Off its address, as the table of entries by hand reads it: a merge request is numbered !42.
      assert.equal(mine.forge, 'gitlab');
    });

    test("newest first, by the day it landed rather than the day it was opened", async () => {
      await contribute({
        id: 6006, number: 6, user: { login: 'octocat', type: 'User' },
        created_at: '2024-01-05T10:00:00.000Z', merged_at: '2026-08-29T10:00:00.000Z',
        merged: true, state: 'closed',
      });
      await contribute({
        id: 6007, number: 7, user: { login: 'octocat', type: 'User' },
        created_at: '2026-04-15T10:00:00.000Z', merged_at: '2026-04-15T10:00:00.000Z',
        merged: true, state: 'closed',
      });

      const mine = await db.contributions.listContributionsForLogin('octocat');

      assert.deepEqual(mine.map((row) => row.number), [6, 7],
        'opened two years earlier, landed last - it belongs at the top');
    });

    test("and a login nobody has used answers an empty list, not an error", async () => {
      assert.deepEqual(await db.contributions.listContributionsForLogin('nobody-at-all'), []);
    });
  });

  describe("what the Me tab is sent", () => {
    test("places its reader among everybody, and names nobody else", async (t) => {
      const { buildMine } = await import("../../src/services/dashboardMine.js");
      const { getReport, REPORT_TTL_MS } = await import("../../src/services/dashboardReport.js");
      const now = new Date().toISOString();
      const merged = { merged: true, state: 'closed' };

      // Two spellings of one person, both merged and opened this month; three merges from last
      // year by somebody else; one pull request opened this month and still open by a third.
      await contribute({ id: 6101, number: 101, user: { login: 'Octocat', type: 'User' }, created_at: now, merged_at: now, closed_at: now, ...merged });
      await contribute({ id: 6102, number: 102, user: { login: 'octocat', type: 'User' }, created_at: now, merged_at: now, closed_at: now, ...merged });

      for (const id of [6103, 6104, 6105]) {
        await contribute({
          id, number: id - 6000, user: { login: 'ada-lovelace', type: 'User' },
          created_at: '2025-01-10T10:00:00.000Z', merged_at: '2025-01-20T10:00:00.000Z', closed_at: '2025-01-20T10:00:00.000Z', ...merged,
        });
      }

      await contribute({ id: 6106, number: 106, user: { login: 'grace-hopper', type: 'User' }, created_at: now });

      // Past the report's window, so the build read here is of these rows and not one an
      // earlier test left in the cache. Only for the window's check, which runs as buildMine is
      // called: the build it starts is dated by the real clock, so the cache it leaves is never
      // fresher than it looks to the next test, and its month is the SQL's.
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() + REPORT_TTL_MS });
      const building = buildMine('OCTOCAT');
      t.mock.timers.reset();

      const mine = await building;
      const { mergeTimes } = await getReport();

      assert.deepEqual(mine.contributions.map((row) => row.number).sort(), [101, 102]);
      // Since day one, among the two with a merge; this month, among the two who opened one.
      assert.deepEqual(mine.rank, {
        ever: { position: 2, of: 2 },
        month: { position: 1, of: 2, month: new Date().toISOString().slice(0, 7) },
      });
      assert.equal(mine.everyone.merged, 5, "everyone's merges, from the same build");
      assert.deepEqual(mine.everyone, {
        merged: mergeTimes.merged, timed: mergeTimes.timed,
        p50Seconds: mergeTimes.p50Seconds, p90Seconds: mergeTimes.p90Seconds,
      });
      assert.doesNotMatch(JSON.stringify(mine), /ada-lovelace|grace-hopper/, 'the standings stay on the server');
    });
  });
};
