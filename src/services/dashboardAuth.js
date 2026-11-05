import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { enrollmentByUserId } from "../db/installations.js";
import { getLogger, fields, format } from "../utils/logger.js";
import { isProduction } from "../utils/constants.js";

const logger = getLogger("dashboardAuth");

/**
 * Authorization for the dashboard, in one place.
 *
 * OAuth establishes WHO is asking; the database decides whether they get in. The cookie carries
 * a GitHub account id and an expiry and never a permission, so every request re-reads the
 * database — which is what makes an uninstall or a suspension take effect on the next click
 * rather than at the end of a session.
 *
 * The id and never the login: a login is released when its owner renames, and whoever registers
 * it next would otherwise walk into the previous owner's session and enrolment. The login the
 * rest of the dashboard reads is the one stored on the enrolled row, looked up from the id on
 * each request. The operator list reads no login at all: it holds account ids.
 */

const SESSION_COOKIE = 'oss_dashboard';
const STATE_COOKIE = 'oss_dashboard_state';

// Short enough that an abandoned session on a shared machine is not a standing grant, long
// enough to survive a working session without re-authenticating.
const SESSION_TTL_SECONDS = 8 * 60 * 60;

// The OAuth round trip is seconds; ten minutes only covers a user who stops to read
// GitHub's authorization screen.
const STATE_TTL_SECONDS = 10 * 60;

// Cookies are restricted to the dashboard's own path, so nothing under / or /callback ever
// carries them. Not a defence on its own — it removes them from requests that have no use
// for them, including the webhook endpoint.
const COOKIE_PATH = '/dashboard';

// Deliberately not derived from PRIVATE_KEY or WEBHOOK_SECRET: one key, one purpose, so
// rotating this never invalidates webhook verification and leaking it is not leaking an app
// credential.
const secret = process.env.SESSION_SECRET || null;

/**
 * Is the dashboard available at all?
 *
 * Without SESSION_SECRET there is no way to sign a session, and the choice is between refusing
 * to boot and leaving the page off. Off: an app that stops collecting contributions because a
 * new optional setting is missing is a far worse failure than a missing page.
 */
export const isDashboardEnabled = () => Boolean(secret);

// The operator tier, by GitHub account id. Never by login: a login is released when its owner
// renames, and whoever registers it next and enrolls would inherit the tier with it. Empty means
// nobody is an operator, which is the safe default: a setting that fails to arrive degrades the
// page for a handful of operators instead of publishing enrollment addresses to everyone
// enrolled. validateEnv refuses an entry that is not an id.
const operatorIds = new Set(
  (process.env.DASHBOARD_OPERATOR_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number)
);

/**
 * Is this GitHub account an operator?
 *
 * Decided per reader, not per process: the page is open to everyone enrolled, and the tier only
 * governs the Operations tab - the jobs, the queue, the accounts with their enrollment addresses,
 * the failure causes and the page's buttons. Matched on the account id the session carries, the
 * same immutable key the session itself is: a rename neither loses the tier nor hands it on.
 * @param {?number} userId - GitHub account id
 */
export const isOperator = (userId) => operatorIds.has(userId);

/**
 * Hand-parsed rather than through cookie-parser: two cookies on one route is not worth a
 * dependency in the tree of an app whose other job is to hold GitHub credentials.
 * @returns {Object<string, string>} Cookie values by name
 */
const readCookies = (req) => {
  const header = req.headers?.cookie;

  if (!header) {
    return {};
  }

  const jar = {};

  // Defensive decode. decodeURIComponent throws URIError on a bare `%` or a truncated escape,
  // and this loop reads every cookie in the header, not only the two this module owns — so one
  // malformed cookie set by any other app on the same registrable domain would throw here,
  // inside sessionLogin(), and answer 500 on every /dashboard route including /dashboard/login,
  // leaving the victim no way to sign back in. The raw slice still fails the HMAC check.
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');

    if (separator > 0) {
      jar[part.slice(0, separator).trim()] = decode(part.slice(separator + 1).trim());
    }
  }

  return jar;
};

/**
 * Set a cookie on the response
 * @param {number} maxAgeSeconds - Lifetime; 0 expires the cookie immediately
 */
const setCookie = (res, name, value, maxAgeSeconds) => {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    // Lax, not Strict, and load-bearing: the OAuth callback is a top-level GET navigation
    // from github.com, and Strict would withhold the cookie on exactly that request, failing
    // the state check every time. Lax still withholds it from cross-site POSTs.
    'SameSite=Lax',
  ];

  // A Secure cookie is never sent over http, so setting it unconditionally would break the
  // whole flow on http://localhost:3000.
  if (isProduction) {
    attributes.push('Secure');
  }

  const existing = res.getHeader('Set-Cookie');
  const header = existing ? [].concat(existing, attributes.join('; ')) : attributes.join('; ');

  res.setHeader('Set-Cookie', header);
};

/** Base64url, without the padding that would need escaping in a cookie. */
const encode = (value) => Buffer.from(value).toString('base64url');

const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * Constant-time comparison: a plain === leaks how many leading characters matched, which over
 * enough requests reconstructs a signature one character at a time.
 */
const equals = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  // timingSafeEqual throws on a length mismatch, and a length difference is not a secret.
  return left.length === right.length && timingSafeEqual(left, right);
};

/** @returns {string} `<payload>.<signature>` */
const issueToken = (claims, ttlSeconds) => {
  const payload = encode(JSON.stringify({
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  }));

  return `${payload}.${sign(payload)}`;
};

/**
 * Verify a signed token and return its claims
 *
 * null for every failure — wrong shape, wrong signature, expired — because the caller has one
 * thing to do in all three cases, and telling them apart would only help somebody probing.
 */
const readToken = (token) => {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const separator = token.lastIndexOf('.');

  if (separator <= 0) {
    return null;
  }

  const payload = token.slice(0, separator);

  if (!equals(token.slice(separator + 1), sign(payload))) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    // The expiry is inside the signed payload, so editing the cookie to extend it breaks the
    // signature.
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
};

/**
 * Start the login flow: mint a CSRF nonce and remember it in a cookie
 *
 * Double-submit. The nonce travels to GitHub as `state` and back in the query string, and a
 * signed copy rides in a cookie; the callback requires the two to match. That ties the callback
 * to a flow this browser started, which is what stops an attacker feeding their own
 * authorization code to a victim's browser and pairing the victim's session with their account.
 *
 * Unlike the enrollment callback, this redirect IS initiated here — which is exactly why a
 * nonce is possible on this route and impossible on /callback.
 * @returns {string} Value to send as the OAuth `state` parameter
 */
export const beginLogin = (res) => {
  const nonce = randomBytes(32).toString('base64url');

  setCookie(res, STATE_COOKIE, issueToken({ nonce }, STATE_TTL_SECONDS), STATE_TTL_SECONDS);

  return nonce;
};

/** Check the returned `state` against the nonce this browser was given. */
export const verifyLoginState = (req, state) => {
  const claims = readToken(readCookies(req)[STATE_COOKIE]);

  return Boolean(claims?.nonce) && typeof state === 'string' && equals(claims.nonce, state);
};

/**
 * Drop the nonce
 *
 * On every callback, whatever its outcome: the nonce is single-use, and one left behind by a
 * refused or failed sign-in would still be there for a second callback to replay.
 */
export const clearLoginState = (res) => {
  setCookie(res, STATE_COOKIE, '', 0);
};

/**
 * Record a successful login
 * @param {number} userId - The GitHub account id GET /user answered with
 */
export const grantSession = (res, userId) => {
  setCookie(res, SESSION_COOKIE, issueToken({ uid: userId }, SESSION_TTL_SECONDS), SESSION_TTL_SECONDS);
};

/** Drop the session cookie. */
export const revokeSession = (res) => {
  setCookie(res, SESSION_COOKIE, '', 0);
};

/**
 * The GitHub account this request is authenticated as
 *
 * A cookie signed before sessions carried an id holds a login instead, and reads as no session
 * at all: its holder is sent through the sign-in again, which mints the new shape.
 * @returns {?number} The account id, or null
 */
export const sessionUserId = (req) => {
  const userId = readToken(readCookies(req)[SESSION_COOKIE])?.uid;

  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
};

/**
 * Decide whether a GitHub account may read the dashboard
 *
 * Enrolment is the whole rule: the population that may read the page is the population being
 * measured. Split from the middleware so it is testable on its own, and so its two callers —
 * the OAuth callback and every subsequent request — apply exactly the same one.
 * @returns {Promise<{allowed: boolean, reason: string, login: ?string}>} `reason` is for the
 *   log, never the response; `login` is the one stored on the account's row, when there is one
 */
export const authorizeUser = async (userId) => {
  if (!userId) {
    return { allowed: false, reason: 'no account id', login: null };
  }

  const { enrolled, known, login } = await enrollmentByUserId(userId);

  if (enrolled) {
    return { allowed: true, reason: 'enrolled', login };
  }

  return {
    allowed: false,
    reason: known ? 'known but not enrolled' : 'never installed the app',
    login,
  };
};

/**
 * How a dashboard line names the reader: by login when the database knows one, by account id
 * when it does not - somebody who never installed the app has no row to read a login from.
 */
const readerFields = (userId, login) => ({ ...(login ? fields.user(login) : {}), user_id: userId });
const readerName = (userId, login) => (login ? format.user(login) : `github account ${userId}`);

/**
 * Gate every dashboard route
 *
 * No session redirects into the login flow, because a page nobody can reach is not a page. A
 * refusal answers 404 rather than 403: a 403 would confirm to somebody who has already proved
 * their identity that the page exists and they are simply not enrolled.
 */
export const requireDashboardAccess = async (req, res, next) => {
  // Unreachable in practice, since src/index.js does not register the routes. Kept so this
  // middleware is safe on its own.
  if (!isDashboardEnabled()) {
    next('route');
    return;
  }

  const userId = sessionUserId(req);

  if (!userId) {
    // The page polls with Accept: application/json, and a redirect would send that fetch to
    // github.com — a cross-origin hop it cannot follow, surfacing as an unexplained network
    // error. An expired session has to be legible to the page that is holding it.
    if (req.get('accept')?.includes('application/json')) {
      res.status(401).json({ error: 'sign-in required' });
      return;
    }

    // 303, so a refresh of the destination never replays this.
    res.redirect(303, '/dashboard/login');
    return;
  }

  try {
    const { allowed, reason, login } = await authorizeUser(userId);

    if (!allowed) {
      // warn, not error: nothing is broken. Worth a line because a stream of these is somebody
      // probing, and because it is the only place an operator learns their access is refused.
      logger.warn(
        { ...readerFields(userId, login), decision: reason },
        `dashboard refused for ${readerName(userId, login)} - ${reason}, answering 404`
      );
      // next('route'), NOT next(): inside a route's own handler chain a bare next() runs the
      // NEXT HANDLER OF THAT ROUTE, which is the page itself — measured, a refused user was
      // served the dashboard with a 200.
      next('route');
      return;
    }

    req.dashboardLogin = login;
    // Per request, like the authorization above, but from the list read when the process started:
    // a change to DASHBOARD_OPERATOR_IDS takes effect once the app restarts, which saving an
    // App Service setting does. Matched on the signed session's account id, never on a login,
    // which a rename releases to whoever registers it next.
    req.isOperator = isOperator(userId);
    next();
  } catch (error) {
    next(error);
  }
};

// Methods that change nothing, and so have nothing for a forged request to achieve.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuse a dashboard write that did not come from the dashboard
 *
 * A second line behind SameSite=Lax, which is the defence today and holds only for as long as
 * every browser honours it and every write stays a POST or a DELETE. The page's own fetch()
 * calls are same-origin, so a browser marks them Sec-Fetch-Site: same-origin and sends an Origin
 * naming this host; a request carrying neither did not come from the page. Origin is compared
 * against the same `protocol://host` the OAuth redirect_uri is built from, which `trust proxy`
 * already makes correct behind the platform's front end.
 *
 * 403 rather than the 404 a refused reader gets: this answers before any session is read, so it
 * confirms nothing about the reader.
 */
export const requireSameOrigin = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)
    || req.get('sec-fetch-site') === 'same-origin'
    || req.get('origin') === `${req.protocol}://${req.get('host')}`) {
    next();
    return;
  }

  logger.warn(
    { method: req.method, url: req.path, origin: req.get('origin') ?? null },
    `dashboard ${req.method} ${req.path} refused - the request did not come from the dashboard, answering 403`
  );

  res.status(403).json({ error: 'cross-origin request refused' });
};
