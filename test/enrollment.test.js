import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ejs from "ejs";

import { enrollmentPage, DEFAULT_ENROLLMENT_REASON, TONES } from "../src/utils/enrollmentPages.js";

const VIEW = fileURLToPath(new URL("../views/enroll.ejs", import.meta.url));
const REASONS = ["no-allowed-email", "no-installation", "stale-link", "error"];
const DOMAINS = "@michelin.com or @tyredating.com";

describe("enrollmentPage", () => {
  test("every outcome has copy the template can render", () => {
    for (const reason of REASONS) {
      const page = enrollmentPage(reason, DOMAINS);

      assert.ok(page.title, `${reason} has no title`);
      assert.ok(TONES.includes(page.tone), `${reason} has tone "${page.tone}", which public/enroll.css cannot paint`);
      assert.ok(page.eyebrow, `${reason} has no eyebrow`);
      assert.ok(page.lead, `${reason} has no lead`);
      assert.ok(page.cta, `${reason} has no cta`);
      assert.ok(Array.isArray(page.steps), `${reason} has no steps array`);
    }
  });

  test("the reason is user input, so anything unknown falls back instead of throwing", () => {
    const fallback = enrollmentPage(DEFAULT_ENROLLMENT_REASON, DOMAINS);

    for (const bad of [undefined, null, "", "nonsense", "constructor", "__proto__", 42, ["a"]]) {
      assert.deepEqual(enrollmentPage(bad, DOMAINS), fallback);
    }
  });

  test("the rejection page names the accepted domains and says the app was removed", () => {
    const page = enrollmentPage("no-allowed-email", DOMAINS);

    assert.match(page.lead, /@michelin\.com or @tyredating\.com/);
    // The uninstall is invisible otherwise, and "install the app again" reads as a
    // pointless extra step.
    assert.match(page.lead, /removed/);
  });

  test("a spent link does not read as the user's fault", () => {
    const page = enrollmentPage("stale-link", DOMAINS);

    assert.equal(page.steps.length, 0);
    // Said once, above the title, where it is read first: the lead used to say it again.
    assert.equal(page.eyebrow, 'Nothing is wrong');
    assert.doesNotMatch(page.lead, /Nothing is wrong/);
  });
});

describe("the enrollment view", () => {
  // A template only fails at request time, which is exactly when nobody is watching.
  test("renders for every outcome", async () => {
    for (const reason of REASONS) {
      const html = await ejs.renderFile(VIEW, {
        page: enrollmentPage(reason, DOMAINS),
        retryUrl: "https://github.com/apps/giveback",
      });

      assert.match(html, new RegExp(enrollmentPage(reason, DOMAINS).title));
      assert.match(html, /Install the app|Start again|Try again/);
    }
  });

  test("hides the install button when the app could not identify itself", async () => {
    // Sending someone to install the wrong instance of this bot — a dev instance offering
    // production — is worse than showing no button.
    const html = await ejs.renderFile(VIEW, {
      page: enrollmentPage("no-allowed-email", DOMAINS),
      retryUrl: null,
    });

    assert.doesNotMatch(html, /class="cta"/);
    // The explanation and the steps still stand on their own.
    assert.match(html, /Email verification required/);
    assert.match(html, /class="step-item"/);
  });

  test("numbers the steps it is given, and drops the block when there are none", async () => {
    const withSteps = await ejs.renderFile(VIEW, {
      page: enrollmentPage("no-allowed-email", DOMAINS),
      retryUrl: "https://example.test",
    });
    const withoutSteps = await ejs.renderFile(VIEW, {
      page: enrollmentPage("stale-link", DOMAINS),
      retryUrl: "https://example.test",
    });

    assert.equal((withSteps.match(/class="step-item"/g) ?? []).length, 4);
    assert.match(withSteps, /class="step-number">4</);
    assert.doesNotMatch(withoutSteps, /class="step-item"/);
    assert.doesNotMatch(withoutSteps, /What to do/);
  });

  test("the outcome picks the page's accent, so the three do not look alike", async () => {
    // The tone class is the only thing that colours this page. If it stopped reaching the
    // panel every outcome would render in the neutral blue, and "our fault" would look
    // exactly like "nothing is wrong".
    const rendered = async (reason) => ejs.renderFile(VIEW, {
      page: enrollmentPage(reason, DOMAINS),
      retryUrl: "https://example.test",
    });

    assert.match(await rendered("no-allowed-email"), /class="panel tone-fix"/);
    assert.match(await rendered("stale-link"), /class="panel tone-neutral"/);
    assert.match(await rendered("error"), /class="panel tone-fail"/);

    // And it is said in words as well as in colour, for whoever cannot tell the two apart.
    assert.match(await rendered("error"), /class="eyebrow">Our fault</);
  });

  test("the page a stranger sees loads nothing from a CDN but its type", async () => {
    // It used to pull Bootstrap from jsdelivr and Font Awesome from cdnjs — ~330 KB of CSS
    // and an icon webfont, for nine glyphs, on the entry page of an OAuth flow. Both are
    // gone, and the assertion is here so neither comes back by habit.
    const html = await ejs.renderFile(VIEW, {
      page: enrollmentPage("no-allowed-email", DOMAINS),
      retryUrl: "https://example.test",
    });

    assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
    assert.doesNotMatch(html, /class="fa[sbr]? |fa-/, "no Font Awesome classes, here or in the copy");
    assert.doesNotMatch(html, /<style/, "the styles live in public/enroll.css, not in the template");
    // The palette and the chassis have to come from the shared file, or this page starts
    // its own - which is how the two views drifted apart in the first place.
    assert.match(html, /<link rel="stylesheet" href="\/base\.css">/);
  });
});
