import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import Express from "express";
import ejs from "ejs";
import { ROOT, read, filesUnder, dashboardServices, withoutComments, fn, functions } from "../test-support/sources.js";
import { mineOf } from "../test-support/fixtures/mine.js";
import { reportOf } from "../test-support/fixtures/collective.js";

// dashboardAuth reads its configuration at import time, exactly as it does in the running
// app, so the environment has to be in place before the dynamic import below.
process.env.SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_ALLOWED_LOGINS = "operator-one, Operator-Two";
// What the footnote states, read by src/utils/constants.js at import like the rest.
process.env.OWN_GITHUB_ORGS = "acme, acme-labs";
process.env.ALLOWED_EMAIL_DOMAINS = "acme.com";
// A database nobody listens on, read by src/db/index.js at import. A test that reaches it fails
// on the spot, rather than passing against whatever the developer's shell happens to point at.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "9";
// The refusals and the unreachable database these tests provoke on purpose each log a warn.
process.env.LOG_LEVEL = "silent";

const auth = await import("../src/services/dashboardAuth.js");
const service = await import("../src/services/dashboardService.js");
const { DASHBOARD_ASSETS, assetsFor, handleGetDashboardAsset } = await import("../src/services/dashboardAssets.js");
const { renderPage } = await import("../test-support/dashboardPage.js");
const { PERCENTILE_MIN_SAMPLE } = await import("../src/utils/constants.js");
const { snapshotOf } = await import("../test-support/fixtures/snapshot.js");
const { operatorSnapshotOf } = await import("../test-support/fixtures/ops.js");

/**
 * A response object that records Set-Cookie the way Express does
 * @returns {Object}
 */
const fakeResponse = () => {
  const headers = {};

  return {
    setHeader: (name, value) => { headers[name] = value; },
    getHeader: (name) => headers[name],
    cookies: () => [].concat(headers['Set-Cookie'] ?? []),
    // Last one wins, which is what a browser does with two Set-Cookie headers for the same
    // name: reading the first would test the opposite of the real behaviour.
    cookie: (name) => [].concat(headers['Set-Cookie'] ?? []).findLast((value) => value.startsWith(`${name}=`)),
  };
};

/**
 * Turn the cookies a response set into the Cookie header a browser would send back
 * @param {Object} res - Fake response
 * @returns {Object} Fake request
 */
const requestFrom = (res) => ({
  headers: {
    cookie: res.cookies()
      .map((cookie) => cookie.split(';')[0])
      // An expired cookie is sent as name=; the browser would simply drop it.
      .filter((pair) => !pair.endsWith('='))
      .join('; '),
  },
  get: () => undefined,
});

describe("the dashboard session", () => {
  test("is enabled when a signing key is configured", () => {
    assert.equal(auth.isDashboardEnabled(), true);
  });

  test("no /dashboard route is registered outside the enablement gate", () => {
    // The other half of that invariant, and the half four documents promise: with no key the
    // routes are left off rather than served unprotected. Read as source, never imported -
    // importing src/index.js runs validateEnv() and express.listen().
    //
    // Every occurrence, not one positive match: a route added below the block would satisfy a
    // match on the file and still be served to anyone, on an instance where /dashboard is meant to
    // be indistinguishable from absent.
    const index = read('src/index.js');
    const gate = index.indexOf('if (isDashboardEnabled()) {');
    const otherwise = index.indexOf('} else {', gate);

    assert.notEqual(gate, -1, 'the isDashboardEnabled block was not found - the marker moved');
    assert.notEqual(otherwise, -1, 'the gate has no else branch any more');

    // Every verb: DELETE /dashboard/manual/:id is a route too, and a pattern reading only get and
    // post would let one registered below the block through.
    const routes = [...index.matchAll(/express\.(?:get|post|put|patch|delete)\("\/dashboard/g)];

    assert.ok(routes.length >= 8, `only ${routes.length} /dashboard routes found - the pattern stopped matching`);

    const ungated = routes
      .filter(({ index: at }) => at < gate || at > otherwise)
      .map(({ index: at }) => index.slice(at, index.indexOf('\n', at)).trim());

    assert.deepEqual(ungated, [], 'these are registered whether a session can be signed or not');

    // And the off case says so in the log, so "why is /dashboard a 404" has an answer there.
    assert.match(index.slice(otherwise, index.indexOf('\n}', otherwise)),
      /logger\.info\('dashboard disabled/, 'a disabled dashboard must still be explained somewhere');
  });

  test("a granted session round-trips to the account it was granted for", () => {
    const res = fakeResponse();

    auth.grantSession(res, 583231);

    assert.equal(auth.sessionUserId(requestFrom(res)), 583231);
  });

  test("a session signed before it carried an account id reads as no session", () => {
    // The shape every cookie had before: a login, correctly signed. A login is released when its
    // owner renames, so a session keyed on one could be inherited by whoever claims it next.
    // Its holder is simply sent through the sign-in again.
    const payload = Buffer.from(JSON.stringify({ login: 'octocat', exp: Math.floor(Date.now() / 1000) + 3600 }))
      .toString('base64url');
    const signature = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
    const request = { headers: { cookie: `oss_dashboard=${payload}.${signature}` }, get: () => undefined };

    assert.equal(auth.sessionUserId(request), null);
  });

  test("the session cookie is not readable by script and not sent cross-site", () => {
    const res = fakeResponse();

    auth.grantSession(res, 583231);

    const cookie = res.cookie('oss_dashboard');

    assert.match(cookie, /HttpOnly/, "a session readable by document.cookie is a session an XSS steals");
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/dashboard/, "nothing outside the dashboard has any use for it");
  });

  test("a tampered payload is refused", () => {
    const res = fakeResponse();

    auth.grantSession(res, 583231);

    const token = decodeURIComponent(res.cookies()[0].split(';')[0].split('=')[1]);
    const [payload, signature] = token.split('.');

    // Re-encode the claims with a different account, keeping the original signature: this is
    // the whole attack the HMAC exists to stop.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...claims, uid: 1 })).toString('base64url');

    const request = { headers: { cookie: `oss_dashboard=${forged}.${signature}` }, get: () => undefined };

    assert.equal(auth.sessionUserId(request), null);
  });

  test("a session with no signature at all is refused", () => {
    for (const value of ['', 'octocat', 'octocat.', '.abc', 'eyJsb2dpbiI6Im9jdG9jYXQifQ']) {
      const request = { headers: { cookie: `oss_dashboard=${value}` }, get: () => undefined };

      assert.equal(auth.sessionUserId(request), null, `accepted ${JSON.stringify(value)}`);
    }
  });

  test("no cookie at all is simply nobody", () => {
    assert.equal(auth.sessionUserId({ headers: {}, get: () => undefined }), null);
  });
});

describe("the login nonce", () => {
  test("matches the state it handed out", () => {
    const res = fakeResponse();
    const state = auth.beginLogin(res);

    assert.equal(auth.verifyLoginState(requestFrom(res), state), true);
  });

  test("refuses a state this browser was never given", () => {
    const res = fakeResponse();

    auth.beginLogin(res);

    // The forged-callback attack: an authorization code delivered to a victim's browser
    // together with a state value the attacker chose.
    assert.equal(auth.verifyLoginState(requestFrom(res), 'chosen-by-someone-else'), false);
  });

  test("refuses a callback with no nonce cookie", () => {
    const res = fakeResponse();
    const state = auth.beginLogin(res);

    assert.equal(auth.verifyLoginState({ headers: {}, get: () => undefined }, state), false);
  });

  test("the OAuth callback refuses a state this browser was never given", async () => {
    // The nonce is only worth something if the handler asks. Nothing tied the two together:
    // deleting the verifyLoginState() check from handleGetDashboardCallback reopened the
    // forged-callback attack with all 296 tests green.
    //
    // Over real HTTP, the way the gate is tested above, because the handler reads req.query
    // and answers on res - and the 400 is decided before any call to GitHub, so nothing here
    // needs the OAuth exchange stubbed.
    const nonce = fakeResponse();

    auth.beginLogin(nonce);

    const app = Express();

    app.get('/dashboard/callback', service.handleGetDashboardCallback);

    const server = app.listen(0);

    try {
      await new Promise((resolve) => server.once('listening', resolve));

      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/dashboard/callback?code=an-authorization-code&state=chosen-by-someone-else`,
        { headers: { Cookie: nonce.cookie('oss_dashboard_state').split(';')[0] }, redirect: 'manual' }
      );

      assert.equal(response.status, 400, 'a callback carrying a foreign state was accepted');

      const granted = [].concat(response.headers.getSetCookie?.() ?? []);

      assert.deepEqual(granted.filter((value) => value.startsWith('oss_dashboard=')), [],
        'a session was minted for a login flow this browser never started');
      // A refused callback spends the nonce too, or it stays behind for a second one to replay.
      assert.ok(granted.some((value) => /^oss_dashboard_state=;.*Max-Age=0/.test(value)),
        'the nonce outlived a refused callback');
    } finally {
      server.close();
    }
  });

  test("is cleared once it has been used", () => {
    const res = fakeResponse();

    auth.beginLogin(res);
    auth.clearLoginState(res);

    const cleared = res.cookie('oss_dashboard_state');

    assert.match(cleared, /^oss_dashboard_state=;/, "a nonce left behind can be replayed");
    assert.match(cleared, /Max-Age=0/);
  });
});

describe("the authorization rule", () => {
  test("enrolment is the whole rule, with no allowlist in front of the lookup", () => {
    // Asserted on the body rather than by calling it: the answer for a login that is not
    // refused outright comes from the database, and this suite never opens one.
    const source = read('src/services/dashboardAuth.js');
    const body = source.slice(
      source.indexOf('export const authorizeUser'),
      source.indexOf('export const requireDashboardAccess')
    );

    assert.match(body, /enrollmentByUserId/, 'decided on the account id, which a rename cannot hand to somebody else');
    assert.doesNotMatch(body, /isOperator/, 'the operator tier must not decide who may read the page');
  });

  test("the operator list is case-insensitive, because GitHub logins are", () => {
    assert.equal(auth.isOperator('OPERATOR-ONE'), true);
    assert.equal(auth.isOperator('operator-two'), true);
    assert.equal(auth.isOperator('somebody-else'), false);
    assert.equal(auth.isOperator(undefined), false);
  });

  test("an unset list makes nobody an operator", () => {
    // The failure mode of a setting that does not arrive: three operators lose the detail,
    // rather than every enrolled user gaining it. Asserted on the source because the set is
    // built once, at import, and this module was imported with the list in place.
    const source = read('src/services/dashboardAuth.js');

    assert.match(source, /operatorLogins\.has\(/, 'membership is the whole test');
    assert.doesNotMatch(source, /operatorLogins\.size === 0/, 'an empty list must not mean "everyone"');
  });

  test("the operator tier is read against the stored login, never one the browser holds", () => {
    // The session carries an account id and nothing else; the login the tier is matched on is
    // the one the database answered for that id, which reconcile keeps current across a rename.
    const source = withoutComments(read('src/services/dashboardAuth.js'));
    const gate = source.slice(source.indexOf('export const requireDashboardAccess'));

    assert.match(gate, /const \{ allowed, reason, login \} = await authorizeUser\(userId\);/);
    assert.match(gate, /req\.isOperator = isOperator\(login\);/);
  });

  test("a missing account id is refused without a lookup", async () => {
    assert.deepEqual(await auth.authorizeUser(null), { allowed: false, reason: 'no account id', login: null });
  });
});

describe("the gate", () => {
  /**
   * Mount the middleware the way src/index.js does and call it over real HTTP
   *
   * A unit test on the middleware could not have caught the bug this exists for: the defect
   * was in what Express does with next(), not in what the middleware decided.
   * @param {string} cookie - Cookie header to send, or ""
   * @returns {Promise<{status: number, body: string, servedThePage: boolean}>}
   */
  const call = async (cookie) => {
    const app = Express();
    let servedThePage = false;

    app.get('/dashboard', auth.requireDashboardAccess, (req, res) => {
      servedThePage = true;
      res.status(200).send('THE DASHBOARD');
    });

    // The same catch-all src/index.js installs after every route.
    app.use((req, res) => res.status(404).send('Not found.'));

    const server = app.listen(0);

    try {
      await new Promise((resolve) => server.once('listening', resolve));

      const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard`, {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: 'manual',
      });

      return { status: response.status, body: await response.text(), servedThePage };
    } finally {
      server.close();
    }
  };

  /**
   * A valid session cookie for an account
   * @param {number} userId - GitHub account id
   * @returns {string} Cookie header
   */
  const sessionFor = (userId) => {
    const res = fakeResponse();

    auth.grantSession(res, userId);

    return res.cookie('oss_dashboard').split(';')[0];
  };

  test("a user the middleware does not authorise never reaches the page", async () => {
    // The regression: next() inside a route chain runs the NEXT HANDLER OF THAT ROUTE, so a
    // refused user was served the dashboard with a 200. Only next('route') abandons it.
    //
    // Asserted as "not served" rather than as a 404, because since enrolment became the whole
    // rule this login's answer comes from the database: a reachable one refuses it with 404, an
    // unreachable one fails the lookup with 500. This suite has to be green on a checkout with
    // no database at all, and both answers prove the same thing - the route was abandoned. The
    // 404 shape is pinned by the test below and by enrollmentByUserId's own integration test.
    const result = await call(sessionFor(424242));

    assert.equal(result.servedThePage, false, 'the dashboard was rendered for an unauthorised user');
    assert.doesNotMatch(result.body, /THE DASHBOARD/);
    assert.notEqual(result.status, 200);
  });

  test("and a refusal abandons the route rather than continuing its chain", () => {
    // The half of the assertion above that a database would otherwise own. Pinned at the
    // source, on the branch itself, because it is one character away from the shipped bug.
    // Comments blanked, or the very comment explaining the bug satisfies the search for it.
    const source = withoutComments(read('src/services/dashboardAuth.js'));
    const refusal = source.slice(
      source.indexOf('if (!allowed) {'),
      source.indexOf('req.dashboardLogin = login;')
    );

    assert.match(refusal, /next\('route'\);/, 'a refusal must abandon the route');
    assert.doesNotMatch(refusal, /next\(\)/, "a bare next() runs the route's own next handler - the page");
  });

  test("a visitor with no session is sent to sign in", async () => {
    const result = await call('');

    assert.equal(result.status, 303);
    assert.equal(result.servedThePage, false);
  });

  test("a forged session is treated as no session, not as a refusal", async () => {
    const result = await call('oss_dashboard=not-a-real-token');

    assert.equal(result.status, 303);
    assert.equal(result.servedThePage, false);
  });
});

describe("a dashboard write from another site", () => {
  /**
   * Mount the origin check the way src/index.js does, in front of one write and one read
   * @param {string} method - HTTP method
   * @param {Object} headers - Request headers
   * @returns {Promise<{status: number, reached: boolean}>}
   */
  const call = async (method, headers) => {
    const app = Express();
    let reached = false;

    app.use('/dashboard', auth.requireSameOrigin);
    app.all('/dashboard/manual', (req, res) => {
      reached = true;
      res.json({ ok: true });
    });

    const server = app.listen(0);

    try {
      await new Promise((resolve) => server.once('listening', resolve));

      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/dashboard/manual`, {
        method,
        // The port is only known once the server listens, so the test spells this host as {self}.
        headers: Object.fromEntries(Object.entries(headers)
          .map(([name, value]) => [name, value.replace('{self}', `127.0.0.1:${port}`)])),
      });

      return { status: response.status, reached };
    } finally {
      server.close();
    }
  };

  test("is refused, whichever header gives it away", async () => {
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      // No header at all is not a browser on this page: a fetch() from it sends at least Origin.
      {},
    ]) {
      for (const method of ['POST', 'DELETE']) {
        const result = await call(method, headers);

        assert.equal(result.status, 403, `${method} with ${JSON.stringify(headers)}`);
        assert.equal(result.reached, false, `${method} with ${JSON.stringify(headers)} reached the handler`);
      }
    }
  });

  test("while the page's own fetch() calls pass", async () => {
    // What a browser sends for a same-origin fetch: one of the two is enough.
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://{self}' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { Origin: 'http://{self}' },
    ]) {
      const result = await call('POST', headers);

      assert.equal(result.status, 200, JSON.stringify(headers));
      assert.equal(result.reached, true);
    }
  });

  test("and a read is never asked", async () => {
    // A navigation from github.com lands on GET /dashboard/callback carrying Sec-Fetch-Site:
    // cross-site, and has to.
    const result = await call('GET', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://github.com' });

    assert.equal(result.status, 200);
  });
});

describe("what a reader without the operator tier is sent", () => {
  test("the snapshot keeps only the fields on the allowlist", () => {
    // The property that matters. Built by picking fields, so anything added to the operational
    // snapshot later is withheld by default rather than published by default - the failure mode
    // of a blocklist is silent, one-way, and only noticed by whoever it exposed.
    const snapshot = service.readerSnapshot('octocat');

    assert.deepEqual(Object.keys(snapshot).sort(), ['app', 'degraded', 'limits', 'now', 'operator', 'viewer']);
    // Which build, and for how long it has been up, are an operator's; /version is what is public.
    assert.deepEqual(Object.keys(snapshot.app).sort(), ['environment', 'name', 'version']);
    assert.deepEqual(Object.keys(snapshot.limits).sort(), ['percentiles', 'reportTtlMs']);
    // The thresholds themselves, not a copy of them: one definition, whoever gates.
    assert.equal(snapshot.limits.percentiles, PERCENTILE_MIN_SAMPLE);
    assert.equal(snapshot.operator, false);
    assert.deepEqual(snapshot.degraded, []);
  });

  test("and costs no read at all", async () => {
    // The database above answers nobody, so a reader's snapshot that read anything would throw -
    // or, had the failure been tolerated, say so in `degraded`. Hence the whole value, not its keys.
    const snapshot = await service.getSnapshot('somebody-else');

    assert.deepEqual(snapshot, { ...service.readerSnapshot('somebody-else'), now: snapshot.now },
      'a reader is sent the base and nothing read beside it');
  });

  test("a partial degradation is reported as one", () => {
    // The defect: `degraded` was derived from a module-level flag afterwards, so one failed
    // read out of four was reset to healthy by the next successful one — the page then
    // reported no degradation while a panel sat empty. It has to come from the per-snapshot
    // set, and the module state may only throttle the log line. That throttle is now per
    // subject, so recovery is asserted per subject too — the assertion below is not a weakened
    // version of the old one.
    const source = dashboardServices();

    assert.match(source, /degraded: \[\.\.\.degraded\]/, 'the page must be told what THIS snapshot could not read');
    assert.doesNotMatch(source, /degraded: historyAvailable/, 'the module flag is not a per-snapshot fact');
    assert.match(source, /if \(!degraded\.has\(what\)\)/, 'recovery is "nothing of that subject degraded", not "one read worked"');
  });
});

describe("the tab the page opens on", () => {
  test("an operator opens on the machine, whatever they contributed", () => {
    assert.equal(service.landingTab({ operator: true, contributions: 12 }), 'ops');
    assert.equal(service.landingTab({ operator: true, contributions: 0 }), 'ops');
  });

  test("a reader with a pull request opens on their own", () => {
    assert.equal(service.landingTab({ operator: false, contributions: 1 }), 'mine');
  });

  test("and one without, on everybody's rather than on an empty tab", () => {
    assert.equal(service.landingTab({ operator: false, contributions: 0 }), 'collective');
  });

  test("is always a tab that tier has, and the tiers differ by the Operations tab alone", () => {
    for (const [tier, operator] of [['reader', false], ['operator', true]]) {
      for (const contributions of [0, 3]) {
        assert.ok(service.LANDING_TABS[tier].includes(service.landingTab({ operator, contributions })),
          `a ${tier} would open on a tab they are not rendered`);
      }
    }

    assert.deepEqual(service.LANDING_TABS.reader, ['mine', 'collective']);
    assert.deepEqual(service.LANDING_TABS.operator, ['mine', 'collective', 'ops']);
  });

  test("is decided by reads that sit apart from the render", () => {
    // A template error is a bug, and belongs to the 500 handler. Rendered inside the try, it
    // would be answered as a 503 blaming the database.
    const body = fn(read('src/services/dashboardService.js'), 'handleGetDashboard');

    assert.ok(body.indexOf('} catch (error) {') !== -1, 'the reads are no longer caught - the marker moved');
    assert.ok(body.indexOf('res.render(') > body.indexOf('} catch (error) {'), 'the page is rendered inside the try');
  });
});

describe("how the figures are computed", () => {
  /** The footnote of a rendered page, as its text */
  const footnoteIn = (html) => {
    const from = html.indexOf('<section class="footnote"');

    return html.slice(from, html.indexOf('</section>', from)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };

  test("is said once, after every tab and before the footer, whoever reads the page", async () => {
    for (const [who, snapshot, mine] of [
      ['a reader with rows', snapshotOf(), mineOf()],
      ['a reader without', snapshotOf(), null],
      ['an operator', operatorSnapshotOf(), null],
    ]) {
      const html = await renderPage(snapshot, { mine, report: reportOf() });
      const at = html.indexOf('<section class="footnote" aria-labelledby="b-footnote">');

      assert.equal(html.split('class="footnote"').length, 2, `${who} is not sent exactly one footnote`);
      assert.ok([...html.matchAll(/role="tabpanel"/g)].every((match) => match.index < at), `${who}: a tab comes after it`);
      assert.ok(at < html.indexOf('<footer>'), `${who}: it is not above the footer`);
      assert.match(html, /<h2 id="b-footnote">How these figures are computed<\/h2>/);
    }
  });

  test("names what counts as ours and who can enrol, as the process was configured", async () => {
    const text = footnoteIn(await renderPage(snapshotOf(), { report: reportOf() }));

    assert.match(text, /Repositories owned by acme, acme-labs; every other repository is elsewhere\./);
    assert.match(text, /verified address at acme\.com\./);
  });

  test("and says so plainly when nothing is treated as ours", async () => {
    // A real deployment state: OWN_GITHUB_ORGS left empty, where every repository is elsewhere.
    // Rendered on its own, because the list is read once, when the process starts.
    const html = await ejs.renderFile(`${ROOT}views/dashboard/footnote.ejs`, {
      footnote: { ownOrgs: [], allowedEmailDomains: ['acme.com'], bots: null, thresholds: PERCENTILE_MIN_SAMPLE },
    });

    assert.match(html, /No owner is configured, so every repository is elsewhere\./);
  });

  test("counts what a bot opened, and says so when it cannot", async () => {
    // The one figure the report leaves out on purpose, so it is the one it has to state.
    assert.match(footnoteIn(await renderPage(snapshotOf(), { report: reportOf() })), /left out: 3, of which 2 merged\./);
    assert.match(footnoteIn(await renderPage(snapshotOf(), { report: null })), /left out: —, of which — merged\./,
      'a count that could not be read is a dash, never a zero and never a missing line');
  });

  test("gives the thresholds the figures are gated on, from their one definition", async () => {
    const text = footnoteIn(await renderPage(snapshotOf()));

    assert.match(text, new RegExp(`A median needs at least ${PERCENTILE_MIN_SAMPLE.p50} values and a p90 at least ${PERCENTILE_MIN_SAMPLE.p90};`));
  });

  test("says what judged, a contributor and a rank are, and where the calendar and the history start", async () => {
    const text = footnoteIn(await renderPage(snapshotOf()));

    assert.match(text, /Pull requests a person opened that were merged\./);
    assert.match(text, /Merged, plus closed without a merge\./);
    assert.match(text, /counted once whatever their case/);
    assert.match(text, /First-time is a login's first pull request opened here/);
    assert.match(text, /A rank since day one is on pull requests merged; a rank in a month, on pull requests opened in it\./);
    assert.match(text, /Months and days are cut in UTC\./);
    assert.match(text, /Collection starts at each person's enrolment; earlier months are incomplete\./);
  });

  test("and nothing of the machine, since every reader is sent it", async () => {
    const text = footnoteIn(await renderPage(operatorSnapshotOf()));

    for (const absent of ['Operations', 'operator', 'DASHBOARD_ALLOWED_LOGINS']) {
      assert.ok(!text.includes(absent), `the footnote mentions ${absent}`);
    }
  });

  test("and a page whose optional reads fail still opens, with a footnote that says so", async () => {
    // The database above answers nobody. A reader's own rows and the report are both unreadable,
    // and neither is a reason to refuse the page: it opens on the Overall tab, which reads its
    // route again, and the footnote says "—" for what it could not count.
    let rendered = null;
    const res = {
      set() {},
      status() { return this; },
      send(body) { rendered = { refused: body }; },
      render(view, locals) { rendered = { view, locals }; },
    };

    await service.handleGetDashboard({ dashboardLogin: 'somebody-else' }, res);

    assert.equal(rendered.view, 'dashboard', `the page was refused: ${rendered.refused}`);
    assert.equal(rendered.locals.landing, 'collective');
    assert.deepEqual(rendered.locals.seed, { mine: null, report: null });
    assert.equal(rendered.locals.footnote.bots, null);
  });
});

describe("the status view", () => {
  test("never concatenates a run's error message straight into innerHTML", () => {
    // A run's error message can quote a git ref, and a git ref is named by whoever opened
    // the pull request. Unescaped, that is stored XSS aimed at whoever operates the bot.
    //
    // The positive half - that the name, the cron and the error are all escaped - is asserted
    // behaviourally in dashboard-ops.test.js, by drawing a hostile job through the real script.
    // This half cannot be: a second unescaped concatenation sitting beside an escaped one draws
    // nothing a render can be asked about. Every script, since any of them may draw a job.
    const scripts = filesUnder('views', '.js');

    assert.ok(scripts.length >= 5, `only ${scripts.length} scripts found under views/`);

    for (const file of scripts) {
      assert.doesNotMatch(read(file), /\+ last\.error \+/, `${file} concatenates a run's error`);
    }
  });

  test("serves its stylesheets and scripts from behind the same gate", () => {
    // Why they are in views/ rather than public/: the static mount is registered
    // unconditionally and ungated, so from there it would hand this page's whole renderer -
    // and the route names inside it - to any anonymous reader, on an instance where /dashboard is
    // meant to be indistinguishable from absent. And why the URLs are under /dashboard/ rather
    // than /dashboard.css: the session cookie is Path=/dashboard, and RFC 6265 only sends it to a
    // path whose next character is "/".
    const index = read('src/index.js');
    const gated = index.slice(
      index.indexOf('if (isDashboardEnabled())'),
      index.indexOf("logger.info('dashboard enabled")
    );

    assert.ok(gated.length > 0, 'the isDashboardEnabled block was not found - the markers moved');
    assert.match(gated, /express\.get\("\/dashboard\/assets\/:name", requireDashboardAccess, handleGetDashboardAsset\)/,
      'the assets must be registered inside the gated block, behind the gate');
  });

  test("and the page links only what that route serves to its reader's tier", async () => {
    // Linked by one list, in load order, and nothing beside it: a <script> or a stylesheet
    // under /dashboard/ that is not on the list is a 404 in the browser and a blank tab.
    for (const [tier, snapshot] of [['reader', snapshotOf()], ['operator', operatorSnapshotOf()]]) {
      const html = await renderPage(snapshot);
      const linked = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="(\/dashboard\/[^"]+)"/g)].map((m) => m[1]);
      const { styles, scripts } = assetsFor(snapshot.operator);

      assert.deepEqual(linked, [...styles, ...scripts].map((name) => `/dashboard/assets/${name}`),
        `the ${tier} page links something the asset list does not serve it`);
    }
  });
});

describe("the dashboard's assets", () => {
  /** Call the handler the way the route does, recording what it answered */
  const call = (name, isOperator) => {
    const passed = [];
    const res = {
      headers: {},
      sent: null,
      set(key, value) { this.headers[key] = value; return this; },
      sendFile(path) { this.sent = path; },
    };

    handleGetDashboardAsset({ params: { name }, isOperator }, res, (arg) => passed.push(arg));

    return { passed, res };
  };

  test("a reader asking for the Operations tab's files is told they do not exist", () => {
    for (const name of ['ops.js', 'ops.css']) {
      const { passed, res } = call(name, false);

      assert.deepEqual(passed, ['route'], `${name} was not refused as a missing route`);
      assert.equal(res.sent, null, `${name} was sent to a reader`);
    }
  });

  test("and so is anyone asking for a name that is not on the list", () => {
    // The list is looked up as own keys only: a name like __proto__ must not reach the object's
    // prototype, and a template beside the scripts must not be served as text.
    for (const name of ['nope.js', 'dashboard.js', 'ops.ejs', '__proto__', 'constructor', '../../src/index.js']) {
      for (const isOperator of [false, true]) {
        const { passed, res } = call(name, isOperator);

        assert.deepEqual(passed, ['route'], `${name} was not refused`);
        assert.equal(res.sent, null);
      }
    }
  });

  test("an operator is sent all of them, and a reader everything else", () => {
    const ops = call('ops.js', true);

    assert.match(ops.res.sent, /views\/dashboard\/ops\.js$/);
    // Revalidated on every load, so a deploy is picked up at once, and never kept by a shared cache.
    assert.equal(ops.res.headers['Cache-Control'], 'private, no-cache');
    assert.match(call('core.js', false).res.sent, /views\/dashboard\/core\.js$/);
    assert.match(call('chart.js', false).res.sent, /node_modules\/chart\.js\/dist\/chart\.umd\.min\.js$/);
  });

  test("and one served out of node_modules is a runtime dependency, which a production install keeps", () => {
    // npm ci --omit=dev is what builds the deployment: a devDependency served here would be a
    // 404 in production and a blank chart, with every test green on a workstation.
    const { dependencies } = JSON.parse(read('package.json'));
    const packages = Object.values(DASHBOARD_ASSETS).flatMap(({ file }) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)?.slice(1) ?? []);

    assert.deepEqual(packages, ['chart.js']);
    assert.ok(packages.every((name) => Object.hasOwn(dependencies, name)), 'a dashboard asset comes from a devDependency');
  });

  test("every file on the list exists", () => {
    for (const [name, { file }] of Object.entries(DASHBOARD_ASSETS)) {
      assert.ok(existsSync(`${ROOT}${file}`), `${name} points at ${file}, which is not there`);
    }
  });

  test("no asset a reader is sent names a route only an operator may use", () => {
    // Their routes answer a reader 404 whatever the script says, but the script is what tells
    // somebody they exist.
    const { styles, scripts } = assetsFor(false);

    for (const name of [...styles, ...scripts]) {
      assert.doesNotMatch(read(DASHBOARD_ASSETS[name].file), /\/dashboard\/manual|\/sync\b/,
        `${name} is sent to every reader and names an operator's route`);
    }
  });

  test("and nothing under test-support/ is ever deployed", () => {
    // It sits outside test/ because node --test runs every file there. The package is an
    // allowlist that does not name it, and the build refuses one that carries it anyway.
    assert.doesNotMatch(read('scripts/build-package.mjs'), /SHIPPED = \[[^\]]*test-support/,
      'the deployment package would carry the test harness');
    assert.match(read('scripts/build-package.mjs'), /\/\^test-support\\\/\//,
      'and build-package.mjs must refuse to build one that does');
  });
});

describe("a contribution is a pull request", () => {
  // pushes and pushes_7d were built on every snapshot, for a five-second loop, and no row of the
  // page ever showed them.
  //
  // Two hops, because the row is renamed at the db boundary: every column a query answers with
  // has to be read by its mapping block, and the camelCase key it maps to has to be used past
  // it - drawn by a script or a template (the footnote is rendered by the server), or read by the
  // service that assembles the report. Whole function bodies, not a 1200-character window: that
  // window once stopped before `AS commits` and checked 7 of the 8.
  //
  // Every read the report is built from, found by what dashboardReport.js imports rather than
  // listed here. Its answer is the final select list; a column there that the query goes on to
  // use itself - to join or order by - is doing a job already.
  const contributions = read('src/db/contributions.js');
  const report = read('src/services/dashboardReport.js');
  const imported = /import \{([^}]*)\} from "\.\.\/db\/contributions\.js"/.exec(report)[1]
    .split(',').map((name) => name.trim()).filter(Boolean);
  // Code only: a comment or an EJS note that names a key is not a reader of it.
  const consumers = [
    ...filesUnder('views', '.js').map((file) => withoutComments(read(file))),
    ...filesUnder('views', '.ejs').map((file) => read(file).replace(/<%#[\s\S]*?%>/g, '')),
    withoutComments(dashboardServices()),
  ].join('\n');

  test("every read the report is built from is held to it", () => {
    assert.ok(imported.length >= 8, `only ${imported.length} reads found - the import stopped matching`);
  });

  for (const name of imported) {
    test(`${name} computes nothing that is never used`, () => {
      const body = fn(contributions, name);
      const sql = /queryText = `([\s\S]*?)`;/.exec(body)[1];
      const last = sql.slice(sql.lastIndexOf('SELECT'));
      // The FROM that opens a line: `IS DISTINCT FROM` inside a filter is not the end of the list.
      const list = last.slice(0, last.search(/\n\s*FROM\b/));
      const rest = last.slice(list.length);
      const selected = [...list.matchAll(/\bAS (\w+)\b/g)].map((match) => match[1]);
      const answers = selected.filter((alias) => !new RegExp(`\\b${alias}\\b`).test(rest));
      const mapped = new Map([...body.matchAll(/(\w+): row\??\.(\w+)\b/g)].map((match) => [match[2], match[1]]));

      assert.ok(selected.length > 0 && mapped.size > 0, `nothing found in ${name} - the pattern stopped matching`);
      assert.deepEqual(answers.filter((alias) => !mapped.has(alias)), [],
        'these are selected and never mapped at the db boundary');
      // Read as a property, named in a destructuring assignment or quoted whole as a key read by
      // name, never merely spelled: `merged` and `month` are words any sentence or local may
      // hold, and `counted` or `one` a parameter list or an object being built.
      const used = (key) => new RegExp(`\\.${key}\\b|\\{[^{}=;]*\\b${key}\\b[^{}=;]*\\}\\s*=|(['"])${key}\\1`).test(consumers);

      assert.deepEqual([...mapped.values()].filter((key) => !used(key)), [],
        'these are computed on every build and used nowhere');
    });
  }
});

describe("re-polling a pull request refreshes what it found", () => {
  const source = read('src/db/pull_requests.js');
  const insert = /INSERT INTO github_pull_requests \(([\s\S]*?)\) VALUES/.exec(source)[1];
  // Bounded to THIS statement, not to the rest of the file. There is a second upsert on the
  // same table below - the one that records a contribution by hand - and an unbounded slice
  // reads its DO UPDATE as part of this one, reporting columns as refreshed that this statement
  // deliberately freezes.
  const conflictAt = source.indexOf('ON CONFLICT (pull_request_id)');
  const conflict = source.slice(conflictAt, source.indexOf('`', conflictAt));

  test("every column is refreshed on conflict, or deliberately frozen", () => {
    // A pull request is captured the day it is opened and re-read until it reaches a final
    // state. A column written on INSERT but missing from DO UPDATE keeps the value it had on
    // first sight for ever - the right answer for six of them and the wrong answer for the rest.
    //
    // FROZEN, each for a measured reason. dest_repo is the name the repository had that day.
    // license, topics, forks_count and stargazers_count are the contribution-time snapshot, the
    // only figures this row is uniquely able to answer for: refreshed on every poll they become
    // one disagreeing copy per contribution, spanning 2,874 stars on apache/kafka.
    // repository_id is frozen as identity - an UPDATE able to move it is an UPDATE able to
    // reassign a contribution to another project.
    //
    // Anything else missing from DO UPDATE is stale by accident: a merged pull request still
    // reading `open`, a commit count frozen at one. Nothing about that looks wrong on the page.
    const FROZEN = ['repository_id', 'dest_repo', 'license', 'topics', 'forks_count', 'stargazers_count'];

    const written = insert.split(',').map((column) => column.trim()).filter(Boolean);
    const refreshed = written.filter((column) => new RegExp(`\\n\\s*${column} = `).test(conflict));

    // The conflict key identifies the row being updated, so it is never on the left of an
    // assignment - and it is not frozen either, it simply cannot change.
    const stale = written
      .filter((column) => column !== 'pull_request_id')
      .filter((column) => !FROZEN.includes(column) && !refreshed.includes(column));

    assert.deepEqual(stale, [], 'these are captured once and never refreshed by a later poll');

    // The other direction, or the list above becomes somewhere to hide a column: every name in
    // it has to be genuinely absent from DO UPDATE.
    const notActuallyFrozen = FROZEN.filter((column) => refreshed.includes(column));

    assert.deepEqual(notActuallyFrozen, [], 'these are listed as frozen and refreshed anyway');
  });

  test("the commit count is one of them", () => {
    // Named on its own because it is the figure the dashboard totals now sum, and because the
    // number a pull request carries on the day it opens is rarely the number it is merged with.
    assert.match(conflict, /\n\s*commits_count = EXCLUDED\.commits_count,/);
  });
});

describe("the repository refresh outlives any one contributor", () => {
  const repositories = read('src/db/repositories.js');
  const job = read('jobs/sync_repositories.js');

  const body = fn(repositories, 'claimRepositoriesForRefresh');

  test("the installation it reads with is any active one, never a contributor's", () => {
    // Binding a repository to the installation of somebody who contributed to it means losing
    // the ability to refresh it the day that person leaves and uninstalls. An installation
    // token reads any public repository, so the choice is free - and an app JWT cannot stand
    // in: measured against the live API, GET /repos/{owner}/{repo} answers 401 with one.
    assert.doesNotMatch(body, /opened_by\s*=\s*gi\.user_login/, 'the claim must not prefer a contributor');
    assert.doesNotMatch(body, /pe\.actor\s*=\s*gi\.user_login/, 'the claim must not prefer a pusher');
    assert.match(body, /installation_suspended = false[\s\S]*installation_deleted = false[\s\S]*verified_at IS NOT NULL/);
    assert.match(body, /ORDER BY gi\.id\s*\n\s*LIMIT 1\) AS installation_id/, 'and it must be a stable choice');
  });

  test("a repository that stops answering is marked gone, not retried forever", () => {
    // Deleted, made private, or transferred out of reach. It fails on every run, so the row
    // leaves the queue - and the verdict is only safe to write because the request carried the
    // ID: an id survives a rename and a transfer, so a 404 against one is a statement about the
    // repository itself and not about a name that moved.
    assert.match(job, /error\.status === 404 \|\| error\.status === 410/);
    assert.match(job, /consecutive404s >= SCHEDULING\.REPO_GONE_AFTER_404/,
      'and not on the first one: a repository made private for an afternoon answers identically');
    assert.match(job, /notFound \? repository\.refresh_404_count \+ 1 : 0/,
      'and on an unbroken run of them: a timeout in between says nothing about the repository');
    assert.match(job, /markRepositoryGone\(/);
    assert.match(repositories, /gone_at = COALESCE\(gone_at, CURRENT_TIMESTAMP\)/,
      'the first sighting is what is kept; a second one is not new information');
    assert.match(body, /r\.gone_at IS NULL/, 'and a marked row leaves the queue');
  });

  test("and nothing else can retire one", () => {
    // Every other queue carries a *_disabled_at column: a verdict the application reached about
    // a subject after failing at it. This one deliberately has none. A repository leaves the
    // refresh queue for two FACTS and no judgements - having no GitHub id, so there is no call
    // to make for it, or having answered 404 by id often enough to be believed.
    assert.doesNotMatch(withoutComments(repositories), /refresh_disabled/);
    assert.doesNotMatch(withoutComments(read('init.sql')), /refresh_disabled/);
    assert.match(body, /r\.github_id IS NOT NULL/);
  });

  test("and a name GitHub could never serve can no longer reach a request", () => {
    // gitlab-community/gitlab-org/gitlab, typed in by hand: a GitLab subgroup path has three
    // segments, so no owner/repo request can be built from it at all. There is deliberately no
    // code handling that case: such a row has no GitHub id, so the claim never returns it, and
    // the job never turns a name into anything.
    assert.doesNotMatch(job, /parseRepoFullname/, 'the refresh has no use for a name at all');
    assert.match(body, /r\.github_id IS NOT NULL/);
  });

  test("it stores the real watcher count, not the alias of the star count", () => {
    // GitHub returns the star count under watchers_count. Storing it would be a second column
    // holding the same number, and it would read as a distinct signal on the page.
    assert.match(repositories, /repository\.subscribers_count/);
    assert.doesNotMatch(repositories, /repository\.watchers_count/);
  });
});

describe("a repository is identified by an id, not only by a name", () => {
  // GitHub frees a renamed repository's name, and somebody else can take it. Matching on the
  // name alone would then move the wrong contributions onto the wrong project.
  const events = read('src/db/events.js');
  const pullRequests = read('src/db/pull_requests.js');

  test("hydration is told which repository ROW, and resolves none itself", () => {
    // The response does carry base.repo.id, and it is GitHub's number. This column is a local
    // key with a foreign key behind it, so turning one into the other is the registry's job -
    // done once by ensureRepository - and not a lookup repeated on every write.
    assert.match(pullRequests, /upsertPullRequest = async \(pullRequest, repositoryId, run = query\)/);
    assert.match(pullRequests, /pull_request_id, number, repository_id,/);
    assert.doesNotMatch(withoutComments(pullRequests), /base\.repo\.id/,
      'a GitHub id written into this table would be a join waiting to be written against it');
  });

  test("and so is the ledger, for both kinds of event", () => {
    assert.match(events, /insertPullRequestEventIfNotExists = async \(pullRequestEvent, repositoryId, run = query\)/);
    assert.match(events, /insertPushEventIfNotExists = async \(pushEvent, repositoryId, run = query\)/);

    // The frozen name stays beside the link, and that is the whole shape of this change: a
    // human reading the ledger months later needs to see what it was called then, and every
    // query needs the row.
    // The two columns in that order in the INSERT list, without pinning where the line breaks
    // fall: what matters is that the link and the frozen name are written together, not the
    // whitespace between them.
    assert.match(fn(events, 'insertPullRequestEventIfNotExists'), /repository_id,\s*repo_fullname\b/);
  });

  test("nothing left in the application joins on a repository name", () => {
    // The defect in one line. Two contributions to a repository renamed between them carry two
    // different frozen names: joined on the name they are two projects, and the day somebody
    // else takes the freed name they become one project with a stranger's contributions in it.
    // Every file in src/db/, found rather than listed: a query file added beside them is held to
    // the same rule without anybody remembering to name it here.
    const files = filesUnder('src/db', '.js');

    assert.ok(files.length >= 8, `only ${files.length} query files found under src/db/`);

    for (const file of files) {
      const source = read(file);

      assert.doesNotMatch(source, /JOIN[^\n]*\bfull_name\s*=/, `${file} joins on a name`);
      assert.doesNotMatch(source, /\bfull_name\s*=\s*\w+\.\w*(repo|name)/, `${file} matches name to name`);
    }
  });
});

describe("a repository gets its row when the contribution is seen, not a tick later", () => {
  const repositories = read('src/db/repositories.js');
  const sync = read('jobs/sync_contributions.js');

  const body = fn(repositories, 'ensureRepository');

  test("both event kinds record their repository, with the id the feed already carries", () => {
    // Measured on the live API: 107 PullRequestEvent out of 107 carry repo.id in the envelope,
    // always equal to the base.repo.id the hydration would read. So this costs no call, and it
    // has to be taken - this is the only creator of a repository row, so a row created without
    // an id could never acquire one.
    const calls = sync.match(/noteEvent\(event, [^)]*\)/g) ?? [];

    assert.equal(calls.length, 2, 'pull request events and push events both, 27 of the 119 repositories in production are known only from a push');
    assert.match(sync, /ensureRepository\(event\.repo\.name, event\.repo\.id, run\)/,
      'the name alone would leave github_id null, and nothing would ever fill it');
  });

  test("and the repository comes FIRST, which is what the foreign key costs", () => {
    // The ledger row references a repository row, so the repository has to exist before it: one
    // indexed no-op insert per event, on a feed that returns the same 300 entries every run.
    //
    // Paid deliberately. The way to avoid it is a second creator of repository rows keyed on
    // something other than the id, and two creators with two keys is how one repository gets
    // two rows.
    const unit = functions(sync).get('noteEvent') ?? '';

    assert.ok(unit.indexOf('ensureRepository') < unit.indexOf('insert(event'),
      'the repository must be written before the ledger row that points at it');
    assert.match(unit, /transaction\(async \(run\) => \{/,
      'and both inside one unit, so a failure leaves neither and the next run retries clean');
  });

  test("the refresh stores what identifies a project, not only what ranks it", () => {
    // description and primary_language are read by people, not by the report: a row that says
    // only "3,392 stars" cannot be recognised by anyone looking at the table.
    const succeeded = fn(repositories, 'markRefreshSucceeded');

    for (const column of ['description', 'primary_language', 'license', 'topics', 'archived', 'pushed_at']) {
      assert.match(succeeded, new RegExp(`${column} = \\$`), `markRefreshSucceeded must write ${column}`);
    }
  });

  test("a repository already known is not written again, and cannot be duplicated", () => {
    // Every contribution to a repository reaches this, and there is nothing to improve once the
    // row exists: the refresh owns the name and every other column, so the conflict does
    // nothing at all rather than taking a write lock to store the same values.
    assert.match(body, /ON CONFLICT \(github_id\) WHERE github_id IS NOT NULL DO NOTHING/,
      'the identity is the GitHub id: a renamed repository cannot get a second row this way. The predicate is repeated because the index is partial - PostgreSQL raises 42P10 without it, and no reading of the source could have told');
    assert.match(body, /refusing to record the repository \$\{fullName\} without a GitHub id/,
      'and an id-less insert would conflict with nothing - two nulls are distinct in the partial unique index, so every event would add another row');
  });

  test("and it hands back the row every child table points at", () => {
    // A boolean was enough while the children held names. They hold a foreign key now, so the
    // caller needs the id - and it cannot come from a second statement, because a statement
    // cannot see its own INSERT: on a fresh insert a following SELECT reads the pre-statement
    // snapshot and finds nothing.
    assert.match(body, /RETURNING id/);
    assert.match(body, /UNION ALL/, 'the insert branch and the lookup branch, exactly one of which returns a row');
    assert.match(body, /ORDER BY branch/, 'and a deterministic order: UNION ALL does not promise one');
  });
});

describe("a lookup says which request failed, not just that one did", () => {
  const source = read('src/services/manualContributionService.js');

  test("a token that cannot be minted is not reported as a missing pull request", () => {
    // Both answer 404. POST /app/installations/{id}/access_tokens does it for an installation
    // this App cannot authenticate as - revoked, or belonging to another App, which is every
    // request a development instance makes against a copy of the production database. Reported
    // as "github does not know this pull request", it sends somebody hunting for a fault in an
    // address that was correct all along. Measured: that is exactly what happened, once.
    assert.match(source, /if \(isTokenMintFailure\(error\)\)/,
      'the status alone cannot tell the two apart - the failing URL can');

    // And the two answers must differ, or telling them apart bought nothing.
    assert.match(source, /'your installation could not be authenticated'/);
    assert.match(source, /'github does not know this pull request'/);
  });

  test("and an infrastructure failure leaves a line in the log", () => {
    // A refusal returned as a value throws nothing, so nothing logs it on its way out. The two
    // that mean something is wrong with the instance have to say so themselves.
    const authBranch = source.slice(source.indexOf('if (isTokenMintFailure(error))'));

    assert.match(authBranch.slice(0, 600), /logger\.warn/);
  });
});

describe("a forge that answered is asked again, never believed", () => {
  const service = read('src/services/manualContributionService.js');
  // Module-private, so sliced by the splitter that also reads unexported declarations.
  const record = functions(withoutComments(service)).get('recordContribution') ?? '';
  // Whichever script draws the form: found by the handler's own marker, not by a file name.
  const saving = filesUnder('views', '.js').map((file) => read(file)).filter((text) => text.includes("target?.id === 'm-save'"));

  test("only the author travels back from the page when GitLab could be read", () => {
    // The GitHub path fetches the pull request a second time rather than trusting the preview
    // it just sent the browser. The GitLab path now reads too, so it owes the same rule - and
    // the two must not blend: a title from the forge beside a date from a form is a row nobody
    // can vouch for. `typed` is that switch, and every field has to sit behind it.
    assert.match(record, /const typed = mr\.needsTyping === true;/);

    const fromPayload = [...record.matchAll(/body\?\.([a-zA-Z]+)/g)].map((m) => m[1]);

    assert.deepEqual([...new Set(fromPayload)].sort(),
      ['author', 'changedFiles', 'commits', 'mergedAt', 'openedAt', 'stars', 'title', 'url'],
      'a field read off the payload that is not in this list is one nobody checked');

    // Six fields, six switches - the author is the seventh and deliberately has none: no forge
    // can answer it, so it is picked on both paths.
    assert.equal((record.match(/\btyped\s*\?/g) ?? []).length, 6);
  });

  test("and the page sends nothing it was not asked for", () => {
    assert.equal(saving.length, 1, `${saving.length} scripts handle the record button - the marker moved`);

    const save = saving[0].slice(saving[0].indexOf("target?.id === 'm-save'"));

    assert.match(save.slice(0, 1200), /body\.author = \$\('g-author'\)\?\.value;/);
    assert.match(save.slice(0, 1200), /if \(manualFound\.needsTyping\) \{/,
      'the typed fields must be conditional, or a stale form would overwrite what was fetched');
  });

  test("merged-only is asked of GitLab wherever GitLab will answer", () => {
    // The rule that makes every entry a fact rather than something to follow. It was enforced
    // on GitHub only, for the honest reason that nothing was read from GitLab.
    assert.equal((service.match(/only merged work can be recorded/g) ?? []).length, 2);
  });
});

describe("a repository is followed by id once its id is known", () => {
  // Four files, because the claim, the route and the job have to agree on what the address is.
  const octokit = read('src/services/octokitService.js');
  const repositories = read('src/db/repositories.js');
  const refreshJob = read('jobs/sync_repositories.js');
  const polling = read('src/db/polling.js');
  const pollJob = read('jobs/poll_non_closed_pull_requests.js');
  const body = fn(octokit, 'fetchRepository');

  test("nothing that FOLLOWS a repository addresses it by name", () => {
    // A rename usually leaves a redirect at the old name. A TRANSFER to another owner does
    // not always: measured on raphi011/amux, which moved to mixpeek/amux and whose old path
    // answers a bare 404 on the API and on the website alike. By name that is indistinguish-
    // able from a deletion, and the repository is retired for having merely moved.
    assert.match(body, /request\('GET \/repositories\/\{id\}'/);

    // One exception, and it is the bootstrap case this test once said did not exist: an
    // operator pastes an address, and an address is made of names. It is admitted by NAME here
    // rather than by pattern, so a second by-name route cannot arrive unnoticed.
    //
    // The hazard does not reach it. Retiring a repository for having moved needs a row that is
    // being followed; this resolves a string a human typed, once, and a 404 on it is answered
    // to that human as "github does not know this pull request". Nothing is marked gone.
    const byName = [...octokit.matchAll(/GET \/repos\/\{owner\}\/\{repo\}[^']*/g)].map((m) => m[0]);

    assert.deepEqual(byName, ['GET /repos/{owner}/{repo}/pulls/{pull_number}'],
      'only the manual lookup may address a repository by name');
    assert.match(fn(octokit, 'pullRequestByName'), /GET \/repos\/\{owner\}\/\{repo\}\/pulls/,
      'and it must be the one that lives in pullRequestByName');

    // The paths that follow a repository must not be able to reach it.
    for (const [name, source] of [['the refresh job', refreshJob], ['the poll job', pollJob]]) {
      assert.doesNotMatch(source, /pullRequestByName/, `${name} must follow by id`);
    }
  });

  test("the claim hands the job the id to follow", () => {
    assert.match(repositories, /RETURNING id, github_id, full_name, etag/);
    // Argument ORDER, not argument layout: `[^)]` matches newlines in JavaScript, so one
    // argument per line is fine and so is renaming the receiver. The previous form failed on
    // either, with no change in behaviour.
    assert.match(refreshJob, /fetchRepository\([^)]*\.installation_id[^)]*\.github_id[^)]*\.etag/);
  });

  test("and so does the poll, which used to carry the address itself", () => {
    // Measured against the live API: an old name answers 301 redirecting to exactly the route
    // below, so GitHub resolves a name into this call. Making it directly skips a hop that a
    // transfer may not have left behind.
    const claim = fn(polling, 'claimPullRequestsForPoll');

    assert.match(claim, /INNER JOIN github_repositories r ON r\.id = c\.repository_id/);
    assert.match(claim, /r\.github_id, r\.full_name/, 'the id for the request, the name for the log line');
    assert.match(octokit, /request\('GET \/repositories\/\{id\}\/pulls\/\{number\}'/);
    assert.match(pollJob, /fetchPullRequest\(claimed\.installation_id, claimed\.github_id, claimed\.number\)/);
    assert.match(pollJob, /upsertPullRequest\(pullRequest, claimed\.repository_id\)/);
  });

  test("and a name it cannot parse can no longer fail a poll", () => {
    // The name is only a log line, so the helper that reads it returns null rather than throwing
    // on anything that is not owner/repo, and format.pr() falls back to "pr #12". A hand-entered
    // three-segment path is enough to reach that.
    assert.doesNotMatch(pollJob, /parseRepoFullname/);
    assert.match(pollJob, /const displayName = \(fullName\) => \{/);
    assert.match(pollJob, /rest\.length === 0 \? \{ owner, name \} : null/);
  });
});
