import { fetch as undiciFetch, ProxyAgent } from "undici";
import { format, getLogger } from "./logger.js";

const logger = getLogger("octokit");

// One dispatcher for the whole process: a ProxyAgent owns a connection pool, so
// building one per Octokit instance (3-4 per enrollment) threw the pool away every time.
let proxyFetch;

/**
 * A fetch that goes through OCTOKIT_HTTP_PROXY, or undefined when no proxy is configured
 * @returns {Function|undefined}
 */
export const createFetchWithProxy = () => {
  if (!process.env.OCTOKIT_HTTP_PROXY) {
    return undefined;
  }

  if (!proxyFetch) {
    const dispatcher = new ProxyAgent(process.env.OCTOKIT_HTTP_PROXY);
    proxyFetch = (url, options) => undiciFetch(url, { ...options, dispatcher });

    // Host only, never the URL: a corporate proxy URL routinely carries credentials in its
    // userinfo, and the host is the only part an operator needs to confirm the route.
    logger.debug(`http proxy configured: ${new URL(process.env.OCTOKIT_HTTP_PROXY).host}`);
  }

  return proxyFetch;
};

/**
 * Octokit options: the throttling policy, and the proxy when one is configured
 * @param {Object} authConfig - Authentication configuration
 * @returns {Object}
 */
export const getOctokitOptions = (authConfig) => {
  const opts = {
    ...authConfig,
    throttle: {
      onRateLimit: async (retryAfter, options, octokit, retryCount) => {
        const request = {
          method: options.method,
          url: options.url,
          retry_after_s: retryAfter,
          retry_count: retryCount,
        };

        // One line per throttled request, not two: each decision below already names the
        // endpoint and the delay.
        //
        // Waiting out a long reset would park a worker thread for up to an hour, so give up
        // and let the next scheduled run pick the work back up.
        if (retryAfter > 120) {
          logger.warn(request, `github rate limit hit for ${options.method} ${options.url}, resets in ${format.duration(retryAfter * 1000)} - skipping, the next scheduled run will resume`);
          return false;
        }

        if (retryCount < 1) {
          logger.warn(request, `github rate limit hit for ${options.method} ${options.url} - retrying that request in ${format.duration(retryAfter * 1000)} (retry ${retryCount + 1} of 1)`);
          return true;
        }

        logger.warn(request, `github rate limit retry exhausted for ${options.method} ${options.url} - skipping, the next scheduled run will resume`);
        return false;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        const request = {
          method: options.method,
          url: options.url,
          retry_after_s: retryAfter,
          retry_count: retryCount,
        };

        if (retryCount < 2) {
          logger.warn(request, `github secondary rate limit hit for ${options.method} ${options.url} - retrying that request in ${format.duration(retryAfter * 1000)} (retry ${retryCount + 1} of 2)`);
          return true;
        }

        logger.warn(request, `github secondary rate limit retry exhausted for ${options.method} ${options.url} - skipping, the next scheduled run will resume`);
        return false;
      },
    },
  };

  const fetch = createFetchWithProxy();
  if (fetch) {
    opts.request = { fetch };
  }

  return opts;
};

/**
 * PRIVATE_KEY as a PEM, whichever of its two accepted forms it was given in
 *
 * Pasting the .pem contents straight in is the usual setup mistake, and probot's webhook path
 * accepts it (@probot/get-private-key decodes only when the value is base64), so this reader has
 * to agree. Decoding a PEM as base64 yields binary noise and no error: the app would boot, serve
 * webhooks, and fail every JWT-authenticated call with "Invalid keyData". Hence the shape check,
 * shared with validateEnv() so the boot gate and the reader cannot disagree.
 * @param {string} value - The variable as set; the single-line .env form escapes its newlines
 * @returns {string} The PEM
 * @throws {Error} If the value is neither a PEM nor a base64-encoded one
 */
export const decodePrivateKey = (value) => {
  const raw = String(value).replace(/\\n/g, '\n');
  const decoded = raw.includes('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');

  if (!decoded.includes('-----BEGIN')) {
    throw new Error('PRIVATE_KEY is neither a PEM nor a base64-encoded PEM - generate it with: base64 < your-app.private-key.pem | tr -d \'\\n\'');
  }

  return decoded;
};

/**
 * The decoded private key, cached after the first call
 * @returns {string}
 */
const getPrivateKey = (() => {
  let cachedKey = null;

  return () => {
    if (!cachedKey && process.env.PRIVATE_KEY) {
      // Validated before it is cached, so a bad key throws on every call rather than once. Bree
      // workers never run validateEnv(), so this is their only check.
      cachedKey = decodePrivateKey(process.env.PRIVATE_KEY);

      // Nothing derived from the key value reaches the message — not a byte, not its length.
      logger.trace('private key decoded and cached');
    }
    return cachedKey;
  };
})();

/**
 * Authentication configuration for the GitHub App
 * @param {number} [installationId] - Omit to authenticate as the app itself
 * @returns {Object}
 */
export const createAppAuthConfig = (installationId) => {
  const auth = {
    appId: process.env.APP_ID,
    privateKey: getPrivateKey(),
  };

  if (installationId !== undefined) {
    auth.installationId = installationId;
  }

  return auth;
};
