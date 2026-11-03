import { ProbotOctokit } from "probot";
import { exchangeWebFlowCode } from "@octokit/oauth-methods";
import { request } from "@octokit/request";
import { createAppAuth } from "@octokit/auth-app";
import { getOctokitOptions, createFetchWithProxy, createAppAuthConfig } from "../utils/octokit.js";
import { PAGINATION } from "../utils/constants.js";

/** Authenticated as a user. */
const userOctokit = (accessToken) =>
  new ProbotOctokit(getOctokitOptions({ auth: { token: accessToken } }));

/**
 * Authenticated as the app, or as one of its installations
 * @param {number} [installationId] - Omit to authenticate as the app itself
 */
export const appOctokit = (installationId) =>
  new ProbotOctokit(getOctokitOptions({
    authStrategy: createAppAuth,
    auth: createAppAuthConfig(installationId),
  }));

/** Exchange an OAuth web-flow code for a user access token. */
export const exchangeCodeForToken = async (code) => {
  const octokitOpts = {
    clientType: "oauth-app",
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    code,
  };

  const fetch = createFetchWithProxy();
  if (fetch) {
    octokitOpts.request = request.defaults({ request: { fetch } });
  }

  const { data } = await exchangeWebFlowCode(octokitOpts);

  return data;
};

/** GET /user. */
export const getAuthenticated = async (accessToken) => {
  const { data } = await userOctokit(accessToken).rest.users.getAuthenticated();

  return data;
};

/**
 * GET /user/emails
 * @returns {Promise<Array<Object>>} Entries carrying `verified` and `primary` flags
 */
export const listEmailsForAuthenticated = async (accessToken) => {
  const { data } = await userOctokit(accessToken).rest.users.listEmailsForAuthenticatedUser();

  return data;
};

/**
 * List the installations of this app the authenticated user can access
 *
 * Authoritative for the two things the OAuth callback needs: a user token can only ever return
 * that user's own installations, so it proves ownership, and it reports the CURRENT
 * installation id — unlike the database, which lags until the webhook arrives.
 */
export const listInstallationsForUser = async (accessToken) => {
  const { data } = await userOctokit(accessToken).rest.apps.listInstallationsForAuthenticatedUser({
    per_page: PAGINATION.PER_PAGE,
  });

  return data.installations ?? [];
};

/**
 * Fetch a user's public events, skipping the work entirely when nothing changed
 *
 * The feed is newest-first, so a 304 on page 1 proves nothing new happened and no further page
 * needs fetching. A 304 costs no primary rate limit at all — confirmed against the API and
 * documented in "Best practices for using the REST API" — which is what lets this poll often
 * without spending quota.
 * @param {Object} octokit - An installation client, the one the caller hydrates with afterwards:
 *   each client mints its own token
 * @param {string} username - Whose feed
 * @param {?string} etag - ETag stored from the previous fetch
 * @returns {Promise<{notModified: boolean, events: Array<Object>, etag: ?string, truncated: boolean}>}
 *   `truncated` means the feed did not end within the pages read: what predates the oldest event
 *   returned is unreachable, and whether that matters is for the caller to decide. It is absent
 *   when `notModified` is true: a 304 reads no page, so it makes no claim about what the feed
 *   still reaches.
 */
export const fetchPublicEvents = async (octokit, username, etag) => {
  const route = 'GET /users/{username}/events';
  const events = [];
  let freshEtag = null;
  // Assumed until a short page proves otherwise: the other two exits, GitHub's 422 and the
  // page cap, both leave events older than the last one read out of reach.
  let truncated = true;

  for (let page = 1; page <= PAGINATION.MAX_PAGES; page++) {
    // Only page 1 is conditional: its ETag stands for the head of the feed.
    const headers = page === 1 && etag ? { 'if-none-match': etag } : undefined;

    let response;

    try {
      response = await octokit.request(route, {
        username,
        per_page: PAGINATION.PER_PAGE,
        page,
        ...(headers ? { headers } : {}),
      });
    } catch (error) {
      // Octokit surfaces 304 as an error; treat it as the "nothing changed" answer.
      if (error.status === 304) {
        return { notModified: true, events: [], etag: null };
      }

      // 422 is GitHub declining to paginate further. MAX_PAGES is set so this cannot be
      // reached, but the cap is GitHub's and can move: keep the pages already read rather
      // than losing them and the user's whole sync with them. Page 1 is different — a 422
      // there is a malformed request, not the end of a feed, and must surface.
      if (error.status === 422 && page > 1) {
        break;
      }

      throw error;
    }

    if (response.status === 304) {
      return { notModified: true, events: [], etag: null };
    }

    if (page === 1) {
      freshEtag = response.headers.etag ?? null;
    }

    events.push(...response.data);

    // The only exit that proves nothing was left behind — and not the only exit: a user with
    // exactly PER_PAGE * MAX_PAGES events returns a full last page, which is why MAX_PAGES is
    // sized to GitHub's 300-event cap rather than treated as a loose guard.
    if (response.data.length < PAGINATION.PER_PAGE) {
      truncated = false;
      break;
    }
  }

  return { notModified: false, events, etag: freshEtag, truncated };
};

/**
 * Read one repository, conditionally
 *
 * Same 304 handling as the events feed: octokit surfaces a not-modified response as an error,
 * so it is caught rather than propagated. A repository whose star count has not moved answers
 * 304 and costs nothing against the rate limit.
 *
 * By id, and there is no by-name form. A rename usually leaves a redirect at the old name, but
 * a TRANSFER to another owner does not always: measured on raphi011/amux, which moved to
 * mixpeek/amux and whose old path answers a bare 404 on both the API and the website. By name
 * that is indistinguishable from a deletion and the repository gets retired for moving. By id it
 * is a 200 reporting the new full_name, so the rename is simply recorded.
 *
 * No bootstrap case to make an exception for: a repository row is created with its id or not at
 * all, and the refresh claim skips the rows that have none.
 * @param {number} installationId - Any active installation; a token reads any public repository
 * @param {number} githubRepoId - github_repositories.github_id
 * @returns {Promise<{notModified: boolean, repository: ?Object, etag: ?string}>}
 */
export const fetchRepository = async (installationId, githubRepoId, etag) => {
  try {
    const response = await appOctokit(installationId).request('GET /repositories/{id}', {
      id: githubRepoId,
      ...(etag ? { headers: { 'if-none-match': etag } } : {}),
    });

    if (response.status === 304) {
      return { notModified: true, repository: null, etag: null };
    }

    return {
      notModified: false,
      repository: response.data,
      etag: response.headers?.etag ?? null,
    };
  } catch (error) {
    if (error.status === 304) {
      return { notModified: true, repository: null, etag: null };
    }

    throw error;
  }
};

/**
 * Fetch a pull request by repository id, with a client the caller already holds
 *
 * Takes the client rather than an installation id, because the two callers have opposite needs:
 * the sync job holds one client for a whole feed and hydrates dozens of pull requests with it,
 * where each appOctokit() call builds a fresh instance that mints its own token. The poll, which
 * handles one row at a time, goes through fetchPullRequest() below.
 *
 * Measured against the live API: this route answers 200, and asking an OLD name answers 301
 * redirecting to exactly it — GitHub resolves a name into this call, so making it directly skips
 * a redirect that a transfer may not have left behind.
 */
export const pullRequestById = async (octokit, githubRepoId, number) => {
  const { data } = await octokit.request('GET /repositories/{id}/pulls/{number}', {
    id: githubRepoId,
    number,
  });

  return data;
};

/**
 * Fetch a pull request by the name in its address
 *
 * The by-id route above cannot serve this: a pasted URL carries `owner/repo`, and resolving that
 * into GitHub's numeric id would be a second call for nothing. Asking by name costs the redirect
 * the id route was written to skip, which is the right trade here - a manual entry happens a few
 * times a year, and a redirect is how a repository renamed since answers correctly.
 *
 * Any live installation token reads any PUBLIC repository, which is what every contribution
 * worth recording is.
 */
export const pullRequestByName = async (octokit, owner, repo, number) => {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: number,
  });

  return data;
};

/**
 * Fetch a pull request. Deliberately NOT a conditional request.
 *
 * Measured against the API: the ETag of a pull request is stable within one installation token
 * but changes with every new one, and each run mints a fresh token — so a stored ETag can never
 * match and If-None-Match would be inert. The events feed's ETag is stable across tokens, which
 * is why the cheap 304 lives there and not here.
 *
 * The cost is bounded by scheduling instead: POLL_BATCH_SIZE plus the adaptive next_poll_at,
 * against a per-installation budget of 5,000 requests an hour.
 */
export const fetchPullRequest = async (installationId, githubRepoId, number) =>
  pullRequestById(appOctokit(installationId), githubRepoId, number);

/** Every installation GitHub currently reports for this app. Authenticated as the app (JWT). */
export const listAppInstallations = async () => {
  const octokit = appOctokit();

  return octokit.paginate(octokit.rest.apps.listInstallations, { per_page: PAGINATION.PER_PAGE });
};

/**
 * GET /app — this app's own metadata, including slug and html_url
 *
 * Authenticated with the JWT, so it answers for whichever app the loaded APP_ID and PRIVATE_KEY
 * belong to. That makes it the only trustworthy source for the app's public URL: a configured
 * slug can point at a different app than the credentials do, which is the mistake nobody
 * notices until a dev instance sends a user to install production.
 */
export const getAppMetadata = async () => {
  const { data } = await appOctokit().rest.apps.getAuthenticated();

  return data;
};

/**
 * Delete a GitHub App installation. App-level endpoint, so authenticated as the app (JWT).
 *
 * Only ever call this on an installation whose ownership has been established — the enrollment
 * callback proves it through GET /user/installations. An id taken from the request itself, a
 * query string say, would let anyone uninstall the app for any user.
 */
export const deleteInstallation = async (installationId) => {
  // No log line: this layer does not know why the uninstall happened. uninstallRejected() in
  // endpointService reports both outcomes, with the user and the reason.
  await appOctokit().rest.apps.deleteInstallation({ installation_id: installationId });
};
