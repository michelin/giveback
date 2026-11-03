import * as octokitService from "./octokitService.js";
import { forceSyncNow } from "../db/installations.js";
import { getOpsSnapshot } from "./dashboardOps.js";
import { buildMine } from "./dashboardMine.js";
import { getReport, REPORT_TTL_MS } from "./dashboardReport.js";
import { assetsFor } from "./dashboardAssets.js";
import { noteRecoveries } from "./dashboardShared.js";
import {
  beginLogin,
  verifyLoginState,
  clearLoginState,
  grantSession,
  revokeSession,
  authorizeUser,
  sessionUserId,
  isOperator,
} from "./dashboardAuth.js";
import { getLogger, format, fields } from "../utils/logger.js";
import { ALLOWED_EMAIL_DOMAINS, OWN_GITHUB_ORGS, PERCENTILE_MIN_SAMPLE } from "../utils/constants.js";
import packageJson from "../../package.json" with { type: "json" };

const logger = getLogger("dashboardService");

/**
 * Where GitHub sends the reader back after authorizing
 *
 * Derived from the request rather than configured, so one fewer setting has to agree with
 * reality in every environment. Safe to derive: GitHub only ever redirects to a URL registered
 * on the app, so a forged Host header can only produce a mismatch, which fails the login.
 *
 * Behind a TLS-terminating proxy this needs `trust proxy`, or req.protocol reads http from the
 * internal hop and the redirect_uri stops matching the registered https one.
 */
const callbackUrl = (req) => `${req.protocol}://${req.get('host')}/dashboard/callback`;

/**
 * What every reader is sent, operator or not
 *
 * Built by picking fields rather than by deleting them from a fuller payload, so a field added
 * to the operational snapshot later is withheld by default rather than published by default.
 * It costs no read at all: everything a reader's tabs draw comes from their own routes.
 * Exported so the whitelist can be tested for what it contains.
 * @param {string} viewer - GitHub login reading the page
 */
export const readerSnapshot = (viewer) => ({
  // The server's clock, so the browser can count down from due times without its own clock
  // skew turning a 30-second wait into a negative number.
  now: new Date().toISOString(),
  viewer,
  operator: false,
  app: {
    name: packageJson.name,
    version: packageJson.version,
    environment: process.env.NODE_ENV || 'development',
  },
  // Named, so the page says what it is missing instead of showing empty panels that read as
  // "the scheduler has never run".
  degraded: [],
  limits: {
    // Shipped so the page throttles its report fetch on the window the server actually caches
    // for, instead of owning a second copy of the number that has to be kept in step.
    reportTtlMs: REPORT_TTL_MS,
    // The same reasoning: the page gates what it computes itself on the thresholds the server
    // gates with, never on numbers of its own.
    percentiles: PERCENTILE_MIN_SAMPLE,
  },
});

/**
 * The snapshot the page is opened with and polls
 *
 * Decided on the server: the document embeds this whole payload as a JSON island, so the page
 * must never receive what it is not allowed to draw. A reader's costs nothing; an operator's
 * carries the Operations tab under `ops`.
 * @param {string} viewer - GitHub login reading the page
 */
export const getSnapshot = async (viewer) => {
  const base = readerSnapshot(viewer);

  if (!isOperator(viewer)) {
    return base;
  }

  // Per-snapshot, so a partial failure is reported as one.
  const degraded = new Set();
  const ops = await getOpsSnapshot(degraded);

  noteRecoveries(degraded);

  return { ...base, operator: true, degraded: [...degraded], ops };
};

/** The tabs each tier is shown, in their order - and so the only tabs it can land on. */
export const LANDING_TABS = Object.freeze({
  reader: Object.freeze(['mine', 'collective']),
  operator: Object.freeze(['mine', 'collective', 'ops']),
});

/**
 * Which tab the page opens on
 *
 * An operator opens on the machine. Anyone else opens on their own contributions if they have
 * any, and on the parc's if not: a manager who never installed the app would otherwise land on
 * an empty tab.
 * @param {{operator: boolean, contributions: number}} reader - Their tier, and how many rows
 *   the Me tab would list for them
 * @returns {string} A key of LANDING_TABS
 */
export const landingTab = ({ operator, contributions }) =>
  (operator ? 'ops' : contributions > 0 ? 'mine' : 'collective');

/**
 * What the footnote states: the same for every reader, operator or not
 *
 * Process constants and two counts, rendered by the server so the configured lists never travel
 * in a payload. Nothing in it is operational. `bots` is null when the report could not be read,
 * and the footnote then says "—" rather than dropping the line.
 * @param {?Object} report - What getReport() answered, or null
 */
const footnoteOf = (report) => ({
  ownOrgs: OWN_GITHUB_ORGS,
  allowedEmailDomains: ALLOWED_EMAIL_DOMAINS,
  bots: report?.bots ?? null,
  thresholds: PERCENTILE_MIN_SAMPLE,
});

/**
 * What the template is rendered with, from what the handler read
 *
 * Pure, and exported so the page tests render the document from this very assembly: a copy of
 * it in the harness would be a second opinion on which tabs a reader is sent.
 * @param {{snapshot: Object, landing: string, mine?: ?Object, report?: ?Object}} read
 */
export const pageLocals = ({ snapshot, landing, mine = null, report = null }) => ({
  snapshot,
  landing,
  tabs: LANDING_TABS[snapshot.operator ? 'operator' : 'reader'],
  assets: assetsFor(snapshot.operator),
  // Every reader's own rows whichever tab the page opens on, since the nameplate above the tabs
  // counts from them and Overall marks them too; the report only for the tab that draws it
  // first. A tab opened later reads its own route then.
  seed: { mine, report: landing === 'collective' ? report : null },
  footnote: footnoteOf(report),
});

/**
 * Render the dashboard
 *
 * The first snapshot is embedded in the document rather than fetched after paint, and so are
 * whatever the landing tab draws and a reader's own rows: a live instrument that opens empty and
 * fills in half a second later reads as broken every time.
 */
export async function handleGetDashboard(req, res) {
  // Set before the read, so it still holds if this handler is ever refactored to return early.
  // The document embeds the snapshot as a JSON island — for an operator, enrollment addresses
  // included — and without this the browser is free to keep that copy in its on-disk cache and
  // re-display it from history after /dashboard/logout, which only drops a cookie. The JSON
  // routes serving the same payloads already say no-store.
  res.set('Cache-Control', 'no-store');

  const login = req.dashboardLogin;
  let snapshot;

  try {
    snapshot = await getSnapshot(login);
  } catch (error) {
    // Same answer as the sibling routes: a database blip on the first load would otherwise
    // reach the catch-all in src/index.js and read as an anonymous 500, at the moment an
    // operator is most likely to be looking.
    logger.error(
      { err: error, ...fields.user(login) },
      `could not read what the dashboard opens on: ${error.message}`
    );

    res.status(503).send("The dashboard cannot reach the database right now. Try again in a moment.");
    return;
  }

  // Neither of these is worth refusing the page over. The Me rows only choose the tab and seed
  // the page, and every tab reads its own route again when it is shown; the report is what the
  // footnote counts from, and without it the footnote says "—".
  const unread = (what) => (error) => {
    logger.warn({ err: error, ...fields.user(login) }, `the dashboard opens without ${what}: ${error.message}`);
    return null;
  };

  // The Me tab's own query, not a count kept elsewhere: the rule can then neither open an empty
  // Me nor send somebody who has rows to another tab. Its answer is not wasted - the page is
  // seeded with it, an operator's too, for the nameplate. Read side by side with the report:
  // buildMine() waits on the same build for the rank and everyone's median, which getReport()
  // shares rather than starts a second time.
  const [mine, report] = await Promise.all([
    buildMine(login).catch(unread('your contributions')),
    getReport().catch(unread('the contribution report')),
  ]);
  const landing = landingTab({ operator: snapshot.operator, contributions: mine?.contributions.length ?? 0 });

  // Outside any try: a template error is a bug in this app, and belongs to the 500 handler, not
  // to a 503 that blames the database.
  res.render("dashboard", pageLocals({ snapshot, landing, mine, report }));
}

/** Serve the snapshot the page polls. */
export async function handleGetDashboardData(req, res) {
  try {
    // An instrument reading five seconds into the past is worse than no instrument, because
    // nothing on screen says which.
    res.set('Cache-Control', 'no-store');
    res.json(await getSnapshot(req.dashboardLogin));
  } catch (error) {
    // Answered as data rather than a 500 page: the page stays up and shows that it lost the
    // database, which is the most useful thing it can display at that moment.
    logger.error(
      { err: error, ...fields.user(req.dashboardLogin) },
      `could not build the status snapshot: ${error.message}`
    );

    res.status(503).json({ error: 'the snapshot could not be read', now: new Date().toISOString() });
  }
}

/**
 * Bring one account's next sync forward, on an operator's click
 *
 * Gated like the rest of the Operations tab it belongs to: the button is drawn from a table
 * only an operator is sent.
 *
 * No CSRF token, deliberately: the session cookie is SameSite=Lax, which a browser withholds
 * from a cross-site POST. That is the whole defence, and it is why this must stay a POST - as
 * a GET it would fire from any <img> on any page an operator visits.
 */
export async function handlePostDashboardUserSync(req, res) {
  if (!req.isOperator) {
    // 404, as requireDashboardAccess answers a refused reader: whether the route exists is
    // not something to confirm to somebody who may not use it.
    res.status(404).json({ error: 'not found' });
    return;
  }

  const userId = Number(req.params.userId);

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'not an account id' });
    return;
  }

  try {
    const forced = await forceSyncNow(userId);

    if (!forced) {
      // Unknown id and known-but-retired are one answer on purpose: the page drew the state
      // beside the button, so it already knows which of the two it is looking at.
      res.status(409).json({ error: 'this account is not syncable' });
      return;
    }

    // The only trace an operator action leaves. Worth a line at info: it moves work that the
    // scheduler otherwise decides on its own, so a queue that suddenly drains has an author.
    logger.info(
      { ...fields.user(req.dashboardLogin), target_user: forced.login, running: forced.running },
      `${format.user(req.dashboardLogin)} brought the sync of ${format.user(forced.login)} forward to now`
    );

    res.json(forced);
  } catch (error) {
    logger.error(
      { err: error, ...fields.user(req.dashboardLogin) },
      `could not bring a sync forward: ${error.message}`
    );

    res.status(503).json({ error: 'the account could not be rescheduled' });
  }
}

/** Send the reader to GitHub to prove who they are. */
export function handleGetDashboardLogin(req, res) {
  // Already signed in: don't mint a new nonce and don't bounce off GitHub for nothing.
  if (sessionUserId(req)) {
    res.redirect(303, '/dashboard');
    return;
  }

  const state = beginLogin(res);

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl(req));
  authorizeUrl.searchParams.set('state', state);
  // No `scope`: a GitHub App's user token carries the app's user permissions, and this flow
  // needs none of them. GET /user answers for any user token.

  res.redirect(303, authorizeUrl.toString());
}

/**
 * Complete the login
 *
 * The OAuth token is used for GET /user and discarded. Nothing is stored: the session carries
 * the account id, and the authorization behind it is re-read from the database on every later
 * request.
 */
export async function handleGetDashboardCallback(req, res) {
  const { code, state } = req.query;
  const started = Boolean(code) && verifyLoginState(req, state);

  // Before any outcome is decided, so every one of them - refused, failed, granted - spends it.
  clearLoginState(res);

  if (!started) {
    // One message for a missing code, a missing cookie and a mismatched nonce: from here they
    // are the same event — this browser did not start the flow that is finishing.
    logger.warn('dashboard login rejected - the callback does not match a login this browser started');
    res.status(400).send("This sign-in link is not valid any more. Start again from /dashboard.");
    return;
  }

  let login = null;

  try {
    const { access_token: accessToken } = await octokitService.exchangeCodeForToken(code);
    const user = await octokitService.getAuthenticated(accessToken);

    login = user.login;

    // On the id: the login GitHub answers with is the one this account holds today, which a
    // rename hands to somebody else - see authorizeUser().
    const { allowed, reason } = await authorizeUser(user.id);

    if (!allowed) {
      logger.warn(
        { ...fields.user(login), decision: reason },
        `dashboard login refused for ${format.user(login)} - ${reason}, answering 404`
      );
      // 404, not 403 — consistent with requireDashboardAccess.
      res.status(404).send("Not found.");
      return;
    }

    grantSession(res, user.id);

    logger.info({ ...fields.user(login) }, `${format.user(login)} signed in to the dashboard`);

    res.redirect(303, '/dashboard');
  } catch (error) {
    logger.error(
      { err: error, ...(login ? fields.user(login) : {}) },
      `dashboard login failed for ${login ? format.user(login) : 'an unidentified user'}: ${error.message}`
    );
    res.status(500).send("Sign-in failed. Try again.");
  }
}

/** Sign out. */
export function handleGetDashboardLogout(req, res) {
  revokeSession(res);
  res.redirect(303, '/');
}
