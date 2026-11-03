import { snapshotOf } from "./snapshot.js";

// A time ahead is set half a minute off a whole one, so a test reading "due in 8 min" does not
// depend on how many milliseconds go by before the page reads its clock. One behind needs no
// margin: that clock can only have moved further from it.
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

/** A subject of the tiles and the fold under the track, in the shape getOpsSnapshot() places it. */
export const subjectOf = (overrides = {}) => ({
  kind: "sync", id: 1, label: "dev-user-1", dueAt: ago(1_800_000), claimed: false, errors: 0, minutes: 15, tier: 15,
  ...overrides,
});

/** Thirty UTC days of detection latency, today last: four merges on every third day, forty in all. */
const latencyFrom = () => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * 86_400_000);
};
const latencyPoints = () => Array.from({ length: 10 }, (_, d) => d * 3).flatMap((day) => [0, 1, 2, 3].map((k) => ({
  at: new Date(latencyFrom().getTime() + day * 86_400_000 + (2 + 5 * k) * 3_600_000).toISOString().replace('.000Z', 'Z'),
  seconds: 600 + 60 * day + 300 * k,
})));

/**
 * The `ops` half of an operator's snapshot, in the shape getOpsSnapshot() builds
 *
 * One set of figures throughout, so a test can hold two blocks to agreeing: the subject states
 * add up to what is tracked, the track's lanes count the same subjects, and the one failing job
 * is the one card that says so.
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object}
 */
const opsOf = (overrides = {}) => ({
  app: { revision: "abc1234", uptimeMs: 91_000 },
  jobs: [
    {
      name: "sync_contributions", cron: "*/30 * * * * *", running: false, nextRunAt: ahead(20_000), state: "failing",
      runs: [
        { outcome: "idle", durationMs: 41, startedAt: ago(60_000) },
        { outcome: "failed", durationMs: 2100, startedAt: ago(0) },
      ],
      window: { runs: 288, failed: 1, idle: 50, avgDurationMs: 1540, maxDurationMs: 6100, subjectsFailed: 0, subjectsClaimed: 451 },
      lastError: "Bad credentials",
    },
    {
      name: "poll_non_closed_pull_requests", cron: "0 */2 * * * *", running: false, nextRunAt: null, state: "ok",
      runs: [], lastError: null,
      window: { runs: 0, failed: 0, idle: 0, avgDurationMs: 0, maxDurationMs: 0, subjectsFailed: 0, subjectsClaimed: 0 },
    },
  ],
  ladders: {
    sync: { tiers: [15, 30, 60, 120, 240], backoff: 360 },
    poll: { tiers: [15, 30, 60, 120, 240], backoff: 360 },
  },
  subjects: {
    sync: { tracked: 40, overdue: 3, overdueOnFloor: 1, claimed: 1, oldestClaimAt: ago(12_000), backoff: 2, onSchedule: 34 },
    poll: { tracked: 22, overdue: 1, overdueOnFloor: 0, claimed: 0, oldestClaimAt: null, backoff: 1, onSchedule: 20 },
    oldestLate: subjectOf(),
  },
  queue: {
    edges: [15, 30, 60, 120, 240],
    // Due now, then up to each edge, then beyond it: every subject tracked, of which the track
    // draws the head.
    shape: { sync: [14, 2, 2, 1, 3, 2, 16], poll: [6, 1, 2, 0, 1, 0, 12] },
    subjects: {
      sync: [
        { at: null, claimed: false, errors: 0, intervalMinutes: 15, label: "dev-user-1", sub: null, lastError: null },
        { at: ago(120_000), claimed: true, errors: 0, intervalMinutes: 15, label: "dev-user-2", sub: ago(7_200_000), lastError: null },
        { at: ahead(510_000), claimed: false, errors: 5, intervalMinutes: 240, label: "dev-user-3", sub: null, lastError: "Not Found" },
      ],
      poll: [
        {
          at: ahead(750_000), claimed: false, errors: 1, intervalMinutes: 30, label: "acme/one#12", sub: "dev-user-1", commits: 7,
          openedAt: ago(86_400_000), lastPolledAt: ago(3_600_000), lastError: "Bad gateway",
        },
      ],
    },
  },
  next: [
    subjectOf(),
    subjectOf({ kind: "poll", id: 12, label: "acme/one#12", dueAt: ahead(750_000), errors: 1, minutes: 30, tier: 30 }),
  ],
  latency: { from: latencyFrom().toISOString(), days: 30, points: latencyPoints(), window: { n: 40, p50: 1500, p90: 3300, p99: null } },
  runs: [
    { job: "sync_contributions", outcome: "ok", durationMs: 599, counters: { claimed: 2, changed: 0, failed: 2 }, error: null, startedAt: ago(0) },
    { job: "reconcile_installations", outcome: "failed", durationMs: 298, counters: { live: 0, purged: 0 }, error: "Integration not found", startedAt: ago(60_000) },
  ],
  users: [
    {
      userId: 583231, login: "dev-user-1", email: "dev.one@acme.com", state: "installed", stateSince: "2026-02-24T09:15:00.000Z",
      disabledReason: null, enrolledAt: "2026-02-20T08:00:00.000Z", lastSyncedAt: ago(3_600_000), pullRequests: 17, merged: 14,
    },
    {
      userId: 1, login: "dev-user-3", email: null, state: "disabled", stateSince: "2026-04-04T00:00:00.000Z",
      disabledReason: "account gone", enrolledAt: "2026-01-02T08:00:00.000Z", lastSyncedAt: null, pullRequests: 0, merged: 0,
    },
  ],
  // Everything stored: a share of each split adding up to its total, and a bot among the authors.
  inventory: {
    pullRequests: 1234, byPeople: 1200, byBots: 34, merged: 980, commits: 5321, authors: 75, byHand: 6,
    since: "2025-09-14T08:30:00.000Z", lastWeek: 12, repositories: 410, repositoriesOurs: 38,
    accounts: 81, accountsActive: 73, pullRequestEvents: 2400, pushEvents: 9100, renames: 4,
  },
  // Two rows of what the process was started with, one list of them empty.
  settings: [
    {
      title: "What counts as ours",
      items: [
        { label: "Repositories we own", env: ["OWN_GITHUB_ORGS"], values: ["acme", "acme-labs"], none: "no owner is ours" },
        { label: "GitLab hosts read", env: ["GITLAB_API_HOSTS"], values: [], none: "no host is read" },
      ],
    },
    {
      title: "How the queues are paced",
      items: [
        { label: "Sync interval", env: ["SYNC_MIN_INTERVAL_MINUTES", "SYNC_MAX_INTERVAL_MINUTES"], unit: "minutes", values: [15, 240] },
        { label: "Sync batch", env: ["SYNC_BATCH_SIZE"], unit: "subjects", values: [200] },
        { label: "Run history kept", env: ["JOB_RUN_RETENTION_DAYS"], unit: "days", values: [7] },
      ],
    },
  ],
  limits: { sparklineRuns: 48, tickMinutes: { sync: 5, poll: 5 }, outcomes: ["ok", "failed", "idle", "skipped"] },
  ...overrides,
});

/**
 * What getSnapshot() answers an operator
 * @param {Object} [ops] - Fields of the `ops` half to replace
 * @param {Object} [overrides] - Fields of the snapshot itself to replace
 * @returns {Object}
 */
export const operatorSnapshotOf = (ops = {}, overrides = {}) => snapshotOf({
  viewer: "the-operator",
  operator: true,
  ops: opsOf(ops),
  ...overrides,
});
