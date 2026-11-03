import { describe, test } from "node:test";
import assert from "node:assert/strict";

/**
 * The off-by-default half of the dashboard, which needs its own file: dashboardAuth reads
 * SESSION_SECRET once at import time, exactly as it does in the running app, and it is set by
 * test/dashboard.test.js. `npm test` is a bare `node --test`, which runs every file in its
 * own child process, so this file gets a fresh module and a fresh read.
 *
 * Deleted, not merely left unset: that child process inherits the developer's shell, and this
 * repo carries a .env.local locally, so anyone who has exported SESSION_SECRET would otherwise
 * get a red suite for a reason that has nothing to do with the code.
 */
delete process.env.SESSION_SECRET;

const auth = await import("../src/services/dashboardAuth.js");

describe("the dashboard with no signing key", () => {
  test("reports itself disabled", () => {
    // Promised in docs/deployment.md, docs/configuration.md, docs/dashboard.md and docs/architecture.md:
    // the routes are left off rather than served unprotected. src/index.js is what honours it.
    assert.equal(auth.isDashboardEnabled(), false);
  });

  test("refuses the request even if a route were registered anyway", async () => {
    // The defence in depth at the top of requireDashboardAccess. next('route') skips the whole
    // route, so the answer is a 404 - the page does not exist rather than exists-and-refuses.
    const passed = [];

    await auth.requireDashboardAccess({}, {}, (arg) => passed.push(arg));

    assert.deepEqual(passed, ['route']);
  });
});
