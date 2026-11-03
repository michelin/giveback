/** `2026-09`, k calendar months before this one, in UTC as the report cuts them. */
const monthsAgo = (k) => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)).toISOString().slice(0, 7);
};

const DAY = 86_400_000;

/**
 * A report with the same shape handleGetDashboardContributions() sends
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object}
 */
export const reportOf = (overrides = {}) => ({
  builtAt: new Date().toISOString(),
  now: new Date().toISOString(),
  // The two halves partition the whole: a repository is ours or it is not.
  summary: {
    external: { opened: 9, merged: 5, closedUnmerged: 1, stillOpen: 3, repositories: 4 },
    own: { opened: 2, merged: 1, closedUnmerged: 0, stillOpen: 1, repositories: 1 },
    all: { opened: 11, merged: 6, closedUnmerged: 1, stillOpen: 4, repositories: 5 },
  },
  bots: { byABot: 3, mergedByABot: 2 },
  // Six merged, all timed: a median, and no p90 yet - it needs ten.
  mergeTimes: {
    merged: 6, timed: 6, p50Seconds: 259_200, p90Seconds: null,
    durations: { under1d: 2, days1to7: 2, days7to30: 1, over30d: 1 },
    commits: { counted: 5, one: 2, twoToThree: 2, fourToNine: 1, tenPlus: 0 },
  },
  // The last three months, this one last.
  months: [
    { month: monthsAgo(2), opened: 1, merged: 1, ownOpened: 4, ownMerged: 2 },
    { month: monthsAgo(1), opened: 3, merged: 0, ownOpened: 2, ownMerged: 5 },
    { month: monthsAgo(0), opened: 0, merged: 1, ownOpened: 0, ownMerged: 0 },
  ],
  // Eight months, this one last: 2 people this month, one of them new.
  contributorSeries: [7, 6, 5, 4, 3, 2, 1, 0].map((k, i) => ({
    month: monthsAgo(k),
    contributors: [0, 0, 0, 0, 0, 3, 4, 2][i],
    firstTime: [0, 0, 0, 0, 0, 2, 1, 1][i],
  })),
  // The top of this month's standings, four at most, and how many there are in all.
  contributors: {
    month: monthsAgo(0),
    of: 2,
    rows: [
      { login: 'alice', opened: 3, ours: 1, elsewhere: 2 },
      { login: 'nolongerhere', opened: 1, ours: 0, elsewhere: 1 },
    ],
  },
  installedAccounts: 12,
  // Four open, one of them by an author nobody polls any more.
  openAges: { open: 4, under7d: 1, days7to30: 0, days30to90: 1, over90d: 2, notFollowed: 1 },
  // Seven projects have a merge, and these are the top of them.
  projects: [
    {
      repositoryId: 21, repo: 'kubernetes/kubernetes', url: 'https://github.com/kubernetes/kubernetes',
      own: false, stars: 112_004, merged: 4, stillOpen: 1, closedUnmerged: 0, people: 2, of: 7,
    },
    {
      repositoryId: 11, repo: 'acme/widget', url: 'https://github.com/acme/widget',
      own: true, stars: null, merged: 1, stillOpen: 1, closedUnmerged: 2, people: 1, of: 7,
    },
  ],
  // Alice is in both, spelled two ways: three people, not four.
  biggestFish: [
    {
      repositoryId: 21, repo: 'kubernetes/kubernetes', url: 'https://github.com/kubernetes/kubernetes',
      stars: 108_000, merged: 4, firstMergedAt: '2026-04-02T10:00:00.000Z',
      contributors: [{ login: 'alice', merged: 3 }, { login: 'bob', merged: 1 }],
    },
    {
      repositoryId: 22, repo: 'hashicorp/terraform', url: 'https://github.com/hashicorp/terraform',
      stars: 43_000, merged: 2, firstMergedAt: '2025-11-20T10:00:00.000Z',
      contributors: [{ login: 'Alice', merged: 1 }, { login: 'carol', merged: 1 }],
    },
  ],
  // The four of them, oldest first.
  pending: [
    {
      id: 2, number: 3, title: 'document the flags', repo: 'kubernetes/kubernetes',
      url: 'https://github.com/kubernetes/kubernetes/pull/3', openedAt: new Date(Date.now() - 200 * DAY).toISOString(),
      login: 'alice', own: false, followed: true,
    },
    {
      id: 4, number: 14, title: 'support ipv6', repo: 'hashicorp/terraform',
      url: 'https://github.com/hashicorp/terraform/pull/14', openedAt: new Date(Date.now() - 120 * DAY).toISOString(),
      login: 'bob', own: false, followed: false,
    },
    {
      id: 6, number: 9, title: 'retry on 502', repo: 'hashicorp/terraform',
      url: 'https://github.com/hashicorp/terraform/pull/9', openedAt: new Date(Date.now() - 45 * DAY).toISOString(),
      login: 'carol', own: false, followed: true,
    },
    {
      id: 8, number: 18, title: 'add a test', repo: 'acme/widget',
      url: 'https://github.com/acme/widget/pull/18', openedAt: new Date(Date.now() - 3 * DAY).toISOString(),
      login: 'ghost', own: true, followed: true,
    },
  ],
  ...overrides,
});
