import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT, read, filesUnder, withoutComments } from "../test-support/sources.js";
import { runPage, runDocument, renderPage, report, idsIn, markup, css, script, rulesOf } from "../test-support/dashboardPage.js";
import { snapshotOf } from "../test-support/fixtures/snapshot.js";
import { operatorSnapshotOf } from "../test-support/fixtures/ops.js";
import { mineOf } from "../test-support/fixtures/mine.js";
import { reportOf } from "../test-support/fixtures/collective.js";

/** An EJS template without its comments, which are about the markup rather than in it. */
const withoutEjsComments = (source) => source.replace(/<%#[\s\S]*?%>/g, '');

describe("both pages are identifiable in a tab", () => {
  const enroll = readFileSync(`${ROOT}views/enroll.ejs`, 'utf8');
  const icon = readFileSync(`${ROOT}public/favicon.svg`, 'utf8');

  test("each declares the icon, and the icon is there to declare", () => {
    for (const [name, view] of [['dashboard', markup()], ['enroll', enroll]]) {
      assert.match(view, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/,
        `views/${name}.ejs does not point at the icon`);
    }
    assert.match(icon, /^<svg [^>]*viewBox="0 0 32 32"/, 'a favicon without a viewBox does not scale');
  });

  test("the icon is well-formed XML, which a double hyphen in a comment would break", () => {
    // The first draft of this file explained itself by naming the CSS tokens it copies -
    // --panel, --sync - and two hyphens in a row END an XML comment. The file parsed as
    // nothing, every browser drew a broken image, and no test would have said so.
    for (const body of icon.match(/<!--[\s\S]*?-->/g) ?? []) {
      assert.doesNotMatch(body.slice(4, -3), /--/,
        'an XML comment cannot contain "--"; the icon will not render at all');
    }
  });

  test("and the heading on the page says the same thing as the tab", () => {
    // The rename moved the route and the <title> and left the <h1> saying "Bot status",
    // which is the one of the three a reader actually looks at. Nothing caught it: the tab
    // title had a test, the heading did not.
    const heading = markup().match(/<h1 class="title">\s*([^<\n]+)/)[1].trim();

    assert.equal(heading, 'Dashboard');
    assert.doesNotMatch(markup(), /Bot status/i, 'the page is not called that any more');
  });

  test("the distinguishing word comes first, because a tab truncates from the right", () => {
    // "giveback - ..." would collapse to "giveback - Da…" on a narrow tab, the same string on
    // both pages, telling a reader with several tabs open nothing.
    const titleOf = (view) => view.match(/<title>(.*?)<\/title>/)[1];
    const dashboard = titleOf(markup());
    const enrollment = titleOf(enroll);

    assert.notEqual(dashboard, enrollment);
    for (const title of [dashboard, enrollment]) {
      assert.doesNotMatch(title, /^giveback/, `"${title}" leads with the name both pages share`);
      assert.match(title, /giveback$/, `"${title}" should still say which app it is`);
    }
  });
});

describe("the tabs", () => {
  /** The tab buttons and panels of a rendered document, by key, as the server wrote them */
  const tabsIn = (html) => {
    const rendered = idsIn(html);
    const keys = [...rendered.keys()].filter((id) => id.startsWith('tab-')).map((id) => id.slice(4));

    return keys.map((key) => ({ key, button: rendered.get(`tab-${key}`), panel: rendered.get(`view-${key}`) }));
  };

  test("each tier is rendered its own tabs, in their order", async () => {
    const reader = await renderPage(snapshotOf());
    const operator = await renderPage(operatorSnapshotOf());

    assert.deepEqual(tabsIn(reader).map((tab) => tab.key), ['mine', 'collective']);
    assert.deepEqual(tabsIn(operator).map((tab) => tab.key), ['mine', 'collective', 'ops']);
    assert.match(operator, />Me<\/button>[\s\S]*>Overall<\/button>[\s\S]*>Operations<\/button>/);
  });

  test("the page opens on one tab, and every attribute that says which agrees", async () => {
    // Rendered by the server, so the page is right before a line of script has run: one panel
    // shown, its tab selected and the one stop in the tab order, each panel labelled by its tab.
    for (const [landing, snapshot, mine] of [
      ['ops', operatorSnapshotOf(), null],
      ['mine', snapshotOf(), mineOf()],
      ['collective', snapshotOf(), null],
    ]) {
      const tabs = tabsIn(await renderPage(snapshot, { mine, report: reportOf() }));

      assert.deepEqual(tabs.filter((tab) => !('hidden' in tab.panel)).map((tab) => tab.key), [landing],
        `opening on ${landing}, exactly that panel is shown`);

      for (const { key, button, panel } of tabs) {
        const selected = key === landing;

        assert.equal(button.role, 'tab');
        assert.equal(button['aria-selected'], String(selected), `${key} on a page opened on ${landing}`);
        assert.equal(button.tabindex, selected ? '0' : '-1', `${key} on a page opened on ${landing}`);
        assert.equal(button['aria-controls'], `view-${key}`);
        assert.equal(panel.role, 'tabpanel');
        assert.equal(panel['aria-labelledby'], `tab-${key}`);
      }
    }
  });

  test("a reader's document holds nothing of the Operations tab", async () => {
    // Not hidden: absent. Its routes answer 404 to a reader, and the page must not tell them
    // otherwise - not in the markup, not in the snapshot, not in what it links.
    for (const mine of [mineOf(), null]) {
      const html = await renderPage(snapshotOf(), { mine, report: reportOf() });

      for (const absent of [
        'Operations', 'aria-controls="view-ops"', 'id="view-ops"', 'assets/ops.', 'DASHBOARD_ALLOWED_LOGINS',
        '/dashboard/manual', '/dashboard/users/',
      ]) {
        assert.ok(!html.includes(absent), `a reader's page carries ${absent}`);
      }

      const embedded = JSON.parse(/id="snapshot">([\s\S]*?)<\/script>/.exec(html)[1]);

      assert.equal('ops' in embedded, false, "the operational snapshot reached a reader's page");
    }
  });

  test("a tab named in the address wins, if the reader has it", async () => {
    const { elements, errors, replaced } = await runPage(snapshotOf(), undefined, {
      mine: mineOf(), report: reportOf(), hash: '#collective', drainIntervals: false,
    });

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('view-collective').hidden, false);
    assert.equal(elements.get('view-mine').hidden, true);
    assert.equal(elements.get('tab-collective').getAttribute('aria-selected'), 'true');
    assert.deepEqual(replaced, ['#collective']);
  });

  test("anything else falls back to where the server opened, and the address is corrected", async () => {
    // A stale link, a typo, or a reader's #ops: the same answer as no hash at all.
    for (const hash of ['', '#nonsense', '#ops']) {
      const { elements, errors, replaced, document } = await runPage(snapshotOf(), undefined, {
        mine: mineOf(), hash, drainIntervals: false,
      });

      assert.equal(errors.length, 0, `the page threw on ${hash || 'no hash'}:\n${report(errors)}`);
      assert.equal(elements.get('view-mine').hidden, false, `${hash || 'no hash'} did not land on Me`);
      assert.deepEqual(replaced, ['#mine']);
      assert.equal(document.getElementById('view-ops'), null);
    }
  });

  test("the arrows move along the tabs and wrap, and Home and End jump", async () => {
    const { sandbox } = await runPage(operatorSnapshotOf(), undefined, { drainIntervals: false });
    const { nextTab } = sandbox.Dash;
    const keys = ['mine', 'collective', 'ops'];

    assert.equal(nextTab(keys, 'mine', 'ArrowRight'), 'collective');
    assert.equal(nextTab(keys, 'ops', 'ArrowRight'), 'mine');
    assert.equal(nextTab(keys, 'mine', 'ArrowLeft'), 'ops');
    assert.equal(nextTab(keys, 'collective', 'Home'), 'mine');
    assert.equal(nextTab(keys, 'mine', 'End'), 'ops');

    for (const key of ['Enter', ' ', 'ArrowDown', 'Tab']) {
      assert.equal(nextTab(keys, 'mine', key), null, `${JSON.stringify(key)} is not the tab bar's to handle`);
    }
  });

  test("and the selection follows the key, taking the focus with it", async () => {
    const { elements, document } = await runPage(operatorSnapshotOf(), undefined, { report: reportOf(), mine: mineOf() });
    const press = (key, modifiers = {}) => {
      let prevented = false;

      elements.get('tabs').handlers.keydown({ key, ...modifiers, preventDefault() { prevented = true; } });

      return prevented;
    };

    assert.equal(press('Home'), true);
    assert.equal(document.activeElement.id, 'tab-mine');
    assert.equal(elements.get('tab-mine').getAttribute('aria-selected'), 'true');
    assert.equal(elements.get('tab-mine').getAttribute('tabindex'), '0');
    assert.equal(elements.get('tab-ops').getAttribute('tabindex'), '-1');
    assert.equal(elements.get('view-ops').hidden, true);
    assert.equal(elements.get('view-mine').hidden, false);

    assert.equal(press('ArrowLeft'), true);
    assert.equal(document.activeElement.id, 'tab-ops', 'the left arrow wraps from the first tab to the last');

    // Anything else is the browser's: Enter on a tab, Tab out of the bar, Alt+Left for Back.
    assert.equal(press('Tab'), false);
    assert.equal(document.activeElement.id, 'tab-ops');

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
      assert.equal(press('ArrowLeft', { [modifier]: true }), false, `${modifier} with an arrow is not the bar's`);
      assert.equal(elements.get('tab-ops').getAttribute('aria-selected'), 'true');
    }
  });

  test("an address edited on the open page follows the same rule", async () => {
    const { elements, errors, listeners, sandbox: { location }, replaced } = await runPage(snapshotOf(), undefined, {
      mine: mineOf(), report: reportOf(), drainIntervals: false,
    });

    location.hash = '#collective';
    listeners.hashchange();

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(elements.get('view-collective').hidden, false);
    assert.equal(elements.get('view-mine').hidden, true);

    // A reader's #ops: back to where the server opened the page, and the address is corrected.
    location.hash = '#ops';
    listeners.hashchange();

    assert.equal(elements.get('view-mine').hidden, false);
    assert.equal(elements.get('view-collective').hidden, true);
    assert.deepEqual(replaced, ['#mine', '#collective', '#mine']);
  });

  test("a tab keeps its focus and its selection across refreshes", async () => {
    const { elements, document, intervals } = await runPage(operatorSnapshotOf(), undefined, { report: reportOf() });

    elements.get('tabs').handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });

    const refresh = intervals.find((interval) => interval.ms === 5000).fn;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await refresh();
    }

    assert.equal(document.activeElement.id, 'tab-collective');
    assert.equal(elements.get('tab-collective').getAttribute('aria-selected'), 'true');
    assert.equal(elements.get('view-collective').hidden, false);
    // The bar is the server's, and the script never writes it: a rebuilt bar is a lost focus.
    assert.equal(elements.get('tabs').innerHTML, '');
  });
});

describe("a reader without the operator tier", () => {
  test("is sent a page that runs, with or without contributions of their own", async () => {
    for (const [who, mine, landing] of [['with rows', mineOf(), 'mine'], ['without', null, 'collective']]) {
      const { html, elements, errors, fetched } = await runPage(snapshotOf(), undefined, { mine, report: reportOf() });

      assert.equal(errors.length, 0, `the page of a reader ${who} threw:\n${report(errors)}`);
      assert.equal(elements.get(`view-${landing}`).hidden, false, `a reader ${who} opens on ${landing}`);

      // Nothing of the machine: no job, no queue, no account, no manual entry - and no request
      // for any of it.
      for (const id of ['o-jobs', 'o-track', 'o-next', 'o-users', 'm-list']) {
        assert.doesNotMatch(html, new RegExp(`id="${id}"`), `a reader ${who} is rendered #${id}`);
      }

      assert.deepEqual(fetched.filter((call) => /^\/dashboard\/(manual|users)/.test(call.url)), []);
    }
  });
});

describe("the dashboard page", () => {
  test("draws every link in every tab where a reader can see it", () => {
    // The rule that stops a link taking the browser default #0000EE named one view, and the
    // manual table was in the other - it shipped for an hour unreadable. Every tab that
    // prints a link has to be on it, which is why this counts them rather than naming two.
    const style = css();
    const page = markup();
    const linking = [...new Set([...page.matchAll(/id="(view-[a-z-]+)"/g)].map((m) => m[1]))];

    for (const id of linking) {
      assert.match(style, new RegExp(`#${id} a[,\\s{]`), `${id} prints links and is not in the rule`);
      assert.match(style, new RegExp(`#${id} a:hover`), `${id} has no hover colour of its own`);
    }

    assert.ok(linking.length >= 3, `only ${linking.length} link-printing tabs found`);
  });

  test("producing a document that identifies itself and stays out of search engines", async () => {
    const { html } = await runPage(operatorSnapshotOf());

    // Pinned loosely on purpose: the exact wording is asserted once, above, where the rule
    // about it lives. Here the point is only that the rendered document carries one.
    assert.match(html, /<title>Dashboard [^<]*<\/title>/);
    assert.match(html, /rel="icon" href="\/favicon\.svg"/);
    assert.match(html, /name="robots" content="noindex/);
    assert.match(html, /<canvas class="track" id="o-track"/);

    // The embedded payload has to survive the round trip, or the page opens with no data.
    const embedded = /id="snapshot">([\s\S]*?)<\/script>/.exec(html);

    assert.ok(embedded, 'the snapshot did not make it into the document');
    assert.equal(JSON.parse(embedded[1]).viewer, 'the-operator');
  });

  test("without letting a value close the script element early", async () => {
    // A viewer login cannot contain markup, but the page must not depend on that: the same
    // escape protects every string in the payload, including a run's error message.
    const { html } = await runPage(snapshotOf({ viewer: '</script><img src=x onerror=alert(1)>' }));
    const embedded = /id="snapshot">([\s\S]*?)<\/script>/.exec(html);

    assert.doesNotMatch(embedded[1], /<\/script>/i);
    assert.doesNotMatch(embedded[1], /<img/i);
    assert.equal(JSON.parse(embedded[1]).viewer, '</script><img src=x onerror=alert(1)>');
  });

  test("with one banner a screen reader hears, kept in the tree while it has nothing to say", async () => {
    assert.equal(idsIn(await renderPage(snapshotOf())).get('notice').role, 'status');
    // display:none takes a live region out of the accessibility tree, and one that enters it
    // already holding its text is not announced - a lost session would go unsaid.
    assert.doesNotMatch(css(), /\.notice[^{]*\{[^}]*display:\s*none/);
  });

  test("which speaks for the tab showing, not for the one left", async () => {
    // Operations loses the bot's database; Me reads its own route, which answers. What the
    // snapshot says about itself is not true of Me, and must not sit over it.
    const run = await runDocument(await renderPage(operatorSnapshotOf()), null, undefined, { mine: mineOf() });
    const notice = run.elements.get('notice');
    const reads = () => run.fetched.filter((request) => request.url === '/dashboard/data').length;
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    assert.equal(run.errors.length, 0, `the page threw:\n${report(run.errors)}`);
    assert.match(notice.innerHTML, /could not read its database/);

    run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'mine' } } });
    // Waiting on its first read: busy, not empty.
    assert.equal(run.elements.get('view-mine').getAttribute('aria-busy'), 'true');
    await settle();

    assert.equal(notice.innerHTML, '');
    assert.equal(notice.classList.contains('show'), false);
    assert.equal(run.elements.get('view-mine').getAttribute('aria-busy'), 'false');

    // And back on Operations, the snapshot is read again at once, rather than shown as it was
    // when the tab was left.
    const before = reads();

    run.elements.get('tabs').handlers.click({ target: { dataset: { view: 'ops' } } });
    await settle();

    assert.equal(reads(), before + 1);
    assert.match(notice.innerHTML, /could not read its database/);
  });

  test("and whose badge is current the moment a snapshot is read", async () => {
    // Back on Operations the badge is drawn from the read before the tab was left: left to the
    // next second's tick, it would call a page stale that has just been read.
    const { elements, sandbox } = await runPage(operatorSnapshotOf(), undefined, { drainIntervals: false });
    const badge = elements.get('heartbeat-text');

    badge.textContent = '3 min stale';
    await sandbox.Dash.refresh();

    assert.equal(badge.textContent, 'live');
  });
});

describe("every list resets the indent the browser adds", () => {
  // .job-failures shipped without the reset every other list on this page has, so its rows sat
  // 40px inside their card, aligned with nothing - and the marker that padding makes room for
  // was not even drawn, because `display: flex` on the row blockifies it away. Invisible cause,
  // visible symptom.
  // Comments stripped so a rule quoted inside one cannot satisfy the search below.
  const style = css().replace(/\/\*[\s\S]*?\*\//g, '');
  // Markup AND script: some of these lists are in the templates and some are built by the
  // scripts, the filtered list's among them. Scanning only the templates would find half of them
  // and let the other half regress unwatched. A list with several classes is reset by its first.
  const drawn = markup() + script();
  const classes = [...new Set([...drawn.matchAll(/<(?:ul|ol)[^>]*class="([a-z-]+)[ "]/g)].map((m) => m[1]))];

  test("on every list the page draws", () => {
    // Every tab draws its lists as the shared one, so that one has to be found: a floor on how
    // many classes turn up would count the lists the tabs have stopped drawing.
    assert.ok(classes.includes('rank'), `found ${classes.join(', ') || 'no list'} - the pattern stopped matching`);

    const offenders = classes.filter((name) => {
      const rule = new RegExp(`(?:^|\\n)\\s*(?:ul|ol)?\\.${name}\\s*\\{([^}]*)\\}`).exec(style)?.[1] ?? '';

      return !/list-style:\s*none/.test(rule) || !/padding:/.test(rule);
    });

    assert.deepEqual(offenders, [], 'these need list-style: none and their own padding');
  });
});

describe("the tab views carry the spacing the shell used to give the panels", () => {
  // The one block that genuinely spans all three sources: the rules are in the stylesheet, the
  // ids the script hides are in the script, and the elements carrying them are in the markup.
  const style = css();

  test("and the hidden one still hides", () => {
    assert.match(style, /\[role="tabpanel"\] \{[^}]*display: flex/, 'the views must re-create the gap the shell lost');
  });

  test("a two-column grid resolves to two columns", () => {
    // auto-fit with a 320px minimum resolved to THREE tracks inside the 1,180px shell — measured
    // in Chrome on every .grid-2 element — so each pair of panels sat in the left two thirds
    // with an empty track beside it.
    assert.match(style, /\.grid-2 \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
      'two explicit tracks; auto-fit counts tracks from the container, not from the children');
    assert.match(style, /@media \(max-width: 900px\) \{[^}]*\.grid-2 \{ grid-template-columns: minmax\(0, 1fr\); \}/,
      'and one track once two panels no longer fit side by side, which auto-fit used to give for free - no wider than the page');
  });

  test("nothing the script hides can be un-hidden by a layout class", () => {
    // The bug this replaces reached a browser: a pair of panels carries .grid-2, `display: grid`
    // is an AUTHOR rule and therefore beats the user agent's [hidden] { display: none } whatever
    // the specificity, so `hidden = true` did nothing and the two panels sat there empty for
    // every anonymous reader. The panel-level test passed throughout: the property was set, the CSS
    // was what failed.
    assert.match(style, /\[hidden\] \{ display: none !important; \}/,
      'one global rule, or the next class to set display re-opens the hole');

    // The places the page itself sets it, as a tripwire: another is a new element to list below.
    // core.js's second is the chart tooltip it writes itself, a class the rule above covers.
    // Each tab's script is counted in that tab's own test.
    for (const [file, count] of [['core.js', 2], ['main.js', 1]]) {
      assert.equal((read(`views/dashboard/${file}`).match(/\.hidden = /g) ?? []).length, count,
        `${file} hides something new - add its id to the list below`);
    }

    // What they reach: every tab's panel, and the box a chart is drawn in, which core.js writes
    // itself. Each has to be immune to the rule above.
    const view = markup();

    for (const id of ['view-mine', 'view-collective', 'view-ops']) {
      assert.match(view, new RegExp(`id="${id}"`), `${id} is hidden by the script but is not in the markup`);
    }

    assert.match(read('views/dashboard/core.js'), /\$\(`\$\{id\}-plot`\)\.hidden = /, 'core.js hides another element than the plot box');
    assert.deepEqual(rulesOf(style).filter((rule) => rule.selectors.some((selector) => /\.plot\b/.test(selector))
      && rule.declarations.some(({ property }) => property === 'display')).map((rule) => rule.selector), []);
  });
});

describe("a panel says what it holds in one line, under its title", () => {
  // 558 words of explanation once sat open on this page. What a figure means is the footnote's
  // to say: a panel keeps one line - its base, its unit or its window - and no sentence of its
  // own about why.
  // The footnote's heading is followed by its list: it is no panel, and has no line to carry.
  const view = markup().replace(/<section class="footnote"[\s\S]*?<\/section>/, '');
  const panels = [...withoutEjsComments(view).matchAll(/<section class="panel"[^>]*>([\s\S]*?)<\/section>/g)]
    .map((match) => match[1]);

  const summaries = [...view.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean));

  test("every heading is followed by exactly one subtitle, and by no other sentence", () => {
    // The pairing, not the count: a panel that loses its line loses the only thing telling a
    // reader what they are looking at.
    const headings = [...view.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>\s*(<[^>]*>)/g)].map((m) => m[1]);

    assert.ok(headings.length >= 16, `found ${headings.length} panel headings`);
    assert.deepEqual(headings.filter((tag) => !tag.startsWith('<p class="panel-sub"')), [], 'a heading is followed by something else');
    assert.equal(panels.length, headings.length, 'a panel without a heading, or a heading outside a panel');

    for (const panel of panels) {
      assert.equal((panel.match(/class="panel-sub"/g) ?? []).length, 1, `a panel has more than one subtitle:\n${panel.slice(0, 200)}`);
      // Anything else a panel says is a script's to write, from the data: a paragraph the
      // template itself fills is an intro sentence.
      const prose = [...panel.matchAll(/<p\b(?![^>]*class="panel-sub")[^>]*>([^<]*[^<\s][^<]*)<\/p>/g)].map((m) => m[1].trim());

      assert.deepEqual(prose, [], 'a panel explains itself');
    }

    assert.doesNotMatch(view, /class="why"|class="callout"/, 'the explanations and the callouts stay gone');

    // A fold is a control, and its label says what opening it shows - in a line, not a paragraph.
    for (const words of summaries) {
      assert.ok(words.length <= 20, `a summary runs to ${  words.length  } words: "${  words.join(' ')  }"`);
    }
  });

  test("a fold starts closed", () => {
    // An <details open> is a paragraph again.
    assert.doesNotMatch(view, /<details[^>]*\sopen[\s>]/, 'a fold that starts open has not been folded');
  });

  test("and is reachable by keyboard and by finger, not only by hover", () => {
    // <details> gives the keyboard and the screen reader a fold for free, where a hover would be
    // invisible on a phone - but only if the summary is styled as the control it is. Every
    // <summary> on the page: a fold is a control wherever it is.
    const style = read('views/dashboard/core.css');

    assert.match(style, /\n\s*summary \{[^}]*min-height: 44px[^}]*cursor: pointer/, 'a finger needs 44px, and a pointer a hand');
    assert.match(style, /\n\s*summary:focus-visible,[^{]*\{[^}]*outline:/, 'a keyboard lands here and must show where it is');
  });

  test("the three sentences that were cut stay cut", () => {
    // Deleted because each said something the page already says: a caption for the callout
    // directly below it, a restatement of the clause named beside it, and a second copy of the
    // tier note that is made once on the accounts panel.
    assert.doesNotMatch(view, /reads its own shape out loud/);
    assert.doesNotMatch(view, /the ordering the claim queries use/);
    // Named on the Operations tab at most, which only an operator is sent - never to a reader,
    // who is told nothing of a tier they are not in.
    assert.ok((read('views/dashboard/ops.ejs').match(/DASHBOARD_ALLOWED_LOGINS/g) ?? []).length <= 1,
      'the tier is explained once, where an operator meets it first');
    assert.equal((view.replace(read('views/dashboard/ops.ejs'), '').match(/DASHBOARD_ALLOWED_LOGINS/g) ?? []).length, 0,
      'and nowhere a reader is sent');
  });
});

/*
 * The contract every tab is held to, file by file: the tokens, the scope of a tab's sheet, the
 * targets, the copy, the classes and the order a tab reads in.
 */

/** Which tab a view file belongs to, or null for the shell and the shared files. */
const tabOf = (file) => /views\/dashboard\/(ops|mine|collective)\.\w+$/.exec(file)?.[1] ?? null;

const STYLESHEETS = ['public/base.css', ...filesUnder('views/dashboard', '.css')];
const SHEETS = filesUnder('views/dashboard', '.css');
const SCRIPTS = filesUnder('views/dashboard', '.js');
const TEMPLATES = ['views/dashboard.ejs', ...filesUnder('views/dashboard', '.ejs')];

/** Every complex selector of a rule, one per comma. */
const selectorsOf = (rule) => rule.selectors;

describe("the page's stylesheets are built from the tokens", () => {
  // Spacing an even number of pixels, as production's 22px rhythm and 18px insets are, or a
  // hairline; one of the four radii, a circle or none; motion from the three durations. The named exceptions are the heartbeat's pulse and two job-card
  // animations, whose timing is the information.
  const TIMINGS = [/^beat 2\.4s\b/, /\bjob-sweep 1\.3s\b/, /\bjob-ran 900ms\b/];
  const LITERAL_COLOURS = /#[0-9a-f]{3,8}\b|rgba?\(/i;

  const offences = (file) => rulesOf(read(file)).flatMap((rule) => rule.declarations.flatMap(({ property, value }) => {
    const where = `${rule.selector} { ${property}: ${value} }`;
    const found = [];

    if (property === 'font-size' && !/^(var\(--f[sd]-[\w-]+\)|inherit)$/.test(value)) {
      found.push(`size ${where}`);
    }

    if (/^(margin|padding|gap|row-gap|column-gap|inset)\b/.test(property)) {
      for (const [, px] of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        if (!(Math.abs(Number(px)) <= 3 || Math.abs(Number(px)) % 2 === 0)) found.push(`spacing ${where}`);
      }
    }

    if (property === 'border-radius' && !value.split(/\s+/).every((part) => /^(var\(--(r-6|r-10|radius|pill)\)|50%|0)$/.test(part))) {
      found.push(`radius ${where}`);
    }

    if (/^(transition|animation)\b/.test(property) && /\b\d+(\.\d+)?m?s\b/.test(value)
      && !TIMINGS.some((allowed) => allowed.test(value))) {
      found.push(`motion ${where}`);
    }

    if (LITERAL_COLOURS.test(value) && !/button\.record/.test(rule.selector) && rule.selector !== '@keyframes beat') {
      found.push(`colour ${where}`);
    }

    return found;
  }));

  for (const file of SHEETS) {
    test(`in ${file}`, () => {
      assert.deepEqual(offences(file), [], 'these are values a token already names');
    });
  }
});

describe("the one loud colour is kept for what is relative to now", () => {
  // The NOW line and its label, a late tile, a claim on the track - its ring, in the key under it
  // too - and what its tooltip says is happening now, the job cards' tick, the overdue segment of
  // a chart, and the reader's login on the nameplate, the person every figure is measured
  // against. One exception, by design choice: a project's stars, which are not relative to now.
  // Nothing else - and never in the two sheets of the tabs that are about the past. The idle grey
  // is a colour for graphics: as text it fails contrast.
  const NOW = [/^\.tile\.late \.v$/, /^\.legend b\.q-ring$/, /(^|\s)\.job-tick\b/, /\bnow\b/i, /^\.you \.who$/, /^\.stars$/];

  test("on a chart, which paints it on the overdue segment alone", async () => {
    const run = await runPage(operatorSnapshotOf(), undefined, { mine: mineOf(), report: reportOf() });

    for (const view of ['mine', 'collective']) {
      run.elements.get('tabs').handlers.click({ target: { dataset: { view } } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const now = run.sandbox.Dash.token('now');
    const painted = run.charts.flatMap((chart) => chart.data.datasets.filter((dataset) =>
      [dataset.backgroundColor, dataset.borderColor].flat().includes(now)).map((dataset) => `${chart.canvas.id}: ${dataset.label}`));

    assert.ok(run.charts.length >= 10, `only ${run.charts.length} charts were drawn`);
    assert.deepEqual(painted, ['o-capacity-canvas: overdue 4']);
  });

  for (const file of SHEETS) {
    test(`in ${file}`, () => {
      const past = ['mine', 'collective'].includes(tabOf(file));
      const offenders = rulesOf(read(file)).flatMap((rule) => [
        ...rule.declarations.some(({ value }) => value.includes('var(--now)'))
          ? selectorsOf(rule).filter((selector) => past || !NOW.some((allowed) => allowed.test(selector.replace(/^:where\([^)]*\)\s*/, ''))))
          : [],
        ...rule.declarations.some(({ property, value }) => property === 'color' && value.includes('var(--idle)'))
          ? [`${rule.selector} (idle as text)`]
          : [],
      ]);

      assert.deepEqual(offenders, [], '--now is for what is relative to now, and --idle is never text');
    });
  }
});

describe("each tab's stylesheet is its own", () => {
  // Scoped by :where(), which adds no specificity: a tab's rule weighs what the component's does,
  // so the order the sheets load in is the whole cascade.
  for (const tab of ['ops', 'mine', 'collective']) {
    test(`views/dashboard/${tab}.css`, () => {
      const others = ['ops', 'mine', 'collective'].filter((other) => other !== tab);
      const rules = rulesOf(read(`views/dashboard/${tab}.css`));
      const unscoped = rules.filter((rule) => !rule.selector.startsWith('@'))
        .flatMap(selectorsOf).filter((selector) => !selector.startsWith(`:where(#view-${tab})`));
      const foreign = rules.flatMap(selectorsOf).filter((selector) => others.some((other) => selector.includes(`#view-${other}`)));
      const keyframes = rules.filter((rule) => rule.selector.startsWith('@keyframes') && !rule.selector.startsWith(`@keyframes ${tab}-`));

      assert.deepEqual(unscoped, [], `every selector starts with :where(#view-${tab})`);
      assert.deepEqual(foreign, [], 'and none reaches into another tab');
      assert.deepEqual(keyframes.map((rule) => rule.selector), [], `and every animation is named ${tab}-…`);
    });
  }
});

describe("a short class name is only ever read under its component", () => {
  // .v, .n, .sub and the rest mean something inside a tile or a bar and nothing on their own:
  // at the head of a selector they reach every element anyone ever gives that name.
  for (const file of STYLESHEETS) {
    test(`in ${file}`, () => {
      const offenders = rulesOf(read(file)).flatMap(selectorsOf)
        .map((selector) => selector.replace(/^:where\([^)]*\)\s*/, ''))
        .filter((selector) => /^\.(v|k|n|base|sub|late|zero|key)\b/.test(selector)
          || (/\.sub\b/.test(selector) && !/\.tile\b[^,]*\.sub\b/.test(selector)));

      assert.deepEqual(offenders, []);
    });
  }
});

describe("every control can be reached, seen and hit", () => {
  // Each has a visible focus and a 44px target. The two small buttons of the Operations tab get
  // their height from an ::after that reaches past them, so a row does not grow for a target.
  const rules = rulesOf(css());
  const all = rules.flatMap((rule) => selectorsOf(rule).map((selector) => ({ selector, rule })));
  const tall = (target) => all.some(({ selector, rule }) => selector.replace(/^:where\([^)]*\)\s*/, '') === target
    && rule.declarations.some(({ property, value }) => property === 'min-height' && value === '44px'));
  const focused = (control) => all.some(({ selector }) => selector.replace(/^:where\([^)]*\)\s*/, '') === `${control}:focus-visible`);

  for (const [control, target] of [
    ['.tab', '.tab'], ['.filters button', '.filters button'], ['summary', 'summary'], ['.pager button', '.pager button'],
    ['[tabindex]', null], ['th button', 'th button'],
    ['button.force', 'button.force::after'], ['.drop', '.drop::after'],
  ]) {
    test(control, () => {
      assert.ok(focused(control), `${control} shows no focus`);

      if (target) assert.ok(tall(target), `${target} is not 44px tall`);
    });
  }

  test("and a chip the keyboard is on is never drawn as a pressed one", () => {
    // Both were a --sync ring: the focus's outside the border, the pressed state's inside it, and
    // a focused chip read as a second chip pressed. Pressed fills the chip and colours its border
    // and count; focus draws the ring and nothing else.
    const declared = (selector) => all.filter((entry) => entry.selector === selector)
      .flatMap(({ rule }) => rule.declarations.map(({ property }) => property));
    const pressed = declared('.filters button[aria-pressed="true"]');

    assert.ok(pressed.includes('background') && pressed.includes('border-color'), 'a pressed chip is filled, its border coloured');
    assert.deepEqual(pressed.filter((property) => /^(outline|box-shadow)/.test(property)), [], 'and draws no ring');
    assert.deepEqual(declared('.filters button:focus-visible').filter((property) => !property.startsWith('outline')), [],
      'focus changes nothing but the ring');
  });
});

describe("an image to a screen reader holds nothing it can focus", () => {
  // role="img" makes its children presentational: a focusable point inside one is a stop the
  // keyboard lands on and a screen reader cannot name. A chart is one image, its canvas, named
  // with every value it draws.
  const images = (source) => [...source.matchAll(/<(\w+)\b[^>]*role="img"[^>]*>/g)]
    .filter((match) => !match[0].endsWith('/>'))
    .map((match) => source.slice(match.index, source.indexOf(`</${match[1]}>`, match.index)));

  for (const file of [...TEMPLATES, ...SCRIPTS]) {
    test(`in ${file}`, () => {
      assert.deepEqual(images(read(file)).filter((inner) => /tabindex/.test(inner)), []);
    });
  }
});

describe("what was removed stays removed", () => {
  // Each became something else - a tile, a chip, the footnote, the queue, the group-by - and
  // a second copy of it would say the same figure twice, in two ways. The bands' headings went
  // too: production had none, and a panel names itself. What counts as ours came back, as the
  // first row of the Settings panel: test/dashboard-ops.test.js holds it to that one place.
  const REMOVED = [
    'What has been measured', 'What has been contributed', 'How long it takes', 'Bot pull requests we merged',
    'Enrolment', 'How often each subject is checked', 'Next batches', 'Your contributions',
    'Your repositories', 'Workers running', 'Due right now', 'class="band', '.band',
  ];
  // Comments out: a note saying why a panel went is not the panel coming back.
  const everything = () => [
    ...TEMPLATES.map((file) => withoutEjsComments(read(file))),
    ...SCRIPTS.map((file) => withoutComments(read(file))),
    ...SHEETS.map((file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '')),
  ].join('\n');

  for (const text of REMOVED) {
    test(text, () => {
      assert.ok(!everything().includes(text), `${text} is back`);
    });
  }
});

describe("the nameplate stands above the tabs, for every reader", () => {
  // The nameplate: the face, the login in the one loud colour, and one row of what they have
  // landed - drawn from their own rows, which the page is seeded with, and never from the
  // snapshot read every five seconds.
  for (const [who, snapshot] of [['a reader', snapshotOf()], ['an operator', operatorSnapshotOf()]]) {
    test(`for ${who}`, async () => {
      const mine = mineOf();
      const html = await renderPage(snapshot, { mine, report: reportOf() });
      const at = html.indexOf('<section class="you" id="you"');

      assert.equal(html.split('class="you"').length, 2, 'exactly one nameplate');
      assert.ok(html.indexOf('</header>') < at && at < html.indexOf('<nav>'), 'between the header and the tabs');
      assert.ok([...html.matchAll(/role="tabpanel"/g)].every((match) => match.index > at), 'outside every tab');
      assert.ok(html.includes(`<span id="you-face"></span><span class="who">${snapshot.viewer}</span>`), 'the login, from the first paint');
      assert.equal(JSON.parse(/id="seed-mine">([\s\S]*?)<\/script>/.exec(html)[1]).login, mine.login, 'seeded with their rows');

      const { elements, errors } = await runPage(snapshot, undefined, { mine, report: reportOf(), drainIntervals: false });

      assert.deepEqual(errors, []);
      assert.match(elements.get('you-face').innerHTML, /<img class="avatar" style="--size: 46px"/);
      assert.equal(elements.get('you-figs').innerHTML, '<span><b class="landed">3</b> merged</span>'
        + '<span><b>4th</b> of 41 who have ever landed one</span>');
    });
  }

  test("with an operator chip for an operator, and for nobody else", async () => {
    const CHIP = '<span class="chip operator">operator</span>';

    assert.ok((await renderPage(operatorSnapshotOf())).includes(`<span class="who">${operatorSnapshotOf().viewer}</span>${CHIP}`));
    assert.ok(!(await renderPage(snapshotOf())).includes('class="chip operator"'));
  });

  test("in the display face, the login in --now", () => {
    const rules = rulesOf(read('views/dashboard/core.css'));
    const declared = (selector) => Object.fromEntries(rules.filter((rule) => selectorsOf(rule).includes(selector))
      .flatMap((rule) => rule.declarations.map(({ property, value }) => [property, value])));

    assert.equal(declared('.you .nameplate')['font-family'], 'var(--display)');
    assert.equal(declared('.you .who').color, 'var(--now)');
  });
});

describe("the page says facts, not commentary", () => {
  // No runbook, no status verdict without a rule behind it, no callout, and ours is "ours" -
  // never the company's name standing in for a scope.
  const BANNED = [/\bkubectl\b/, /\bNominal\b/, /\bDegraded\b/, /\bDown\b/, /callout/, /re-apply init\.sql/i,
    /\bmichelin\b(?!")/i];

  for (const file of [...TEMPLATES, ...SCRIPTS]) {
    test(`in ${file}`, () => {
      const text = file.endsWith('.ejs') ? withoutEjsComments(read(file)) : withoutComments(read(file));

      assert.deepEqual(BANNED.filter((pattern) => pattern.test(text)).map(String), []);
    });
  }
});

describe("a template swapped in holds nothing its reader keeps", () => {
  // swap() replaces an element's content: a <details> in it would close, an input would lose
  // what was typed, a scroll box would jump back to its start, a canvas would lose its chart.
  // Those live in the templates, or are written once by the component that owns them.
  for (const file of SCRIPTS) {
    test(`in ${file}`, () => {
      const source = withoutComments(read(file));
      const calls = [...source.matchAll(/\bswap\(/g)].map((match) => source.slice(match.index, source.indexOf(';\n', match.index)));

      assert.deepEqual(calls.filter((call) => /<details|<input|<canvas|users-wrap/.test(call)), []);
    });
  }
});

describe("the thresholds are defined once", () => {
  test("in src/utils/constants.js, and the page reads them from its snapshot", () => {
    const defining = filesUnder('src', '.js').filter((file) => /PERCENTILE_MIN_SAMPLE = /.test(read(file)));

    assert.deepEqual(defining, ['src/utils/constants.js']);
    assert.deepEqual(filesUnder('src', '.js').filter((file) => /\bp50: \d/.test(read(file))), ['src/utils/constants.js']);

    for (const file of [...SCRIPTS, ...TEMPLATES]) {
      assert.doesNotMatch(read(file), /\bp(50|90|99): \d/, `${file} keeps a threshold of its own`);
    }

    assert.match(read('views/dashboard/core.js'), /snapshot\.limits\.percentiles/);
  });
});

describe("every class the page uses is one its stylesheets define", () => {
  // `.tag` was used and never defined, and nothing said so. Per audience: a reader is sent four
  // sheets and an operator five, and a class defined only in ops.css is undefined for a reader.
  const definedIn = (files) => new Set(files.flatMap((file) => rulesOf(read(file)).flatMap(selectorsOf))
    .flatMap((selector) => [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])));

  /** The classes a text names: static ones, and each string literal inside a `${…}`. */
  const classesIn = (text) => [
    ...text.matchAll(/class="([^"]*)"/g), ...text.matchAll(/class: '([^']*)'/g), ...text.matchAll(/class: `([^`]*)`/g),
  ].flatMap((match) => {
    const expressions = [...match[1].matchAll(/\$\{([^}]*)\}/g)].map((expression) => expression[1]);
    const literals = expressions.flatMap((expression) => [...expression.matchAll(/'([^']*)'/g)].map((literal) => literal[1]));

    return [match[1].replace(/\$\{[^}]*\}/g, ' '), ...literals].join(' ').split(/\s+/);
  }).concat([...text.matchAll(/classList\.\w+\('([\w-]+)'/g)].map((match) => match[1]))
    .filter((name) => /^[a-z][\w-]*$/.test(name));

  const undefinedFor = async (snapshot, scripts, sheets) => {
    const html = withoutEjsComments(await renderPage(snapshot, { mine: mineOf(), report: reportOf() }));
    const defined = definedIn(sheets);
    const used = new Set([...classesIn(html), ...scripts.flatMap((file) => classesIn(withoutComments(read(file))))]);

    return [...used].filter((name) => !defined.has(name)).sort();
  };

  test("for a reader", async () => {
    const shared = SCRIPTS.filter((file) => !/ops\.js$/.test(file));

    assert.deepEqual(await undefinedFor(snapshotOf(), shared, STYLESHEETS.filter((file) => !/ops\.css$/.test(file))), []);
  });

  test("for an operator", async () => {
    assert.deepEqual(await undefinedFor(operatorSnapshotOf(), SCRIPTS, STYLESHEETS), []);
  });

  // Through Dash.cls(), which answers 'unknown' off the list, or a choice between literals. A
  // class spelled from a payload is one the stylesheet may never have heard of.
  const safe = (expression) => /^(Dash\.)?cls\(/.test(expression.trim())
    || (expression.includes('?') && expression.split(/\s*[?:]\s*/).filter((_, i, parts) => i % 2 === 1 || i === parts.length - 1)
      .every((branch) => /^'[^']*'$/.test(branch.trim())));

  for (const file of SCRIPTS) {
    test(`and ${file} makes a class from data only out of a vocabulary`, () => {
      const unsafe = [...withoutComments(read(file)).matchAll(/class(?:="|: `)([^"`]*)["`]/g)]
        .flatMap((match) => [...match[1].matchAll(/\$\{([^}]*)\}/g)].map((expression) => expression[1]))
        .filter((expression) => !safe(expression));

      assert.deepEqual(unsafe, []);
    });
  }

  test("and every word of every vocabulary has a style", async () => {
    const { sandbox } = await runPage(operatorSnapshotOf(), undefined, { drainIntervals: false });
    const { VOCAB } = sandbox.Dash;
    const reader = definedIn(STYLESHEETS.filter((file) => !/ops\.css$/.test(file)));
    const operator = definedIn(STYLESHEETS);

    for (const [name, defined] of [['OUTCOMES', reader], ['HUES', operator],
      ['JOB_STATES', operator], ['RUN_OUTCOMES', operator], ['ACCOUNT_STATES', operator]]) {
      assert.deepEqual([...VOCAB[name], 'unknown'].filter((word) => !defined.has(word)), [], `${name} has words no sheet paints`);
    }
  });

  test("and every class a sheet of the page styles is one something draws", async () => {
    // The other way round: a rule for a panel that has gone is a second page nobody sees, and
    // nothing else says it is dead. A word of a vocabulary is drawn, from the data, through
    // cls(). public/base.css is left out: it is the enrollment page's as well.
    const { sandbox } = await runPage(operatorSnapshotOf(), undefined, { drainIntervals: false });
    const drawn = new Set([
      ...TEMPLATES.flatMap((file) => classesIn(withoutEjsComments(read(file)))),
      ...SCRIPTS.flatMap((file) => classesIn(withoutComments(read(file)))),
      ...Object.values(sandbox.Dash.VOCAB).flat(), 'unknown',
    ]);
    const dead = Object.fromEntries(SHEETS.map((file) => [file, [...definedIn([file])].filter((name) => !drawn.has(name)).sort()])
      .filter(([, names]) => names.length > 0));

    assert.deepEqual(dead, {}, 'these are styled and drawn by nothing');
  });
});

describe("each tab reads in one order: four tiles, then its panels", () => {
  // The reading grammar, panel by panel, with no heading between them: production had none. A
  // string is a panel, named by its h2; a pair is two panels side by side in one .grid-2; an id
  // is anything else, named by it. Month by month on the report is two panels one after the
  // other, not a pair: the two charts are each as wide as the page.
  const SEQUENCE = {
    mine: ['y-tiles', ['How it added up', 'Outcome and scope', 'Every one of them']],
    collective: ['r-tiles', [
      'Who is contributing', 'Month by month',
      ['Outcome by scope', 'Time to merge and size'], 'Awaiting a verdict',
      ['The biggest ones we got into', 'Most contributed projects'], "This month's contributors",
    ]],
    ops: ['o-tiles', [
      '#o-jobs', 'The queue', ['Capacity and backlog', 'Detection latency'], 'Recent runs',
      'Enrolled accounts', 'Record a contribution', 'Recorded by hand', 'What the bot has recorded', 'Settings',
    ]],
  };

  /**
   * A template as the tree of its sections, divs, lists and headings
   *
   * The EJS logic is taken out and every output left as a placeholder: what is being read is
   * the shape, which does not depend on the data.
   */
  const treeOf = (source) => {
    const text = withoutEjsComments(source).replace(/<%[=-][\s\S]*?%>/g, 'x').replace(/<%[\s\S]*?%>/g, '');
    const root = { tag: 'root', attributes: '', children: [], text: '' };
    const stack = [root];

    for (const [, closing, tag, attributes] of text.matchAll(/<(\/?)(section|div|dl|p|h2)\b([^>]*)>/g)) {
      if (closing) {
        stack.pop();
      } else {
        const node = { tag, attributes, children: [], at: 0 };

        stack.at(-1).children.push(node);
        stack.push(node);
      }
    }

    // The text of a heading, read back off the source it came from.
    const texts = [...text.matchAll(/<h2\b[^>]*>([^<]*)</g)].map((match) => match[1].trim());
    let next = 0;

    const label = (node) => {
      if (node.tag === 'h2') {
        node.text = texts[next];
        next += 1;
      }

      node.children.forEach(label);
    };

    label(root);

    return root;
  };

  const is = (node, tag, name) => node.tag === tag && new RegExp(`class="${name}"`).test(node.attributes);
  const h2 = (panel) => panel.children.find((child) => child.tag === 'h2')?.text;

  /** What a node of the tab is, in the same notation as SEQUENCE. */
  const readNode = (node) => {
    if (is(node, 'div', 'grid-2')) return node.children.map(h2);
    if (/class="panel"/.test(node.attributes)) return h2(node);

    return `#${/id="([^"]+)"/.exec(node.attributes)?.[1]}`;
  };

  for (const [tab, [tiles, panels]] of Object.entries(SEQUENCE)) {
    test(`${tab}: tiles first, then exactly its panels`, async () => {
      const panel = treeOf(read(`views/dashboard/${tab}.ejs`)).children[0];
      const [first, ...rest] = panel.children;

      assert.ok(is(first, 'dl', 'tiles') && first.attributes.includes(`id="${tiles}"`),
        `the tab opens on <dl class="tiles" id="${tiles}">, with no heading before it`);
      assert.deepEqual(rest.map(readNode), panels);

      const snapshot = tab === 'ops' ? operatorSnapshotOf() : snapshotOf();
      const { elements } = await runPage(snapshot, undefined, { mine: mineOf(), report: reportOf(), hash: `#${tab}` });

      assert.equal((elements.get(tiles).innerHTML.match(/<div class="tile/g) ?? []).length, 4, 'and it holds four tiles');
      assert.equal((read(`views/dashboard/${tab}.ejs`).match(/class="tiles"/g) ?? []).length, 1, 'and only the one row of them');
    });

    test(`${tab}: every panel title is followed by its one line`, () => {
      const headings = [...withoutEjsComments(read(`views/dashboard/${tab}.ejs`)).matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>\s*(<[^>]*>)/g)];

      assert.ok(headings.length > 0);
      assert.deepEqual(headings.map((match) => match[1]).filter((next) => !next.startsWith('<p class="panel-sub"')), []);
    });
  }
});
