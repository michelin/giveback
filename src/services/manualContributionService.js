import { createHash } from "node:crypto";

import { parseContributionUrl } from "../utils/contributionUrl.js";
import { asCount } from "../utils/counts.js";
import { parseRepoFullname, isTokenMintFailure } from "../utils/github.js";
import { getLogger, format, fields } from "../utils/logger.js";
import { appOctokit, pullRequestByName } from "./octokitService.js";
import { readMergeRequest } from "./gitlabService.js";
import { transaction } from "../db/index.js";
import { isEnrolledUser, liveInstallationIdForLogin } from "../db/installations.js";
import { ensureRepository, ensureForeignRepository } from "../db/repositories.js";
import {
  upsertManualContribution,
  listManualContributions,
  deleteManualContribution,
} from "../db/pull_requests.js";

/**
 * Recording a contribution the events feed never offered.
 *
 * Two forges, and only one of them is ever typed. A GitHub pull request is FETCHED from the address
 * the operator pasted, so the row written is the row the sync would have written - author
 * included, which is the half that has gone wrong before. A GitLab merge request is read where
 * its host is in GITLAB_API_HOSTS and typed where it is not - except the author, who is always
 * chosen from the enrolled.
 *
 * Merged work only, on both paths. Nothing here is ever polled or updated afterwards.
 */

const logger = getLogger("manualContributionService");

/**
 * The identity of a merge request on another forge
 *
 * A GitLab address carries the `iid`, the number WITHIN a project - `!1664` is the 1664th merge
 * request of that project, and thousands of projects have one. The global id that
 * `pull_request_id` wants is not on the page and not in the URL; it takes an API call to learn,
 * which a host outside GITLAB_API_HOSTS never gets. Asking an operator for it would be asking for
 * a number they cannot find.
 *
 * So it is derived, deterministically, from the three things the address does carry. Two
 * properties fall out, and both matter more than the id being meaningful:
 *
 *   - re-pasting the same address produces the same id, so recording twice updates once;
 *   - it is NEGATIVE, and a forge id never is. A synthesised id therefore cannot collide with a
 *     real GitHub pull request id - not unlikely, impossible - which is a stronger guarantee
 *     than the one we settled for when the two id spaces were merely expected to stay apart.
 *
 * 48 bits, so the value stays inside Number.MAX_SAFE_INTEGER after negation and survives the
 * round trip through JSON that every payload on this dashboard makes.
 */
export const synthesiseId = (host, fullName, number) => {
  const digest = createHash('sha256').update(`${host}|${fullName}|${number}`).digest();

  return -Number(digest.readUIntBE(0, 6));
};

/** A date the database will accept, or null. Rejects `new Date('nonsense')`, which is Invalid Date. */
const asDate = (value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const at = new Date(value);

  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/**
 * Look one up, and decide whether it may be recorded at all
 *
 * Read-only: it writes nothing and exists so the operator sees what the app sees before
 * committing to it. The GitHub path answers with the real pull request; the GitLab path answers
 * with the coordinates read out of the address, for the form to start from.
 *
 * @param {string} rawUrl - As pasted
 * @param {string} operator - Whose installation token does the reading
 */
const lookupContribution = async (rawUrl, operator) => {
  const parsed = parseContributionUrl(rawUrl);

  if (!parsed) {
    return { ok: false, status: 400, error: 'not a pull request or merge request address' };
  }

  if (parsed.forge === 'gitlab') {
    const read = await readMergeRequest(parsed);

    if (!read) {
      // An instance we may not call, a private project, a forge that did not answer. The form
      // fills in what nobody could read, which is what it was written for.
      return { ok: true, found: { ...parsed, needsTyping: true } };
    }

    if (!read.merged) {
      // Asked of GitLab wherever GitLab will answer, exactly as it is asked of GitHub. Where it
      // will not, the operator asserts it - that asymmetry is the cost of a forge we cannot call.
      return { ok: false, status: 409, error: 'only merged work can be recorded' };
    }

    return { ok: true, found: { ...parsed, ...read, needsTyping: false } };
  }

  const installationId = await liveInstallationIdForLogin(operator);

  if (installationId === null) {
    // Their own token, and they are enrolled or they would not be reading this page - so this
    // is a race with an uninstall, not a state to design around.
    return { ok: false, status: 409, error: 'your own installation is no longer live' };
  }

  const { owner, name } = parseRepoFullname(parsed.fullName);

  let pullRequest;

  try {
    pullRequest = await pullRequestByName(appOctokit(installationId), owner, name, parsed.number);
  } catch (error) {
    // WHICH request failed, not just its status: reported as "github does not know this pull
    // request", a token that could not be minted sends somebody looking for a fault in an
    // address that was perfectly correct.
    if (isTokenMintFailure(error)) {
      logger.warn(
        { ...fields.user(operator), installation_id: installationId, err: error },
        `could not authenticate as the installation of ${format.user(operator)} - `
          + `is this instance running against a different GitHub App?`
      );

      return { ok: false, status: 502, error: 'your installation could not be authenticated' };
    }

    if (error?.status === 404) {
      return { ok: false, status: 404, error: 'github does not know this pull request' };
    }

    logger.warn({ ...fields.user(operator), err: error }, `lookup failed: ${error.message}`);

    return { ok: false, status: 502, error: 'github could not be reached' };
  }

  if (pullRequest.merged !== true) {
    // The one rule that makes every entry a fact rather than something to follow.
    return { ok: false, status: 409, error: 'only merged work can be recorded' };
  }

  const author = pullRequest.user?.login ?? null;
  const { enrolled } = author ? await isEnrolledUser(author) : { enrolled: false };

  return {
    ok: true,
    found: {
      forge: 'github',
      fullName: parsed.fullName,
      number: parsed.number,
      url: parsed.url,
      id: pullRequest.id,
      title: pullRequest.title,
      author,
      authorId: pullRequest.user?.id ?? null,
      enrolled,
      openedAt: pullRequest.created_at ?? null,
      mergedAt: pullRequest.merged_at ?? null,
      mergedBy: pullRequest.merged_by?.login ?? null,
      commits: pullRequest.commits ?? null,
      changedFiles: pullRequest.changed_files ?? null,
      stars: pullRequest.base?.repo?.stargazers_count ?? null,
      repositoryId: pullRequest.base?.repo?.id ?? null,
    },
  };
};

/**
 * Write one down
 *
 * The GitHub path fetches again rather than trusting what the browser sends back. The preview
 * the operator saw is a courtesy; this is the record, and a payload that has been round-tripped
 * through a page is not evidence of anything.
 *
 * The repository row and the contribution are one unit, as the sync job writes them: a failure
 * between the two would otherwise leave a registry row nothing points at.
 */
const recordContribution = async (body, operator) => {
  const found = await lookupContribution(body?.url, operator);

  if (!found.ok) {
    return found;
  }

  if (found.found.forge === 'github') {
    const pr = found.found;

    if (!pr.enrolled) {
      return { ok: false, status: 409, error: `${pr.author} has never enrolled` };
    }

    const { recorded } = await transaction(async (run) => {
      const { id: repositoryId } = await ensureRepository(pr.fullName, pr.repositoryId, run);

      return upsertManualContribution({ ...pr, openedBy: pr.author }, repositoryId, run);
    });

    return { ok: true, recorded, contribution: pr };
  }

  // GitLab: the author is picked rather than written, whatever else could be read.
  const mr = found.found;
  const { fullName, number, host, url } = mr;
  const openedBy = typeof body?.author === 'string' ? body.author.trim() : '';

  // Read again where reading is possible, typed only where it is not - and never a mixture of
  // the two. What came back from the browser is the preview the operator saw, not evidence: on
  // the readable path the fields below are the forge's own answer, fetched a second time, which
  // is the same rule the GitHub path follows.
  const typed = mr.needsTyping === true;
  const title = typed
    ? (typeof body?.title === 'string' ? body.title.trim() : '')
    : mr.title;
  const mergedAt = typed ? asDate(body?.mergedAt) : mr.mergedAt;

  if (!openedBy || !title || !mergedAt) {
    return { ok: false, status: 400, error: 'an author, a title and a merge date are required' };
  }

  const { enrolled } = await isEnrolledUser(openedBy);

  if (!enrolled) {
    // The picker only offers the enrolled, so reaching this means the payload was not built by
    // the page. Refused all the same: a gate that only exists in a form is not a gate.
    return { ok: false, status: 409, error: `${openedBy} is not an enrolled account` };
  }

  const { recorded } = await transaction(async (run) => {
    const { id: repositoryId } = await ensureForeignRepository(fullName, run);

    return upsertManualContribution({
      id: synthesiseId(host, fullName, number),
      number,
      title,
      url,
      fullName,
      openedBy,
      openedAt: typed ? asDate(body?.openedAt) : mr.openedAt,
      mergedAt,
      // Never `merge_user`, even when GitLab hands it over: this column is joined to
      // installations by name, and the names in it are GitHub logins. See
      // gitlabService.mapMergeRequest().
      mergedBy: null,
      commits: typed ? asCount(body?.commits) : mr.commits,
      changedFiles: typed ? asCount(body?.changedFiles) : mr.changedFiles,
      stars: typed ? asCount(body?.stars) : mr.stars,
    }, repositoryId, run);
  });

  return { ok: true, recorded, contribution: { fullName, number, url, author: openedBy } };
};

/* ------------------------------------------------------------------ the routes */

/**
 * The operator gate, spelled the same way as the one write route that came before it: 404 and
 * not 403, because whether a route exists is not something to confirm to somebody who may not
 * use it.
 */
const refuseUnlessOperator = (req, res) => {
  if (req.isOperator) {
    return false;
  }

  res.status(404).json({ error: 'not found' });

  return true;
};

export async function handleGetManualContributions(req, res) {
  if (refuseUnlessOperator(req, res)) {
    return;
  }

  try {
    res.json({ contributions: await listManualContributions() });
  } catch (error) {
    logger.error({ err: error, ...fields.user(req.dashboardLogin) }, `could not list manual entries: ${error.message}`);
    res.status(503).json({ error: 'the list could not be read' });
  }
}

export async function handlePostManualLookup(req, res) {
  if (refuseUnlessOperator(req, res)) {
    return;
  }

  try {
    const result = await lookupContribution(req.body?.url, req.dashboardLogin);

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.found);
  } catch (error) {
    logger.error({ err: error, ...fields.user(req.dashboardLogin) }, `lookup failed: ${error.message}`);
    res.status(503).json({ error: 'the lookup failed' });
  }
}

export async function handlePostManualContribution(req, res) {
  if (refuseUnlessOperator(req, res)) {
    return;
  }

  try {
    const result = await recordContribution(req.body, req.dashboardLogin);

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    // The only trace a manual entry leaves. At info, and naming both people: the operator who
    // decided and the contributor being credited.
    logger.info(
      { ...fields.user(req.dashboardLogin), credited: result.contribution.author, url: result.contribution.url },
      `${format.user(req.dashboardLogin)} recorded ${result.contribution.fullName}#${result.contribution.number} `
        + `for ${format.user(result.contribution.author)}${result.recorded ? '' : ' (already known, updated)'}`
    );

    res.status(result.recorded ? 201 : 200).json({ recorded: result.recorded });
  } catch (error) {
    logger.error({ err: error, ...fields.user(req.dashboardLogin) }, `could not record: ${error.message}`);
    res.status(503).json({ error: 'the contribution could not be recorded' });
  }
}

export async function handleDeleteManualContribution(req, res) {
  if (refuseUnlessOperator(req, res)) {
    return;
  }

  // Negative ids are real here - see synthesiseId() - so this is not a positive-integer check.
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id === 0) {
    res.status(400).json({ error: 'not a contribution id' });
    return;
  }

  try {
    const removed = await deleteManualContribution(id);

    if (!removed) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    logger.info(
      { ...fields.user(req.dashboardLogin), pull_request_id: id },
      `${format.user(req.dashboardLogin)} removed the hand-recorded contribution ${id}`
    );

    res.json({ removed: true });
  } catch (error) {
    logger.error({ err: error, ...fields.user(req.dashboardLogin) }, `could not remove ${id}: ${error.message}`);
    res.status(503).json({ error: 'the contribution could not be removed' });
  }
}
