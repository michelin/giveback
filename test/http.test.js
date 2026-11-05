import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import http from "node:http";
import vm from "node:vm";
import { createHmac } from "node:crypto";
import Express from "express";

// Read by src/services/webhookGuard.js at import time, as the running app reads it.
process.env.WEBHOOK_SECRET = "a-webhook-secret";
// The webhook guard's refusals log a warn.
process.env.LOG_LEVEL = "silent";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The middleware src/index.js declares inline: the /callback throttle, the page security headers,
 * the webhook mount and the last-resort error handler.
 *
 * Importing src/index.js is not an option - it opens a port, starts Bree and connects to
 * PostgreSQL at module scope - and asserting on its source text would only pin the shape of the
 * code, not what it does. The regression this file exists for was invisible in the source: the
 * throttle read req.ip, which is exactly what it should read, and still counted every TCP
 * connection separately because express hands back the rightmost X-Forwarded-For token verbatim.
 * Only running it against a real express instance behind `trust proxy` catches that.
 *
 * So the middleware is cut out of the real file, run in a vm, and mounted on a real Express app
 * that is really listening. Same precedent as the dashboard's page tests, which run its scripts in
 * a vm rather than trusting that a template mentions them. The cost is that the two markers below
 * must keep existing; the assertions in `region` fail loudly the moment one is renamed.
 */
const source = readFileSync(`${ROOT}src/index.js`, 'utf8');

/**
 * The slice of src/index.js between two markers
 * @param {string} start - Literal the region begins with
 * @param {string} end - Literal the region stops before
 * @returns {string} The source between them, `start` included
 */
const region = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end);

  assert.ok(from >= 0, `src/index.js no longer contains: ${start}`);
  assert.ok(to > from, `src/index.js no longer contains, after it: ${end}`);

  return source.slice(from, to);
};

/**
 * A listening app carrying the real /callback throttle, with its counters freshly zeroed
 *
 * `trust proxy` is 1 here for the same reason src/index.js sets it in production: that setting
 * is what makes req.ip an unparsed X-Forwarded-For token, and the whole point of clientKey is
 * to survive it. A harness without it would test the one environment where the bug never was.
 * @returns {Promise<{server: import('node:http').Server, warnings: Array<Object>, clientKey: Function}>}
 */
const throttled = async () => {
  assert.match(source, /express\.set\('trust proxy', 1\)/, 'the throttle is only exercised behind a proxy hop');

  const warnings = [];
  const context = vm.createContext({ isIP, logger: { warn: (fields) => warnings.push(fields) } });
  // The bindings are `const` at script scope, so they never land on the sandbox's global - the
  // trailing expression is how the script hands them back.
  const { clientKey, throttleCallback } = vm.runInContext(
    `${region('const CALLBACK_LIMIT', 'express.get("/callback"')}\n;({ clientKey, throttleCallback });`,
    context,
    { filename: 'index-callback-throttle.js' }
  );

  const express = Express();

  express.set('trust proxy', 1);
  express.get('/callback', throttleCallback, (req, res) => res.json({ enrolled: true }));

  return { server: await listening(express), warnings, clientKey };
};

/**
 * A listening app carrying every real header middleware, plus the two pages they are mounted
 * on and one page that must stay bare
 *
 * Three regions, run in one context: the /dashboard middleware calls setPageSecurityHeaders,
 * which is declared with the /enroll one. Splitting them would leave that call unresolved.
 * @param {{isProduction?: boolean}} [mode] - What src/utils/constants.js would have resolved
 * @returns {Promise<import('node:http').Server>}
 */
const headered = async ({ isProduction = false } = {}) => {
  const express = Express();

  // Each region starts at the comment above its middleware, not at the `express.use(...)`
  // line: the mount path is one of the things under test, and a marker containing it would
  // turn "the policy escaped its page" into "the marker moved" - a failure for the wrong
  // reason.
  vm.runInContext(
    region('// --- headers on every response', "express.set('view engine'")
    + region('// --- security headers for the two pages', 'express.get("/callback"')
    + region('// Defence in depth for the one page', 'express.get("/dashboard/login"'),
    vm.createContext({ express, isProduction }),
    { filename: 'index-page-headers.js' }
  );

  express.get('/dashboard', (req, res) => res.send('dashboard'));
  express.get('/enroll', (req, res) => res.send('enrollment'));
  // Neither policy may reach it.
  express.get('/ping', (req, res) => res.send('pong'));

  return listening(express);
};

/**
 * A listening app carrying the real webhook mount - the guard, and Probot behind it - with a
 * Probot app that records the deliveries it handles
 *
 * The real Probot, not a stand-in: what is under test is where Probot matches a path, and only
 * @octokit/webhooks' own matching shows whether a path the guard does not route can still reach
 * it. `reached` records every request Probot's middleware was handed, whatever it did with it.
 * @returns {Promise<{server: import('node:http').Server, reached: string[], handled: string[]}>}
 */
const webhooked = async () => {
  const { WEBHOOK_PATH, guardWebhooks } = await import('../src/services/webhookGuard.js');
  const { getLogger } = await import('../src/utils/logger.js');
  const { createNodeMiddleware, Probot } = await import('probot');

  const reached = [];
  const handled = [];
  const express = Express();

  const context = vm.createContext({
    express,
    WEBHOOK_PATH,
    guardWebhooks,
    getLogger,
    app: (probot) => probot.on('installation.created', (event) => { handled.push(event.id); }),
    // No delivery here names an installation, so nothing ever authenticates with this key.
    createProbot: ({ overrides }) => new Probot({ appId: 1, privateKey: 'unused', secret: process.env.WEBHOOK_SECRET, ...overrides }),
    createNodeMiddleware: async (...args) => {
      const middleware = await createNodeMiddleware(...args);

      return (req, res, next) => {
        reached.push(req.url);
        return middleware(req, res, next);
      };
    },
  });

  // The region awaits Probot's middleware, as src/index.js does at module scope; a vm script
  // only allows that inside an async function.
  await vm.runInContext(
    `(async () => {\n${region('// Capped and signature-checked before Probot', '// --- security headers for the two pages')}\n})()`,
    context,
    { filename: 'index-webhooks.js' }
  );
  express.use((req, res) => res.status(404).send('Not found.'));

  return { server: await listening(express), reached, handled };
};

/**
 * A listening app carrying the real JSON parser of the manual-entry routes and the real
 * last-resort error handler, around a route that either accepts its body or throws `failure`
 * @param {Error} [failure] - What the route throws once its body is parsed
 * @returns {Promise<{server: import('node:http').Server, logged: Array<{level: string, fields: Object, message: string}>}>}
 */
const erroring = async (failure) => {
  const logged = [];
  const record = (level) => (fields, message) => logged.push({ level, fields, message });
  const express = Express();
  const context = vm.createContext({ express, Express, logger: { warn: record('warn'), error: record('error') } });
  const jsonBody = vm.runInContext(`${region('const jsonBody', 'express.get("/dashboard/manual"')}\n;jsonBody`, context);

  express.post('/dashboard/manual', jsonBody, (req, res) => {
    if (failure) {
      throw failure;
    }

    res.json({ received: req.body });
  });
  vm.runInContext(region('// Last resort.', 'const PORT ='), context, { filename: 'index-last-resort.js' });

  return { server: await listening(express), logged };
};

/**
 * One POST with a body, whatever the server does with it
 * @param {import('node:http').Server} server
 * @param {string} path
 * @param {string|Buffer} body
 * @param {Object} [headers]
 * @returns {Promise<{status: number, body: string}>}
 */
const post = (server, path, body, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request(
    {
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    },
    (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    }
  );

  request.on('error', reject);
  request.end(body);
});

/** @returns {Promise<import('node:http').Server>} An app bound to an ephemeral loopback port */
const listening = (express) => new Promise((resolve) => {
  const server = express.listen(0, '127.0.0.1', () => resolve(server));
});

/**
 * One real HTTP request
 * @param {import('node:http').Server} server
 * @param {string} path
 * @param {Object} [headers]
 * @returns {Promise<{status: number, headers: Object}>}
 */
const get = (server, path, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request(
    { host: '127.0.0.1', port: server.address().port, path, headers },
    (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    }
  );

  request.on('error', reject);
  request.end();
});

/**
 * A Content-Security-Policy header split into its directives
 * @param {string} policy
 * @returns {Map<string, string[]>} Directive name to its source list
 */
const directives = (policy) => new Map(
  policy.split(';').map((directive) => directive.trim().split(/\s+/)).filter(([name]) => name)
    .map(([name, ...sources]) => [name, sources])
);

describe("the /callback throttle counts a client, not a connection", () => {
  test("a caller whose source port changes on every request still spends one budget", async (t) => {
    // The regression, exactly as Azure App Service produces it: its front end appends the client
    // to X-Forwarded-For WITH the source port, and a new TCP connection means a new port. Keyed
    // on the raw req.ip these are 21 different clients and all 21 are served - measured at 40 of
    // 40 before the fix. Keyed on the address, the 21st is the first one over 20.
    const { server, warnings } = await throttled();

    t.after(() => server.close());

    const statuses = [];

    for (let port = 52000; port <= 52020; port += 1) {
      statuses.push((await get(server, '/callback?code=x', { 'X-Forwarded-For': `203.0.113.5:${port}` })).status);
    }

    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200), 'an honest enrollment spends one, twenty must pass');
    assert.equal(statuses[20], 429, 'the 21st request in the window is one client over its budget, whatever port it came from');
    assert.deepEqual(
      warnings.map((fields) => fields.client_ip),
      ['203.0.113.5'],
      'the crossing is logged once, against the address rather than against a port'
    );
  });

  test("two IPv6 clients that differ only in their last group keep separate budgets", async (t) => {
    // The fix that was NOT applied, and must not come back: stripping /:\d+$/ turns "::1" into
    // ":" and "::2" into ":", so unrelated clients share a bucket and throttle each other. Twenty
    // from one address must leave the other's first request untouched.
    const { server } = await throttled();

    t.after(() => server.close());

    for (let spent = 0; spent < 20; spent += 1) {
      assert.equal((await get(server, '/callback?code=x', { 'X-Forwarded-For': '::1' })).status, 200);
    }

    assert.equal(
      (await get(server, '/callback?code=x', { 'X-Forwarded-For': '::2' })).status,
      200,
      'a second IPv6 client must not inherit the first one\'s spent budget'
    );
    assert.equal((await get(server, '/callback?code=x', { 'X-Forwarded-For': '::1' })).status, 429);
  });

  test("a bare IPv6 address is counted whole and a bracketed one loses only its port", async (t) => {
    const { server, clientKey } = await throttled();

    t.after(() => server.close());

    assert.equal(clientKey({ ip: '::1' }), '::1');
    assert.equal(clientKey({ ip: '2001:db8::1' }), '2001:db8::1');
    assert.equal(clientKey({ ip: '[2001:db8::1]:52011' }), '2001:db8::1');
    assert.equal(clientKey({ ip: '203.0.113.5:52011' }), '203.0.113.5');
    assert.equal(clientKey({ ip: '203.0.113.5' }), '203.0.113.5');
  });
});

describe("the security headers on the two pages this app renders", () => {
  test("the policy names every origin the dashboard actually loads from", async (t) => {
    // Taken from the files the page is made of, not from the comment in src/index.js:
    // views/dashboard.ejs links the Google Fonts stylesheet (style-src) which pulls its faces from
    // fonts.gstatic.com (font-src), and core.js shows every person the page names by their avatar,
    // from avatars.githubusercontent.com. Its github.com links
    // are navigations, which no directive here governs. Everything else - the page's own
    // scripts, stylesheets and /dashboard/data polling - is same-origin.
    const server = await headered();

    t.after(() => server.close());

    const policy = directives((await get(server, '/dashboard')).headers['content-security-policy']);

    assert.deepEqual(policy.get('default-src'), ["'none'"], 'everything not named below must be refused');
    assert.ok(policy.get('style-src').includes('https://fonts.googleapis.com'), 'views/dashboard.ejs links the Google Fonts stylesheet');
    assert.ok(policy.get('font-src').includes('https://fonts.gstatic.com'), 'that stylesheet fetches its faces from gstatic');
    assert.ok(policy.get('img-src').includes('https://avatars.githubusercontent.com'), 'a person is shown by their GitHub avatar');
    assert.ok(policy.get('img-src').includes("'self'"), '/images/company_logo.svg is served by this app');
    assert.ok(policy.get('script-src').includes("'self'"), 'the scripts are served from /dashboard/assets/');
    assert.ok(policy.get('connect-src').includes("'self'"), 'the page polls /dashboard/data');
    // The style attributes the scripts write - tints, widths, heights - need this; script-src
    // staying 'self' with no 'unsafe-inline' is what keeps the XSS defence real.
    assert.ok(policy.get('style-src').includes("'unsafe-inline'"));
    assert.ok(!policy.get('script-src').includes("'unsafe-inline'"), 'the page builds its DOM from innerHTML - inline script must stay refused');
  });

  test("each page gets its own policy, and neither reaches a page that is not one", async (t) => {
    // The mount paths are as much under test as the policy strings. /dashboard once had the only
    // policy, because views/enroll.ejs pulled Bootstrap and Font Awesome from two CDNs it does
    // not name; now each page has the policy its own contents need.
    const server = await headered();

    t.after(() => server.close());

    const dashboard = (await get(server, '/dashboard')).headers['content-security-policy'];
    const enroll = (await get(server, '/enroll')).headers['content-security-policy'];

    assert.ok(dashboard, '/dashboard renders a page and must carry a policy');
    assert.ok(enroll, '/enroll renders a page and must carry a policy');
    assert.notEqual(dashboard, enroll, 'one shared policy would be the union of the two, which over-permits the public page');
    // /, /ping and the 404 answer with one sentence and no markup. A policy there would be
    // inert: one this strict is checked against the two pages only.
    assert.equal((await get(server, '/ping')).headers['content-security-policy'], undefined);
    for (const policy of [dashboard, enroll]) {
      assert.ok(!policy.includes('cdn.jsdelivr.net') && !policy.includes('cdnjs.cloudflare.com'), 'no page in this app loads a CDN any more - neither policy may re-admit one');
    }
  });

  test("the public page is held tighter than the gated one, because it does less", async (t) => {
    // The dashboard has to relax three things to work: it runs a script, polls /dashboard/data
    // and emits 26 markup style attributes. The enrollment page does none of that, so none of
    // those relaxations belong on the page a stranger reaches - and the moment one appears
    // here, something on that page started needing it.
    const server = await headered();

    t.after(() => server.close());

    const policy = directives((await get(server, '/enroll')).headers['content-security-policy']);

    assert.deepEqual(policy.get('default-src'), ["'none'"]);
    assert.equal(policy.get('script-src'), undefined, 'the page has no script - default-src none refuses one');
    assert.equal(policy.get('connect-src'), undefined, 'and it fetches nothing');
    assert.ok(!policy.get('style-src').includes("'unsafe-inline'"), 'the styles live in public/enroll.css - not one inline style attribute is rendered');
    assert.ok(policy.get('style-src').includes("'self'"), '/base.css and /enroll.css are served by this app');
    assert.ok(policy.get('style-src').includes('https://fonts.googleapis.com'), 'the page links the Google Fonts stylesheet');
    assert.ok(policy.get('font-src').includes('https://fonts.gstatic.com'), 'which fetches its faces from gstatic');
    assert.deepEqual(policy.get('img-src'), ["'self'"], 'only the logo - no avatars on this page');
    assert.deepEqual(policy.get('frame-ancestors'), ["'none'"], 'a framed copy of an OAuth entry page is a phishing surface');
  });

  test("both pages carry the headers that do not depend on what they load", async (t) => {
    // Shared through setPageSecurityHeaders and the app-wide middleware, so this asserts the
    // sharing as much as the values: the same three, identical, on both.
    const server = await headered();

    t.after(() => server.close());

    for (const path of ['/dashboard', '/enroll']) {
      const { headers } = await get(server, path);

      assert.equal(headers['x-frame-options'], 'DENY', `${path}: frame-ancestors covers modern browsers, this covers the rest`);
      assert.equal(headers['x-content-type-options'], 'nosniff', `${path}`);
      assert.equal(headers['referrer-policy'], 'no-referrer', `${path}: neither URL is for github.com to read - one is gated, the other names a rejection reason`);
    }
  });
});

describe("the headers on every response", () => {
  test("nosniff everywhere, and no banner naming the framework", async (t) => {
    // App-wide, unlike the page policies: a JSON answer or a plain sentence is as sniffable as
    // a page, and X-Powered-By is on every response Express sends unless it is turned off.
    const server = await headered();

    t.after(() => server.close());

    for (const path of ['/ping', '/dashboard', '/enroll', '/no-such-route']) {
      const { headers } = await get(server, path);

      assert.equal(headers['x-content-type-options'], 'nosniff', path);
      assert.equal(headers['x-powered-by'], undefined, `${path} names the framework`);
    }
  });

  test("HSTS in production only, where the platform serves https and nothing else", async (t) => {
    const development = await headered();
    const production = await headered({ isProduction: true });

    t.after(() => {
      development.close();
      production.close();
    });

    // From http://localhost the header would pin a developer's browser to an https the laptop
    // does not serve.
    assert.equal((await get(development, '/ping')).headers['strict-transport-security'], undefined);
    assert.equal((await get(production, '/ping')).headers['strict-transport-security'], 'max-age=31536000');
  });
});

describe("the webhook endpoint", () => {
  // What GitHub sends: a signed installation.created.
  const body = '{"action":"created"}';
  const headers = {
    'x-github-event': 'installation',
    'x-github-delivery': 'd-1',
    'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex')}`,
  };

  test("a genuine delivery passes the guard and is handled by Probot", async (t) => {
    // Probot mounted on a route sees req.url unchanged, and the body in the form the guard hands
    // over. A slip in either and Probot passes the delivery on, or waits on a spent stream.
    const { server, handled } = await webhooked();

    t.after(() => server.close());

    assert.equal((await post(server, '/api/github/webhooks', body, headers)).status, 200);
    assert.deepEqual(handled, ['d-1']);
  });

  test("a path the guard does not route never reaches Probot", async (t) => {
    // @octokit/webhooks resolves dot segments and strips every trailing slash, and Express does
    // neither: mounted app-wide, Probot also handled these four spellings, which the guard's
    // route does not match. On the guard's route only, they are the app's 404.
    const { server, reached, handled } = await webhooked();

    t.after(() => server.close());

    for (const path of ['/api/github/webhooks//', '/api/github/./webhooks', '/api/github/x/../webhooks', '/api/github/%2e/webhooks']) {
      assert.equal((await post(server, path, body, headers)).status, 404, path);
    }

    assert.deepEqual(reached, [], 'Probot was handed a request the guard never saw');
    assert.deepEqual(handled, []);
  });
});

describe("the last-resort error handler", () => {
  test("a body the dashboard JSON parser refuses is answered with its own status", async (t) => {
    // 400, 413 and 415 are what body-parser decided; the handler used to answer all three 500.
    const { server, logged } = await erroring();

    t.after(() => server.close());

    for (const [status, body, headers] of [
      [400, '{"title": oops}', {}],
      [413, JSON.stringify({ title: 'x'.repeat(20 * 1024) }), {}],
      [415, '{}', { 'content-encoding': 'gzip' }],
    ]) {
      const response = await post(server, '/dashboard/manual', body, headers);

      assert.equal(response.status, status);
      assert.equal(typeof JSON.parse(response.body).error, 'string', 'a small JSON error, as the page reads one');
    }

    assert.deepEqual(logged.map(({ level }) => level), ['warn', 'warn', 'warn'], 'a refused body needs no human');
    // body-parser attaches the raw text as err.body, and JSON.parse quotes it in its message.
    assert.doesNotMatch(JSON.stringify(logged), /oops|xxxx/, 'the client\'s body reached the log');
  });

  test("a failure of ours is still a 500 logged at error, even one carrying a status", async (t) => {
    // An Octokit RequestError carries GitHub's status: a 404 from GitHub is not the client's.
    const failure = Object.assign(new Error('Not Found'), { status: 404 });
    const { server, logged } = await erroring(failure);

    t.after(() => server.close());

    assert.equal((await post(server, '/dashboard/manual', '{}')).status, 500);
    assert.deepEqual(logged.map(({ level }) => level), ['error']);
  });
});

describe("a request has a bounded time to arrive", () => {
  test("30 s rather than Node's 300, so a trickled webhook body cannot hold memory for minutes", () => {
    // Pinned at the source: the server is created by express.listen() at the end of index.js,
    // which no test here starts, and a real 408 takes Node's 30 s check interval to observe.
    const [, timeout] = source.match(/^server\.requestTimeout = ([\d_]+);$/m) ?? [];

    assert.ok(timeout, 'server.requestTimeout is no longer set on the listening server');
    assert.ok(Number(timeout.replaceAll('_', '')) <= 30_000, `requestTimeout is ${timeout} ms`);
  });
});
