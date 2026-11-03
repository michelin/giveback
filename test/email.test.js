import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseAllowedEmailDomains } from "../src/utils/constants.js";
import {
  isAllowedEmailDomain,
  pickEnrollmentEmail,
  formatAllowedEmailDomains,
} from "../src/utils/email.js";

const DOMAINS = ["michelin.com", "tyredating.com"];
const addr = (email, extra = {}) => ({ email, verified: true, primary: false, ...extra });

describe("parseAllowedEmailDomains", () => {
  test("has no default: an unset value yields nothing, never someone else's domains", () => {
    // A default here would accept the wrong company's employees and reject your own, in
    // INFO-level silence. validateEnv turns an empty list into a startup failure.
    assert.deepEqual(parseAllowedEmailDomains(undefined), []);
    assert.deepEqual(parseAllowedEmailDomains(null), []);
    assert.deepEqual(parseAllowedEmailDomains(""), []);
    assert.deepEqual(parseAllowedEmailDomains("   "), []);
  });

  test("normalizes: trims, lower-cases, strips '@', de-duplicates", () => {
    assert.deepEqual(
      parseAllowedEmailDomains(" @Michelin.COM , tyredating.com ,michelin.com "),
      ["michelin.com", "tyredating.com"]
    );
  });

  test("adding a domain is a one-line config change", () => {
    assert.deepEqual(
      parseAllowedEmailDomains("michelin.com,tyredating.com,newbrand.com"),
      ["michelin.com", "tyredating.com", "newbrand.com"]
    );
  });

  test("garbage parses to an empty list so validateEnv can reject it", () => {
    assert.deepEqual(parseAllowedEmailDomains(",,"), []);
    assert.deepEqual(parseAllowedEmailDomains(" , "), []);
  });
});

describe("isAllowedEmailDomain", () => {
  test("accepts every configured domain, case-insensitively", () => {
    assert.equal(isAllowedEmailDomain("a.b@michelin.com", DOMAINS), true);
    assert.equal(isAllowedEmailDomain("A.B@MICHELIN.COM", DOMAINS), true);
    assert.equal(isAllowedEmailDomain("a.b@TyreDating.com", DOMAINS), true);
    assert.equal(isAllowedEmailDomain("  a.b@tyredating.com  ", DOMAINS), true);
  });

  test("is anchored on the whole domain", () => {
    for (const bad of [
      "a@notmichelin.com",
      "a@michelin.com.evil.io",
      "a@mail.michelin.com",
      "a@tyredating.com.br",
      "a@michelin.co",
    ]) {
      assert.equal(isAllowedEmailDomain(bad, DOMAINS), false, `${bad} must be rejected`);
    }
  });

  test("rejects malformed input instead of throwing", () => {
    for (const bad of [undefined, null, 42, {}, "", "@michelin.com", "a@", "a@b@michelin.com"]) {
      assert.equal(isAllowedEmailDomain(bad, DOMAINS), false);
    }
  });
});

describe("pickEnrollmentEmail", () => {
  test("requires the address to be verified", () => {
    const emails = [{ email: "a@michelin.com", verified: false }];

    assert.equal(pickEnrollmentEmail(emails, DOMAINS), null);
  });

  test("returns null when no address is on an allowed domain", () => {
    assert.equal(pickEnrollmentEmail([addr("a@gmail.com")], DOMAINS), null);
  });

  test("prefers the first configured domain over the second", () => {
    const emails = [addr("b@tyredating.com"), addr("a@michelin.com")];

    assert.equal(pickEnrollmentEmail(emails, DOMAINS), "a@michelin.com");
  });

  test("prefers the primary address within the same domain", () => {
    const emails = [addr("aaa@michelin.com"), addr("zzz@michelin.com", { primary: true })];

    assert.equal(pickEnrollmentEmail(emails, DOMAINS), "zzz@michelin.com");
  });

  test("is deterministic regardless of GitHub's ordering", () => {
    const emails = [addr("b@michelin.com"), addr("a@michelin.com")];

    assert.equal(pickEnrollmentEmail(emails, DOMAINS), "a@michelin.com");
    assert.equal(pickEnrollmentEmail([...emails].reverse(), DOMAINS), "a@michelin.com");
  });

  test("lower-cases the stored address", () => {
    assert.equal(pickEnrollmentEmail([addr("A.B@Michelin.com")], DOMAINS), "a.b@michelin.com");
  });

  test("tolerates a missing or malformed email list", () => {
    assert.equal(pickEnrollmentEmail(undefined, DOMAINS), null);
    assert.equal(pickEnrollmentEmail([null, undefined, {}], DOMAINS), null);
  });
});

describe("formatAllowedEmailDomains", () => {
  test("reads as a sentence for one, two or three domains", () => {
    assert.equal(formatAllowedEmailDomains(["michelin.com"]), "@michelin.com");
    assert.equal(formatAllowedEmailDomains(DOMAINS), "@michelin.com or @tyredating.com");
    assert.equal(
      formatAllowedEmailDomains([...DOMAINS, "newbrand.com"]),
      "@michelin.com, @tyredating.com or @newbrand.com"
    );
  });
});
