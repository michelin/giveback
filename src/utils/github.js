/**
 * Parse a GitHub repository full name into owner and repo name
 * @param {string} fullname - e.g. "owner/repo"
 * @returns {{owner: string, name: string}}
 */
export const parseRepoFullname = (fullname) => {
  if (!fullname || typeof fullname !== 'string') {
    throw new Error('invalid repository fullname');
  }

  const [owner, name, ...rest] = fullname.split('/');

  if (!owner || !name || rest.length > 0) {
    throw new Error(`invalid repository fullname format: ${fullname}`);
  }

  return { owner, name };
};

/**
 * The window of events a truncated feed could not reach, if any
 *
 * GitHub serves at most 300 public events per user, and beyond that the feed simply ends with
 * no marker: a very active contributor's older activity is not late, it is gone.
 *
 * The distinction that matters is between a feed that is merely full and one that actually
 * lost something. Full is the normal state of any active account and would fire on every
 * single sync — an alarm that never stops is not an alarm. Something is lost only when the
 * oldest event still served is NEWER than the last successful sync, because then whatever
 * happened between the two is unreachable and always will be.
 * @param {{truncated: boolean, events: Array<Object>}} feed - As returned by fetchPublicEvents
 * @param {?Date|?string} lastSyncedAt - When this subject last synced successfully
 * @returns {?{since: ?Date, until: Date}} The unreachable window; `since` is null on a first
 *   sync, where how much history predates the window is unknowable
 */
export const missedEventsWindow = ({ truncated, events } = {}, lastSyncedAt) => {
  if (!truncated || !Array.isArray(events) || events.length === 0) {
    return null;
  }

  // The feed is newest-first, so the last entry is the far edge of what GitHub still serves.
  const oldest = new Date(events[events.length - 1]?.created_at);

  if (Number.isNaN(oldest.getTime())) {
    return null;
  }

  if (lastSyncedAt === null || lastSyncedAt === undefined) {
    return { since: null, until: oldest };
  }

  const previous = lastSyncedAt instanceof Date ? lastSyncedAt : new Date(lastSyncedAt);

  // An unreadable stored timestamp must not be read as "nothing was missed": that is the
  // silent direction, and this whole function exists to break a silence.
  if (Number.isNaN(previous.getTime())) {
    return { since: null, until: oldest };
  }

  return oldest > previous ? { since: previous, until: oldest } : null;
};

/**
 * Did this request fail before it was made, while minting the installation token?
 *
 * Minting answers 404 for an installation this App cannot authenticate as - uninstalled since
 * the claim, or belonging to another App, which is every request a development instance makes
 * against a copy of the production database. The status alone reads exactly like "this pull
 * request, repository or account does not exist", and a verdict built on that is a verdict about
 * the wrong thing. The failing URL tells the two apart.
 * @param {*} error - As octokit raises it
 * @returns {boolean}
 */
export const isTokenMintFailure = (error) =>
  typeof error?.request?.url === 'string' && error.request.url.includes('/access_tokens');
