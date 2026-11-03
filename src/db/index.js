import pgPromise from "pg-promise";
import { isMainThread } from "node:worker_threads";
import { getLogger, format } from "../utils/logger.js";
import { isProduction } from "../utils/constants.js";

const logger = getLogger("db");

// No `error:` hook on purpose: it fires before runner()'s own catch, announcing every failure
// twice, and the value it exists to log is `e.query` — which pg-promise builds by inlining
// parameter values client-side, so a failed enrollment INSERT would write the user's email
// address and real name into the log. runner() below is the single error site, for the pool and
// for a transaction alike.
const pgp = pgPromise();

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  // Managed PostgreSQL usually requires TLS, so failing open on an unset value produces only a
  // confusing "connection refused" in production.
  ssl: process.env.DB_SSL ? process.env.DB_SSL === 'true' : isProduction,
  database: process.env.DB_NAME || "postgres",
  // Every worker thread builds its own pool, and job queries run strictly sequentially.
  max: isMainThread ? 10 : 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// Which instance points at which database, which an operator needs at boot. `pgp()` below is
// lazy, so this describes the target and not a connection that has happened.
const target = `postgresql://${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;

// Guarded because this module is imported before validateEnv runs: on a misconfigured start it
// would print `postgresql://undefined@undefined:5432/postgres`, which reads like a bug in the
// app rather than a missing variable. validateEnv names them a moment later.
if (dbConfig.host && dbConfig.user) {
  const line = `database target ${target} (ssl=${dbConfig.ssl}, pool max ${dbConfig.max})`;

  if (isMainThread) {
    logger.info(line);
  } else {
    logger.trace(line);
  }
}

const db = pgp(dbConfig);

// Above this, a query is worth complaining about; below, it is noise.
const SLOW_QUERY_MS = 1000;

// Long enough to reach past the SELECT list of the widest statement here, short enough that a
// log line stays one line.
const STATEMENT_OUTLINE_CHARS = 140;

/**
 * Enough of a SQL statement to recognise it in a log message
 *
 * The template, never the formatted query, which inlines parameter values. Collapsed rather than
 * cut at the first line, which here is often the verb alone, and stripped of `--` comments first,
 * which are written for a reader of the source and not for a log line.
 * @param {string} text - SQL template
 * @returns {string}
 */
const outlineOf = (text) => {
  const outline = String(text)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return outline.length > STATEMENT_OUTLINE_CHARS
    ? `${outline.slice(0, STATEMENT_OUTLINE_CHARS)}...`
    : outline;
};

/**
 * Build the query function for one execution context
 *
 * Two contexts exist and they must log identically: the pool, and a transaction. A factory
 * rather than two copies, so the slow-query warning and the single error site below cover a
 * statement inside a transaction exactly as they cover one outside it.
 * @param {Object} ctx - The pg-promise database or task object
 */
const runner = (ctx) => async (text, params = []) => {
  const start = Date.now();

  try {
    // ctx.result for every query, so rowCount is always available.
    const result = await ctx.result(text, params);

    const duration = Date.now() - start;

    // No line per query — hundreds a tick, telling a reader nothing. Only the exceptional case
    // is worth one, and it names the statement so it can be acted on.
    if (duration > SLOW_QUERY_MS) {
      logger.warn(
        { duration_ms: duration, rows: result.rowCount },
        `slow query, ${format.duration(duration)} for ${result.rowCount} row(s): ${outlineOf(text)}`
      );
    }

    return {
      rows: result.rows || [],
      rowCount: result.rowCount,
    };
  } catch (error) {
    // The technical half of a failure, and the only place naming a statement and a PostgreSQL
    // code — neither belongs in a business-level line.
    //
    // warn, not error: every caller wraps this and rethrows, and the layer that knows *why* the
    // query ran logs it once at error with the full cause chain, so error here would double
    // every alert count for one failure. `err` is omitted because a pg error's stack points
    // into the driver, and the caller's line carries the useful one.
    logger.warn(
      { code: error.code, duration_ms: Date.now() - start },
      `statement failed after ${format.duration(Date.now() - start)} [${error.code ?? 'no code'}]: ${outlineOf(text)}`
    );
    throw error;
  }
};

/**
 * Execute a database query
 * @returns {Promise<{rows: Array, rowCount: number}>}
 */
export const query = runner(db);

/**
 * Run several statements as one unit, or none of them
 *
 * The callback receives a `run` with the same signature as query(), bound to the transaction.
 * Every function in this directory takes one as its last parameter and defaults to the pool, so
 * a caller composes a unit out of them without any of them knowing about transactions.
 *
 * There is one reason this exists, and it is not tidiness. A contribution needs its repository
 * row and its ledger row, in that order, and the ledger row cannot exist without the other -
 * there is a foreign key. As two statements, a crash between them leaves a repository row for an
 * event nothing recorded. As one unit, a failure leaves nothing and the next run retries from a
 * clean state.
 * @param {(run: Function) => Promise<any>} work
 */
export const transaction = async (work) => db.tx((t) => work(runner(t)));

/**
 * Drain this instance's connection pool
 *
 * pgp.end() is synchronous and returns undefined, so it cannot be awaited — the awaitable drain
 * is the underlying node-postgres pool. Workers must await this before exiting, or open sockets
 * keep the event loop alive.
 */
export const closePool = async () => {
  logger.trace('closing the database connection pool');
  await db.$pool.end();
};
