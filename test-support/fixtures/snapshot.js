import { PERCENTILE_MIN_SAMPLE } from "../../src/utils/constants.js";

/**
 * A snapshot with the shape readerSnapshot() builds: what every reader is sent
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object}
 */
export const snapshotOf = (overrides = {}) => ({
  now: new Date().toISOString(),
  viewer: "dev-user-1",
  operator: false,
  app: { name: "giveback", version: "1.0.0", environment: "development" },
  degraded: [],
  limits: { reportTtlMs: 60_000, percentiles: PERCENTILE_MIN_SAMPLE },
  ...overrides,
});
