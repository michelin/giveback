/**
 * The page itself: which tab is showing, and the two loops that keep it current
 *
 * Loaded last, because it drives the tabs the other scripts registered. The tab bar is the
 * server's: which tabs exist, their order and the one the page opens on are all in the markup,
 * and this only moves the selection - it never rebuilds the bar, so focus stays where the reader
 * left it.
 *
 * Only the tab showing is kept current. Operations follows the snapshot, read every five seconds;
 * the others follow their own source through Dash.data, which asks again only once the report's
 * window is over - so a reader never polls /dashboard/data at all.
 *
 * Adds Dash.refresh(), for a tab that has just written something and wants to show it at once,
 * and Dash.signOut(), for whatever read is the first to be answered 401.
 */
(() => {
  'use strict';

  const REFRESH_MS = 5000;
  // Above this past its own cadence, the heartbeat says the page is showing the past rather than
  // the present.
  const STALE_MS = 16000;

  const { $, fmt } = Dash;
  const { reportTtlMs } = Dash.snapshot.limits;

  // What each tab other than Operations is drawn from, the first read being the one the banner and
  // the badge speak for. Overall waits on the reader's own rows too, for their marks.
  const SOURCES = {
    mine: { reads: ['mine'], what: 'your contributions' },
    collective: { reads: ['report', 'mine'], what: 'the contribution report' },
  };

  /** The read the banner and the badge speak for on a tab, or undefined on Operations. */
  const sourceOf = (key) => SOURCES[key] && Dash.data.peek(SOURCES[key].reads[0]);

  let snapshot = Dash.snapshot;
  let lastOkAt = Date.now();

  // Whatever the last snapshot fetch has to say about itself. Owned by refresh(), read by notice().
  let transportNotice = '';

  const buttons = [...document.querySelectorAll('[role="tab"]')];
  const keys = buttons.map((button) => button.dataset.view);
  const landing = buttons.find((button) => button.getAttribute('aria-selected') === 'true').dataset.view;
  let active = landing;
  const loops = [];

  /**
   * The one banner, with exactly one owner
   *
   * Decided here, every time, from what is wrong right now: the session, then the read behind
   * the tab showing - the snapshot's for Operations, with its degraded parts, and the tab's
   * own source for the others, which the snapshot says nothing about. refresh() clearing the
   * banner directly on success wiped the degradation message five seconds after it first
   * appeared, leaving the empty panels unexplained.
   */
  const notice = () => {
    const degraded = snapshot.degraded ?? [];
    const source = sourceOf(active);
    let message = source ? '' : transportNotice;

    if (!message && source?.status === 'error') {
      message = `Could not read ${SOURCES[active].what}${source.data ? ' — showing the last successful read' : ''}.`;
    }

    if (!message && !source && degraded.length > 0) {
      message = `Showing the page without ${degraded.join(' and ')}: ${degraded.length === 1 ? 'its table is' : 'their tables are'} missing.`;
    }

    const el = $('notice');

    // A live region, decided every few seconds: the same words written again would be announced
    // again, and swap() writes nothing when nothing changed.
    Dash.dom.swap(el, Dash.signedOut ? 'Session expired. <a href="/dashboard/login">sign in</a>' : Dash.esc(message));
    el.classList.toggle('show', Boolean(message) || Dash.signedOut);
  };

  /**
   * How old what the tab showing was drawn from is: its read, not the page's. Signed out,
   * nothing is read any more, and the badge is the first thing to say so.
   */
  const heartbeat = () => {
    if (Dash.signedOut) {
      $('heartbeat').classList.add('stale');
      Dash.dom.text($('heartbeat-text'), 'signed out');
      return;
    }

    const source = sourceOf(active);
    const readAt = source ? source.readAt : lastOkAt;
    const cadence = source ? reportTtlMs : REFRESH_MS;
    const age = Date.now() - readAt;
    const stale = source?.status === 'error' || (readAt > 0 && age > cadence + STALE_MS);

    $('heartbeat').classList.toggle('stale', stale);
    Dash.dom.text($('heartbeat-text'), readAt === 0
      ? (stale ? 'not read' : 'reading')
      : stale ? `${fmt.span(age)} stale` : 'live');
  };

  /**
   * Busy while any read a tab waits on has never answered: its panels are waiting, not empty.
   * Signed out, nothing is waited for any more - a first read answered 401 leaves it loading.
   */
  const busy = (key) => {
    const waiting = SOURCES[key].reads.some((name) => Dash.data.peek(name).status === 'loading');

    $(`view-${key}`).setAttribute('aria-busy', String(!Dash.signedOut && waiting));
  };

  /**
   * The nameplate's one row, from the reader's own rows: what they have merged, where that
   * puts them since day one, and what is still open. The same read the Me tab is drawn from,
   * seeded with the page, so it costs the snapshot nothing; unread, the row waits empty. No
   * zero in the display face: a 0 set like a measurement reads as one.
   */
  const nameplate = () => {
    const { data } = Dash.data.peek('mine');
    const { merged, open } = data?.summary ?? {};
    const ever = data?.rank?.ever;
    const figures = data ? [
      merged > 0 ? `<b class="landed">${fmt.n(merged)}</b> merged` : 'nothing landed yet',
      // Written as a sentence: it says who the denominator counts, which a bare "2nd of 17" leaves open.
      ever && `<b>${fmt.place(ever.position)}</b> of ${fmt.n(ever.of)} who have ever landed one`,
      open > 0 && `<b>${fmt.n(open)}</b> open`,
    ].filter(Boolean) : [];

    Dash.dom.swap($('you-figs'), figures.map((figure) => `<span>${figure}</span>`).join(''));
  };

  /** A tab drawn from its own reads: each asked again if its window is over, then drawn. */
  const follow = async (key) => {
    await Promise.all(SOURCES[key].reads.map((name) => Dash.data.load(name)));

    nameplate();

    // Outside any try, after the read settled: a throw here is a bug in the tab, and it has to
    // reach the console rather than be taken for a failed read.
    if (key === active) {
      busy(key);
      notice();
      heartbeat();
      Dash.tabs.get(key).render();
    }
  };

  /**
   * Show one tab and hide the others
   *
   * The address says which, so a reload or a shared link opens the same tab. replaceState
   * rather than a hash assignment: switching tabs is not a navigation, and the back button
   * should leave the page rather than walk back through every tab visited.
   */
  const select = (key) => {
    const switched = key !== active;

    active = key;
    Dash.state.tab = key;

    for (const button of buttons) {
      const selected = button.dataset.view === key;

      button.setAttribute('aria-selected', String(selected));
      // Roving: the selected tab is the one stop in the tab order, the arrows do the rest.
      button.setAttribute('tabindex', selected ? '0' : '-1');
      $(`view-${button.dataset.view}`).hidden = !selected;
    }

    history.replaceState(null, '', `#${key}`);
    Dash.dom.text($('f-refresh'), SOURCES[key] ? `read every ${fmt.span(reportTtlMs)}` : `refreshed every ${fmt.span(REFRESH_MS)}`);
    Dash.tabs.get(key).activate();
    notice();
    heartbeat();

    if (SOURCES[key]) {
      busy(key);
      follow(key);
    } else if (switched) {
      // The snapshot was not read while another tab showed: read it now rather than show the
      // moment Operations was left, and call it stale, until the next turn of the loop.
      refresh();
    }
  };

  /**
   * Fold a fresh snapshot in
   *
   * Every tab that wants the snapshot gets it; only the one showing redraws.
   */
  const apply = (fresh) => {
    snapshot = fresh;
    Dash.setClock(fresh.now);

    for (const hooks of Dash.tabs.values()) {
      hooks.snapshot?.(fresh);
    }

    notice();
    Dash.tabs.get(active).render();
  };

  const refresh = async () => {
    if (Dash.signedOut) return;

    try {
      const response = await fetch('/dashboard/data', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (response.status === 401) {
        Dash.signOut();
        return;
      }

      if (!response.ok) {
        transportNotice = 'The bot is up but could not read its database — the figures below are frozen at their last good read.';
        notice();
        return;
      }

      transportNotice = '';
      // apply() recomputes the banner from the fresh payload.
      apply(await response.json());
      lastOkAt = Date.now();
      // At once, not at the next second's tick: back on this tab, the badge was drawn from the
      // read before it was left.
      heartbeat();
    } catch {
      // Network, not application: leave the last good snapshot on screen and let the
      // heartbeat say how old it is. Blanking the page would destroy the only evidence.
      transportNotice = 'Lost contact with the bot — showing the last successful read.';
      notice();
    }
  };

  Dash.refresh = refresh;

  Dash.signOut = () => {
    Dash.signedOut = true;

    for (const loop of loops) {
      clearInterval(loop);
    }

    notice();
    heartbeat();
  };

  // Delegated on the bar, which is never rebuilt: data-view is the whole contract with a tab.
  $('tabs').addEventListener('click', (event) => {
    const view = event.target?.dataset?.view;

    if (view) {
      select(view);
    }
  });

  // Selection follows focus, as a tablist is expected to: the arrows, Home and End.
  $('tabs').addEventListener('keydown', (event) => {
    // A modified arrow is the browser's or the system's - Alt+Left is Back - not the bar's.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const next = Dash.nextTab(keys, active, event.key);

    if (next) {
      event.preventDefault();
      select(next);
      $(`tab-${next}`).focus();
    }
  });

  Dash.dom.swap($('app-line'), Dash.ui.fragments([`${snapshot.app.name} v${snapshot.app.version}`, snapshot.app.environment].map(Dash.esc)));
  Dash.dom.swap($('you-face'), Dash.marks.face(snapshot.viewer, 46));
  nameplate();

  // A tab named in the address wins, if this reader has it; anything else - a stale link, a
  // reader's #ops - falls back to where the server opened the page, and the address is corrected.
  const wanted = location.hash.slice(1);

  select(keys.includes(wanted) ? wanted : landing);

  // An address edited on the open page follows the same rule as on load: a tab this reader has, or
  // the one the server opened on. replaceState in select() fires no hashchange, so this cannot loop.
  addEventListener('hashchange', () => {
    const key = location.hash.slice(1);

    select(keys.includes(key) ? key : landing);
  });

  loops.push(setInterval(() => (SOURCES[active] ? follow(active) : refresh()), REFRESH_MS));
  loops.push(setInterval(() => {
    heartbeat();
    Dash.tabs.get(active).tick?.();
  }, 1000));
})();
