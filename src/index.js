import Express from "express";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { createNodeMiddleware, createProbot } from "probot";
import app from "./app.js";
import { getLogger, format } from "./utils/logger.js";
import { startBree, stopBree } from "./services/breeService.js";
import { handleGetCallback, handleGetEnroll } from "./services/endpointService.js";
import {
  handleGetDashboard,
  handleGetDashboardData,
  handleGetDashboardLogin,
  handleGetDashboardCallback,
  handleGetDashboardLogout,
  handlePostDashboardUserSync,
} from "./services/dashboardService.js";
import { handleGetDashboardContributions } from "./services/dashboardReport.js";
import { handleGetMyContributions } from "./services/dashboardMine.js";
import { handleGetDashboardAsset } from "./services/dashboardAssets.js";
import { isDashboardEnabled, requireDashboardAccess, requireSameOrigin } from "./services/dashboardAuth.js";
import {
  handleGetManualContributions,
  handlePostManualLookup,
  handlePostManualContribution,
  handleDeleteManualContribution,
} from "./services/manualContributionService.js";
import { getAppMetadata } from "./services/octokitService.js";
import { WEBHOOK_PATH, guardWebhooks } from "./services/webhookGuard.js";
import packageJson from "../package.json" with { type: "json" };
import { validateEnv } from "./utils/validateEnv.js";
import { isProduction } from "./utils/constants.js";
import { query as dbQuery, closePool } from "./db/index.js";

const logger = getLogger("index");

const bootedAt = Date.now();

/**
 * Stop the process without truncating the log
 *
 * process.exit() discards whatever pino's async transport has not flushed — measured on this
 * logger, most of a burst is lost. Setting the code and letting the loop end drains it.
 */
const exitWith = (code) => {
  process.exitCode = code;
};

// A fail-fast check, not a gate: the imports above are hoisted and several read process.env
// at load time, so they have already run by the time this does.
try {
  validateEnv();
} catch (error) {
  logger.fatal({ err: error }, `${error.message} - exiting`);
  exitWith(1);
  throw error;
}

// Local development only: GitHub cannot reach a laptop behind a corporate proxy, so
// smee.io relays the webhooks. Never set WEBHOOK_PROXY_URL in a hosted environment.
let smee;
if (process.env.WEBHOOK_PROXY_URL) {
  try {
    const SmeeClient = (await import("smee-client")).default;
    smee = new SmeeClient({
      source: process.env.WEBHOOK_PROXY_URL,
      target: `http://localhost:${process.env.PORT || 3000}/api/github/webhooks`,
      // Wrapped, not the raw instance: smee-client writes capitalized lines of its own at
      // info and repeats the channel URL in each — and that URL is a capability, since anyone
      // holding it receives this app's webhooks. Its info is per-delivery bookkeeping that
      // duplicates the request line below, hence trace rather than debug.
      logger: {
        info: (...args) => logger.trace(args.map(String).join(' ')),
        warn: (...args) => logger.debug(args.map(String).join(' ')),
        error: (...args) => logger.debug(args.map(String).join(' ')),
      },
    });
    smee.start();
    logger.info('smee webhook relay started (local development)');
    logger.debug({ smee_channel: process.env.WEBHOOK_PROXY_URL }, 'smee channel configured');
  } catch (error) {
    // No tunnel means no webhook ever arrives, which looks exactly like "nobody is installing
    // the app" — worth an error, not a warning.
    logger.error({ err: error }, `smee webhook relay could not start, no webhook will be received: ${error.message}`);
  }
}

const express = Express();

// Azure App Service terminates TLS at its front end and forwards over http, so without this
// req.protocol reads "http" and the OAuth redirect_uri built from it stops matching the
// https one registered on the app. 1, not `true`: trust the single hop in front of us, never
// an arbitrary X-Forwarded-For chain a client can extend.
if (isProduction) {
  express.set('trust proxy', 1);
}

// --- headers on every response -------------------------------------------------------------

// X-Powered-By tells a scanner which advisories to try and tells a reader nothing.
express.disable('x-powered-by');

// Ahead of every route, Probot's and the static files included, because neither depends on what
// the response is. nosniff stops a browser from running a response as a type other than the one
// it is declared as - a JSON answer as script, say. HSTS only in production: the platform serves https only, and sent from
// http://localhost the header would pin a developer's browser to an https the laptop does not
// serve.
express.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');

  if (isProduction) {
    res.set('Strict-Transport-Security', 'max-age=31536000');
  }

  next();
});

express.set('view engine', 'ejs');
express.set('views', fileURLToPath(new URL('../views', import.meta.url)));
express.use(Express.static(fileURLToPath(new URL('../public', import.meta.url))));

/**
 * Ask GitHub which app these credentials belong to
 *
 * Called on every start whether or not the install URL is configured, for two reasons that
 * have nothing to do with the button: it names the app in the log, which is otherwise
 * invisible — a local instance pointing at the production app looks exactly like a correctly
 * configured one — and it exercises APP_ID and PRIVATE_KEY, which are otherwise first used on
 * the first webhook, long after the deploy reported success.
 * @returns {Promise<?string>} Derived install URL, or null if it could not be determined
 */
const identifyApp = async () => {
  try {
    const { slug, html_url: htmlUrl } = await getAppMetadata();

    logger.info(`authenticated as github app ${slug}`);

    return `${htmlUrl}/installations/new`;
  } catch (error) {
    // A warn: the app runs, only the button is affected — though it does mean the credentials
    // or the network are not working, which the next GitHub call will confirm.
    logger.warn({ err: error }, `could not identify this github app - the install button stays hidden: ${error.message}`);

    return null;
  }
};

express.locals.retryUrl = process.env.GITHUB_APP_PUBLIC_URL || null;

// Deliberately not awaited: behind a dead proxy this call burns its full retry budget, and
// blocking here would delay the port opening by that long.
identifyApp().then((derived) => {
  // A configured URL wins — it can be a vanity or proxied address that is not derivable. With
  // neither, the button stays hidden rather than pointing at a plausible-but-wrong app.
  express.locals.retryUrl ??= derived;

  if (express.locals.retryUrl) {
    const source = process.env.GITHUB_APP_PUBLIC_URL ? 'GITHUB_APP_PUBLIC_URL' : 'derived from GET /app';
    logger.info(`install url ${express.locals.retryUrl} (${source})`);
  } else {
    logger.warn('no install url available - the enrollment page will not offer a way to install the app');
  }
});

let shuttingDown = false;

// A request arriving mid-shutdown would otherwise reach a pool being destroyed and report a
// stack trace for what is an orderly stop. Connection: close also tells a keep-alive client to
// stop reusing its socket, which is what lets the server finish closing.
express.use((req, res, next) => {
  if (!shuttingDown) {
    next();
    return;
  }

  res.set('Connection', 'close');
  res.status(503).json({ error: 'shutting down' });
});

// One line per request, at debug — without it a mistyped webhook path or a probe scanning the
// instance leaves no trace at all.
//
// req.path, never req.originalUrl: the query string of /callback carries the one-time OAuth
// code, and of /enroll the rejection reason. Neither belongs in a log line.
express.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    logger.debug(
      { method: req.method, url: req.path, status: res.statusCode, duration_ms: Date.now() - startedAt },
      `${req.method} ${req.path} ${res.statusCode} in ${format.duration(Date.now() - startedAt)}`
    );
  });

  next();
});

// Capped and signature-checked before Probot reads a byte - see src/services/webhookGuard.js.
//
// Probot is mounted on the guard's own route, behind it, and nowhere else. Mounted app-wide it
// matched the path itself, and @octokit/webhooks resolves `.` and `..` segments and strips every
// trailing slash where Express does neither: /api/github/webhooks// or /api/github/./webhooks
// missed the guard and still reached Probot, which buffers the whole body, uncapped, before it
// checks the signature. Now a path Express does not route here gets the 404 below. A route, not
// express.use(WEBHOOK_PATH, ...): use strips its mount path from req.url, and Probot compares
// req.url with webhooksPath.
//
// Our logger rather than the one Probot builds for itself: Probot and @octokit/webhooks log an
// error with the whole delivery attached, and only ours has the serializer that strips it.
// webhooksPath named, so the guard and Probot can never disagree on the path.
express.post(WEBHOOK_PATH, guardWebhooks, await createNodeMiddleware(app, {
  probot: createProbot({ overrides: { log: getLogger("probot") } }),
  webhooksPath: WEBHOOK_PATH,
}));

// --- security headers for the two pages this app renders ----------------------------------

/**
 * The two headers that do not depend on what a page loads, so both pages carry the same ones
 *
 * Shared rather than restated per mount: they are a policy about this app, not about a page,
 * and the day one of them changes it must change in both places or in neither.
 * @param {import('express').Response} res
 */
const setPageSecurityHeaders = (res) => {
  // Neither page is meant to be framed. /dashboard carries the app's only state-changing
  // control; /enroll is the entry point of an OAuth flow, and a framed copy of it is a
  // phishing surface and nothing else. X-Frame-Options as well as frame-ancestors, because
  // the header still covers the browsers that ignore the directive.
  res.set('X-Frame-Options', 'DENY');
  // /dashboard is a gated page whose URL is not worth handing to github.com or an avatar CDN.
  // /enroll carries the rejection reason in its query string - ?reason=no-allowed-email says
  // that this person failed the employee check - and it links out to github.com.
  res.set('Referrer-Policy', 'no-referrer');
};

// The enrollment page. Its policy is STRICTER than the dashboard's below, because the page is
// simpler: it renders no script, no form and not one inline style attribute, so nothing here
// has to be relaxed to let it work. default-src 'none' then refuses script outright.
//
// It is worth having even though nothing on the page is user input today. The template
// renders page.lead and every step with <%- %>, unescaped, which is safe only for as long as
// those strings stay literals in src/utils/enrollmentPages.js. This is the net under that.
//
// Mounted on /enroll rather than app-wide: the only other HTML this app returns is a
// one-sentence body from /, /ping and the 404, and a policy this strict is checked against
// this page only.
express.use('/enroll', (req, res, next) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self' https://fonts.googleapis.com; "
    + "font-src https://fonts.gstatic.com; img-src 'self'; "
    + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  setPageSecurityHeaders(res);
  next();
});

/**
 * OAuth callbacks one client may spend per window
 *
 * Both callbacks exchange whatever `?code=` they are handed for a token, with the app's client
 * secret, and /callback cannot carry a nonce (endpointService says why). Unthrottled, an anonymous
 * caller drives one authenticated request to GitHub per request, enough to trip GitHub's abuse
 * detection on this OAuth client and break enrollment for everyone. An honest visit spends one.
 */
const CALLBACK_LIMIT = 20;
const CALLBACK_WINDOW_MS = 60_000;

// A fixed window, dropped whole at each rollover: counting is per instance anyway, and the reset
// is what bounds the map's size.
let callbackWindowStartedAt = Date.now();
let callbackHits = new Map();

/**
 * The address to count against, without a source port
 *
 * Behind `trust proxy`, req.ip is the rightmost X-Forwarded-For token verbatim, and Azure App
 * Service's front end writes it with the client's port: unstripped, every connection would get
 * its own bucket. isIP decides rather than a /:\d+$/ strip, which would eat an IPv6 address's
 * last group and merge unrelated clients into one bucket.
 * @param {import('express').Request} req
 * @returns {string} A bare address where one can be recovered, the raw value otherwise
 */
const clientKey = (req) => {
  const raw = String(req.ip ?? '');

  if (isIP(raw)) {
    return raw;
  }

  const bracketed = /^\[(.+)\]:\d+$/.exec(raw);

  if (bracketed && isIP(bracketed[1])) {
    return bracketed[1];
  }

  const withoutPort = raw.slice(0, raw.lastIndexOf(':'));

  return isIP(withoutPort) ? withoutPort : raw;
};

const throttleCallback = (req, res, next) => {
  const now = Date.now();

  if (now - callbackWindowStartedAt >= CALLBACK_WINDOW_MS) {
    callbackWindowStartedAt = now;
    callbackHits = new Map();
  }

  const key = clientKey(req);
  const spent = (callbackHits.get(key) ?? 0) + 1;

  callbackHits.set(key, spent);

  if (spent > CALLBACK_LIMIT) {
    // On the crossing only, so a flood of requests does not become a flood of lines.
    if (spent === CALLBACK_LIMIT + 1) {
      logger.warn(
        { client_ip: key, limit: CALLBACK_LIMIT, window_ms: CALLBACK_WINDOW_MS },
        `oauth callbacks from ${key} exceeded ${CALLBACK_LIMIT} per minute - answering 429 until the window rolls over`
      );
    }

    res.status(429).json({ error: 'too many sign-in attempts, try again in a minute' });
    return;
  }

  next();
};

// The callback performs the enrollment and redirects; /enroll renders the outcome. Two
// routes rather than one because the OAuth code is single-use: a page rendered directly by
// the callback breaks on the first refresh.
express.get("/callback", throttleCallback, handleGetCallback);
express.get("/enroll", handleGetEnroll);

// Registered only when they can be guarded: without SESSION_SECRET there is no way to sign a
// session, so the routes are left off rather than served unprotected. Unregistered routes fall
// through to the 404 handler, making a disabled dashboard indistinguishable from an absent one.
if (isDashboardEnabled()) {
  // Defence in depth for the one page in this app that builds its whole DOM from innerHTML.
  // The scripts in views/dashboard/ escape at every one of their call sites today, but that is
  // a single helper called by hand a hundred times with no second layer, and the strings they
  // render are GitHub-controlled — a branch name may legally be `<img src=x onerror=...>`.
  //
  // Its own policy rather than the enrollment page's, and looser in three places: this page
  // runs scripts, polls endpoints and loads avatars from GitHub, none of which /enroll
  // does. One shared policy would have to be the union of the two, which would hand the
  // public page permissions it has no use for.
  //
  // 'unsafe-inline' in style-src is required, not laziness: the dashboard's scripts write two
  // kinds of style attribute - a tile's tint and a sparkline bar's height.
  // The XSS defence here is default-src 'none' plus script-src 'self', which stays intact —
  // there are no inline <style> blocks and no inline event handlers on this page to protect.
  //
  // The two img-src hosts are both needed: /images/company_logo.svg is self, and every person the
  // page names is shown by their GitHub avatar, from avatars.githubusercontent.com.
  express.use('/dashboard', (req, res, next) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + "font-src https://fonts.gstatic.com; img-src 'self' https://avatars.githubusercontent.com; "
      + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
    setPageSecurityHeaders(res);
    next();
  });

  express.get("/dashboard/login", handleGetDashboardLogin);
  express.get("/dashboard/callback", throttleCallback, handleGetDashboardCallback);
  express.get("/dashboard/logout", handleGetDashboardLogout);

  // Every write below, before any session is read - see requireSameOrigin().
  express.use('/dashboard', requireSameOrigin);

  express.get("/dashboard/data", requireDashboardAccess, handleGetDashboardData);
  // Its own route because it is on its own clock: the report is cached for a minute, where the
  // snapshot above must never be.
  express.get("/dashboard/contributions", requireDashboardAccess, handleGetDashboardContributions);
  // Scoped to the session's own login, with nothing in the path to point somewhere else. Its
  // own route because its answer differs per reader: there is nobody to share a cache with.
  express.get("/dashboard/mine", requireDashboardAccess, handleGetMyContributions);
  // Operator tier, checked inside the handler. POST rather than GET so the SameSite=Lax session
  // cookie, and requireSameOrigin above, are what stop it being fired from another site.
  express.post("/dashboard/users/:userId/sync", requireDashboardAccess, handlePostDashboardUserSync);

  // Recording a contribution by hand: operator tier, checked inside each handler, which answers
  // 404 rather than 403 to anyone else.
  //
  // The JSON parser is mounted HERE and not on the app, deliberately. Probot verifies a webhook
  // signature against the RAW body, so a global parser would consume the stream before it and
  // every webhook would start failing its signature check - silently, since a rejected webhook
  // is a 400 GitHub retries and nothing here logs.
  //
  // 16kb because the largest of these payloads is a pull request title and a URL.
  //
  // inflate off because the page's fetch() never compresses a body, and decoding one is what put
  // these routes in reach of CVE-2026-111497 (Node2Shell), a Brotli decoder bug any enrolled
  // reader could trigger: the operator check runs in the handler, after the body is parsed. Off,
  // body-parser refuses the body with a 415 before zlib sees a byte, whatever runtime the host
  // picks - answered as a 415 by the last-resort handler at the end of this file, like its 400
  // and 413.
  const jsonBody = Express.json({ limit: '16kb', inflate: false });

  express.get("/dashboard/manual", requireDashboardAccess, handleGetManualContributions);
  express.post("/dashboard/manual/lookup", requireDashboardAccess, jsonBody, handlePostManualLookup);
  express.post("/dashboard/manual", requireDashboardAccess, jsonBody, handlePostManualContribution);
  express.delete("/dashboard/manual/:id", requireDashboardAccess, handleDeleteManualContribution);
  express.get("/dashboard", requireDashboardAccess, handleGetDashboard);

  // The page's stylesheets and scripts, which live beside its templates in views/dashboard/
  // rather than under the ungated public/ mount: served from there they would hand the whole
  // dashboard renderer and the route names above to any anonymous reader, on an instance where
  // /dashboard is meant to be indistinguishable from absent. Gated like the page instead —
  // requireDashboardAccess refuses with next('route'), so a refused reader falls through to
  // the 404 below, and with no SESSION_SECRET the assets are never registered at all. The
  // Operations tab's two files are refused the same way to anyone without the operator tier.
  //
  // Under /dashboard/, not /dashboard.css: the session cookie is Path=/dashboard and RFC 6265 only
  // path-matches when the next character is "/", so /dashboard.css would arrive without the
  // cookie and be answered with the login redirect on every load.
  express.get("/dashboard/assets/:name", requireDashboardAccess, handleGetDashboardAsset);

  logger.info('dashboard enabled at /dashboard - github oauth, enrolled users only');
} else {
  // info, not warn: running without the page is a valid configuration. The line exists so
  // "why is /dashboard a 404" has an answer in the log rather than in the source.
  logger.info('dashboard disabled - set SESSION_SECRET to enable it');
}

express.get("/", (req, res) => {
  res.status(200).send("🤖");
});

express.get("/ping", (req, res) => {
  res.json({ status: "pong" });
});

// Only the edges of a health outage are logged, so this remembers which side we are on.
let healthy = true;

// What a probe needs and nothing more: the route is public, and the backlog, the schedule and
// the enrolment counts are the operator's to read, on the dashboard's Operations tab.
express.get("/health", async (req, res) => {
  // Only the query is tried: a failure after it is not the database's, and must not be
  // reported as "disconnected".
  try {
    await dbQuery('SELECT 1 as health_check');
  } catch (error) {
    // The transition, not the probe: a platform probing every 30s wrote 240 error lines an
    // hour for one condition, and nothing at all when it recovered.
    if (healthy) {
      healthy = false;
      logger.error({ err: error }, `health check failed - returning 503 until it recovers: ${error.message}`);
    }

    res.status(503).json({
      status: "unhealthy",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (!healthy) {
    healthy = true;
    logger.info('health check recovered - the database is reachable again');
  }

  res.json({
    status: "healthy",
    database: "connected",
    timestamp: new Date().toISOString(),
  });
});

express.get("/version", (req, res) => {
  res.json({
    name: packageJson.name,
    version: packageJson.version,
    // Deployments are zip-based, so the package version says nothing about what is
    // actually running. Set APP_REVISION at deploy time to answer "which commit is live".
    revision: process.env.APP_REVISION || "unknown",
    // The runtime is chosen by the host, not by this repository - App Service picks the patch
    // inside its NODE|<major>-lts image. Answering it here is the difference between reading
    // a fact and downloading the container log to infer one.
    node: process.version,
  });
});

// Anything not matched above. Express answers an unmatched route with its own HTML page
// naming the method and path, which is noise on a public endpoint.
express.use((req, res) => {
  res.status(404).send("Not found.");
});

// Last resort. Outside production Express prints the stack trace of any handler error
// straight into the response — absolute filesystem paths included — and logs nothing.
// Here it is the other way round: the stack goes to the log, the user gets a sentence.
//
// Except a request refused for what the client sent - body-parser's 400 for JSON that does not
// parse, 413 past the 16kb limit, 415 for a compressed body, or send's 412 and 416 for a
// dashboard asset's conditional or range request - which is answered with its own status. `expose` is how http-errors marks one: an Octokit error carries a `status` too, but that
// is GitHub's answer to us, and a 500 the operator has to see. A warn, not an error: nothing here
// needs a human. And logged without the error: its `body` is the client's raw text, and
// JSON.parse quotes that text in its message.
// eslint-disable-next-line no-unused-vars
express.use((error, req, res, next) => {
  if (error.expose && error.status >= 400 && error.status < 500) {
    logger.warn(
      { method: req.method, url: req.path, status: error.status, type: error.type },
      `${req.method} ${req.path} refused (${error.type ?? 'client error'}) - answering ${error.status}`
    );

    res.status(error.status).json({ error: error.message });
    return;
  }

  logger.error(
    { err: error, method: req.method, url: req.path },
    `unhandled error on ${req.method} ${req.path}: ${error.message}`
  );

  // A render that failed halfway has already flushed a status and part of a body; there
  // is nothing left to say.
  if (res.headersSent) {
    return;
  }

  res.status(500).send("An internal error occurred.");
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const revision = process.env.APP_REVISION || 'unknown revision';

const server = express.listen(PORT, HOST, () => {
  logger.info(`server listening on http://${HOST}:${PORT} - ${packageJson.name} v${packageJson.version} (${revision})`);
});

// How long a client has to finish SENDING its request, body included - not how long a handler
// may take to answer. Node's default is 300 s, which lets an anonymous caller hold a webhook body
// in memory for five minutes by trickling it, and so pin far more of them at once. Every request
// this app accepts is small: 30 s is generous. Node checks it every 30 s, so a slow request is
// cut between 30 and 60 s in.
server.requestTimeout = 30_000;

// How long a shutdown waits for in-flight requests before cutting the sockets. Below any
// platform's grace period, so the process ends on its own terms rather than being killed.
const DRAIN_TIMEOUT_MS = 5000;

/**
 * Refuse new work, close idle sockets, wait for the in-flight ones, cut whatever is left, and
 * only then release the pool.
 *
 * The ordering is the whole point. server.close() only stops ACCEPTING connections — an open
 * keep-alive socket stays open, and a browser polling /dashboard/data every five seconds holds
 * exactly such a socket. Release the pool first and every subsequent poll answers 500 with a
 * full stack, while the process cannot exit at all because the server still has a live
 * connection.
 */
const shutdown = async (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  const shutdownStartedAt = Date.now();

  logger.info(`${signal} received - shutting down after ${format.duration(shutdownStartedAt - bootedAt)} of uptime`);

  // Without closeIdleConnections a keep-alive connection alone keeps close() pending forever.
  server.close();
  server.closeIdleConnections?.();

  // Bounded: a hung request must not hold the shutdown open past the platform's grace period.
  const drained = await Promise.race([
    new Promise((resolve) => server.once('close', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
  ]);

  if (!drained) {
    logger.warn(`in-flight requests did not finish within ${format.duration(DRAIN_TIMEOUT_MS)} - closing their connections`);
    server.closeAllConnections?.();
  }

  try {
    await stopBree();
  } catch (error) {
    logger.error({ err: error }, `the scheduler did not stop cleanly: ${error.message}`);
  }

  try {
    await smee?.stop?.();
  } catch {
    // best effort
  }

  try {
    await closePool();
  } catch (error) {
    logger.error({ err: error }, `the database pool did not close cleanly: ${error.message}`);
  }

  // No process.exit(): the loop ends on its own, and pino gets to flush this last line.
  logger.info(`shutdown complete in ${format.duration(Date.now() - shutdownStartedAt)} - scheduler stopped, database pool released`);
};

try {
  await startBree();
} catch (error) {
  // No scheduler means the app captures nothing. Fail loudly instead of serving 200s.
  // The cause is not interpolated: ` - exiting` is the greppable suffix every fatal ends with,
  // and `: ` may introduce a raw cause only at the end of a line — the two rules cannot both
  // hold here. Nothing is lost, the err serializer still emits error.message under err.message.
  logger.fatal({ err: error }, 'the scheduler failed to start, no contribution will be synchronized - exiting');
  exitWith(1);
  await shutdown('scheduler start failure');
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Past the drain, the scheduler and the pool: how long a fatal error gives the orderly shutdown
// before the process is ended outright.
const FATAL_EXIT_TIMEOUT_MS = DRAIN_TIMEOUT_MS + 5000;

/**
 * Shut down after an error nothing caught, and make sure the process does end
 *
 * The orderly path ends the process only when nothing holds the event loop open, and after an
 * error nobody handled that is not something to rely on. Unref'd, so a shutdown that does
 * finish is never held back by the backstop.
 */
const fatalShutdown = (reason) => {
  exitWith(1);
  setTimeout(() => process.exit(1), FATAL_EXIT_TIMEOUT_MS).unref();
  shutdown(reason);
};

// Without these, an unhandled rejection or an uncaught exception bypasses pino entirely and
// lands as a raw stack on stderr, unattributed and outside the log stream.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection - exiting');
  fatalShutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception - exiting');
  fatalShutdown('uncaughtException');
});
