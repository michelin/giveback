import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { format, fields, errSerializer } from "../src/utils/logger.js";
import { jobOutcome } from "../src/utils/jobSummary.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every .js file under src/ and jobs/
 * @returns {Array<{path: string, lines: string[]}>}
 */
const sourceFiles = () => {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;

      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
      } else if (entry.endsWith(".js")) {
        found.push({ path: rel, lines: readFileSync(join(ROOT, rel), "utf8").split("\n") });
      }
    }
  };

  walk("src");
  walk("jobs");

  return found;
};

const FILES = sourceFiles();
const LOG_CALL = /logger\.(trace|debug|info|warn|error|fatal)\(/;

/**
 * The code on a line, with comments removed
 *
 * These checks describe what the code does, and several of the rules are *explained* in
 * comments that quote the very pattern they forbid.
 * @param {string} line - Source line
 * @returns {string} The line's code, or "" if it is entirely a comment
 */
const codeOf = (line) => {
  const trimmed = line.trim();

  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return '';
  }

  return line.split('//')[0];
};

describe("format helpers", () => {
  test("one entity has one spelling", () => {
    assert.equal(format.repo("octocat", "hello"), "octocat/hello");
    assert.equal(format.pr(12, { owner: "octocat", name: "hello" }), "octocat/hello#12");
    assert.equal(format.pr(12), "pr #12");
    assert.equal(format.pr(12, { owner: "octocat" }), "pr #12", "a half-known repo falls back rather than printing undefined");
    assert.equal(format.installation(12345), "installation 12345");
    assert.equal(format.user("octocat"), "user octocat");
  });

  test("durations are never hand-formatted", () => {
    assert.equal(format.duration(0), "0ms");
    assert.equal(format.duration(842), "842ms");
    assert.equal(format.duration(8400), "8.4s");
    assert.equal(format.duration(140_000), "2.3min");
    // The hours branch, pinned at the boundary: from an hour on a duration reads in hours, so
    // three days is "72.0h" and never "4320.0min".
    assert.equal(format.duration(3_600_000), "1.0h");
    assert.equal(format.duration(259_200_000), "72.0h");
    // A missing or absurd duration must not render "NaNms" in a report line.
    for (const bad of [undefined, null, Number.NaN, -5]) {
      assert.equal(format.duration(bad), "0ms");
    }
  });

  test("counters keep their zeros, so every run has the same shape", () => {
    // grep 'failed=[1-9]' must find every bad run and nothing else, which only works if a
    // good run also prints failed=0.
    assert.equal(format.counts({ claimed: 4, changed: 3, failed: 0 }), "claimed=4 changed=3 failed=0");
    assert.equal(format.counts({}), "");
    assert.equal(format.counts(undefined), "");
  });

  test("fields are the structured twin of the prose", () => {
    assert.deepEqual(fields.installation(12345), { installation_id: 12345 });
    assert.deepEqual(fields.user("octocat"), { user: "octocat" });
    assert.deepEqual(fields.pr(12, { owner: "octocat", name: "hello" }), { pr_number: 12, repo: "octocat/hello" });
    assert.deepEqual(fields.pr(12), { pr_number: 12 });
    assert.deepEqual(fields.job("sync_contributions"), { job: "sync_contributions" });
  });
});

describe("the job report", () => {
  test("renders the four outcomes", () => {
    assert.equal(
      format.jobReport("sync_contributions", { ok: true, durationMs: 8400, claimed: 4, changed: 3, failed: 0 }),
      "sync_contributions ok in 8.4s - claimed=4 changed=3 failed=0"
    );
    assert.equal(
      format.jobReport("sync_contributions", { ok: true, durationMs: 41, claimed: 0 }),
      "sync_contributions idle in 41ms - claimed=0"
    );
    assert.equal(
      format.jobReport("poll_non_closed_pull_requests", { ok: false, durationMs: 2100, claimed: 137, failed: 1, error: "connection terminated unexpectedly" }),
      "poll_non_closed_pull_requests failed in 2.1s - claimed=137 failed=1: connection terminated unexpectedly"
    );
    assert.equal(
      format.jobReport("reconcile_installations", { ok: true, durationMs: 120, skipped: true, live: 0 }),
      "reconcile_installations skipped in 120ms - live=0"
    );
  });

  test("system state goes behind the pipe, never mixed with the run's own counters", () => {
    const line = format.jobReport("reconcile_installations", {
      ok: true,
      durationMs: 6200,
      live: 812,
      corrected: 2,
      state: { active: 780, pending: 17, due: 126 },
    });

    assert.equal(line, "reconcile_installations ok in 6.2s - live=812 corrected=2 | active=780 pending=17 due=126");
    assert.equal((line.match(/\|/g) ?? []).length, 1, "the pipe is reserved for this one separator");
  });

  test("a numeric `skipped` counter is not mistaken for the skipped outcome", () => {
    // reconcile posts `skipped: true` to mean "this run declined to do anything"; sync posts a
    // count of events it stepped over. Conflating them dropped sync's counter from the line.
    const line = format.jobReport("sync_contributions", { ok: true, durationMs: 100, claimed: 2, skipped: 3 });

    assert.match(line, /^sync_contributions ok /);
    assert.match(line, /skipped=3/);
  });

  test("the prose and the fields can never disagree on the outcome", () => {
    // Both are derived from one shared function, because a line that says "ok" next to a field
    // that says failed is worse than either alone.
    const cases = [
      [{ ok: true, durationMs: 10, claimed: 2 }, "ok"],
      [{ ok: true, durationMs: 10, claimed: 0 }, "idle"],
      [{ ok: false, durationMs: 10, claimed: 2 }, "failed"],
      [{ ok: true, durationMs: 10, skipped: true, live: 0 }, "skipped"],
    ];

    for (const [summary, expected] of cases) {
      assert.equal(fields.jobReport("j", summary).outcome, expected);
      assert.match(format.jobReport("j", summary), new RegExp(`^j ${expected} `));
    }
  });

  test("jobOutcome hands back the outcome word and the run's own counters, nothing else", () => {
    // recordRun() in breeService depends on this shape directly: what comes back as `counters`
    // is what lands in job_runs.counters, so the fields with their own column and the system
    // state have to be gone before it gets there.
    assert.deepEqual(
      jobOutcome({ ok: true, durationMs: 100, claimed: 4, failures: [{}], state: { active: 1 } }),
      { outcome: "ok", counters: { claimed: 4 } }
    );
  });

  test("the fields carry no raw ok boolean and no camelCase duration", () => {
    const f = fields.jobReport("sync_contributions", {
      ok: true,
      durationMs: 855,
      claimed: 1,
      state: { active: 780, due: 126 },
    });

    assert.equal(f.ok, undefined, "outcome replaces it, and reads the same as the message");
    assert.equal(f.durationMs, undefined, "duration_ms is the one spelling");
    assert.equal(f.duration_ms, 855);
    assert.equal(f.outcome, "ok");
    // Flattened and prefixed: `active` would collide with a run counter of the same name.
    assert.equal(f.state, undefined);
    assert.equal(f.state_active, 780);
    assert.equal(f.state_due, 126);
  });

  test("installation_id has one type, whatever the source", () => {
    // PostgreSQL returns BIGINT as a string to protect precision; a webhook payload gives a
    // number. Two types on one field breaks every filter a log platform can apply to it.
    assert.deepEqual(fields.installation("157202528"), { installation_id: 157202528 });
    assert.deepEqual(fields.installation(157202528), { installation_id: 157202528 });
    assert.equal(typeof fields.installation("157202528").installation_id, "number");
  });

  test("ok, error and durationMs never appear as counters", () => {
    const line = format.jobReport("x", { ok: true, durationMs: 100, error: "boom", claimed: 1 });

    assert.doesNotMatch(line, /ok=/);
    assert.doesNotMatch(line, /durationMs=/);
    assert.doesNotMatch(line, /error=/);
  });
});

describe("the codebase obeys docs/logging.md", () => {
  test("no message starts with an uppercase letter or with the word \"error\"", () => {
    // Environment variables, SQL relations and webhook names keep their real casing, so a
    // message may legitimately open with an ALL_CAPS token.
    const violations = [];

    for (const { path, lines } of FILES) {
      lines.forEach((line, index) => {
        const call = LOG_CALL.exec(line);
        if (!call) {
          return;
        }

        const message = /[`'"]([A-Za-z].*?)[`'"]/.exec(line.slice(call.index + call[0].length));
        if (!message) {
          return;
        }

        const text = message[1];
        const firstWord = text.split(/[\s:]/)[0];
        const isIdentifier = /^[A-Z][A-Z0-9_]+$/.test(firstWord);

        if ((text[0] === text[0].toUpperCase() && text[0] !== text[0].toLowerCase() && !isIdentifier) ||
            text.toLowerCase().startsWith("error ")) {
          violations.push(`${path}:${index + 1} ${text.slice(0, 60)}`);
        }
      });
    }

    assert.deepEqual(violations, []);
  });

  test("every error and fatal hands the Error to pino", () => {
    // Without `{ err }` no stack and no cause chain ever reaches the log, which was the single
    // biggest gap against "clear errors". Carrying the field is only half of it: pino's
    // serializer passes a non-Error straight through, so `err: error.message` produces a log
    // line with no type, no stack and no cause - the very absence the rule exists to forbid.
    const violations = [];

    // `err:` handed something that provably is not an Error. Only the shapes a reader can settle
    // from the text: a bare local name may well hold an Error and is left to the reviewer.
    const NOT_AN_ERROR = /err:\s*(null\b|undefined\b|String\(|['"`]|\w+\.(message|error)\b)/;

    for (const { path, lines } of FILES) {
      lines.forEach((line, index) => {
        // Three spellings of the same call, and the rule has to see all three: `logger.error(`,
        // the job's rebound `jobLogger.error(`, and the two computed-level calls that pick their
        // level from the outcome (jobs/jobRun.js and jobs/sync_repositories.js) - which the
        // dotted pattern alone reads as no log call at all.
        //
        // codeOf, like every other rule here: the reason this one exists is written in comments
        // that quote `logger.error(` to explain it.
        if (!/ogger\.(error|fatal)\(|ogger\[[^\]]*'error'[^\]]*\]\(/.test(codeOf(line))) {
          return;
        }

        // The call may span several lines.
        const window = lines.slice(index, index + 5).map(codeOf).join("\n");

        if (!/err:/.test(window)) {
          violations.push(`${path}:${index + 1} no cause: ${line.trim().slice(0, 60)}`);
        } else if (NOT_AN_ERROR.test(window)) {
          violations.push(`${path}:${index + 1} the cause is not an Error: ${NOT_AN_ERROR.exec(window)[0]}`);
        }
      });
    }

    assert.deepEqual(violations, []);
  });

  test("the rule above can tell an Error from the string that came off one", () => {
    // The rule is a text scan, so what it rejects is worth pinning: it stayed green for years
    // against `err: summary.error`, a plain string, which is exactly the shape it names.
    const NOT_AN_ERROR = /err:\s*(null\b|undefined\b|String\(|['"`]|\w+\.(message|error)\b)/;

    for (const rejected of ["{ err: null }", "{ err: undefined }", "{ err: String(error) }",
      "{ err: 'boom' }", "{ err: error.message }", "{ err: summary.error }"]) {
      assert.match(rejected, NOT_AN_ERROR, `${rejected} must not satisfy the cause rule`);
    }

    for (const accepted of ["{ err: error }", "{ err: reason }", "{ err: releaseError }",
      "{ err: new Error(String(summary.error)) }", "{ err: error, ...totals }"]) {
      assert.doesNotMatch(accepted, NOT_AN_ERROR, `${accepted} is a legitimate cause`);
    }
  });

  test("no layer logs an error it also rethrows", () => {
    // A one-line lookback exempted almost every call site there is: a logger.error carrying a
    // context object spans three or four lines and closes with `);` on its own, so the line
    // before a following throw is a bracket, never the call. 16 of the 28 error calls in the
    // tree are that shape.
    //
    // logger.error only, not fatal: src/index.js logs fatal and rethrows on purpose at boot,
    // which is the one place the pattern is right. And a bare `throw error;` rethrow counts -
    // it is the dominant shape here, and it double-reports the same failure just as loudly.
    const violations = [];

    for (const { path, lines } of FILES) {
      lines.forEach((line, index) => {
        if (!/throw new Error|^\s*throw (error|err);/.test(codeOf(line))) {
          return;
        }

        const window = lines.slice(Math.max(0, index - 6), index).map(codeOf).join("\n");

        if (/ogger\.error\(/.test(window)) {
          violations.push(`${path}:${index + 1} ${line.trim().slice(0, 70)}`);
        }
      });
    }

    assert.deepEqual(violations, []);
  });

  test("format and fields are reached as imports, never through the logger", () => {
    // getLogger returns a bare pino instance, so `logger.format.duration(ms)` is a TypeError
    // at runtime - raised inside a log call, which is the least likely place to be exercised
    // before production. It compiles, eslint accepts it, and only this catches it.
    const violations = FILES
      .flatMap(({ path, lines }) => lines
        .map((line, index) => (/logger\.(format|fields)\b/.test(codeOf(line)) ? `${path}:${index + 1}` : null))
        .filter(Boolean));

    assert.deepEqual(violations, []);
  });

  test("a killed worker can be recognised on every run, not only the first", async () => {
    // The set that separates "killed at closeWorkerAfterMs" (a warn: the claimed rows come
    // back with the lease) from "crashed" (an error) is keyed on "has this run reported yet".
    // Nothing cleared it, so after a job's first successful run every later timeout was
    // reported as a crash. Bree emits 'worker created' just before each worker starts, which
    // is the one moment the answer is knowably false.
    const { bree } = await import("../src/services/breeService.js");

    assert.ok(
      bree.listenerCount('worker created') > 0,
      "nothing resets the reported set, so the timeout verdict only ever fires once per job"
    );
  });

  test("nothing calls process.exit, which truncates pino's async transport", () => {
    const violations = [];

    // One exception, and only in this exact shape: src/index.js's backstop after an uncaught
    // error. Delayed past the orderly shutdown, which is what flushes the transport, and unref'd,
    // so it only ever fires when that shutdown could not end the process.
    const BACKSTOP = /setTimeout\(\(\) => process\.exit\(1\), FATAL_EXIT_TIMEOUT_MS\)\.unref\(\);/;

    for (const { path, lines } of FILES) {
      lines.forEach((line, index) => {
        if (/process\.exit\s*\(/.test(codeOf(line)) && !(path.endsWith('src/index.js') && BACKSTOP.test(line))) {
          violations.push(`${path}:${index + 1} ${line.trim().slice(0, 70)}`);
        }
      });
    }

    assert.deepEqual(violations, []);
  });

  test("a pg error cannot carry parameter values into the log", () => {
    // pg-promise builds error.query by inlining the parameter values client-side, and pino's
    // default serializer publishes every enumerable own property of an Error. Measured against
    // PostgreSQL 17: a failed enrollment INSERT reaches the log with the user's email address
    // and real name in it, whenever the RAW pg error is the one handed to logger.error.
    const pgError = Object.assign(new Error('invalid input syntax for type bigint'), {
      code: '22P02',
      query: "INSERT INTO github_installations (user_name, user_enrollment_email_address) "
        + "VALUES ('A Real Person', 'someone@acme.com')",
      params: ['A Real Person', 'someone@acme.com'],
    });

    const serialized = JSON.stringify(errSerializer(pgError));

    assert.doesNotMatch(serialized, /someone@acme\.com/, 'the enrollment address reached the log');
    assert.doesNotMatch(serialized, /A Real Person/, 'the real name reached the log');
    assert.equal(errSerializer(pgError).query, undefined);
    assert.equal(errSerializer(pgError).params, undefined);

    // And everything worth diagnosing with survives.
    assert.equal(errSerializer(pgError).code, '22P02');
    assert.match(errSerializer(pgError).message, /invalid input syntax/);
    assert.ok(errSerializer(pgError).stack);
  });

  test("a failed oauth exchange cannot carry the client secret into the log", () => {
    // @octokit/oauth-methods puts the whole exchange on error.request, and any GitHub user can
    // make it throw by sending a made-up code to /dashboard/callback or /callback.
    const oauthError = Object.assign(new Error('The code passed is incorrect or expired.'), {
      status: 400,
      request: {
        method: 'POST',
        url: 'https://github.com/login/oauth/access_token',
        headers: { accept: 'application/json' },
        client_id: 'Iv1.public',
        client_secret: 'the-oauth-client-secret',
        code: 'a-made-up-code',
      },
    });

    const serialized = errSerializer(oauthError);

    assert.doesNotMatch(JSON.stringify(serialized), /the-oauth-client-secret|a-made-up-code/);
    assert.deepEqual(serialized.request, { method: 'POST', url: 'https://github.com/login/oauth/access_token' });
    assert.equal(serialized.status, 400);
  });

  test("a webhook error cannot carry the delivery into the log", () => {
    // The shape @octokit/webhooks hands an error handler on a signature mismatch: an
    // AggregateError whose `event` is the inner error, whose own `event` is the raw request -
    // a body any anonymous caller chose.
    const inner = Object.assign(new Error('signature does not match event payload and secret'), {
      status: 400,
      event: { id: 'a-delivery', name: 'installation', payload: '{"chosen":"by-the-caller"}', signature: 'sha256=0' },
    });
    const aggregate = Object.assign(new AggregateError([inner], inner.message), { event: inner });

    const serialized = errSerializer(aggregate);

    assert.doesNotMatch(JSON.stringify(serialized), /by-the-caller/, 'the delivery body reached the log');
    assert.equal(serialized.event, undefined);
    assert.equal(serialized.aggregateErrors[0].event, undefined);
    // And the members keep what is worth diagnosing with.
    assert.equal(serialized.aggregateErrors[0].status, 400);
    assert.match(serialized.aggregateErrors[0].message, /signature does not match/);
  });

  test("pg-promise's formatted query is never logged", () => {
    // pg-promise inlines parameter values client-side, so `e.query` would carry enrollment
    // email addresses and real names into the log.
    const violations = [];

    for (const { path, lines } of FILES) {
      lines.forEach((line, index) => {
        if (/e\.query|error\.query|\bquery:\s*e\./.test(codeOf(line))) {
          violations.push(`${path}:${index + 1} ${line.trim().slice(0, 70)}`);
        }
      });
    }

    assert.deepEqual(violations, []);
  });
});
