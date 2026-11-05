import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The scheduler's share of a shutdown, against a job that ignores it
 *
 * bree.stop() posts 'cancel', which no job listens for, clears the closeWorkerAfterMs kill and
 * waits for the worker with no limit. Run in a child process for two reasons: what is under test
 * is that the process ends on its own, and the failure mode is a hang this runner would inherit.
 */
const SERVICE = new URL("../src/services/breeService.js", import.meta.url).href;

const CHILD = `
  import { once } from "node:events";

  const { bree, stopBree } = await import(${JSON.stringify(SERVICE)});

  // A run stuck on a GitHub call: it never reports and never answers 'cancel'. Set before Bree's
  // lazy init, which turns a function path into an eval'd worker.
  bree.config.jobs.find((job) => job.name === "sync_contributions").path = () => setInterval(() => {}, 2 ** 30);

  await bree.run("sync_contributions");
  await once(bree.workers.get("sync_contributions"), "online");
  await stopBree(200);
`;

test("a job that ignores the stop is terminated at the bound, and the process ends on its own", async () => {
  // The timeout is the verdict without the bound: the child is killed and execFile rejects.
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { PATH: process.env.PATH, LOG_LEVEL: "info", LOG_FORMAT: "json" },
    timeout: 20_000,
  });

  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const killed = lines.find((line) => line.msg.startsWith("sync_contributions was killed"));

  // Not "killed after 4m": bree.stop() cleared that timer, so saying so would send an operator
  // after a timeout that never fired.
  assert.equal(
    killed?.msg,
    "sync_contributions was killed by the shutdown without reporting - its claimed rows return to the queue when their lease expires"
  );
  assert.equal(killed.timeout_ms, undefined);
  assert.ok(lines.some((line) => line.msg.startsWith("scheduler stopped in")), "the stop must say it finished");
});

test("a stop that rejects still terminates what runs, then passes the error on", async () => {
  // bree.stop() rejecting must not skip the termination: the error used to leave stopBree()
  // before it, and the worker kept the process alive. Bree 9 rejects only from a failed init(),
  // when no worker exists yet, so the rejection is forced here on a scheduler that did start.
  const child = `
    import { once } from "node:events";

    const { bree, stopBree } = await import(${JSON.stringify(SERVICE)});

    bree.config.jobs.find((job) => job.name === "sync_contributions").path = () => setInterval(() => {}, 2 ** 30);

    await bree.run("sync_contributions");
    await once(bree.workers.get("sync_contributions"), "online");
    bree.stop = async () => { throw new Error("stop refused"); };

    await stopBree(200).then(
      () => console.log(JSON.stringify({ msg: "stopBree resolved" })),
      // The count at the moment of the rejection: terminated first, then rejected, never the
      // other way round, or src/index.js would close the pool under a worker still running.
      (error) => console.log(JSON.stringify({ msg: "stopBree rejected: " + error.message, workers: bree.workers.size })),
    );
  `;

  // As above, the timeout is the verdict without the fix: the worker keeps the child alive.
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", child], {
    env: { PATH: process.env.PATH, LOG_LEVEL: "info", LOG_FORMAT: "json" },
    timeout: 20_000,
  });

  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const rejected = lines.find((line) => line.msg === "stopBree rejected: stop refused");

  assert.ok(lines.some((line) => line.msg.startsWith("sync_contributions was killed by the shutdown")), "the running job must be terminated");
  assert.ok(rejected, "and the caller must still learn the stop failed");
  assert.equal(rejected.workers, 0, "rejected while a worker was still running");
});
