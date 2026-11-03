import { getLogger } from "../utils/logger.js";

const logger = getLogger("dashboardShared");

// What the page has already said it cannot read. Complained about once per subject, not on
// every snapshot: the page polls every five seconds, so a per-request warning would be 720
// identical lines an hour per open tab.
const complainedAbout = new Set();

/**
 * Build a rejection handler that degrades one optional read
 *
 * A database whose schema predates job_runs is a real state an adopter passes through. Losing
 * the sparklines there is acceptable; answering 500 for the page that is supposed to tell you
 * what the bot is doing is not.
 *
 * `degraded` is per-snapshot, never module state: derived from the module flag afterwards, one
 * failed read out of three was reset to healthy by the next successful one, and the page
 * reported no degradation while a panel sat empty. The set only throttles the log line.
 * @param {Set<string>} degraded - Collects what this snapshot could not read
 * @param {string} what - How the page names the missing panel to its reader
 * @param {*} fallback - Value to use instead
 */
export const tolerate = (degraded, what, fallback) => (error) => {
  degraded.add(what);

  if (!complainedAbout.has(what)) {
    complainedAbout.add(what);
    logger.warn(
      { err: error },
      `the dashboard cannot read ${what} - showing the page without it, re-apply init.sql if the schema is behind: ${error.message}`
    );
  }

  return fallback;
};

/**
 * Say so, once, of every subject that was complained about and read cleanly this time
 *
 * Recovery is per subject: "nothing this snapshot read under that name failed", not "one of
 * the reads worked".
 * @param {Set<string>} degraded - What this snapshot could not read, once all its reads settled
 */
export const noteRecoveries = (degraded) => {
  for (const what of complainedAbout) {
    if (!degraded.has(what)) {
      complainedAbout.delete(what);
      logger.info(`the dashboard can read ${what} again`);
    }
  }
};
