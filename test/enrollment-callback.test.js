import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The inbound write path: the OAuth callback that enrolls somebody, the webhook handler that
 * records a new installation, and the registration that ties each event name to a handler.
 *
 * Read as text rather than called, like the ~45 other source-reading assertions in this suite.
 * Every branch of handleGetCallback goes through octokitService and the database, and mocking
 * either needs --experimental-test-module-mocks - a process-wide flag in package.json's `test`
 * script, which would put the whole suite behind a Node feature that might change at any time.
 * The cost of reading source instead is that a rename fails this file until it is updated; the
 * invariants below were chosen because losing any of them is otherwise silent.
 */

const read = (path) => readFileSync(join(ROOT, path), "utf8");

const endpoint = read("src/services/endpointService.js");
const event = read("src/services/eventService.js");
const app = read("src/app.js");

/**
 * Where a literal appears in a source, failing if it does not
 *
 * indexOf alone is a trap for ordering assertions: a missing needle returns -1, which is less
 * than everything, so the ordering passes precisely when the code it orders has gone.
 * @param {string} source
 * @param {string} needle
 * @returns {number} Index of the first occurrence
 */
const at = (source, needle) => {
  const index = source.indexOf(needle);

  assert.ok(index >= 0, `src no longer contains: ${needle}`);

  return index;
};

describe("the OAuth callback proves ownership before it enrolls anybody", () => {
  test("the installation_id in the query string is never read", () => {
    // The invariant the comment above handleGetCallback records: nothing ties that id to the
    // OAuth code, and since this app never initiated the redirect a `state` nonce is not even
    // possible - trusting it let anyone act on an arbitrary installation.
    assert.doesNotMatch(endpoint, /query\.installation_id/, 'the query string installation_id is attacker-controlled');
    assert.match(endpoint, /const \{ code \} = req\.query;/, 'the code is the only thing the callback may take from the query string');
  });

  test("the installation comes from the caller's own token", () => {
    // GET /user/installations called with the user's token can only return that user's
    // installations, which is what makes it the ownership proof. Reading the id from the
    // database instead would lag the installation.created webhook, and on a reinstall would
    // verify against a dead installation id.
    assert.match(endpoint, /octokitService\.listInstallationsForUser\(accessToken\)/);
    assert.match(endpoint, /candidate\.account\?\.id === user\.id/, 'without this predicate any visible installation enrolls, including an organization one');
  });

  test("every enrollment outcome leaves the user on a reloadable URL", () => {
    // 303, not 302: "the result of your request is over there", which is what makes the
    // destination safe to refresh, bookmark or share.
    assert.match(endpoint, /res\.redirect\(303, `\/enroll\?reason=\$\{reason\}`\)/);
    assert.doesNotMatch(endpoint, /redirect\(302/);
  });

  test("a rejected owner is uninstalled before the page tells them why", () => {
    // Order matters twice over. The uninstall has to happen while the request still holds the
    // proof that the installation is the caller's own, and the row has to be marked deleted
    // after the installation is actually gone.
    assert.ok(
      at(endpoint, 'await uninstallRejected(login, installation.id)') < at(endpoint, "done('no-allowed-email')"),
      'the rejection page must not be the end of the request while the app stays installed'
    );

    const uninstall = endpoint.slice(
      at(endpoint, 'async function uninstallRejected'),
      at(endpoint, 'const isSpentCode')
    );

    assert.ok(
      at(uninstall, 'octokitService.deleteInstallation(installationId)') <
        at(uninstall, 'installationsDb.handleInstallationEvent(InstallationEvent.DELETED, installationId)'),
      'marking the row deleted before the uninstall succeeds would lose the row and keep the app installed'
    );
  });
});

describe("installation.created is the only enrollment signal", () => {
  test("an organization install is dropped before anything is written", () => {
    // One installation == one user is baked into the data model: github_installations is keyed
    // on user_id and contributions are fetched per GitHub handle, so an org install would
    // create rows nothing can ever match.
    const guard = at(event, "if (account.type !== 'User') {");
    const returned = event.indexOf('return;', guard);

    assert.ok(returned > guard, 'the account.type guard no longer returns');
    assert.ok(
      returned < at(event, 'installationsDb.insertPendingInstallation(account, installationId)'),
      'the guard must return before the insert - the warn line is its only trace, so a row written here is invisible'
    );
  });
});

describe("every webhook this app answers is wired to its own handler", () => {
  test("all four installation events reach the handler named for them", () => {
    // A misspelt event name is not silent: @octokit/webhooks validates with
    // onUnknownEventName: "warn" and prints `"installation.suspned" is not a known webhook
    // name` through the app logger at boot. What the runtime cannot catch is a valid name wired
    // to the wrong handler - suspend calling handleInstallationUnsuspended would mark every
    // suspended installation active again, and nothing would say so.
    const registered = Object.fromEntries(
      [...app.matchAll(/app\.on\("([^"]+)", (\w+)\)/g)].map((match) => [match[1], match[2]])
    );

    assert.deepEqual(registered, {
      'installation.created': 'handleInstallationCreated',
      'installation.suspend': 'handleInstallationSuspended',
      'installation.unsuspend': 'handleInstallationUnsuspended',
      'installation.deleted': 'handleInstallationDeleted',
    });
  });
});
