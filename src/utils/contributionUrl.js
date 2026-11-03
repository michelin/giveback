/**
 * The address of a contribution, parsed back into its coordinates.
 *
 * One operator types one URL, and everything else about a manual entry is derived from it. That
 * is the whole point: the nine contributions recorded by hand before this existed were typed
 * field by field, and one of them spent a year attached to nobody because a handle was written
 * where a login belonged. A URL is the one thing a human can paste without inventing anything.
 *
 * Parsed through the URL constructor rather than a regular expression on the raw string. A regex
 * that matches `github.com/o/r/pull/1` also matches `evil.example/github.com/o/r/pull/1`, and the
 * result of this function decides which API is called.
 */

import { asCount } from "./counts.js";

/** Everything after the project path on a GitLab merge request address. */
const GITLAB_MARKER = '/-/merge_requests/';

/** GitHub serves the same repository from both, and links in the wild carry either. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/**
 * The number of a contribution: a count, and a positive one
 *
 * Zero is a valid count and never a valid number - forges number upwards from one - so this is
 * the one caller of asCount() that also checks the value. Everything else it rejects, and why,
 * is in src/utils/counts.js.
 */
const asNumber = (text) => {
  const value = asCount(text);

  return value !== null && value > 0 ? value : null;
};

/**
 * Split a URL into the forge, the project and the number
 *
 * @param {string} raw - As pasted, trailing slash, query string and fragment all tolerated
 * @returns {?{forge: string, host: string, fullName: string, number: number, url: string}}
 *   `fullName` is the project path - `owner/repo` on GitHub, and on GitLab the whole nested
 *   group path, which is what the project is called. `url` is the address rebuilt from the
 *   parts, so what is stored is never the query string somebody happened to copy.
 */
export const parseContributionUrl = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }

  // http:// would be accepted by the URL constructor and then fetched over a downgraded
  // connection, or stored as the permanent address of something that is served over TLS.
  if (parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');

  if (GITHUB_HOSTS.has(host)) {
    // Exactly four segments. `/owner/repo/pull/1/files` is a view of the pull request, not the
    // pull request, and accepting it would store an address that redirects.
    const parts = path.split('/').filter(Boolean);

    if (parts.length !== 4 || parts[2] !== 'pull') {
      return null;
    }

    const number = asNumber(parts[3]);

    if (number === null) {
      return null;
    }

    const fullName = `${parts[0]}/${parts[1]}`;

    return { forge: 'github', host, fullName, number, url: `https://github.com/${fullName}/pull/${number}` };
  }

  // Any GitLab, not only gitlab.com: the marker is distinctive enough, and a company that runs
  // its own instance contributes to it exactly the same way. The host is kept so the address
  // can be rebuilt without assuming where it came from.
  const marker = path.indexOf(GITLAB_MARKER);

  if (marker <= 0) {
    return null;
  }

  const fullName = path.slice(1, marker);
  const number = asNumber(path.slice(marker + GITLAB_MARKER.length));

  // A project path is at least `group/project`. A single segment is a user or a group page,
  // which has no merge requests of its own.
  if (number === null || !fullName.includes('/') || fullName.split('/').some((part) => part === '')) {
    return null;
  }

  return {
    forge: 'gitlab',
    host,
    fullName,
    number,
    url: `https://${host}/${fullName}${GITLAB_MARKER}${number}`,
  };
};
