import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseContributionUrl } from "../src/utils/contributionUrl.js";

describe("the address of a contribution", () => {
  test("reads a GitHub pull request", () => {
    assert.deepEqual(parseContributionUrl('https://github.com/apache/kafka/pull/22725'), {
      forge: 'github',
      host: 'github.com',
      fullName: 'apache/kafka',
      number: 22725,
      url: 'https://github.com/apache/kafka/pull/22725',
    });
  });

  test("reads a GitLab merge request, however deep the group path", () => {
    // Groups nest, and the whole path is what the project is called - `gitlab-org/gitlab` is
    // one project, not a group and a project to be recombined later.
    const deep = parseContributionUrl('https://gitlab.com/gitlab-org/quality/toolbox/-/merge_requests/9');

    assert.equal(deep.forge, 'gitlab');
    assert.equal(deep.fullName, 'gitlab-org/quality/toolbox');
    assert.equal(deep.number, 9);
  });

  test("accepts a GitLab that is not gitlab.com", () => {
    // A company contributes to its own instance the same way it contributes to anyone's, and
    // the host is kept rather than assumed.
    const internal = parseContributionUrl('https://gitlab.example.com/platform/tools/x/-/merge_requests/3');

    assert.equal(internal.host, 'gitlab.example.com');
    assert.equal(internal.url, 'https://gitlab.example.com/platform/tools/x/-/merge_requests/3');
  });

  test("rebuilds the address rather than storing what was pasted", () => {
    // A link copied out of a browser carries a tab, an anchor, a tracking parameter. None of
    // that belongs in a column other systems read as the contribution's permanent address.
    const noisy = parseContributionUrl('https://github.com/apache/kafka/pull/22725/files?w=1#diff-3');

    // /files is a VIEW of the pull request, not the pull request: refused rather than trimmed,
    // because trimming guesses at what somebody meant.
    assert.equal(noisy, null);

    const clean = parseContributionUrl('https://github.com/apache/kafka/pull/22725/?utm_source=slack#top');

    assert.equal(clean.url, 'https://github.com/apache/kafka/pull/22725');
  });

  test("refuses a host that merely contains a forge's name", () => {
    // The reason this parses a URL instead of matching a pattern: the result decides which API
    // is called, and a regex on the raw string would accept both of these.
    assert.equal(parseContributionUrl('https://evil.example/github.com/apache/kafka/pull/1'), null);
    assert.equal(parseContributionUrl('https://github.com.evil.example/apache/kafka/pull/1'), null);
  });

  test("refuses anything that is not https", () => {
    assert.equal(parseContributionUrl('http://github.com/apache/kafka/pull/1'), null);
    assert.equal(parseContributionUrl('javascript:alert(1)'), null);
    assert.equal(parseContributionUrl('file:///etc/passwd'), null);
  });

  test("refuses a number that only looks like one", () => {
    // parseInt would answer 12 for the first and record the wrong pull request.
    assert.equal(parseContributionUrl('https://github.com/a/b/pull/12abc'), null);
    assert.equal(parseContributionUrl('https://github.com/a/b/pull/0'), null);
    assert.equal(parseContributionUrl('https://github.com/a/b/pull/-3'), null);
    assert.equal(parseContributionUrl('https://github.com/a/b/pull/'), null);
  });

  test("refuses what is not a contribution at all", () => {
    assert.equal(parseContributionUrl('https://github.com/apache/kafka'), null);
    assert.equal(parseContributionUrl('https://github.com/apache/kafka/issues/4'), null);
    assert.equal(parseContributionUrl('https://gitlab.com/gitlab-org/-/merge_requests/4'), null);
    assert.equal(parseContributionUrl('https://example.com/whatever'), null);
    assert.equal(parseContributionUrl(''), null);
    assert.equal(parseContributionUrl(null), null);
    assert.equal(parseContributionUrl(undefined), null);
  });
});

describe("the identity of a merge request on a forge we cannot call", () => {
  test("is derived from the address, so recording twice records once", async () => {
    const { synthesiseId } = await import("../src/services/manualContributionService.js");

    assert.equal(
      synthesiseId('gitlab.com', 'gitlab-org/gitlab', 199182),
      synthesiseId('gitlab.com', 'gitlab-org/gitlab', 199182)
    );
  });

  test("and is NEGATIVE, so it cannot collide with a forge's own id", async () => {
    const { synthesiseId } = await import("../src/services/manualContributionService.js");
    const id = synthesiseId('gitlab.com', 'gitlab-org/gitlab', 199182);

    // The guarantee this buys is not "unlikely" but "impossible": GitHub numbers pull requests
    // upwards from one, so no real id is ever negative. A GitLab address carries the iid, the
    // number within a project, which thousands of projects share - it could never be the key.
    assert.ok(id < 0, `expected a negative id, got ${id}`);
    assert.ok(Number.isSafeInteger(id), 'it has to survive the round trip through JSON');
  });

  test("and tells two merge requests apart, whatever they share", async () => {
    const { synthesiseId } = await import("../src/services/manualContributionService.js");
    const ids = new Set([
      synthesiseId('gitlab.com', 'a/b', 1),
      synthesiseId('gitlab.com', 'a/b', 2),
      synthesiseId('gitlab.com', 'a/c', 1),
      synthesiseId('gitlab.example.com', 'a/b', 1),
    ]);

    assert.equal(ids.size, 4, 'host, project and number all have to reach the digest');
  });
});

describe("what GitLab answers, and what it never will", () => {
  test("maps a merge request onto the fields this application stores", async () => {
    const { mapMergeRequest } = await import("../src/services/gitlabService.js");

    // Trimmed from a real answer of gitlab.com, unauthenticated, with the people renamed.
    const mapped = mapMergeRequest({
      iid: 199182,
      state: 'merged',
      title: 'Add CI_PROJECT_TOPICS predefined variable',
      created_at: '2025-07-24T19:12:18.634Z',
      merged_at: '2025-07-31T18:53:31.216Z',
      changes_count: '4',
      author: { username: 'jane.doe', name: 'Jane Doe' },
      merge_user: { username: 'john.smith' },
    }, { commits: 1, stars: 6140 });

    assert.equal(mapped.merged, true);
    assert.equal(mapped.title, 'Add CI_PROJECT_TOPICS predefined variable');
    assert.equal(mapped.author, 'jane.doe');
    assert.equal(mapped.changedFiles, 4);
    assert.equal(mapped.commits, 1);
    assert.equal(mapped.stars, 6140);

    // The one field it must NOT carry, though `merge_user` is right there. `merged_by` is
    // joined to installations BY NAME and the names in it are GitHub logins: a GitLab username
    // written there detaches a person's whole history from their enrollment.
    assert.equal('mergedBy' in mapped, false);
  });

  test("an open merge request is not merged, whatever else it carries", async () => {
    const { mapMergeRequest } = await import("../src/services/gitlabService.js");

    assert.equal(mapMergeRequest({ state: 'opened', title: 'x' }).merged, false);
    assert.equal(mapMergeRequest({ state: 'closed', title: 'x' }).merged, false);
  });

  test("a capped count is no count at all", async () => {
    const { mapMergeRequest } = await import("../src/services/gitlabService.js");

    // GitLab answers `changes_count: "1000+"` for a large merge request. Number('1000+') is
    // NaN and parseInt would answer 1000 - a made-up figure, stored as if it were measured.
    assert.equal(mapMergeRequest({ changes_count: '1000+' }).changedFiles, null);
    assert.equal(mapMergeRequest({ changes_count: '4' }).changedFiles, 4);
    assert.equal(mapMergeRequest({}).changedFiles, null);
  });

  test("and only an allow-listed instance is ever called", async () => {
    const { isReadableHost, readMergeRequest } = await import("../src/services/gitlabService.js");

    // The address is typed by a human and parseContributionUrl accepts any host that spells a
    // merge request. Without this the form would be a way to make the server issue a request
    // to a host of somebody's choosing - an internal one included.
    assert.equal(isReadableHost('gitlab.com'), true);
    assert.equal(isReadableHost('gitlab.internal.example'), false);

    // Refused before any socket is opened: null comes back without the network being touched.
    assert.equal(await readMergeRequest({
      host: 'gitlab.internal.example', fullName: 'a/b', number: 1,
    }), null);
  });
});
