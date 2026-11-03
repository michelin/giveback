import * as installationsDb from "../db/installations.js";
import { InstallationEvent } from "../utils/types.js";
import { getLogger, format, fields } from "../utils/logger.js";

const logger = getLogger("eventService");

// The raw enum is suspend|unsuspend|deleted, which does not read as English in a sentence.
const EVENT_LABEL = {
  [InstallationEvent.SUSPEND]: 'suspended',
  [InstallationEvent.UNSUSPEND]: 'unsuspended',
  [InstallationEvent.DELETED]: 'deleted',
};

/**
 * Handle installation.created, the only trustworthy enrollment signal
 *
 * Probot HMAC-verifies the payload, so installation.id and installation.account.id cannot be
 * forged. The row is written as pending: it is synchronized only once the OAuth callback proves
 * a verified address on an allowed domain.
 */
export async function handleInstallationCreated(context) {
  const { id: installationId, account } = context.payload.installation;

  // One installation == one user is baked into the data model: github_installations is keyed
  // on user_id and contributions are fetched per GitHub handle, so an org install would create
  // rows nothing can ever match.
  if (account.type !== 'User') {
    // The line states the consequence because there is none: nothing is recorded, counted or
    // uninstalled. This is its only trace.
    logger.warn(
      // fields.user, not an `account:` key of its own: a login is spelled `user` everywhere else
      // in the stream, and this warn is the only trace of an ignored install — under any other
      // key an operator filtering `user = "acme-org"` never finds it. account_type sitting
      // beside it resolves the oddity of labelling a non-User account `user`.
      { ...fields.installation(installationId), ...fields.user(account.login), account_type: account.type },
      `ignoring ${format.installation(installationId)} - ${account.login} is a ${account.type}, not a User: nothing is recorded and the app stays installed`
    );
    return;
  }

  // No line before the insert: it would claim success before the work happened, and duplicate
  // the outcome line the db layer already writes.
  try {
    await installationsDb.insertPendingInstallation(account, installationId);
  } catch (error) {
    logger.error(
      { err: error, ...fields.installation(installationId), ...fields.user(account.login) },
      `could not record ${format.installation(installationId)} from webhook installation.created: ${error.message}`
    );
  }
}

/**
 * Apply a lifecycle transition reported by a webhook
 * @param {string} installationEvent - One of InstallationEvent
 */
const applyInstallationEvent = async (installationEvent, context) => {
  const installationId = context.payload.installation.id;

  const label = EVENT_LABEL[installationEvent] ?? installationEvent;

  try {
    await installationsDb.handleInstallationEvent(installationEvent, installationId);

    logger.info(
      { ...fields.installation(installationId), event: installationEvent },
      `${format.installation(installationId)} ${label} (webhook)`
    );
  } catch (error) {
    logger.error(
      { err: error, ...fields.installation(installationId), event: installationEvent },
      `could not mark ${format.installation(installationId)} ${label}: ${error.message}`
    );
  }
};

export const handleInstallationSuspended = (context) =>
  applyInstallationEvent(InstallationEvent.SUSPEND, context);

export const handleInstallationUnsuspended = (context) =>
  applyInstallationEvent(InstallationEvent.UNSUSPEND, context);

export const handleInstallationDeleted = (context) =>
  applyInstallationEvent(InstallationEvent.DELETED, context);
