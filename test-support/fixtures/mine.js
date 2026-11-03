/**
 * What GET /dashboard/mine answers: the rows listContributionsForLogin() reads, what
 * summariseMine() makes of them, and where the reader stands among everybody
 */
export const mineOf = (overrides = {}) => ({
  login: 'the-operator',
  contributions: [
    {
      id: 1, number: 7, title: 'Teach the widget to spin', repo: 'acme/widget', repositoryId: 11,
      url: 'https://github.com/acme/widget/pull/7', openedAt: '2026-08-01T09:00:00Z',
      mergedAt: '2026-08-20T09:00:00Z', closedAt: '2026-08-20T09:00:00Z', merged: true, state: 'closed',
      commits: 3, recordedByHand: false, own: false, forge: 'github',
    },
    {
      id: 2, number: 12, title: 'Fix the banner', repo: 'michelin/UX-Scape', repositoryId: 12,
      url: 'https://github.com/michelin/UX-Scape/pull/12', openedAt: '2026-05-02T09:00:00Z',
      mergedAt: '2026-05-14T09:00:00Z', closedAt: '2026-05-14T09:00:00Z', merged: true, state: 'closed',
      commits: 1, recordedByHand: false, own: true, forge: 'github',
    },
    {
      id: -3, number: 1664, title: 'Add azure data disk management', repo: 'gitlab-org/toolkit', repositoryId: 13,
      url: 'https://gitlab.com/gitlab-org/toolkit/-/merge_requests/1664', openedAt: '2026-05-01T09:00:00Z',
      mergedAt: '2026-05-09T09:00:00Z', closedAt: null, merged: true, state: 'closed',
      commits: 16, recordedByHand: true, own: false, forge: 'gitlab',
    },
  ],
  // Three merged, taking 19, 12 and 8 days: a median, and no p90 yet - it needs ten.
  summary: {
    merged: 3, open: 0, closedUnmerged: 0, decided: 3, oldestOpenAt: null,
    timeToMerge: { merged: 3, timed: 3, p50Seconds: 1_036_800, p90Seconds: null },
    where: { ours: { prs: 1, repositories: 1 }, elsewhere: { prs: 2, repositories: 2 } },
    series: [
      { month: '2026-05', opened: 2, landed: 2, openedTotal: 2, total: 2 },
      { month: '2026-06', opened: 0, landed: 0, openedTotal: 2, total: 2 },
      { month: '2026-07', opened: 0, landed: 0, openedTotal: 2, total: 2 },
      { month: '2026-08', opened: 1, landed: 1, openedTotal: 3, total: 3 },
    ],
    earlier: 0, undated: 0,
  },
  rank: { ever: { position: 4, of: 41 }, month: { position: 2, of: 23, month: '2026-09' } },
  // The report's mergeTimes: everybody's median, beside this reader's.
  everyone: { merged: 6, timed: 6, p50Seconds: 259_200, p90Seconds: null },
  now: new Date().toISOString(),
  ...overrides,
});
