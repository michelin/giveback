import { getLogger } from "./utils/logger.js";
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationSuspended,
  handleInstallationUnsuspended,
} from "./services/eventService.js";

/**
 * Probot app: webhook handlers only.
 *
 * Startup work — env validation, scheduling, shutdown — lives in src/index.js. Inside this
 * factory a failure is invisible and cannot keep the process from reporting itself healthy.
 * @param {import('probot').Probot} app
 */
export default (app) => {
  const logger = getLogger("app");

  // The signed enrollment signal. Everything else is a state transition on a row this
  // handler created.
  app.on("installation.created", handleInstallationCreated);
  app.on("installation.suspend", handleInstallationSuspended);
  app.on("installation.unsuspend", handleInstallationUnsuspended);
  app.on("installation.deleted", handleInstallationDeleted);

  // Routed through our own logger rather than Probot's: this is the only record of a failed
  // delivery, and it has to name the event, the delivery and the installation.
  app.onError(async (error) => {
    logger.error(
      {
        err: error,
        event: error.event?.name,
        delivery: error.event?.id,
        installation_id: error.event?.payload?.installation?.id,
      },
      `webhook ${error.event?.name ?? 'delivery'} failed: ${error.message}`
    );
  });
};
