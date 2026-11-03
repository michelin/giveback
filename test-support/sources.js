import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The source text the guards read, and the three ways they cut it up
 *
 * Outside test/ because node --test runs every file under that directory as a test. One copy,
 * imported by every suite that slices a source file: the two copies this replaced were kept
 * byte for byte by hand.
 */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {string} path - From the repository root
 * @returns {string} The file
 */
export const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');

/**
 * Every file under a directory with this extension, walked rather than listed
 *
 * A guard over a fixed list of files stops guarding the day a file is added beside them, and
 * says nothing when it does.
 * @param {string} dir - From the repository root, e.g. 'views'
 * @param {string} extension - e.g. '.js'
 * @returns {Array<string>} Paths from the repository root, sorted
 */
export const filesUnder = (dir, extension) => readdirSync(`${ROOT}${dir}`, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory()
    ? filesUnder(`${dir}/${entry.name}`, extension)
    : entry.name.endsWith(extension) ? [`${dir}/${entry.name}`] : []))
  .sort();

/**
 * @returns {string} Every src/services/dashboard*.js module as one text: what the page is sent
 *   is assembled across them, so a guard on it cannot name one file
 */
export const dashboardServices = () => filesUnder('src/services', '.js')
  .filter((file) => file.startsWith('src/services/dashboard'))
  .map(read)
  .join('\n');

/**
 * The code of a file, with its comments removed
 *
 * For the assertions that FORBID a spelling. A comment explaining why a column is gone contains
 * the column's name, and a doesNotMatch over the raw file reads that explanation as the offence
 * it is describing - which is how a guard ends up unsatisfiable by any correct file.
 *
 * One stripper, used by every guard. There were three, with three rule sets: two inline copies
 * that did not know about `/*` and this one, which did not track a block across its
 * continuation lines. Guards that disagree about what a comment is fail on different files.
 * @param {string} source - The file
 * @returns {string} The same file, comment lines blanked, line numbers preserved
 */
export const withoutComments = (source) => {
  let inBlock = false;

  return source.split('\n').map((line) => {
    const trimmed = line.trim();

    if (inBlock) {
      inBlock = !trimmed.includes('*/');
      return '';
    }

    if (trimmed.startsWith('/*')) {
      inBlock = !trimmed.includes('*/');
      return '';
    }

    return /^(--|\*|\/\/)/.test(trimmed) ? '' : line;
  }).join('\n');
};

/**
 * One exported function's body, sliced out of a source file
 *
 * The slice is asserted rather than trusted: on a marker that no longer matches, indexOf
 * returns -1, the slice collapses to the empty string, and every assertion built on it passes
 * without reading a line of the code it guards.
 *
 * Both declaration styles. `export async function NAME()` is still exported, so slicing on
 * `export const NAME =` alone failed it with a message saying it was gone - a guard that lies
 * about why it broke is a guard people delete.
 * @param {string} source - Contents of the source file
 * @param {string} name - Name of the exported function
 * @returns {string} The body, up to the '}' that closes it
 */
export const fn = (source, name) => {
  const declaration = new RegExp(`export (const ${name} =|(?:async )?function ${name}\\b)`);
  const match = declaration.exec(source);

  assert.ok(match, `${name} is not exported here any more - this guard is no longer asserting anything`);

  const from = source.slice(match.index);
  // An arrow const closes on '};', a function declaration on '}'. Kept distinct rather than
  // searching for either: '\n}' alone would cut an arrow body short at any nested block that
  // happened to close in column zero.
  const closing = match[1].startsWith('const') ? '\n};' : '\n}';
  const end = from.indexOf(closing);

  assert.notEqual(end, -1, `${name} does not end in '${closing.replace('\n', '\\n')}' - the slice is wrong`);

  return from.slice(0, end);
};

/**
 * The file split into its top-level exported functions, so a column can be attributed to one
 * rather than merely found somewhere in 400 lines.
 * @param {string} source - The file, with its comment lines already blanked by the caller -
 *   stripping has to stay at the call site, or a column could hide from these guards in a comment
 * @returns {Map<string, string>} Body by function name
 */
export const functions = (source) => {
  // Both declaration styles. Reading `const NAME =` only meant a query written as
  // `export async function listUsersByProject()` was folded into the body of whatever const
  // preceded it - and if that was an operator-tier name, the loops below skipped it entirely
  // and an aggregate could emit a login with this suite green. Nothing enforces the arrow-const
  // style these files happen to use: eslint has no func-style rule.
  const DECLARATION = /^(?:export )?(?:const|(?:async )?function)\s+(\w+)\b/gm;
  const names = [...source.matchAll(DECLARATION)].map((m) => ({ name: m[1], at: m.index }));

  assert.ok(names.length >= 3, `only ${names.length} declarations found - the splitter stopped matching`);

  const bodies = new Map(names.map(({ name, at }, i) => [name, source.slice(at, names[i + 1]?.at ?? source.length)]));
  const exported = [...source.matchAll(/^export (?:const|(?:async )?function)\s+(\w+)\b/gm)].map((m) => m[1]);

  // Not a count: module-private consts (IS_OWN, REGISTRY, SYNCABLE...) are legitimate entries.
  // What matters is that no EXPORT is invisible here, because invisible means exempt.
  assert.deepEqual(exported.filter((name) => !bodies.has(name)), [],
    'declared in a style this splitter cannot see - these exports are exempt from every guard below');

  return bodies;
};
