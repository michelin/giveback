import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runJob, failureLedger } from "../jobs/jobRun.js";
import { closePool } from "../src/db/index.js";

/**
 * A logger that records instead of writing
 *
 * runJob takes the job's own logger rather than making one, precisely so the abort line and the
 * pool-close line keep the job's `name` binding. Passing a recorder here is the same seam.
 * @returns {{lines: Array<{level: string, fields: Object, message: string}>}}
 */
const recorder = () => {
  const lines = [];
  const at = (level) => (first, second) =>
    lines.push(typeof first === 'string'
      ? { level, fields: {}, message: first }
      : { level, fields: first, message: second });

  return {
    lines,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
  };
};

describe("failureLedger", () => {
  test("keeps the cause of a failure in the shape the dashboard reads", () => {
    const { failures, noteFailure } = failureLedger();

    noteFailure('octocat', Object.assign(new Error('Not Found'), { status: 404 }));

    assert.deepEqual(failures, [{ subject: 'octocat', status: 404, message: 'Not Found' }]);
  });

  test("a status is null rather than absent, and a non-Error is still readable", () => {
    // The page renders these rows straight from job_runs, so a missing key would print
    // "undefined" where the status column belongs.
    const { failures, noteFailure } = failureLedger();

    noteFailure('octocat', new Error('connection terminated unexpectedly'));
    noteFailure('hubber', 'a string thrown from somewhere');

    assert.equal(failures[0].status, null);
    assert.equal(failures[1].message, 'a string thrown from somewhere');
  });

  test("only the first line of a message, and at most 300 characters of it", () => {
    // A pg error carries its whole statement on the following lines, and the failure list is a
    // column on a page, not a place to read a stack.
    const { failures, noteFailure } = failureLedger();

    noteFailure('octocat', new Error(`first line\nsecond line`));
    noteFailure('hubber', new Error('x'.repeat(500)));

    assert.equal(failures[0].message, 'first line');
    assert.equal(failures[1].message, 'x'.repeat(300));
  });

  test("caps at 20, and the `failed` counter is what keeps the true total", () => {
    const { failures, noteFailure } = failureLedger();

    for (let i = 0; i < 200; i++) {
      noteFailure(`subject-${i}`, new Error('boom'));
    }

    assert.equal(failures.length, 20);
    assert.equal(failures[19].subject, 'subject-19', 'the first 20, not the last 20');
  });

  test("the array's identity is stable, so a run that throws mid-loop still reports how far it got", async () => {
    // Why each job destructures this at module scope, outside run(): the epilogue reads the
    // same array after run() has thrown.
    const { failures, noteFailure } = failureLedger();
    const totals = { claimed: 2, failed: 0 };
    const exitCode = process.exitCode;

    const summary = await runJob({
      name: 'demo_job',
      logger: recorder(),
      totals,
      tail: () => ({ failures }),
      run: async () => {
        totals.failed++;
        noteFailure('octocat', new Error('boom'));
        throw new Error('the pool went away');
      },
    });

    process.exitCode = exitCode;

    assert.deepEqual(summary.failures, [{ subject: 'octocat', status: null, message: 'boom' }]);
  });
});

describe("runJob", () => {
  test("counter keys land in declaration order: totals, then the tail, then the cause", async () => {
    // docs/logging.md promises counter keys "in declaration order" and operators grep that
    // line, so insertion order into the summary is the contract, not an accident.
    const logger = recorder();
    const summary = await runJob({
      name: 'demo_job',
      logger,
      run: async () => undefined,
      totals: { claimed: 4, changed: 3, unchanged: 1, failed: 0 },
      tail: () => ({ failures: [] }),
    });

    assert.deepEqual(Object.keys(summary), ['ok', 'durationMs', 'claimed', 'changed', 'unchanged', 'failed', 'failures']);
    assert.equal(summary.ok, true);
    assert.equal(typeof summary.durationMs, 'number');
    assert.equal(summary.error, undefined, 'a run that did not throw carries no cause');
  });

  test("the tail is handed whatever run() resolved to, so one job can nest it under a key", async () => {
    // reconcile_installations is that job: its resolved value describes the whole system and
    // belongs behind the ` | ` separator, not among the run's own counters.
    const logger = recorder();
    let skippedRun = false;

    const summary = await runJob({
      name: 'reconcile_installations',
      logger,
      totals: { live: 0 },
      run: async () => {
        skippedRun = true;
        return { active: 780, due: 126 };
      },
      tail: (state) => ({
        ...(skippedRun ? { skipped: true } : {}),
        ...(state ? { state } : {}),
      }),
    });

    assert.deepEqual(Object.keys(summary), ['ok', 'durationMs', 'live', 'skipped', 'state']);
    assert.deepEqual(summary.state, { active: 780, due: 126 });
  });

  test("an aborted run is reported with the totals it had reached, and its cause", async () => {
    // process.exitCode is saved and restored: parentPort is null in the test process, so the
    // standalone branch runs and a leaked exitCode=1 would fail the whole `node --test` run.
    const exitCode = process.exitCode;
    const logger = recorder();

    const summary = await runJob({
      name: 'demo_job',
      logger,
      totals: { claimed: 9, failed: 2 },
      run: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    });

    assert.equal(process.exitCode, 1, 'a failed run by hand must exit non-zero');
    process.exitCode = exitCode;

    assert.equal(summary.ok, false);
    assert.equal(summary.error, 'connection terminated unexpectedly');
    assert.deepEqual(Object.keys(summary), ['ok', 'durationMs', 'claimed', 'failed', 'error']);

    const abort = logger.lines.find((line) => /demo_job run aborted/.test(line.message));

    assert.ok(abort, 'the abort must be logged');
    assert.equal(abort.level, 'error');
    assert.ok(abort.fields.err instanceof Error, 'and it must hand the Error to pino');
    assert.equal(abort.fields.claimed, 9, 'with the counters the run had reached');
  });

  test("run by hand, the job emits its own report line - one per run in either mode", async () => {
    const exitCode = process.exitCode;
    const logger = recorder();

    await runJob({
      name: 'demo_job',
      logger,
      run: async () => undefined,
      totals: { claimed: 0 },
    });

    process.exitCode = exitCode;

    const report = logger.lines.filter((line) => /^demo_job (ok|idle|failed|skipped) in /.test(line.message));

    assert.equal(report.length, 1);
    assert.equal(report[0].level, 'info');
    assert.equal(report[0].fields.job, 'demo_job', 'the structured twin carries the job name');
  });

  test("the pool is closed whatever the run did, and a pool that will not close does not fail the run", async () => {
    // The one thing every job depends on runJob for and nothing asserted: deleting the whole
    // `finally { await closePool(); }` block left all nine tests in this file green, while a
    // worker that never drains its pool holds connections and, run by hand, never exits.
    //
    // Asserted through the failure, because that is the only observable this file has: node-
    // postgres rejects a second Pool.end() with "Called end on pool more than once", so ending
    // it here first turns runJob's own call into a line in the recorder. No line means no call.
    //
    // (It is also the branch the rest of this file has been taking by accident since the first
    // runJob test ended the shared pool - four of the five calls, with nothing looking at it.)
    await closePool().catch(() => {});

    const logger = recorder();

    const summary = await runJob({
      name: 'demo_job',
      logger,
      run: async () => undefined,
      totals: { claimed: 0 },
    });

    const complaints = logger.lines.filter((line) => /could not close the database pool/.test(line.message));

    assert.equal(complaints.length, 1, 'runJob did not close the pool');
    assert.equal(complaints[0].level, 'error');
    assert.ok(complaints[0].fields.err instanceof Error, 'and the cause goes to pino as an Error');

    assert.equal(summary.ok, true, 'a pool that would not close must not turn a good run into a failed one');
    assert.equal(summary.error, undefined);
  });

  test("the pool is closed exactly once, on the good path and on the aborted one", async () => {
    // The behavioural half, reachable now that runJob takes a defaulted `closePool` in its
    // options. Exactly once matters in both directions: never, and a worker holds its
    // connections until Bree kills it; twice, and node-postgres rejects the second call and the
    // run reports a failure it did not have.
    const onSuccess = [];
    const onAbort = [];

    // Saved and restored like every other standalone-branch call in this file: parentPort is
    // null here, so the aborted run below sets process.exitCode = 1 and would fail the whole
    // `node --test` process even with every assertion green.
    const exitCode = process.exitCode;

    await runJob({
      name: 'demo_job',
      logger: recorder(),
      run: async () => undefined,
      totals: { claimed: 0 },
      closePool: async () => { onSuccess.push(1); },
    });

    assert.equal(onSuccess.length, 1, 'the pool was not closed after a run that succeeded');

    const summary = await runJob({
      name: 'demo_job',
      logger: recorder(),
      run: async () => { throw new Error('the body threw'); },
      totals: { claimed: 0 },
      closePool: async () => { onAbort.push(1); },
    });

    // The `finally`, which is the part a success-only assertion cannot see: a run whose body
    // threw must still drain, or an outage leaves every worker holding connections.
    assert.equal(onAbort.length, 1, 'the pool was not closed after a run that threw');
    assert.equal(summary.ok, false);
    assert.equal(summary.error, 'the body threw', 'and the abort keeps its own cause');

    process.exitCode = exitCode;
  });
});
