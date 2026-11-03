import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PAGINATION } from "../src/utils/constants.js";

// GitHub's documented ceiling on the public events feed. Asking for anything past it
// returns 422 "In order to keep the API fast for everyone, pagination is limited for this
// resource." - not an empty page.
const GITHUB_EVENTS_CAP = 300;

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/services/octokitService.js", import.meta.url)),
  "utf8"
);

describe("the public events feed stays inside GitHub's pagination cap", () => {
  test("PER_PAGE * MAX_PAGES never asks for a page GitHub refuses", () => {
    // The defect this guards: PER_PAGE=100 with MAX_PAGES=5 asked for page 4 as soon as a
    // user had 300 events or more. Page 3 comes back full, so the short-page break does
    // not fire, and the 422 on page 4 failed that user's whole sync - silently, apart from
    // one error line, and only for the most active contributors.
    assert.ok(
      PAGINATION.PER_PAGE * PAGINATION.MAX_PAGES <= GITHUB_EVENTS_CAP,
      `PER_PAGE (${PAGINATION.PER_PAGE}) * MAX_PAGES (${PAGINATION.MAX_PAGES}) = `
      + `${PAGINATION.PER_PAGE * PAGINATION.MAX_PAGES}, above GitHub's ${GITHUB_EVENTS_CAP}-event cap`
    );
  });

  test("the last page allowed is still a page GitHub serves", () => {
    // One page fewer would leave events unread for no reason, so the bound is exact
    // rather than merely safe.
    assert.equal(PAGINATION.PER_PAGE * PAGINATION.MAX_PAGES, GITHUB_EVENTS_CAP);
  });

  test("a 422 past page 1 ends the walk instead of losing the pages already read", () => {
    // Source-level, like the logging rules: the branch matters more than any one call, and
    // asserting it here costs nothing next to injecting a fake Octokit.
    assert.match(
      SOURCE,
      /error\.status === 422 && page > 1/,
      "the pagination loop must treat a 422 past page 1 as the end of the feed"
    );
  });

  test("a 422 on page 1 still surfaces, because it is not an end of feed", () => {
    assert.doesNotMatch(
      SOURCE,
      /error\.status === 422\s*\)/,
      "an unguarded 422 branch would swallow a malformed request on page 1"
    );
  });

  test("304 keeps its own branch: nothing changed is not the same as nothing left", () => {
    assert.match(SOURCE, /error\.status === 304/);
    assert.match(SOURCE, /notModified: true/);
  });
});
