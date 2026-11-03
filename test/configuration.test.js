import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The environment is the whole configuration surface of this app, and it is the surface an
 * adopter meets first. A variable the code reads but nothing documents is a setting nobody
 * knows exists; a variable the docs promise but nothing reads is a setting that silently does
 * nothing. Both had happened before this file existed, and both were found by hand.
 */

/**
 * Every .js file under src/ and jobs/
 * @returns {string[]} Absolute paths
 */
const sourceFiles = () => {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;

      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
      } else if (entry.endsWith(".js")) {
        found.push(join(ROOT, rel));
      }
    }
  };

  walk("src");
  walk("jobs");

  return found;
};

/**
 * Every environment variable the code actually reads
 *
 * Three spellings, because all three are in use: direct access, dynamic access (validateEnv
 * iterates a list), and intFromEnv() in constants.js, which reads through a parameter and
 * would otherwise be invisible to a grep for `process.env.`.
 * @returns {Map<string, string[]>} Variable name to the files reading it
 */
const variablesRead = () => {
  const read = new Map();

  const note = (name, file) => {
    if (!read.has(name)) {
      read.set(name, []);
    }

    const where = read.get(name);

    if (!where.includes(file)) {
      where.push(file);
    }
  };

  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    const relative = file.slice(ROOT.length);

    for (const match of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      note(match[1], relative);
    }

    for (const match of text.matchAll(/process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)) {
      note(match[1], relative);
    }

    for (const match of text.matchAll(/intFromEnv\(['"]([A-Z_][A-Z0-9_]*)['"]/g)) {
      note(match[1], relative);
    }
  }

  return read;
};

// Commented or not: `# PORT=3000` documents PORT just as well as `PORT=`, and the optional
// ones are deliberately commented out so a fresh copy starts on the defaults.
const declaredInExample = new Set(
  [...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)]
    .map((match) => match[1])
);

// A row of a reference table in docs/configuration.md, not merely a mention somewhere in the
// docs: a passing reference in a paragraph kept a variable "documented" after its row had been
// dropped, which is the exact rot this file exists to catch.
const documented = new Set(
  [...readFileSync(join(ROOT, "docs/configuration.md"), "utf8")
    .matchAll(/^\| `([A-Z_][A-Z0-9_]*)` \|/gm)]
    .map((match) => match[1])
);

/**
 * Variables that legitimately appear in the configuration without this code reading them.
 *
 * One entry, and it needs its reason in writing: WEBHOOK_SECRET is read by Probot when it
 * verifies the webhook signature. src/services/webhookGuard.js checks the same signature first,
 * so the entry is belt and braces today - but Probot would still need it if that guard went.
 */
const READ_ELSEWHERE = new Set(["WEBHOOK_SECRET"]);

describe("the documented environment matches the one the code reads", () => {
  const read = variablesRead();

  test("every variable the code reads is in .env.example", () => {
    const missing = [...read.keys()]
      .filter((name) => !declaredInExample.has(name))
      .map((name) => `${name} (read in ${read.get(name).join(", ")})`);

    assert.deepEqual(missing, [], 'add these to .env.example, commented out if they have a default');
  });

  test("every variable the code reads is documented", () => {
    const missing = [...read.keys()]
      .filter((name) => !documented.has(name))
      .map((name) => `${name} (read in ${read.get(name).join(", ")})`);

    assert.deepEqual(missing, [], 'give these a row in a reference table in docs/configuration.md');
  });

  test("nothing in .env.example is dead configuration", () => {
    // The other direction, and the one that rots quietly: a variable removed from the code
    // stays in the example file forever, and the next person sets it and waits for something
    // to happen.
    const dead = [...declaredInExample]
      .filter((name) => !read.has(name) && !READ_ELSEWHERE.has(name));

    assert.deepEqual(dead, [], 'these are promised by .env.example but nothing reads them');
  });

  test("the required variables are the ones with no usable default", () => {
    // Required means the app cannot do its job without it, not merely that it is important.
    // ALLOWED_EMAIL_DOMAINS is the interesting case: a default would accept one company's
    // employees and reject another's, at info level, in silence.
    const validateEnv = readFileSync(join(ROOT, "src/utils/validateEnv.js"), "utf8");
    const required = [...(/const REQUIRED_ENV_VARS = \[([\s\S]*?)\]/.exec(validateEnv)?.[1] ?? '')
      .matchAll(/'([A-Z_][A-Z0-9_]*)'/g)].map((match) => match[1]);

    assert.deepEqual(required.sort(), [
      'ALLOWED_EMAIL_DOMAINS',
      'APP_ID',
      'DB_HOST',
      'DB_USER',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'PRIVATE_KEY',
      'WEBHOOK_SECRET',
    ], 'changing what is required changes whether an existing deployment still boots');
  });
});

describe("the setup path in the README and its guides works", () => {
  // The README's quick start, and the two guides it sends readers to for the full steps.
  const readme = ["README.md", "docs/getting-started.md", "docs/deployment.md"]
    .map((file) => readFileSync(join(ROOT, file), "utf8"))
    .join("\n");
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("every npm script it tells you to run exists", () => {
    const invoked = [...readme.matchAll(/npm run ([a-z:]+)/g)].map((match) => match[1]);

    for (const script of new Set(invoked)) {
      assert.ok(packageJson.scripts[script], `README runs "npm run ${script}", which package.json does not define`);
    }
  });

  test("the Node version it claims is the one package.json enforces", () => {
    // These drifted apart once already, when the floor moved for probot 14.3.
    assert.ok(
      readme.includes(packageJson.engines.node.replace(/\|\|/g, '\\|\\|')),
      `README must state engines.node verbatim: ${packageJson.engines.node}`
    );
  });

  test("compose.yaml applies the same schema file a manual install does", () => {
    const compose = readFileSync(join(ROOT, "compose.yaml"), "utf8");

    assert.match(compose, /\.\/init\.sql:\/docker-entrypoint-initdb\.d\//);
    assert.match(readme, /psql "\$DATABASE_URL" -f init\.sql/);
  });
});

describe("every route the app serves is in the endpoint table", () => {
  // The same rot as an undocumented variable, one level up: a route added to src/index.js and
  // left out of docs/architecture.md is invisible to everyone who reads the docs first - and
  // an undocumented route that WRITES is worse than an undocumented one that reads.
  const routes = [...readFileSync(join(ROOT, "src/index.js"), "utf8")
    .matchAll(/express\.(get|post|put|patch|delete)\("([^"]+)"/g)]
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`);

  const architecture = readFileSync(join(ROOT, "docs/architecture.md"), "utf8");

  test("and /version answers the runtime it is actually running on", () => {
    // The runtime is the host's choice, not this repository's. Without this the only way to
    // learn which Node is live was to download the container log and read the image tag.
    const index = readFileSync(join(ROOT, "src/index.js"), "utf8");

    assert.match(index, /node: process\.version,/, 'GET /version must report the running runtime');
  });

  test("with its verb, so a write is never documented as a read", () => {
    assert.ok(routes.length > 5, `only ${routes.length} routes found - the pattern stopped matching`);

    const missing = routes.filter((route) => !architecture.includes(`\`${route}\``));

    assert.deepEqual(missing, [], 'give these a row in the Endpoints table in docs/architecture.md');
  });
});

describe("the toolchain agrees with itself about Node", () => {
  // Three files name a Node version and none of them can see the others. They drifting apart
  // is not cosmetic: below Node 24 `node --test` exits 0 when the body of a describe throws,
  // so a CI image one major behind turns this whole file into decoration.
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  const major = (text, pattern, what) => {
    const found = pattern.exec(text);

    assert.ok(found, `no Node version found in ${what}`);

    return Number(found[1]);
  };

  test("mise, devEngines and the CI image all say the same major", () => {
    const declared = {
      "mise.toml": major(readFileSync(join(ROOT, "mise.toml"), "utf8"), /^node = "(\d+)\./m, "mise.toml"),
      "package.json devEngines": major(
        JSON.stringify(manifest.devEngines), /">=(\d+)"/, "devEngines.runtime.version"
      ),
    };

    // The pipeline is a deployment's own file, not part of every checkout: compared when present.
    if (existsSync(join(ROOT, ".gitlab-ci.yml"))) {
      declared[".gitlab-ci.yml"] = major(
        readFileSync(join(ROOT, ".gitlab-ci.yml"), "utf8"), /hub\/node(\d+)-bookworm/, "NODE_IMAGE"
      );
    }

    assert.equal(
      new Set(Object.values(declared)).size, 1,
      `these disagree: ${JSON.stringify(declared)}`
    );
  });

  test("and it is a version whose test runner reports a broken suite", () => {
    // The reason the floor is where it is, so nobody lowers it back without meeting it.
    assert.ok(
      major(JSON.stringify(manifest.devEngines), /">=(\d+)"/, "devEngines") >= 24,
      "below 24, a suite whose body throws is reported as a pass"
    );
  });
});

describe("the event tables hold nothing nobody writes", () => {
  /**
   * Both event tables have exactly one writer, which is what makes this checkable at all: the
   * whole column list of each is one INSERT away.
   *
   * The invariant is not style. Nineteen columns sat in these tables writing nothing from
   * November 2025, because the payload of GitHub's events feed does not carry them - and the
   * schema still promised them to anyone reading it with \d+ or a documentation tool.
   *
   * github_installations and github_pull_requests are deliberately out of scope: they are
   * written across a dozen UPDATEs, so "declared but never written" cannot be decided by
   * reading one statement.
   */
  const LEDGERS = [
    { table: 'github_pull_request_events', source: 'src/db/events.js' },
    { table: 'github_push_events', source: 'src/db/events.js' },
  ];

  const schema = readFileSync(join(ROOT, "init.sql"), "utf8");

  /**
   * The columns one CREATE TABLE declares, and which of them the database fills by itself
   * @returns {{all: string[], defaulted: string[]}}
   */
  const declared = (table) => {
    const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(schema)?.[1];

    assert.ok(body, `${table} is not declared in init.sql`);

    // Comment lines are dropped first, or a `-- why this column exists` inside the CREATE TABLE
    // is read as a column named `--` that nothing writes.
    const lines = body.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('--'));

    return {
      all: lines.map((line) => line.split(/\s+/)[0]),
      // SERIAL and DEFAULT are the two ways a column is filled without anyone naming it.
      defaulted: lines.filter((line) => /\bSERIAL\b|\bDEFAULT\b/.test(line)).map((line) => line.split(/\s+/)[0]),
    };
  };

  /**
   * Every column of this table that some statement in the module writes
   *
   * INSERT and UPDATE both: github_pull_request_events is written in two goes - the insert notes
   * the event, an update after hydration fills the thirteen snapshot columns - because the
   * events feed's payload carries none of them.
   *
   * The invariant is the same either way: no column may be promised by the schema and filled by
   * nothing. Exactly one INSERT is still required, because one CREATOR is the rule - two would
   * be two ways for a row to come into existence.
   */
  const written = (table, source) => {
    const text = readFileSync(join(ROOT, source), "utf8");
    const inserts = [...text.matchAll(new RegExp(`INSERT INTO ${table} \\(([^)]*)\\)`, 'g'))];

    assert.ok(inserts.length > 0, `${table} has no INSERT in ${source}`);

    // The UNION across every insert into this table, not the columns of one of them. There are
    // two on github_pull_requests - what the sync hydrates, and what an operator records by
    // hand - and they write different column sets on purpose: the manual row has no branch
    // refs and no topics to write. A column is dead only when NEITHER writes it.
    const columns = [...new Set(inserts.flatMap((insert) =>
      insert[1].split(',').map((column) => column.trim()).filter(Boolean)))];

    // Every name on the left of an assignment in an UPDATE of this table.
    for (const update of text.matchAll(new RegExp(`UPDATE ${table}\\s+SET([\\s\\S]*?)\\n\\s*WHERE`, 'g'))) {
      for (const assignment of update[1].matchAll(/(\w+)\s*=\s*\$/g)) {
        columns.push(assignment[1]);
      }
    }

    return columns;
  };

  /**
   * The one exemption, and it needs the schema's own word for it
   *
   * A PushEvent is never hydrated - no call describes one - so nothing will write the four
   * popularity columns on github_push_events again. 1,071 values no request can restore, which
   * is why they are kept rather than dropped.
   *
   * Listed here AND asserted against init.sql below, so exempting a column means declaring it an
   * archive in the schema, where the next reader running \\d+ will see it.
   */
  const ARCHIVE = {
    github_push_events: ['license', 'topics', 'forks_count', 'stargazers_count'],
  };

  for (const { table, source } of LEDGERS) {
    test(`every column of ${table} is written or defaulted`, () => {
      const { all, defaulted } = declared(table);
      const inserted = written(table, source);
      const exempt = ARCHIVE[table] ?? [];
      const dead = all
        .filter((column) => !inserted.includes(column) && !defaulted.includes(column))
        .filter((column) => !exempt.includes(column));

      assert.deepEqual(dead, [], `nothing writes these - drop them from init.sql, or write them`);

      // The other direction on the exemption: a name in ARCHIVE that some statement does write
      // is a stale exemption, and it would hide the next dead column added beside it.
      const notActuallyArchived = exempt.filter((column) => inserted.includes(column));

      assert.deepEqual(notActuallyArchived, [], 'these are listed as archive and written anyway');
    });

    test(`${table} declares every column its writer names`, () => {
      // The other direction: an INSERT naming a column the schema does not have fails at run
      // time, on a code path that only runs when somebody actually contributes.
      const { all } = declared(table);
      const missing = written(table, source).filter((column) => !all.includes(column));

      assert.deepEqual(missing, [], `init.sql does not declare these`);
    });
  }

  test("and the schema itself says which columns are kept without a writer", () => {
    // The exemption above is only allowed because the schema carries the word. A reader running
    // \d+ has to be told these are frozen, not merely unwritten - otherwise the next person to
    // find four popularity columns on a push event reads them as today's figures, which is the
    // exact defect this table's history is made of.
    const push = /CREATE TABLE IF NOT EXISTS github_push_events \(([\s\S]*?)\n\);/.exec(schema)[1];

    assert.match(push, /-- ARCHIVE\./, 'init.sql must mark the archive columns of github_push_events');
    assert.match(schema, /COMMENT ON COLUMN github_push_events\.stargazers_count IS\s*\n\s*'ARCHIVE/,
      'and say it in the database, for whoever never opens this repository');
  });
});

describe("only one thing in this application creates a repository row", () => {
  /**
   * A creator whose conflict target cannot match is how one repository ends up with two rows.
   *
   * That used to be an argument for having exactly one: github_id was the only conflict target,
   * two nulls are distinct in the partial unique index behind it, so an id-less insert conflicted
   * with nothing and every attempt added a row nothing could afterwards tell from its twin. The
   * rule was therefore "one INSERT, and it refuses a row without an id".
   *
   * A second one now exists, for the projects on other forges that have no GitHub id to be keyed
   * on, and it is only safe because idx_repositories_foreign_full_name gives THOSE rows a
   * conflict target of their own. So the invariant is no longer a count - it is that every
   * creator lives in the registry and names a target that can actually match.
   */
  const inserts = sourceFiles()
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/INSERT INTO github_repositories\b/g)]
      .map(() => file.slice(ROOT.length)));

  test("every creator is in the registry, and nowhere else", () => {
    assert.deepEqual([...new Set(inserts)], ['src/db/repositories.js'],
      'a repository row created outside the registry answers to none of its rules');
  });

  test("and each one names a conflict target that can match", () => {
    const source = readFileSync(join(ROOT, "src/db/repositories.js"), "utf8");
    const schema = readFileSync(join(ROOT, "init.sql"), "utf8");

    // The id-ful path, unchanged: it refuses the row it could never read back.
    assert.match(source, /ON CONFLICT \(github_id\) WHERE github_id IS NOT NULL DO NOTHING/);
    assert.match(source, /refusing to record the repository \$\{fullName\} without a GitHub id/);

    // The id-less path, and the index that makes it legal. Both halves are asserted: the
    // predicate has to be spelled on the statement for PostgreSQL to infer a partial index, and
    // the index has to exist in the schema or the statement raises 42P10 at run time - on the
    // one code path that runs when somebody actually records a contribution.
    assert.match(source, /ON CONFLICT \(lower\(full_name\)\) WHERE github_id IS NULL DO NOTHING/);
    assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_foreign_full_name\s*\n\s*ON github_repositories \(lower\(full_name\)\) WHERE github_id IS NULL;/);

    assert.equal(inserts.length, 2, 'a third creator needs a conflict target of its own, and a line here');
  });
});

describe("no body parser decompresses a request", () => {
  /**
   * CVE-2026-111497 (Node2Shell) is a Brotli decoder bug, and body-parser hands any body sent
   * with Content-Encoding: br straight to zlib unless told not to. Nothing this app receives is
   * compressed - GitHub never compresses a delivery, the page's fetch() never compresses a body -
   * so inflate off costs nothing and keeps the decoder out of reach whatever runtime the host
   * picks. Asserted here because the parser a route needs next will be written without it.
   */
  const parsers = sourceFiles()
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/Express\.(?:json|raw|text|urlencoded)\((?:\{[^}]*\})?\)/g)]
      .map((match) => ({ file: file.slice(ROOT.length), call: match[0] })));

  test("every one is built with inflate: false", () => {
    assert.ok(parsers.length >= 2, `only ${parsers.length} body parsers found - the pattern stopped matching`);

    const inflating = parsers.filter(({ call }) => !/\binflate:\s*false\b/.test(call));

    assert.deepEqual(inflating, [], 'a parser that inflates reaches the Brotli decoder');
  });
});
