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
