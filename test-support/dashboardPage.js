import vm from "node:vm";
import ejs from "ejs";
import { ROOT, read, filesUnder } from "./sources.js";
import { DASHBOARD_ASSETS } from "../src/services/dashboardAssets.js";
import { landingTab, pageLocals } from "../src/services/dashboardService.js";

/**
 * Run the dashboard's own scripts, for real.
 *
 * This exists because of a bug that got all the way to a browser: render() still referenced a
 * variable belonging to machinery that had been deleted, which threw a ReferenceError at load
 * and killed the whole IIFE. Every other check passed — eslint did not read the template it was
 * inlined in, the EJS render only proves the HTML was produced, and an HTTP request for
 * /dashboard returns 200 with a perfectly valid document. The page was simply blank.
 *
 * So the scripts are read from their own files and executed against a DOM stub, in the order
 * the rendered document loads them. Not a browser and not trying to be one: it asserts that the
 * code PATHS RUN — load, and every interval the page installs — and that the panels end up with
 * content.
 *
 * Strict where a browser is strict, because a lenient stub is how a page passes here and dies
 * there: an id the document never rendered is null, exactly as getElementById answers, and a
 * route nobody serves is a 404 rather than the snapshot.
 */

// The page is written in three languages, each across several files. Three readers rather than
// one joined string, because a blob lets a CSS rule satisfy an assertion aimed at the markup -
// each check names the source it actually means.
const pageFiles = (extension) => filesUnder('views', extension)
  .filter((file) => file === 'views/dashboard.ejs' || file.startsWith('views/dashboard/'));

/** @returns {string} Every template of the page: the shell and each tab's */
export const markup = () => pageFiles('.ejs').map(read).join('\n');
/** @returns {string} Every stylesheet of the page */
export const css = () => pageFiles('.css').map(read).join('\n');
/** @returns {string} Every browser script of the page */
export const script = () => pageFiles('.js').map(read).join('\n');

/**
 * A stylesheet as its rules, each with the at-rule it sits in
 *
 * Enough of a parser for the guards on this page's own sheets: comments dropped, @media and
 * @supports walked into, a @keyframes kept whole as one rule named after itself.
 * @param {string} source - A stylesheet
 * @returns {Array<{selector: string, selectors: Array<string>, declarations: Array<{property: string,
 *   value: string}>, at: ?string}>} `selectors` split on the commas outside any :is() or :where()
 */
export const rulesOf = (source) => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];

  const walk = (chunk, at) => {
    let from = 0;

    while (chunk.indexOf('{', from) !== -1) {
      const open = chunk.indexOf('{', from);
      const selector = chunk.slice(from, open).trim();
      let depth = 1;
      let close = open + 1;

      for (; depth > 0 && close < chunk.length; close += 1) {
        depth += chunk[close] === '{' ? 1 : chunk[close] === '}' ? -1 : 0;
      }

      const body = chunk.slice(open + 1, close - 1);

      if (/^@(media|supports)\b/.test(selector)) {
        walk(body, selector);
      } else {
        rules.push({
          selector,
          selectors: selector.split(/,(?![^(]*\))/).map((part) => part.trim()).filter(Boolean),
          at,
          declarations: body.split(/;|[{}]/).map((line) => line.trim()).filter((line) => line.includes(':'))
            .map((line) => ({ property: line.slice(0, line.indexOf(':')).trim(), value: line.slice(line.indexOf(':') + 1).trim() })),
        });
      }

      from = close;
    }
  };

  walk(text, null);

  return rules;
};

// Compiled once per process and run in a fresh context per test, rather than compiled per test.
// Parsing 1,550 lines 34 times allocated enough to crash V8's mark-compact collector: a
// stack-guard GC raised inside Sparkplug's prologue segfaulted iterating the frame's roots,
// which took the whole file down - 59 tests reported as a single bare 'test failed', no
// assertion and no stderr - on 8 runs in 100. The semantics are identical; only the garbage is
// gone.
const compiled = new Map();

const scriptOf = (file) => {
  if (!compiled.has(file)) {
    compiled.set(file, new vm.Script(read(file), { filename: file }));
  }

  return compiled.get(file);
};

/** `a="1" b hidden` as an object, a bare attribute reading as the empty string. */
const attributesOf = (source) => Object.fromEntries(
  [...source.matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ''])
);

/** Every element the markup gives an id, with the attributes it was written with. */
export const idsIn = (markup) => new Map([...markup.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)]
  .map((m) => attributesOf(m[2]))
  .filter((attributes) => attributes.id !== undefined)
  .map((attributes) => [attributes.id, attributes]));

/** Enough of a classList for the page to toggle a state and a test to read it back. */
const classesOf = (names = '') => {
  const set = new Set(names.split(/\s+/).filter(Boolean));

  return {
    add: (name) => { set.add(name); },
    remove: (name) => { set.delete(name); },
    toggle: (name, force = !set.has(name)) => {
      if (force) set.add(name); else set.delete(name);

      return force;
    },
    contains: (name) => set.has(name),
  };
};

/**
 * The palette the page's canvas reads through getComputedStyle, from the one sheet that defines
 * it: a token the track asks for and base.css does not have answers the empty string, as a
 * browser's would.
 */
const TOKENS = new Map([...read('public/base.css').matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));

/** data-next-run="x" as dataset.nextRun, the way a browser maps it. */
const datasetOf = (attributes) => Object.fromEntries(Object.entries(attributes)
  .filter(([name]) => name.startsWith('data-'))
  .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));

/**
 * The smallest DOM the page can run against
 * @returns {Object}
 */
const stubDom = (html, snapshot, { size, report, mine, manual, hash, reducedMotion }) => {
  const rendered = idsIn(html);
  const islands = new Map([...html.matchAll(/<script type="application\/json" id="([^"]+)">([\s\S]*?)<\/script>/g)]
    .map((m) => [m[1], m[2]]));
  const elements = new Map();
  // Every interval the page installs, and whether it has since been cleared.
  const intervals = [];
  // Every request the page makes, so a test can assert on the one an operator's click sends.
  const fetched = [];
  // Every URL the page wrote into the address bar.
  const replaced = [];
  // What the page listens for on the window, so a test can fire an address edited by hand.
  const listeners = {};
  // Every animation frame the page asks for, so a test can run one: the track schedules the next
  // from inside each, so draining them would never end.
  const frames = [];
  // Every call that places or paints something on a canvas, with the style it was made in, so a
  // test can assert none of it leaves the canvas and every colour is the palette's.
  const painted = [];
  // Every chart the page made, in the order it made them.
  const charts = [];

  /**
   * Chart.js, as far as the page reaches it: a chart keeps the config it was made from, and
   * update() records the mode it was asked for, so a test reads what would be drawn and tells a
   * refresh that updates a chart from one that makes another. Its defaults are the shape of the
   * real ones the page themes.
   */
  class Chart {
    static defaults = { font: {}, plugins: { tooltip: {} } };

    static Tooltip = { positioners: {} };

    constructor(canvas, config) {
      Object.assign(this, { canvas, config, data: config.data, options: config.options, updates: [] });
      charts.push(this);
    }

    update(mode) { this.updates.push(mode); }
  }

  // Every other 2D call is a no-op, except measureText, which the layout reads back.
  const PAINTING = ['moveTo', 'lineTo', 'arc', 'fillRect', 'fillText', 'fill', 'stroke'];
  const context2d = new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'measureText') return () => ({ width: 64 });

      if (PAINTING.includes(prop)) {
        return (...args) => {
          painted.push({ op: prop, args, fillStyle: target.fillStyle, strokeStyle: target.strokeStyle, lineWidth: target.lineWidth });
        };
      }

      return prop in target ? target[prop] : () => {};
    },
    set: (target, prop, value) => { target[prop] = value; return true; },
  });

  const document = {
    activeElement: null,
    documentElement: {},
    getElementById: (id) => {
      if (islands.has(id)) {
        return { textContent: islands.get(id) };
      }

      if (!elements.has(id)) {
        // Rendered by the server, or written since by the page itself. Anything else does not
        // exist, and a page reaching for it has to fail here the way it would in a browser.
        const written = [...elements.values()].some((el) => el.innerHTML.includes(`id="${id}"`));

        if (!rendered.has(id) && !written) {
          return null;
        }

        elements.set(id, element(id, rendered.get(id) ?? {}));
      }

      return elements.get(id);
    },
    querySelectorAll: (selector) => {
      // [role="tab"] and the like: every rendered element carrying that attribute, in order.
      const attribute = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);

      if (attribute) {
        return [...rendered].filter(([, attributes]) => attributes[attribute[1]] === attribute[2])
          .map(([id]) => document.getElementById(id));
      }

      return [];
    },
  };

  const element = (id, attributes) => {
    const node = {
      id,
      textContent: '',
      innerHTML: '',
      hidden: 'hidden' in attributes,
      value: '',
      style: {},
      dataset: datasetOf(attributes),
      classList: classesOf(attributes.class),
      // Nothing is inside anything here: an element is a string of markup, not a tree.
      contains: (other) => other === node,
      offsetWidth: 120,
      offsetHeight: 60,
      getBoundingClientRect: () => ({ ...size, left: 0, top: 0 }),
      getContext: () => context2d,
      insertAdjacentHTML(where, markup) { this.innerHTML += markup; },
      // Seeded with what the server rendered, so a test reads back aria-selected and tabindex
      // as the page left them.
      attributes: { ...attributes },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      querySelectorAll: () => [],
      focus() { document.activeElement = node; },
      handlers: {},
    };

    return node;
  };

  const location = { hash };

  // Each route is a different payload, and answering them all with the snapshot would let every
  // assertion pass against a page that renders nothing. A route with no payload is one the
  // server could not read, a route given a number answers with that status, and a route that is
  // not here is one it does not serve.
  const answer = (method, url) => {
    if (method === 'GET' && url === '/dashboard/data') return snapshot;
    if (method === 'GET' && url === '/dashboard/contributions') return report;
    if (method === 'GET' && url === '/dashboard/mine') return mine;
    if (method === 'GET' && url === '/dashboard/manual') return manual && { contributions: manual };
    if (method === 'POST' && /^\/dashboard\/users\/[^/]+\/sync$/.test(url)) return {};

    return undefined;
  };

  const sandbox = {
    console,
    document,
    location,
    history: {
      replaceState: (state, title, url) => {
        replaced.push(url);
        location.hash = url;
      },
    },
    matchMedia: (query) => ({ matches: query.includes('prefers-reduced-motion') && reducedMotion }),
    getComputedStyle: (el) => ({ getPropertyValue: (name) => (el === document.documentElement ? TOKENS.get(name) ?? '' : '') }),
    devicePixelRatio: 2,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => frames.push(fn),
    setInterval: (fn, ms) => intervals.push({ fn, ms, cleared: false }) - 1,
    clearInterval: (id) => { if (intervals[id]) intervals[id].cleared = true; },
    addEventListener: (type, handler) => { listeners[type] = handler; },
    fetch: async (url, options) => {
      const method = options?.method ?? 'GET';

      fetched.push({ url, method });

      const body = answer(method, String(url));

      if (body === undefined) {
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => 'Not found.' };
      }

      if (body === null || typeof body === 'number') {
        return { ok: false, status: body ?? 503, json: async () => ({ error: 'could not be read' }), text: async () => '' };
      }

      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Set, Map, WeakMap, Infinity,
    isNaN, parseInt, parseFloat, encodeURI, encodeURIComponent, decodeURIComponent,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  return { sandbox, elements, intervals, fetched, replaced, listeners, document, frames, painted, charts, Chart };
};

/**
 * The document handleGetDashboard() would send, from the same assembly it uses
 * @param {Object} snapshot - What getSnapshot() answered
 * @param {Object} [read] - What else the handler read: the Me rows and the report
 * @param {string} [read.landing] - Forced, rather than decided by the rule
 * @returns {Promise<string>}
 */
export const renderPage = (snapshot, { mine = null, report = null, landing } = {}) => ejs.renderFile(
  `${ROOT}views/dashboard.ejs`,
  pageLocals({
    snapshot,
    landing: landing ?? landingTab({ operator: snapshot.operator, contributions: mine?.contributions?.length ?? 0 }),
    mine,
    report,
  })
);

/**
 * Run a document's scripts, in the order it lists them, then one animation frame and every interval
 *
 * Any document, not only the page: a component test hands it a few islands, one host element
 * and the one script it is about.
 * @param {string} html - The document
 * @param {Object} snapshot - What /dashboard/data answers
 * @param {{width: number, height: number}} [size] - The box every element reports
 * @param {Object} [options]
 * @param {boolean} [options.drainIntervals] - Run every interval once after load
 * @param {?Object} [options.report] - What GET /dashboard/contributions answers
 * @param {?Object} [options.mine] - What GET /dashboard/mine answers
 * @param {?Array<Object>} [options.manual] - The rows GET /dashboard/manual answers
 * @param {string} [options.hash] - location.hash as the page is opened
 * @param {boolean} [options.reducedMotion] - Whether matchMedia('(prefers-reduced-motion: reduce)') matches
 * @returns {Promise<Object>}
 */
export const runDocument = async (html, snapshot, size = { width: 1080, height: 268 },
  { drainIntervals = true, report = null, mine = null, manual = [], hash = '', reducedMotion = false } = {}) => {
  const dom = stubDom(html, snapshot, { size, report, mine, manual, hash, reducedMotion });
  const context = vm.createContext(dom.sandbox);
  const errors = [];

  // One context for all of them, in document order: the later scripts read what the earlier
  // ones left on the global, exactly as classic scripts do in a browser. Chart.js is the stub
  // above, put where the real one would put itself: a document that does not load it has none.
  for (const [, name] of html.matchAll(/<script src="\/dashboard\/assets\/([^"]+)"><\/script>/g)) {
    try {
      if (name === 'chart.js') {
        dom.sandbox.Chart = dom.Chart;
      } else {
        scriptOf(DASHBOARD_ASSETS[name].file).runInContext(context);
      }
    } catch (error) {
      errors.push({ phase: `load ${name}`, error });
    }
  }

  // One frame, not the loop: each asks for the next.
  if (dom.frames[0]) {
    try {
      dom.frames[0](Date.now());
    } catch (error) {
      errors.push({ phase: 'animation frame', error });
    }
  }

  if (drainIntervals) {
    for (const { fn, ms } of dom.intervals) {
      try {
        await fn();
      } catch (error) {
        errors.push({ phase: `interval ${ms}ms`, error });
      }
    }
  }

  return { html, errors, ...dom };
};

/**
 * Render the page, then run its scripts through load and every interval
 * @param {Object} snapshot - Snapshot the handler would pass
 * @param {{width: number, height: number}} [size] - The box every element reports
 * @param {Object} [options] - As runDocument() takes them, and:
 * @param {string} [options.landing] - The tab the server opens on, if not the rule's
 * @returns {Promise<Object>}
 */
export const runPage = async (snapshot, size, options = {}) => runDocument(
  await renderPage(snapshot, { mine: options.mine ?? null, report: options.report ?? null, landing: options.landing }),
  snapshot,
  size,
  options
);

/**
 * The chart a host was drawn with, found by its canvas
 * @param {Object} run - What runDocument() answered
 * @param {string} id - The host's id
 * @returns {Object|undefined} The stub chart, or undefined when none was made
 */
export const chartIn = (run, id) => run.charts.find((chart) => chart.canvas.id === `${id}-canvas`);

/** Markup's text as it reads: the five entities esc() writes, turned back. */
const unescaped = (text) => text.replace(/&(lt|gt|amp|quot|#39);/g, (_, name) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[name]);

/** Which key an entry of a legend is drawn with, by what its svg holds. */
const KEYS = [[/<line [^>]*stroke-dasharray/, 'dash'], [/<line /, 'line'], [/<circle /, 'circle'], [/<rect /, 'square'], [/<path /, 'triangle']];

/**
 * A chart's legend, read back off the markup core.js wrote under its canvas: each entry as its
 * key, its label, its value and its share, "(dimmed)" after one at zero, and a note as `note: …`
 * @param {Object} run - What runPage() or runDocument() answered
 * @param {string} id - The chart's host
 * @returns {Array<string>}
 */
export const legendIn = (run, id) => [...(run.elements.get(`${id}-legend`)?.innerHTML ?? '')
  .matchAll(/<li(?: class="([\w-]+)")?[^>]*>([\s\S]*?)<\/li>/g)]
  .map(([, name, inner]) => (name === 'legend-note'
    ? `note: ${inner}`
    : [KEYS.find(([pattern]) => pattern.test(inner))?.[1] ?? 'none', /class="legend-label">([^<]*)</.exec(inner)?.[1],
      /<b>([^<]*)<\/b>/.exec(inner)?.[1], /<small>([^<]*)<\/small>/.exec(inner)?.[1], name === 'zero' ? '(dimmed)' : undefined]
      .filter(Boolean).join(' ')))
  .map(unescaped);

/**
 * What the page made, in the test's realm: deepStrictEqual tells an array made in the page's
 * context from one made in the test's, however alike
 * @param {*} value - Plain data
 * @returns {*}
 */
export const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Turn the collected errors into a message worth reading in CI
 * @param {Array<Object>} errors - Errors from runPage
 * @returns {string}
 */
export const report = (errors) => errors
  .map(({ phase, error }) => `[${phase}] ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 3).join('\n')}`)
  .join('\n\n');
