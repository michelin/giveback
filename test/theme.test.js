import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { read, withoutComments } from "../test-support/sources.js";
import { runPage, renderPage, report, rulesOf, TOKENS } from "../test-support/dashboardPage.js";
import { operatorSnapshotOf } from "../test-support/fixtures/ops.js";
import { enrollmentPage } from "../src/utils/enrollmentPages.js";
import { THEME_COOKIE, THEMES, themeOf } from "../src/utils/theme.js";

const ENROLL = fileURLToPath(new URL("../views/enroll.ejs", import.meta.url));
const cookie = (value) => ({ headers: { cookie: value } });

describe("the reader's theme", () => {
  test("is dark unless the cookie says light", () => {
    assert.equal(themeOf({ headers: {} }), 'dark');
    assert.equal(themeOf({}), 'dark');
    assert.equal(themeOf(cookie(`${THEME_COOKIE}=light`)), 'light');
    assert.equal(themeOf(cookie(`oss_dashboard=abc; ${THEME_COOKIE}=light; other=1`)), 'light');
    assert.equal(themeOf(cookie(`${THEME_COOKIE}=dark`)), 'dark');

    // Anything else is the default, and a cookie whose name merely ends in ours is not ours.
    for (const value of ['LIGHT', 'light2', '', '"light"', 'light%00']) {
      assert.equal(themeOf(cookie(`${THEME_COOKIE}=${value}`)), 'dark', value);
    }
    assert.equal(themeOf(cookie(`x${THEME_COOKIE}=light`)), 'dark');
  });

  test("is kept in the cookie the server reads, on every path", () => {
    // The page writes it and the server reads it: one name, or the choice is lost on reload.
    // Path=/ because the enrollment page, outside /dashboard, is drawn in it too.
    const core = withoutComments(read('views/dashboard/core.js'));

    assert.match(core, new RegExp(`document\\.cookie = \`${THEME_COOKIE}=\\$\\{name\\}; Path=/;`));
  });
});

describe("the light theme", () => {
  test("redefines every colour of the dark one, except the logo's yellow and its navy, and nothing else", () => {
    // A colour the light block forgets is a dark one on a light page: unreadable, and found by
    // a reader. --now stays the logo's #ffce00 in both, and becomes a fill on the light page;
    // --on-now, the navy set on that fill, is the same in both because the fill is.
    // Sizes, faces and timings are the theme's business in neither, so the light block holds
    // only tokens the dark one defines.
    const colour = /^(#[0-9a-f]{6}|rgba\(|transparent$)/i;
    const dark = [...TOKENS.dark].filter(([, value]) => colour.test(value)).map(([name]) => name);
    const light = [...TOKENS.light.keys()].filter((name) => TOKENS.light.get(name) !== TOKENS.dark.get(name));

    assert.deepEqual(light.filter((name) => !TOKENS.dark.has(name)), [], 'a token only the light theme has');
    assert.deepEqual(dark.filter((name) => !['--now', '--on-now'].includes(name) && !light.includes(name)), [], 'colours the light theme leaves dark');
    assert.equal(TOKENS.light.get('--now'), TOKENS.dark.get('--now'));
    assert.equal(TOKENS.light.get('--on-now'), TOKENS.dark.get('--on-now'));
  });

  test("never sets text in the yellow: the text that took it is in ink", () => {
    assert.equal(TOKENS.dark.get('--now-ink'), TOKENS.dark.get('--now'));
    assert.equal(TOKENS.light.get('--now-ink'), TOKENS.light.get('--ink'));

    // Every rule that colours text with the loud colour goes through --now-ink.
    for (const file of ['views/dashboard/core.css', 'views/dashboard/ops.css']) {
      const yellow = rulesOf(read(file)).filter((rule) => rule.declarations.some(({ property, value }) =>
        property === 'color' && value === 'var(--now)'));

      assert.deepEqual(yellow.map((rule) => rule.selector), [], `${file} sets text in --now`);
    }
  });

  test("sets every hue that is also text at 4.5:1 or more, on the panels and under white", () => {
    // WCAG AA for body text. The palette's first draft had the warning eyebrow at 3.5:1 and the
    // green "ok" chips at 3.6:1: fine as fills, not as words.
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

      return (hi + 0.05) / (lo + 0.05);
    };
    const light = (name) => TOKENS.light.get(`--${name}`);

    for (const text of ['ink', 'ink-dim', 'ink-mute', 'sync', 'poll', 'ok', 'warn', 'fail']) {
      for (const ground of ['panel', 'panel-2']) {
        assert.ok(contrast(light(text), light(ground)) >= 4.5, `--${text} on --${ground}: ${contrast(light(text), light(ground)).toFixed(2)}`);
      }
    }
    assert.ok(contrast(light('ink-mute'), light('ground')) >= 4.5, 'the footer is set on the ground');
    for (const fill of ['sync', 'poll']) {
      assert.ok(contrast(light('on-hue'), light(fill)) >= 4.5, `--on-hue on --${fill}`);
    }

    // The two felt-tip marks, in both themes: the stars' navy on the yellow, and the login's ink
    // over the blue stroke at the strength core.css gives it, laid on the ground.
    const over = (hex, ground, alpha) => `#${[1, 3, 5].map((i) => Math.round(alpha * parseInt(hex.slice(i, i + 2), 16)
      + (1 - alpha) * parseInt(ground.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('')}`;
    const strength = Number(/color-mix\(in srgb, var\(--sync\) (\d+)%, transparent\) 2\.5%/.exec(read('views/dashboard/core.css'))[1]) / 100;

    for (const theme of ['dark', 'light']) {
      const token = (name) => TOKENS[theme].get(`--${name}`);
      const stroke = over(token('sync'), token('ground'), strength);

      assert.ok(contrast(token('on-now'), token('now')) >= 4.5, `${theme}: --on-now on --now`);
      assert.ok(contrast(token('ink'), stroke) >= 4.5, `${theme}: the login over its stroke, ${contrast(token('ink'), stroke).toFixed(2)}`);
    }
  });

  test("gives the browser the ground it is drawn on", () => {
    assert.equal(THEMES.dark.ground, TOKENS.dark.get('--ground'));
    assert.equal(THEMES.light.ground, TOKENS.light.get('--ground'));
  });
});

describe("both pages render in the reader's theme from the first paint", () => {
  test("the dashboard", async () => {
    const dark = await renderPage(operatorSnapshotOf());
    const light = await renderPage(operatorSnapshotOf(), { theme: 'light' });

    assert.match(dark, /<html lang="en" data-theme="dark">/);
    assert.match(dark, /<meta name="theme-color" content="#080c17">/);
    assert.match(dark, /id="theme-toggle"[^>]*aria-pressed="false"/);
    assert.match(light, /<html lang="en" data-theme="light">/);
    assert.match(light, /<meta name="theme-color" content="#e8edf5">/);
    assert.match(light, /id="theme-toggle"[^>]*aria-pressed="true"/);
  });

  test("the enrollment page, which runs no script and has no button", async () => {
    const page = enrollmentPage('no-allowed-email', '@acme.com');
    const light = await ejs.renderFile(ENROLL, { page, retryUrl: null, theme: 'light', themeColor: THEMES.light.ground });
    const bare = await ejs.renderFile(ENROLL, { page, retryUrl: null });

    assert.match(light, /<html lang="en" data-theme="light">/);
    assert.match(light, /<meta name="theme-color" content="#e8edf5">/);
    assert.match(bare, /<html lang="en" data-theme="dark">/, 'rendered without a theme, it is the default');
    assert.doesNotMatch(light, /<script|theme-toggle/);
  });
});

describe("the theme button", () => {
  test("switches the page, keeps the choice and repaints the queue in the new palette", async () => {
    const run = await runPage(operatorSnapshotOf());
    const { elements, document, meta, frames, painted, errors } = run;
    const button = elements.get('theme-toggle');
    const click = () => button.handlers.click({ currentTarget: button });
    // The queue's discs, drawn on the next frame after the click.
    const discsAfter = (from) => {
      frames.at(-1)(Date.now());

      return new Set(painted.slice(from).flatMap((call, i, calls) => (call.op === 'arc' && call.args[2] < 4
        ? [calls[i + 1].fillStyle] : [])));
    };

    assert.equal(errors.length, 0, `the page threw:\n${report(errors)}`);
    assert.equal(document.documentElement.dataset.theme, 'dark');

    click();
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.match(document.cookie, new RegExp(`^${THEME_COOKIE}=light; Path=/; Max-Age=\\d+; SameSite=Lax$`));
    assert.equal(meta.attributes.content, TOKENS.light.get('--ground'));
    assert.ok(discsAfter(painted.length).has(TOKENS.light.get('--sync')), 'the queue still in the dark palette');

    click();
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.match(document.cookie, new RegExp(`^${THEME_COOKIE}=dark;`));
    assert.ok(discsAfter(painted.length).has(TOKENS.dark.get('--sync')));
  });
});
