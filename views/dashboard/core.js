/**
 * What the dashboard's tabs share, loaded before any of them
 *
 * Classic scripts rather than modules, one per tab, run in the order the page lists them: this
 * one defines `Dash`; each tab's script is an IIFE that registers itself with Dash.tab() and
 * touches nothing but Dash and its own ids; main.js, loaded last, switches between them, runs
 * the page's two loops and adds Dash.refresh() and Dash.signOut(). A tab the reader's tier does
 * not include is never served, so nothing here may assume it exists.
 *
 * The contract every tab is built on. A tab that needs something else writes it privately, and
 * it moves here once a second tab needs it too.
 *
 * Dash.tab(key, hooks)          activate() on selection, render() when a refresh comes round,
 *                               snapshot?(fresh) for each /dashboard/data payload, tick?() each second
 * Dash.now()                    the server's clock, from the skew of the last payload
 * Dash.$(id), Dash.esc(value)   an element by its id; text made safe for innerHTML
 * Dash.fmt                      n num ordinal place pct date month monthName monthAxis day span seconds
 *                               age tier until ago time plural - every figure and date the page prints
 * Dash.VOCAB, Dash.cls(v, x)    the frozen class vocabularies; every class built from data goes
 *                               through cls(), which answers 'unknown' for anything off the list
 * Dash.stats                    MIN (the snapshot's thresholds), gate(key, value, n)
 * Dash.dom                      swap(el, html) - a no-op when html is what was last written,
 *                               restoring focus by data-focus-key, without scrolling - and
 *                               text(el, s).
 *                               Focus comes back to the first control of the element carrying
 *                               the key: a second control in a row carries a data-focus-key of
 *                               its own (e.g. `drop:${id}`)
 * Dash.data                     load(name) and peek(name) for 'mine' and 'report': one request in
 *                               flight, reused for limits.reportTtlMs, seeded from #seed-mine and
 *                               #seed-report, answering { status: loading|ready|error, data,
 *                               readAt } and never rejecting - the caller renders outside any try
 * Dash.state                    { tab, lists, sort }: what a refresh must not lose
 * Dash.token(name), Dash.reduceMotion   a CSS token's value, for what paints a canvas; whether
 *                               the reader asked for no motion
 * Dash.marks                    outcome forge ownBadge scope face chip
 * Dash.ui                       nothing fragments name tiles stackedBar lineChart dotChart filters counter
 *                               pages filteredList
 * Dash.chart.months(keys), Dash.list.select   a monthly series' x, for lineChart; the pure half
 *                               of filteredList
 *
 * The charts are Chart.js's, loaded before this file as the global `Chart` and themed here once.
 * stackedBar() and lineChart() each draw into an empty host whose parts they write once - a
 * stacked bar's title, a sized box holding the canvas, the legend, the empty state - so a refresh
 * updates the chart in place, and never makes it again. The legend is the page's, not the
 * canvas's: text, written from the same table as the chart.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // The server escapes `<` in every island, so their text is the JSON itself.
  const island = (id) => JSON.parse($(id).textContent);

  const snapshot = island('snapshot');

  // Server clock minus browser clock. Every countdown is computed through this, so a
  // browser whose clock is minutes off still shows the right time to the next run.
  let skewMs = Date.parse(snapshot.now) - Date.now();

  const now = () => Date.now() + skewMs;

  const setClock = (iso) => {
    const at = Date.parse(iso);

    if (Number.isFinite(at)) {
      skewMs = at - Date.now();
    }
  };

  /**
   * Escape text before it goes into innerHTML
   *
   * Not paranoia about our own job names: a run's error message can quote a git ref, and
   * git refs are named by whoever opened the pull request. `git checkout -b
   * '<img src=x onerror=...>'` is a legal branch name, so an unescaped error line here
   * would be stored XSS aimed squarely at whoever operates the bot.
   */
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  /* ---- formats ------------------------------------------------------------ */

  // Spelled out rather than asked of toLocaleDateString: the page reads the same in every
  // browser, and "Sep" is never "sept." because of somebody's system locale.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** A Date from a Date or an ISO string, or null - never the epoch a `new Date(null)` would be. */
  const dateOf = (value) => {
    if (value === null || value === undefined || value === '') return null;

    const at = new Date(value);

    return Number.isNaN(at.getTime()) ? null : at;
  };

  /** `2026-04` or `2026-04-14`, as its numbers. */
  const keyParts = (key) => (/^\d{4}-\d{2}/.test(String(key)) ? String(key).split('-').map(Number) : null);

  const fmt = {
    n: (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—'),
    // A forge's own spelling of the number, which is part of the name: no separator in it.
    num: (value, forge) => `${forge === 'gitlab' ? '!' : '#'}${value}`,
    ordinal: (k) => {
      const teen = k % 100 >= 11 && k % 100 <= 13;

      return `${fmt.n(k)}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[k % 10] ?? 'th'}`;
    },
    // A rank as it is shown: the podium carries its medal.
    place: (k) => `${['🥇 ', '🥈 ', '🥉 '][k - 1] ?? ''}${fmt.ordinal(k)}`,
    // Never 100% or 0% unless it is exactly that: 299 of 300 reads 99%, one of 300 reads 1%.
    pct: (part, whole) => {
      if (!(whole > 0) || !Number.isFinite(part)) return '—';
      if (part === whole) return '100%';
      if (part === 0) return '0%';

      return `${Math.min(99, Math.max(1, Math.round((part / whole) * 100)))}%`;
    },
    // In UTC, the calendar the months and the days are cut in on the server.
    date: (value) => {
      const at = dateOf(value);

      return at ? `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}` : '—';
    },
    month: (key) => {
      const parts = keyParts(key);

      return parts ? `${MONTHS[parts[1] - 1]} ${parts[0]}` : '—';
    },
    // "Sep": the month a figure is cut on, named rather than called "this month".
    monthName: (key) => {
      const parts = keyParts(key);

      return parts ? MONTHS[parts[1] - 1] : '—';
    },
    // The year on the first point and on every January, so the axis says which year it is in.
    monthAxis: (keys, i) => {
      const parts = keyParts(keys[i]);

      if (!parts) return '—';

      return i === 0 || parts[1] === 1 ? fmt.month(keys[i]) : fmt.monthName(keys[i]);
    },
    day: (key) => {
      const parts = keyParts(key);

      return parts ? `${MONTHS[parts[1] - 1]} ${parts[2]}` : '—';
    },
    // Two units at most, truncated: 1 h 30 min, 3 d 2 h. Seconds only under a minute. A number
    // is held to its unit by a no-break space, so a narrow tile breaks between the two units
    // and never inside one.
    span: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      if (ms < 1000) return `${Math.floor(ms)}\u00a0ms`;

      const seconds = Math.floor(ms / 1000);

      if (seconds < 60) return `${seconds}\u00a0s`;

      const minutes = Math.floor(seconds / 60);

      if (minutes < 60) return `${minutes}\u00a0min`;

      const hours = Math.floor(minutes / 60);

      if (hours < 24) return minutes % 60 ? `${hours}\u00a0h ${minutes % 60}\u00a0min` : `${hours}\u00a0h`;

      const days = Math.floor(hours / 24);

      return hours % 24 ? `${days}\u00a0d ${hours % 24}\u00a0h` : `${days}\u00a0d`;
    },
    // A duration the server measured in seconds, as span() writes it.
    seconds: (value) => fmt.span(value * 1000),
    // One unit: how long something has been open, as somebody would say it.
    age: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return '—';

      const minutes = Math.floor(ms / 60000);

      if (minutes < 60) return `${minutes}\u00a0min`;

      const hours = Math.floor(minutes / 60);

      return hours < 24 ? `${hours}\u00a0h` : `${fmt.n(Math.floor(hours / 24))}\u00a0d`;
    },
    tier: (minutes) => fmt.span(minutes * 60000),
    until: (value) => {
      const at = dateOf(value);

      if (!at) return '—';

      const ms = at.getTime() - now();

      return ms >= 0 ? `due in ${fmt.span(ms)}` : `${fmt.span(-ms)} overdue`;
    },
    ago: (value) => {
      const at = dateOf(value);

      if (!at) return '—';

      const ms = now() - at.getTime();

      return ms < 60000 ? 'just now' : `${fmt.span(ms)} ago`;
    },
    // The clock alone today, the day as well otherwise - both in UTC.
    time: (value) => {
      const at = dateOf(value);

      if (!at) return '—';

      const iso = at.toISOString();

      return iso.slice(0, 10) === new Date(now()).toISOString().slice(0, 10)
        ? iso.slice(11, 19)
        : `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${iso.slice(11, 16)}`;
    },
    plural: (count, one, many) => `${fmt.n(count)} ${count === 1 ? one : many}`,
  };

  /* ---- vocabularies ------------------------------------------------------- */

  const VOCAB = Object.freeze({
    OUTCOMES: Object.freeze(['merged', 'open', 'closed']),
    JOB_STATES: Object.freeze(['ok', 'running', 'failing', 'idle']),
    RUN_OUTCOMES: Object.freeze(['ok', 'failed', 'idle', 'skipped', 'unknown']),
    ACCOUNT_STATES: Object.freeze(['installed', 'pending', 'suspended', 'uninstalled', 'disabled']),
    HUES: Object.freeze(['sync', 'poll']),
  });

  // A class built from data is a class the stylesheet may not have: off the list, it is
  // 'unknown', which every vocabulary's styles define.
  const cls = (vocab, value) => (vocab.includes(value) ? value : 'unknown');

  const TINTS = Object.freeze(['poll', 'sync', 'now', 'fail', 'warn', 'ok']);

  /* ---- statistics --------------------------------------------------------- */

  // The server computes every percentile; the page only gates what it draws on its sample.
  const MIN = Object.freeze({ ...snapshot.limits.percentiles });

  const stats = {
    MIN,
    gate: (key, value, count) => (count >= MIN[key] ? value : null),
  };

  /* ---- the DOM ------------------------------------------------------------ */

  // What swap() last wrote into each element, compared instead of innerHTML: a browser
  // serialises markup its own way, and comparing against that would redraw on every call.
  const written = new WeakMap();

  /**
   * What to focus for a key: the first control inside the element carrying it, or that element
   * itself when it is one - a chip, a page button.
   * Only the first: a row's second control carries a key of its own (`drop:${id}`), which
   * swap() finds before the row's, being the nearer.
   */
  const focusable = (el, key) => {
    const holder = [...el.querySelectorAll('[data-focus-key]')].find((node) => node.getAttribute('data-focus-key') === key);
    const CONTROL = 'a, button, [tabindex]';

    return holder?.querySelector(CONTROL) ?? (holder?.matches(CONTROL) ? holder : null);
  };

  const dom = {
    /**
     * Replace an element's content, unless it is what is already there
     *
     * A refresh that changed nothing then changes nothing: no reflow, no lost selection, no
     * live region announcing the same words again. When it does rewrite, focus comes back to
     * the element carrying the same data-focus-key, without moving the page, so a keyboard
     * user is not thrown to the top of it every five seconds.
     * @returns {boolean} Whether anything was written
     */
    swap: (el, html) => {
      if (written.get(el) === html) return false;

      const active = document.activeElement;
      const key = active && el.contains(active)
        ? active.closest('[data-focus-key]')?.getAttribute('data-focus-key') ?? null
        : null;

      el.innerHTML = html;
      written.set(el, html);

      // A click focuses what it lands on too, and the reader may since have scrolled away from
      // it: a refresh leaves them where they are.
      if (key !== null) focusable(el, key)?.focus({ preventScroll: true });

      return true;
    },
    text: (el, value) => {
      if (el && el.textContent !== value) el.textContent = value;
    },
  };

  /* ---- what the tabs read ------------------------------------------------- */

  const ROUTES = { mine: '/dashboard/mine', report: '/dashboard/contributions' };

  const seeded = (value) => (value
    ? { status: 'ready', data: value, readAt: Date.now() }
    : { status: 'loading', data: null, readAt: 0 });

  const sources = { mine: seeded(island('seed-mine')), report: seeded(island('seed-report')) };
  const inFlight = {};

  /** One read of a source. Settles to the next state of it and never throws. */
  const fetchSource = async (name) => {
    try {
      const response = await fetch(ROUTES[name], { headers: { Accept: 'application/json' }, cache: 'no-store' });

      if (response.status === 401) {
        Dash.signOut();
        return sources[name];
      }

      if (!response.ok) {
        return { ...sources[name], status: 'error' };
      }

      const payload = await response.json();

      setClock(payload.now);

      return { status: 'ready', data: payload, readAt: Date.now() };
    } catch {
      // Network, not application: what was last read stays, and says it is not current.
      return { ...sources[name], status: 'error' };
    }
  };

  const data = {
    load: (name) => {
      const source = sources[name];
      const fresh = source.status === 'ready' && Date.now() - source.readAt < snapshot.limits.reportTtlMs;

      if (Dash.signedOut || fresh) {
        return Promise.resolve(source);
      }

      inFlight[name] ??= fetchSource(name).then((next) => {
        sources[name] = next;
        delete inFlight[name];
        return next;
      });

      return inFlight[name];
    },
    peek: (name) => sources[name],
  };

  /* ---- marks -------------------------------------------------------------- */

  // The three outcomes by shape, so colour is never the only thing telling them apart: a
  // circle merged, a square open, a triangle closed.
  const SHAPES = {
    merged: '<circle cx="6" cy="6" r="4.5"/>',
    open: '<rect x="1.75" y="1.75" width="8.5" height="8.5" rx="1"/>',
    closed: '<path d="M6 1.25 10.9 10.25H1.1Z"/>',
  };

  /**
   * The forge a contribution lives on, as its mark
   *
   * The shape says which, not the colour: both marks are drawn in the same neutral ink, so a
   * forge never borrows the hue that means "ours" or "elsewhere" on the same row.
   */
  const FORGE_MARKS = {
    github: '<path d="M8 0a8 8 0 0 0-2.5 15.6c.4.07.55-.17.55-.38v-1.35C3.84 14.3 3.4 13 3.4 13c-.36-.9-.87-1.15-.87-1.15-.71-.48.05-.47.05-.47.79.06 1.2.81 1.2.81.7 1.2 1.83.85 2.28.65.07-.5.27-.85.5-1.05-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.14.46.55.38A8 8 0 0 0 8 0Z"/>',
    gitlab: '<path d="M8 15 5.1 6.1h5.8L8 15Zm0 0L1.2 6.1h3.9L8 15Zm-6.8-8.9L.3 9a.6.6 0 0 0 .22.67L8 15 1.2 6.1Zm0 0h3.9L3.4.9c-.09-.26-.46-.26-.55 0L1.2 6.1ZM8 15l2.9-8.9h3.9L8 15Zm6.8-8.9L15.7 9a.6.6 0 0 1-.22.67L8 15l6.8-8.9Zm0 0h-3.9L12.6.9c.09-.26.46-.26.55 0l1.65 5.2Z"/>',
  };

  const GLOBE = '<svg viewBox="0 0 12 12" role="img" aria-label="elsewhere" fill="none" stroke-width="1">'
    + '<circle cx="6" cy="6" r="4.5"/><ellipse cx="6" cy="6" rx="2.1" ry="4.5"/><path d="M1.6 6h8.8"/></svg>';

  const OURS = '<img src="/images/company_logo.svg" alt="ours">';

  const marks = {
    /**
     * The shape, then the word - or what stands for it, a count. With a count, the shape is
     * what says which outcome it counts, so it says so out loud too: "merged 128", not "128".
     */
    outcome: (state, text = state) => `<span class="outcome ${cls(VOCAB.OUTCOMES, state)}">`
      + `<svg viewBox="0 0 12 12" ${text === state ? 'aria-hidden="true"' : `role="img" aria-label="${esc(state)}"`}>`
      + `${SHAPES[cls(VOCAB.OUTCOMES, state)] ?? ''}</svg>${esc(text)}</span>`,
    forge: (forge) => `<svg class="forgemark" viewBox="0 0 16 16" role="img" aria-label="${esc(forge)}">`
      + `<title>${esc(forge)}</title>${FORGE_MARKS[forge] ?? ''}</svg>`,
    // The badge marking a repository the company owns: the app's own logo, never a word.
    ownBadge: () => '<img class="own-badge" src="/images/company_logo.svg" alt="ours">',
    // The logo or the globe, then the count: the glyph says which, so no class does. A zero
    // recedes rather than sitting level with the other.
    scope: (kind, count) => `<span class="scope-mark${count === 0 ? ' zero' : ''}">`
      + `${kind === 'ours' ? OURS : GLOBE}<b>${fmt.n(count)}</b></span>`,
    /**
     * A person, by their GitHub face: by their account id where it is known, which outlives a
     * rename, and by their login otherwise; where there is neither, a question mark in its place.
     *
     * Drawn `size` px round and fetched at twice that, or it is soft on a retina screen; lazy,
     * so a page of rows fetches the faces in view; no referrer, so GitHub is not handed the
     * page's address with each. No alt: the login is always written beside it.
     */
    face: (login, size = 24, id = null) => {
      const box = `style="--size: ${Number(size)}px"`;

      if (!login && !id) return `<span class="avatar monogram" ${box} aria-hidden="true">?</span>`;

      return `<img class="avatar" ${box} alt="" loading="lazy" referrerpolicy="no-referrer" `
        + `src="https://avatars.githubusercontent.com/${id ? `u/${encodeURIComponent(id)}` : encodeURIComponent(login)}?s=${2 * Number(size)}">`;
    },
    chip: (text) => `<span class="chip">${esc(text)}</span>`,
  };

  /* ---- components --------------------------------------------------------- */

  /** An empty state: the fact in bold, and at most one line on what will fill it. */
  const nothing = (fact, hint) => `<div class="nothing"><b>${esc(fact)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`;

  /**
   * Fragments of one line, each in a box of its own
   *
   * Set apart by the line's gap rather than by a dot, so a narrow line breaks between two boxes
   * and never leaves a separator hanging at the end of one. The space between them is for whoever
   * copies or hears the line. Markup in: the caller escapes what it hands over.
   */
  const fragments = (parts) => parts.map((part) => `<span>${part}</span>`).join(' ');

  /** A row's name, linked to the forge in a new tab when there is an address to link to. */
  const name = (url, text) => (url
    ? `<a class="name" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(text)}</a>`
    : `<span class="name">${esc(text)}</span>`);

  /**
   * A row of tiles, written into its <dl class="tiles">
   *
   * A value of "0" is zero, shown with its base and no sub-line; null is below its threshold,
   * shown as "—" with its base. `zero` says so of any other value - "none" where nothing is
   * there to measure. Late only when it is not zero: zero wins.
   *
   * A space between the value and its base, so the text reads "29 of 34 judged" wherever it is
   * copied or spoken, and the base and the sub-line as fragments - a base's split at " · " - so a
   * narrow tile breaks between two of them rather than inside one.
   * @param {Element} el - The <dl class="tiles">
   * @param {Array<{key: string, label: string, value: ?string, base?: string, sub?: Array<string>,
   *   tint: string, late?: boolean, zero?: boolean, inline?: boolean}>} list - `inline` keeps the base on the
   *   value's line, the value in its tint: a place and what it is out of, read as one
   */
  const tiles = (el, list) => dom.swap(el, list.map((tile) => {
    const zero = tile.zero ?? (tile.value === null || tile.value === '0');
    const late = !zero && tile.late === true;
    const sub = tile.value === '0' ? [] : (tile.sub ?? []).filter(Boolean);

    return `<div class="tile${zero ? ' zero' : late ? ' late' : ''}${tile.inline ? ' inline' : ''}" style="--tint: var(--${cls(TINTS, tile.tint)})" data-tile="${esc(tile.key)}">`
      + `<dt>${esc(tile.label)}</dt>`
      + `<dd><span class="v">${esc(tile.value ?? '—')}</span>${tile.base ? ` <small>${fragments(tile.base.split(' · ').map(esc))}</small>` : ''}`
      + `${sub.length > 0 ? `<p class="sub">${fragments(sub.map(esc))}</p>` : ''}</dd>`
      + `</div>`;
  }).join(''));

  /* ---- charts ------------------------------------------------------------- */

  // A canvas takes no var(), so what paints one reads the tokens, once: the page has one theme.
  const style = getComputedStyle(document.documentElement);
  const token = (name) => style.getPropertyValue(`--${name}`).trim();

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Every chart's theme, set once: its ticks in the page's face at 12px, its inks, and no motion for
  // a reader who asked for none. No legend and no painted tooltip: each chart's legend is written
  // in the page under its canvas, and its tooltip over it, styled by .chart-tip.
  Object.assign(Chart.defaults, { color: token('ink-mute'), borderColor: token('line-soft'), maintainAspectRatio: false });
  Object.assign(Chart.defaults.font, { family: token('sans'), size: 12 });

  if (reduceMotion) Chart.defaults.animation = false;

  /**
   * Every chart's tooltip, written in the page beside its canvas rather than painted in it
   *
   * A tooltip Chart.js paints cannot leave its canvas, and a stacked bar's canvas is 16px tall:
   * the box was cut to a sliver. This one sits over the chart, centred above the point, kept
   * inside the chart's box sideways, in the theme's colours - one element per chart, made on
   * first use and reused.
   */
  const tooltip = ({ chart, tooltip: tip }) => {
    const box = chart.canvas.parentNode;
    let el = box.querySelector('.chart-tip');

    if (!el) {
      el = document.createElement('div');
      el.classList.add('chart-tip');
      el.setAttribute('aria-hidden', 'true');
      box.append(el);
    }

    el.hidden = tip.opacity === 0;

    if (el.hidden) return;

    const lines = tip.body.flatMap((part) => part.lines);

    el.innerHTML = (tip.title ?? []).map((title) => `<b>${esc(title)}</b>`).join('')
      + lines.map((line, i) => `<span><i style="background: ${esc(tip.labelColors[i]?.backgroundColor ?? 'transparent')}"></i>${esc(line)}</span>`).join('')
      + (tip.footer ?? []).map((footer) => `<small>${esc(footer)}</small>`).join('');
    const half = el.offsetWidth / 2;

    el.style.left = `${Math.min(Math.max(tip.caretX, half), box.clientWidth - half)}px`;
    el.style.top = `${tip.caretY}px`;
  };

  // Over the pointer: Chart.js places a bar's tooltip at the segment's far end, a long way from
  // the hand on a wide bar.
  Chart.Tooltip.positioners.pointer = (items, position) => (items.length > 0 ? position : false);
  Object.assign(Chart.defaults.plugins.tooltip, { enabled: false, external: tooltip, position: 'pointer' });

  // Every chart made, by its host's id: a refresh updates it rather than making another.
  const charts = new Map();

  /**
   * A chart's legend, as the items of its <ul class="legend-list">
   *
   * Each item is its key, drawn as the canvas draws what it keys, then its label, its value and
   * what the value is a share of, if anything; one at zero recedes, as a scope mark does. An item
   * with no key is a note, on a line of its own after the others.
   * @param {Array<{key: string, paint: string, label: string, value?: string, share?: string,
   *   zero?: boolean}|{note: string}>} items - `key` is markup; `paint`, the token it is drawn in
   * @returns {string}
   */
  const legend = (items) => items.map((item) => (item.note
    ? `<li class="legend-note">${esc(item.note)}</li>`
    : `<li${item.zero ? ' class="zero"' : ''} style="--key: var(--${esc(item.paint)})">${item.key}`
      + `<span class="legend-label">${esc(item.label)}</span>${item.value ? ` <b>${esc(item.value)}</b>` : ''}`
      + `${item.share ? ` <small>${esc(item.share)}</small>` : ''}</li>`)).join('');

  // The keys: an outcome's shape and a square for anything else, as a stacked bar paints them;
  // a line in its series' own dash, 24px long so a dash can be told from a solid.
  const shapeKey = (key) => `<svg class="legend-key" viewBox="0 0 12 12" aria-hidden="true">${SHAPES[cls(VOCAB.OUTCOMES, key)] ?? SHAPES.open}</svg>`;
  const lineKey = (dash) => '<svg class="legend-key line" viewBox="0 0 24 4" aria-hidden="true">'
    + `<line x1="0" y1="2" x2="24" y2="2"${dash ? ' stroke-dasharray="6 4"' : ''}/></svg>`;

  /** What a legend item says, read out whole: the canvas's label says it too. */
  const said = (item) => item.note ?? [item.label, item.value, item.share].filter(Boolean).join(' ');

  /**
   * Draw a chart into its host, or its empty state in its place
   *
   * The parts are written once - `head`, then a sized box holding the canvas alone, as Chart.js
   * asks, then the legend, then the empty state - so the canvas and its chart outlive every
   * refresh. The chart is made on the first drawing and updated in place, without animation, on
   * every one after. An empty chart has no legend: its empty state says what there is.
   * @param {Element} host
   * @param {{head?: string, tall?: boolean, config: Object, label: string, legend: Array<Object>,
   *   empty: {fact: string, hint?: string}|false}} chart - `label` is the canvas's name to a
   *   screen reader: every value. `legend`, as legend() takes it
   */
  const plot = (host, { head = '', tall = false, config, label, legend: items, empty }) => {
    const { id } = host;

    if (!charts.has(id)) {
      host.innerHTML = `${head}<div class="plot${tall ? ' tall' : ''}" id="${esc(id)}-plot">`
        + `<canvas id="${esc(id)}-canvas" role="img"></canvas></div>`
        + `<ul class="legend-list" id="${esc(id)}-legend"></ul><div id="${esc(id)}-none"></div>`;
      charts.set(id, null);
    }

    $(`${id}-plot`).hidden = Boolean(empty);
    dom.swap($(`${id}-legend`), empty ? '' : legend(items));
    dom.swap($(`${id}-none`), empty ? nothing(empty.fact, empty.hint) : '');

    if (empty) return;

    const canvas = $(`${id}-canvas`);
    const chart = charts.get(id);

    canvas.setAttribute('aria-label', label);

    if (!chart) {
      charts.set(id, new Chart(canvas, config));
      return;
    }

    chart.data = config.data;
    chart.options = config.options;
    chart.update('none');
  };

  // What each segment of a stacked bar is painted in. Anything off the list is --ink-mute, and
  // the loud --now is overdue's alone. The three outcomes are keyed by their shapes - a circle,
  // a square, a triangle - as on every row, and everything else by a square.
  const SEGMENT_PAINT = Object.freeze({
    merged: 'poll', open: 'warn', closed: 'fail', ours: 'sync', else: 'poll',
    b1: 'ok', b2: 'poll', b3: 'sync', b4: 'warn', ontime: 'ok', overdue: 'now', claimed: 'sync', backoff: 'fail',
  });

  /**
   * One stacked bar with its title, its base and its legend
   *
   * One bar, as wide as its total. A zero leaves the bar and stays in the legend, dimmed, where it
   * says the category exists and is empty; a bar of nothing is its empty state, under its title.
   * A slice under a few percent is still 4px wide: as a hairline, the one a reader most needs to
   * see - one still open among 244 - would not be seen at all on a phone.
   * @param {Element} host - An empty <div class="bar-row">
   * @param {{title: string, base?: string, segments: Array<{key: string, label: string, n: number,
   *   note?: string}>, empty?: {fact: string, hint?: string}}} bar - `note` is what the count is a
   *   share of, or says beside it: the base says over what
   */
  const stackedBar = (host, { title, base, segments, empty }) => {
    const total = segments.reduce((sum, segment) => sum + segment.n, 0);
    const items = segments.map((segment) => ({
      key: shapeKey(segment.key),
      paint: SEGMENT_PAINT[segment.key] ?? 'ink-mute',
      label: segment.label,
      value: fmt.n(segment.n),
      share: segment.note,
      zero: segment.n === 0,
    }));
    const entries = segments.map((segment) => `${segment.label} ${fmt.n(segment.n)}${segment.note ? ` (${segment.note})` : ''}`);

    plot(host, {
      head: `<h3 id="${esc(host.id)}-head"></h3>`,
      label: `${title}: ${entries.join(', ')}`,
      legend: items,
      empty: total === 0 && (empty ?? { fact: 'Nothing recorded yet.' }),
      config: {
        type: 'bar',
        data: {
          labels: [title],
          datasets: segments.map((segment, i) => ({
            label: entries[i],
            // A zero as null, which Chart.js skips: the minimum below would draw it.
            data: [segment.n || null],
            backgroundColor: token(items[i].paint),
            barThickness: 14,
            minBarLength: 4,
          })),
        },
        options: {
          indexAxis: 'y',
          scales: { x: { stacked: true, display: false, max: total }, y: { stacked: true, display: false } },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (item) => item.dataset.label } },
          },
        },
      },
    });

    dom.swap($(`${host.id}-head`), `${esc(title)}${base ? ` <span class="base">${esc(base)}</span>` : ''}`);
  };

  // A duration lane is scaled to one unit, chosen by its largest value, so its ticks fall on
  // round numbers of it.
  const DURATION_UNITS = [
    { label: 's', seconds: 1, below: 120 },
    { label: 'min', seconds: 60, below: 7200 },
    { label: 'h', seconds: 3600, below: 172_800 },
    { label: 'd', seconds: 86_400, below: Infinity },
  ];

  /**
   * A line chart: lanes sharing one x axis, each on a y scale of its own stacked above the next,
   * one table driving the datasets, the tooltip and the canvas's label alike
   *
   * @param {Element} host - An empty element
   * @param {{x: Array<{key: string, label: string, title: string, base?: string}>, running?: {note: string},
   *   lanes: Array<{label: string, unit: 'count'|'duration', series: Array<{key: string, label: string,
   *   hue: string, dash?: boolean, mode?: 'line'|'step', values: Array<?number>}>}>, legend?: Array<{series: string,
   *   value?: string, share?: string}|{note: string}>, rows?: function(number): Array<{key?: string, text: string}>,
   *   empty?: {fact: string, hint?: string}}} chart
   *   Durations are in seconds, and a null is a gap. A chart with nothing in it at all is its
   *   `empty` state; a series of nulls stays in the legend undrawn. A legend entry is keyed and
   *   labelled by its series, dimmed when its value is zero; a note is a line after them.
   */
  const lineChart = (host, chart) => {
    const last = chart.x.length - 1;
    const series = chart.lanes.flatMap((lane) => lane.series);
    const lanes = chart.lanes.map((lane) => {
      const peak = Math.max(0, ...lane.series.flatMap((one) => one.values).filter(Number.isFinite));

      return { ...lane, scale: lane.unit === 'duration' ? DURATION_UNITS.find((unit) => peak < unit.below) : null };
    });
    const scaleOf = new Map(lanes.flatMap((lane) => lane.series.map((one) => [one.key, lane.scale])));

    const rowsOf = (i) => [
      ...(chart.rows?.(i) ?? [
        ...series.map((one) => {
          const value = one.values[i];

          return { key: one.key, text: `${one.label} ${!Number.isFinite(value) ? '—' : scaleOf.get(one.key) ? fmt.seconds(value) : fmt.n(value)}` };
        }),
        ...(chart.x[i].base ? [{ text: chart.x[i].base }] : []),
      ]),
      // Said as well as drawn open, so a screen reader hears that the last period is not a whole one.
      ...(chart.running && i === last ? [{ text: chart.running.note }] : []),
    ];

    // At zero is what the entry says, when it says a figure: a p90 no day reaches still has the
    // window's. Without one, a series that never leaves zero.
    const items = (chart.legend ?? series.map((one) => ({ series: one.key }))).map((entry) => {
      const one = series.find((candidate) => candidate.key === entry.series);

      return entry.note ? entry : {
        ...entry,
        key: lineKey(one.dash),
        paint: one.hue,
        label: one.label,
        zero: entry.value === undefined ? !one.values.some((value) => value > 0) : entry.value === '0',
      };
    });
    const longest = Math.max(0, ...chart.x.map((x) => x.label.length));
    const panel = token('panel');

    plot(host, {
      tall: lanes.length > 1,
      label: [...items.map(said),
        ...chart.x.map((x, i) => `${x.title}: ${rowsOf(i).map((row) => row.text).join(', ')}`)].join('. '),
      empty: (chart.x.length === 0 || series.every((one) => one.values.every((value) => !value)))
        && (chart.empty ?? { fact: 'Nothing recorded yet.' }),
      legend: items,
      config: {
        type: 'line',
        data: {
          labels: chart.x.map((x) => x.label),
          datasets: lanes.flatMap((lane, k) => lane.series.map((one) => {
            const hue = token(one.hue);
            const alone = (i) => !Number.isFinite(one.values[i - 1]) && !Number.isFinite(one.values[i + 1]);

            return {
              label: one.label,
              data: one.values.map((value) => (Number.isFinite(value) ? value / (lane.scale?.seconds ?? 1) : null)),
              yAxisID: `y${k}`,
              borderColor: hue,
              backgroundColor: hue,
              borderWidth: 2,
              borderDash: one.dash ? [6, 4] : [],
              stepped: one.mode === 'step',
              // A point only where no line reaches - a value alone between two gaps - and on the
              // period still running, drawn open. The line carries the rest; the tooltip names each.
              pointRadius: one.values.map((value, i) => (Number.isFinite(value) && (alone(i) || (chart.running && i === last)) ? 3.5 : 0)),
              pointBackgroundColor: one.values.map((_, i) => (chart.running && i === last ? panel : hue)),
              pointBorderWidth: 2,
            };
          })),
        },
        options: {
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxRotation: 0, autoSkipPadding: 16 },
              // Thinned, the axis may have dropped every label that names a year: the first label
              // left, and the first left in each year after it, take their period's full name,
              // when it is no wider than the longest label the thinning made room for.
              beforeFit: (axis) => axis.ticks.forEach((tick, k, kept) => {
                const x = chart.x[tick.value];

                if (x.title.length <= longest && (k === 0 || x.key.slice(0, 4) !== chart.x[kept[k - 1].value].key.slice(0, 4))) {
                  tick.label = x.title;
                }
              }),
            },
            // The first lane on top, the heavier being placed first. The zero of a lane with one
            // under it is left unlabelled: it is where the top of the next lane's scale is written.
            ...Object.fromEntries(lanes.map((lane, k) => [`y${k}`, {
              stack: 'lanes',
              weight: -k,
              beginAtZero: true,
              title: { display: true, text: `${lane.label}${lane.scale ? ` (${lane.scale.label})` : ''}` },
              ticks: { precision: 0, maxTicksLimit: 5, callback: (value, i) => (i === 0 && k < lanes.length - 1 ? '' : fmt.n(value)) },
            }])),
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: ([item]) => chart.x[item.dataIndex].title,
                label: (item) => rowsOf(item.dataIndex).find((row) => row.key === series[item.datasetIndex].key).text,
                footer: ([item]) => rowsOf(item.dataIndex).filter((row) => !row.key).map((row) => row.text),
              },
            },
          },
        },
      },
    });
  };

  /**
   * A dot chart: one dot per measurement on a time axis, under level lines for the figures that
   * sum them up
   *
   * For a measurement taken a few times a day, where a figure per day would be a gap on most days.
   * Every dot is drawn; a level is drawn only when it has a value, which is for the caller to gate.
   * @param {Element} host - An empty element
   * @param {{from: string, days: number, label: string, unit: 'duration', points: Array<{at: string,
   *   value: number}>, dot: string, levels: Array<{key: string, label: string, value: ?number,
   *   dash?: boolean}>, notes?: Array<string>, empty: {fact: string, hint?: string}}} chart
   *   `from` is the first day's UTC midnight and the axis runs `days` days from it. `dot` names
   *   one dot in the legend. Durations are in seconds
   */
  const dotChart = (host, chart) => {
    const start = Date.parse(chart.from);
    const end = start + chart.days * 86_400_000;
    const levels = chart.levels.filter((level) => Number.isFinite(level.value));
    const peak = Math.max(0, ...chart.points.map((point) => point.value), ...levels.map((level) => level.value));
    const scale = DURATION_UNITS.find((unit) => peak < unit.below);
    // A tick on a day's midnight, as many days apart as keeps the axis to eight of them.
    const step = Math.ceil(chart.days / 8) * 86_400_000;
    const ink = token('ink-dim');
    const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
    const when = (at) => `${fmt.date(at)} ${at.slice(11, 16)}`;

    const items = [
      { key: shapeKey('merged'), paint: 'ink-dim', label: chart.dot },
      ...levels.map((level) => ({ key: lineKey(level.dash), paint: 'ink-dim', label: level.label, value: fmt.seconds(level.value) })),
      ...(chart.notes ?? []).map((note) => ({ note })),
    ];

    plot(host, {
      label: [...items.map(said), ...chart.points.map((point) => `${when(point.at)}: ${fmt.seconds(point.value)}`)].join('. '),
      empty: chart.points.length === 0 && chart.empty,
      legend: items,
      config: {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: chart.dot,
              data: chart.points.map((point) => ({ x: Date.parse(point.at), y: point.value / scale.seconds })),
              backgroundColor: ink,
              borderColor: ink,
              pointRadius: 3.5,
              pointHoverRadius: 5,
            },
            // A level runs the whole axis, behind the dots, and answers no tooltip: the legend
            // says its value.
            ...levels.map((level) => ({
              type: 'line',
              label: level.label,
              data: [{ x: start, y: level.value / scale.seconds }, { x: end, y: level.value / scale.seconds }],
              borderColor: ink,
              borderWidth: 1.5,
              borderDash: level.dash ? [6, 4] : [],
              pointRadius: 0,
              pointHitRadius: 0,
              order: 1,
            })),
          ],
        },
        options: {
          interaction: { mode: 'nearest', intersect: true },
          scales: {
            x: {
              type: 'linear',
              min: start,
              max: end,
              grid: { display: false },
              afterBuildTicks: (axis) => {
                axis.ticks = Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, k) => ({ value: start + k * step }));
              },
              ticks: { maxRotation: 0, autoSkip: false, callback: (value) => fmt.day(dayOf(value)) },
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: `${chart.label} (${scale.label})` },
              ticks: { precision: 0, maxTicksLimit: 5, callback: (value) => fmt.n(value) },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => item.datasetIndex === 0,
              callbacks: {
                title: ([item]) => when(chart.points[item.dataIndex].at),
                label: (item) => fmt.seconds(chart.points[item.dataIndex].value),
              },
            },
          },
        },
      },
    });
  };

  /** Every month of a series as a chart's x: its name on the axis, in full in the tooltip. */
  const months = (keys) => keys.map((key, i) => ({ key, label: fmt.monthAxis(keys, i), title: fmt.month(key) }));

  /* ---- the filtered list -------------------------------------------------- */

  const PAGE = 10;

  // What each pager's click turns, by its element: the latest state and redraw it was drawn with.
  const pagers = new WeakMap();

  /**
   * A list's pages: the controls under it, and which of its rows the page shows
   *
   * Ten rows a page, the page kept in the list's own state, so a refresh stays on it; a list
   * that shrank under it is brought back to its last page. The controls are hidden while
   * everything fits on one. Each button says what it does and is disabled at its end: pressed
   * up to it, it hands the focus to the other one, since a disabled button holds none.
   * @param {Element} el - Where the controls go, written whole by every drawing
   * @param {{page: number}} state - The list's, in Dash.state.lists: `page` counts from 0
   * @param {number} count - The rows to page through
   * @param {function(): void} redraw - Draws the list again, once a button has turned the page
   * @returns {{from: number, to: number}} The page's rows, as slice() takes them
   */
  const pages = (el, state, count, redraw) => {
    const last = Math.max(0, Math.ceil(count / PAGE) - 1);

    state.page = Math.min(state.page, last);

    const from = state.page * PAGE;
    const to = Math.min(count, from + PAGE);
    const button = (step, label, text, end) => `<button type="button" data-page="${step}" data-focus-key="page:${step}" `
      + `aria-label="${label}" aria-describedby="${esc(el.id)}-range"${end ? ' disabled' : ''}>${text}</button>`;

    dom.swap(el, last === 0 ? '' : `<div class="pager">${button(-1, 'Previous page', '‹ Previous', state.page === 0)}`
      + `<span id="${esc(el.id)}-range">${fmt.n(from + 1)}–${fmt.n(to)} of ${fmt.n(count)}</span>`
      + `${button(1, 'Next page', 'Next ›', state.page === last)}</div>`);

    if (!pagers.has(el)) {
      el.addEventListener('click', (event) => {
        const pressed = event.target?.closest?.('button[data-page]');
        const current = pagers.get(el);

        if (!pressed || pressed.disabled) return;

        const step = Number(pressed.dataset.page);

        current.state.page += step;
        current.redraw();

        if (focusable(el, `page:${step}`)?.disabled) focusable(el, `page:${-step}`)?.focus({ preventScroll: true });
      });
    }

    pagers.set(el, { state, redraw });

    return { from, to };
  };

  /**
   * Which rows a list shows, in which order, and every chip's count
   *
   * Pure. Facets combine with AND, each a single choice where 'all' passes everything; a
   * chip counts over the whole population, whatever the other chips say. Grouped, the groups
   * run by size then name, each keeping the rows' own order, which 'none' gives back.
   * @param {Array<Object>} rows
   * @param {Object} list - As filteredList() takes it
   * @param {{facets: Object<string, string>, group: 'none'|'by'}} state
   * @returns {{rows: Array<Object>, groups: ?Map<string, number>, counts: Object, total: number}}
   *   `rows` are all that match, in order, every page of them
   */
  const select = (rows, list, state) => {
    const counts = Object.fromEntries(list.facets.map((facet) => {
      const tally = { all: rows.length };

      for (const { value } of facet.values) tally[value] = 0;

      for (const row of rows) {
        const value = facet.of(row);

        if (Object.hasOwn(tally, value) && value !== 'all') tally[value] += 1;
      }

      return [facet.key, tally];
    }));

    const matched = rows.filter((row) => list.facets.every((facet) => {
      const wanted = state.facets[facet.key] ?? 'all';

      return wanted === 'all' || facet.of(row) === wanted;
    }));

    if (!list.groupBy || state.group === 'none') {
      return { rows: matched, groups: null, counts, total: rows.length };
    }

    const groups = new Map();

    for (const row of matched) {
      const group = list.groupBy.of(row);

      groups.set(group, (groups.get(group) ?? 0) + 1);
    }

    const order = [...groups.keys()].sort((a, b) => groups.get(b) - groups.get(a) || String(a).localeCompare(String(b)));
    const grouped = order.flatMap((group) => matched.filter((row) => list.groupBy.of(row) === group));

    return { rows: grouped, groups, counts, total: rows.length };
  };

  /**
   * A list's chips: one group per facet, 'all' first, exactly one pressed
   *
   * Each chip has a focus key, because pressing one redraws them all: without it the chip under
   * the keyboard is replaced and the focus falls to the top of the page. The group's name is
   * its label; the word shown beside the chips says it again, so it is left unspoken.
   */
  const filters = (facets, counts, state) => facets.map((facet) => {
    const pressed = state.facets[facet.key] ?? 'all';

    return `<div class="filters" role="group" aria-label="${esc(facet.label)}" data-facet="${esc(facet.key)}">`
      + `<span class="k" aria-hidden="true">${esc(facet.label)}</span>${
        [{ value: 'all', label: 'all' }, ...facet.values].map(({ value, label }) => {
          const count = counts[facet.key][value] ?? 0;

          return `<button type="button" aria-pressed="${value === pressed}" data-value="${esc(value)}" `
            + `data-focus-key="${esc(`facet:${facet.key}:${value}`)}">${esc(label)} `
            + `<b${count === 0 ? ' class="zero"' : ''}>${fmt.n(count)}</b></button>`;
        }).join('')
      }</div>`;
  }).join('');

  /**
   * "12 of 41 pull requests match.", or "3 of 10 match." for a list that names no noun
   *
   * What the chips and the search let through, every page of it - which rows of it are on the
   * page is the pager's to say. Whole, it is only read out: "41 of 41" shows nothing the list
   * does not.
   *
   * A live region only from its second value: a region that arrives holding its words is not
   * announced, and the first fill is not news - every later one is.
   */
  const counter = (el, matched, total, noun) => {
    dom.text(el, total === 0 ? '' : `${fmt.n(matched)} of ${fmt.n(total)}${noun ? ` ${noun}` : ''} match.`);
    el.classList.toggle('whole', total > 0 && matched === total);

    if (el.textContent && el.getAttribute('aria-live') === null) {
      el.setAttribute('aria-live', 'polite');
    }
  };

  const lists = new Map();

  /** The list drawn from its current state: chips, the page's rows, empty result, counter, pages. */
  const drawList = (list) => {
    const { id } = list;
    const state = Dash.state.lists[id];
    const picked = select(list.rows, list, state);
    const part = (name) => $(`${id}-${name}`);

    if (picked.total === 0) {
      dom.swap(part('tools'), '');
      dom.swap(part('rows'), '');
      dom.swap(part('none'), nothing(list.empty.fact, list.empty.hint));
      counter(part('count'), 0, 0, '');
      dom.swap(part('pages'), '');
      return picked;
    }

    const grouping = list.groupBy
      ? `<div class="filters" role="group" aria-label="Group" data-groupby><span class="k" aria-hidden="true">Group</span>`
        + `<button type="button" aria-pressed="${state.group === 'none'}" data-value="none" data-focus-key="group:none">none</button>`
        + `<button type="button" aria-pressed="${state.group === 'by'}" data-value="by" data-focus-key="group:by">`
        + `by ${esc(list.groupBy.label)}</button></div>`
      : '';

    const item = (row) => `<li data-focus-key="${esc(`${id}:${list.key(row)}`)}">${list.render(row)}</li>`;
    const { from, to } = pages(part('pages'), state, picked.rows.length, () => drawList(lists.get(id)));
    const visible = picked.rows.slice(from, to);
    let rows;

    // Grouped, a page cuts the rows as they run, and a group it takes up again says its head again.
    if (picked.groups) {
      const runs = [];

      for (const row of visible) {
        const group = list.groupBy.of(row);

        if (runs.at(-1)?.group !== group) runs.push({ group, rows: [] });

        runs.at(-1).rows.push(row);
      }

      rows = runs.map((run, k) => `<li class="group"><p class="group-head" id="${esc(`${id}-g${k}`)}">`
        + `${esc(list.groupBy.head(run.group, picked.groups.get(run.group)))}</p>`
        + `<ul aria-labelledby="${esc(`${id}-g${k}`)}">${run.rows.map(item).join('')}</ul></li>`).join('');
    } else {
      rows = visible.map(item).join('');
    }

    dom.swap(part('tools'), filters(list.facets, picked.counts, state) + grouping);
    dom.swap(part('rows'), rows);
    dom.swap(part('none'), picked.rows.length === 0 ? nothing(list.none ?? 'Nothing matches these filters.') : '');
    counter(part('count'), picked.rows.length, picked.total, list.noun[picked.total === 1 ? 0 : 1]);

    return picked;
  };

  /**
   * A list with its chips, drawn into its own panel
   *
   * @param {Element} host - An empty element with the list's id; its parts are written once
   * @param {{id: string, noun: [string, string], rows: Array<Object>, key: function(Object): string,
   *   facets: Array<{key: string, label: string, values: Array<{value: string, label: string}>,
   *   of: function(Object): string}>, groupBy?: {label: string, of: function(Object): string,
   *   head: function(string, number): string}, render: function(Object): string,
   *   empty: {fact: string, hint?: string}, none?: string}} list
   *   render(row) is the content of the row's <li>. The chips, the group-by and the page live
   *   in Dash.state.lists[id], so a refresh keeps them; a chip or a group-by pressed goes back
   *   to the first page.
   */
  const filteredList = (host, list) => {
    const { id } = list;

    Dash.state.lists[id] ??= { facets: {}, group: 'none', page: 0 };

    if (!lists.has(id)) {
      host.innerHTML = `<div class="list-tools" id="${esc(id)}-tools"></div><ul class="rank" id="${esc(id)}-rows"></ul>`
        + `<div id="${esc(id)}-none"></div><p class="table-count" id="${esc(id)}-count"></p><div id="${esc(id)}-pages"></div>`;

      host.addEventListener('click', (event) => {
        const button = event.target?.closest?.('button');
        const current = lists.get(id);
        const state = Dash.state.lists[id];

        if (!button) return;

        const facet = button.closest('[data-facet]');

        if (facet) {
          state.facets[facet.dataset.facet] = button.dataset.value;
          state.page = 0;
          drawList(current);
          return;
        }

        if (button.closest('[data-groupby]')) {
          state.group = button.dataset.value;
          state.page = 0;
          drawList(current);
        }
      });
    }

    lists.set(id, list);

    return drawList(list);
  };

  /* ---- the tabs ----------------------------------------------------------- */

  /**
   * The tab a key press moves to, or null for a key the tab bar does not handle
   *
   * Arrows wrap, Home and End jump: the keys a tablist is expected to answer, and a pure
   * function so the rule can be read and tested without a keyboard.
   * @param {Array<string>} keys - The tabs, in their order
   * @param {string} current - The selected one
   * @param {string} key - KeyboardEvent.key
   * @returns {?string}
   */
  const nextTab = (keys, current, key) => {
    const at = keys.indexOf(current);

    switch (key) {
      case 'ArrowRight': return keys[(at + 1) % keys.length];
      case 'ArrowLeft': return keys[(at - 1 + keys.length) % keys.length];
      case 'Home': return keys[0];
      case 'End': return keys.at(-1);
      default: return null;
    }
  };

  const tabs = new Map();

  globalThis.Dash = {
    // As the document was served; main.js hands each fresh one to the tabs that want it.
    snapshot,
    now,
    setClock,
    // Set by Dash.signOut() on a 401: every loader stops asking once the session is gone.
    signedOut: false,
    tabs,
    tab: (key, hooks) => { tabs.set(key, hooks); },
    nextTab,
    esc,
    fmt,
    VOCAB,
    cls,
    stats,
    dom,
    data,
    state: { tab: null, lists: {}, sort: {} },
    token,
    reduceMotion,
    marks,
    chart: { months },
    list: { select },
    ui: { nothing, fragments, name, tiles, stackedBar, lineChart, dotChart, filters, counter, pages, filteredList },
    $,
  };
})();
