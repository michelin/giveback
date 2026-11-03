import { createFetchWithProxy } from "../utils/octokit.js";
import { GITLAB_API_HOSTS } from "../utils/constants.js";
import { getLogger } from "../utils/logger.js";
import { asCount } from "../utils/counts.js";

/**
 * Reading a merge request, on the forges we are allowed to call.
 *
 * GitLab's REST API answers for a public project WITHOUT a token, which the manual-entry form
 * was written as though it did not: it asked an operator to retype a title, two dates and three
 * counts that are all one GET away. Everything here exists to stop asking.
 *
 * What it still cannot answer is the one field that matters most - WHO. A merge request carries
 * a GitLab username, and enrollment is keyed on a GitHub login; the two are different names for
 * the same person and nothing connects them. So the author stays a deliberate choice, and what
 * is read from the forge is shown beside the picker as the hint for making it.
 *
 * A failure here is never an error: it falls back to the typed form. An instance we cannot
 * reach, a private project, a token we do not have - each of those is a reason to type a
 * contribution in, not a reason to refuse to record it.
 */

const logger = getLogger("gitlabService");

/**
 * Long enough for a forge answering normally, short enough that an operator does not sit on a
 * dead instance. Applied to each of the three requests: the merge request first, then its commits
 * and its project side by side.
 */
const TIMEOUT_MS = 6000;

const url = (host, path) => `https://${host}/api/v4/${path}`;

/**
 * OCTOKIT_HTTP_PROXY, despite the name: it is the one egress proxy this process has, and in
 * production nothing leaves the network without it. Reused rather than renamed, because the
 * name is a deployed setting and renaming it would be a configuration change dressed as a
 * refactor.
 */
const get = async (target) => {
  const fetchImpl = createFetchWithProxy() ?? fetch;

  return fetchImpl(target, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
};

/**
 * The fields a merge request offers, under the names the rest of this application uses
 *
 * Pure, and exported for that reason: everything above it is a network call, and the mapping is
 * the part worth pinning down.
 *
 * `mergedBy` is deliberately absent even though `merge_user` is right there. That column is
 * joined to installations BY NAME, against GitHub logins - writing a GitLab username into it
 * would plant the fault that detaches a person's whole history from their enrollment.
 */
export const mapMergeRequest = (mr, extra = {}) => ({
  merged: mr?.state === 'merged',
  title: typeof mr?.title === 'string' && mr.title.trim() !== '' ? mr.title.trim() : null,
  author: mr?.author?.username ?? null,
  authorName: mr?.author?.name ?? null,
  openedAt: mr?.created_at ?? null,
  mergedAt: mr?.merged_at ?? null,
  // A STRING, and GitLab caps it: a huge merge request answers "1000+", which is no count.
  changedFiles: asCount(mr?.changes_count),
  commits: extra.commits ?? null,
  stars: extra.stars ?? null,
});

/**
 * Is this a forge we may call at all?
 *
 * The address is typed by a human, and `parseContributionUrl` accepts ANY host that spells a
 * merge request - so without this the form would be a way to make the server issue a request to
 * a host of somebody's choosing, internal ones included. An allow-list, not a denial list.
 */
export const isReadableHost = (host) => GITLAB_API_HOSTS.includes(host);

/**
 * The star count from a settled GET /projects/{id}, or null - never a throw
 *
 * Its body is read after the merge request's, so a body that fails to parse would otherwise
 * escape into the caller's catch and lose a merge request that was read perfectly well.
 * @param {PromiseSettledResult<Response>} settled
 * @returns {Promise<?number>}
 */
const starsOf = async (settled) => {
  if (settled.status !== 'fulfilled' || !settled.value.ok) {
    return null;
  }

  try {
    return asCount((await settled.value.json())?.star_count);
  } catch (error) {
    logger.debug({ err: error }, `the project's star count could not be read - recorded without one: ${error.message}`);

    return null;
  }
};

/**
 * Read one merge request, or answer null and let it be typed
 *
 * @param {{host: string, fullName: string, number: number}} coordinates - From the address
 * @returns {Promise<?Object>} The mapped merge request, or null when it cannot be read
 */
export const readMergeRequest = async ({ host, fullName, number }) => {
  if (!isReadableHost(host)) {
    logger.debug(`${host} is not in GITLAB_API_HOSTS - the merge request will be typed in`);

    return null;
  }

  const project = encodeURIComponent(fullName);

  try {
    const response = await get(url(host, `projects/${project}/merge_requests/${number}`));

    if (!response.ok) {
      logger.info(`${host} answered ${response.status} for ${fullName}!${number} - falling back to typing`);

      return null;
    }

    const mr = await response.json();

    // Both of these are decoration next to the merge request itself, so one failing must not
    // lose the rest: settled, never awaited for a throw.
    const [commits, stars] = await Promise.allSettled([
      get(url(host, `projects/${project}/merge_requests/${number}/commits?per_page=1`)),
      get(url(host, `projects/${project}`)),
    ]);

    return mapMergeRequest(mr, {
      // The count without the page: `x-total` is the whole list's size, which is the number
      // wanted, and `per_page=1` is what keeps it from being downloaded to find that out.
      commits: commits.status === 'fulfilled' && commits.value.ok
        ? asCount(commits.value.headers.get('x-total'))
        : null,
      stars: await starsOf(stars),
    });
  } catch (error) {
    // A timeout, a DNS failure, an instance behind a VPN this process is not on.
    logger.warn({ err: error }, `could not read ${fullName}!${number} from ${host}: ${error.message}`);

    return null;
  }
};
