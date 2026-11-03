/**
 * What every part of the SQL-layer suite shares
 *
 * The suite is one file, test/db.integration.test.js, because node --test runs files in
 * parallel and two of them would drop each other's schema. Its areas live beside it, each as a
 * register(ctx) that declares its describe blocks when the file loads. ctx carries the modules
 * under test - `ctx.db`, filled in by the suite's before() once the environment points at the
 * scratch schema - and the helpers that read rows back and seed them: rowsOf, oneRow, enrol,
 * contribute and expireLease.
 */

/** A hydration response, in the shape upsertPullRequest destructures it. */
export const hydrated = (overrides = {}) => ({
  id: 5001,
  number: 7,
  title: 'Teach the widget to spin',
  state: 'open',
  html_url: 'https://github.com/acme/widget/pull/7',
  created_at: '2026-01-02T10:00:00.000Z',
  updated_at: '2026-01-02T10:00:00.000Z',
  closed_at: null,
  merged_at: null,
  merged: false,
  merged_by: null,
  commits: 3,
  changed_files: 4,
  user: { login: 'octocat', type: 'User' },
  head: { repo: { full_name: 'octocat/widget' }, ref: 'spin' },
  base: {
    ref: 'main',
    repo: {
      full_name: 'acme/widget',
      license: { key: 'apache-2.0' },
      topics: ['tyres'],
      forks_count: 12,
      stargazers_count: 340,
    },
  },
  ...overrides,
});
