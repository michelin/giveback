import * as installationsDb from "../db/installations.js";
import * as octokitService from "./octokitService.js";
import { getLogger, format, fields } from "../utils/logger.js";
import { ALLOWED_EMAIL_DOMAINS } from "../utils/constants.js";
import { pickEnrollmentEmail, formatAllowedEmailDomains } from "../utils/email.js";
import { enrollmentPage } from "../utils/enrollmentPages.js";
import { THEMES, themeOf } from "../utils/theme.js";
import { InstallationEvent } from "../utils/types.js";

const logger = getLogger("endpointService");

/**
 * Remove an installation whose owner failed the email check
 *
 * Safe here and only here: the installation came from GET /user/installations, so it is
 * provably the caller's own. Never fatal — a failed uninstall leaves an unverified row, which
 * is never synchronized, so the user still gets the instructions instead of an error page.
 */
async function uninstallRejected(login, installationId) {
  try {
    await octokitService.deleteInstallation(installationId);
    // Recorded now rather than waiting for the installation.deleted webhook, so the row is out
    // of the way even if that delivery is lost.
    await installationsDb.handleInstallationEvent(InstallationEvent.DELETED, installationId);

    logger.info(
      { ...fields.installation(installationId), ...fields.user(login) },
      `removed ${format.installation(installationId)} from ${format.user(login)}'s account and marked the row deleted - no eligible address`
    );
  } catch (error) {
    logger.error(
      { err: error, ...fields.installation(installationId), ...fields.user(login) },
      `could not remove ${format.installation(installationId)} from ${format.user(login)}'s account - it stays installed but unverified, so it is never synchronized: ${error.message}`
    );
  }
}

/**
 * Is this the one-shot OAuth code being replayed? A refresh, a bookmark or the back button all
 * land here, and none of them is a fault.
 */
const isSpentCode = (error) =>
  error?.response?.data?.error === 'bad_verification_code' ||
  /bad_verification_code/.test(error?.message ?? '');

/**
 * Handle the OAuth callback GitHub redirects to after an installation
 *
 * Performs the enrollment and never renders: it always ends in a redirect, so the URL the user
 * is left on carries no one-shot code and can be refreshed, bookmarked or shared.
 *
 * The installation_id in the query string is deliberately ignored. Nothing ties it to the OAuth
 * code, and since this app never initiated the redirect a `state` nonce is not even possible —
 * trusting it let anyone act on an arbitrary installation. GET /user/installations is the
 * authority instead: called with the user's own token it can only return that user's
 * installations, so it proves ownership, and it reports the installation that exists right now.
 * Reading the id from the database would lag behind the installation.created webhook, and on a
 * reinstall the callback would verify against a dead installation id.
 */
export async function handleGetCallback(req, res) {
  const { code } = req.query;

  // 303, not 302: "the result of your request is over there", which is what makes the
  // destination safe to reload.
  const done = (reason) => res.redirect(303, `/enroll?reason=${reason}`);

  if (!code) {
    logger.debug('callback reached without an oauth code - most likely a direct visit');
    done('stale-link');
    return;
  }

  // Hoisted so the catch below can name who failed: scoped inside the try, every enrollment
  // error reads "an unidentified user".
  let login = null;

  try {
    const { access_token: accessToken } = await octokitService.exchangeCodeForToken(code);
    const user = await octokitService.getAuthenticated(accessToken);

    login = user.login;

    logger.info({ ...fields.user(login) }, `enrollment started for ${format.user(login)}`);

    const installations = await octokitService.listInstallationsForUser(accessToken);

    // One installation == one user, so only an installation on the user's own account can be
    // enrolled. An organization install shows up here too and is deliberately not eligible.
    const installation = installations.find((candidate) => candidate.account?.id === user.id);

    if (!installation) {
      logger.warn(
        { ...fields.user(login), visible_installations: installations.length },
        `no personal installation for ${format.user(login)} among ${installations.length} visible - only an installation on the user's own account can be enrolled`
      );
      done('no-installation');
      return;
    }

    const emails = await octokitService.listEmailsForAuthenticated(accessToken);
    const enrollmentEmailAddress = pickEnrollmentEmail(emails, ALLOWED_EMAIL_DOMAINS);

    if (!enrollmentEmailAddress) {
      logger.info(
        { ...fields.user(login), ...fields.installation(installation.id) },
        `enrollment rejected for ${format.user(login)} - no verified address on ${ALLOWED_EMAIL_DOMAINS.join(', ')}`
      );
      await uninstallRejected(login, installation.id);
      done('no-allowed-email');
      return;
    }

    await installationsDb.verifyInstallation(user, enrollmentEmailAddress, installation.id);

    logger.info(
      { ...fields.user(login), ...fields.installation(installation.id) },
      `enrolled ${format.user(login)} with ${format.installation(installation.id)}`
    );

    res.redirect(`https://github.com/settings/installations/${installation.id}`);
  } catch (error) {
    if (isSpentCode(error)) {
      logger.debug('callback replayed with a spent oauth code - a refresh or the back button');
      done('stale-link');
      return;
    }

    logger.error(
      { err: error, ...(login ? fields.user(login) : {}) },
      `enrollment failed for ${login ? format.user(login) : 'an unidentified user'}: ${error.message}`
    );
    done('error');
  }
}

/**
 * Render the enrollment outcome page
 *
 * No side effect and no one-shot token, so it is safe to reload. The reason is user input, so
 * an unknown value falls back to the neutral page.
 */
export function handleGetEnroll(req, res) {
  const theme = themeOf(req);

  res.render("enroll", {
    page: enrollmentPage(req.query.reason, formatAllowedEmailDomains()),
    theme,
    themeColor: THEMES[theme].ground,
  });
}
