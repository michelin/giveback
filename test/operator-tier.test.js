import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import Express from "express";

/**
 * The operator tier, decided over real HTTP by the real gate
 *
 * The defect this pins: the tier used to be matched on the login stored on the reader's row, and
 * a login is released when its owner renames. Whoever registered the freed login and enrolled was
 * an operator. The database is replaced at the module loader, as test/jobs.test.js does, so the
 * gate runs unchanged against rows the test chooses.
 */

// Account id → what enrollmentByUserId answers for it.
const rows = new Map([
  // The operator, renamed since the list was written: the row holds the new login.
  [1001, { enrolled: true, known: true, login: 'alice-renamed' }],
  // Somebody else, who registered the freed login 'alice' and enrolled with it.
  [2002, { enrolled: true, known: true, login: 'alice' }],
]);

globalThis.__operatorTierRows = rows;

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('/src/db/installations.js')
      ? {
        format: 'module',
        shortCircuit: true,
        source: 'export const enrollmentByUserId = async (id) => globalThis.__operatorTierRows.get(id) ?? { enrolled: false, known: false, login: null };',
      }
      : nextLoad(url, context);
  },
});

// Read at import, as in the running app: in place before the dynamic import below.
process.env.SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_OPERATOR_IDS = " 1001 ";
process.env.LOG_LEVEL = "silent";

const auth = await import("../src/services/dashboardAuth.js");

/**
 * Call the gate as src/index.js mounts it, signed in as one account
 * @param {number} userId - GitHub account id the session is for
 * @returns {Promise<?boolean>} req.isOperator as the page's handler saw it, null if refused
 */
const tierOf = async (userId) => {
  const app = Express();
  let seen = null;

  app.get('/dashboard', auth.requireDashboardAccess, (req, res) => {
    seen = req.isOperator;
    res.end();
  });

  const headers = {};
  auth.grantSession({ setHeader: (name, value) => { headers[name] = value; }, getHeader: (name) => headers[name] }, userId);
  const cookie = [].concat(headers['Set-Cookie']).find((value) => value.startsWith('oss_dashboard=')).split(';')[0];

  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await fetch(`http://127.0.0.1:${server.address().port}/dashboard`, { headers: { Cookie: cookie } });

    return seen;
  } finally {
    server.close();
  }
};

describe("the operator tier", () => {
  test("follows the account id across a rename", async () => {
    assert.equal(await tierOf(1001), true);
  });

  test("and is never inherited with a freed login", async () => {
    assert.equal(await tierOf(2002), false);
  });

  test("and a login in place of an id matches nobody", () => {
    assert.equal(auth.isOperator(1001), true);
    assert.equal(auth.isOperator(2002), false);
    assert.equal(auth.isOperator(null), false);
    assert.equal(auth.isOperator('alice'), false);
  });
});
