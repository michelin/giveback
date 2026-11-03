/**
 * The transition values handleInstallationEvent (src/db/installations.js) accepts.
 *
 * The switch's legal inputs, not every installation webhook: `installation.created` is routed
 * to its own insert path (src/app.js) and never reaches this object, so a value added here
 * without a case falls through to the default throw.
 */
export const InstallationEvent = {
  SUSPEND: "suspend",
  UNSUSPEND: "unsuspend",
  DELETED: "deleted",
};
