import { ALLOWED_EMAIL_DOMAINS } from "./constants.js";

/**
 * Domain part of an email address, or null when the address is not exactly local@domain
 * @param {unknown} address - Candidate email address
 * @returns {string|null} Lower-cased domain, or null
 */
const domainOf = (address) => {
  if (typeof address !== 'string') {
    return null;
  }

  const parts = address.trim().toLowerCase().split('@');

  if (parts.length !== 2) {
    return null;
  }

  const [localPart, domain] = parts;

  if (!localPart || !domain) {
    return null;
  }

  return domain;
};

/**
 * True when the address' domain is EXACTLY one of the allowed domains
 *
 * Anchored on the whole domain, so "a@notacme.com", "a@acme.com.evil.io" and the sub-domain
 * "a@mail.acme.com" all fail. List sub-domains explicitly in ALLOWED_EMAIL_DOMAINS if needed.
 * @param {unknown} address - Candidate email address
 * @param {string[]} [allowedDomains] - Domains to accept
 * @returns {boolean}
 */
export const isAllowedEmailDomain = (address, allowedDomains = ALLOWED_EMAIL_DOMAINS) => {
  const domain = domainOf(address);

  return domain !== null && allowedDomains.includes(domain);
};

/**
 * Verified addresses on an allowed domain, in input order
 * @param {Array<{email: string, verified: boolean, primary?: boolean}>} emails - GitHub email list
 * @param {string[]} allowedDomains - Domains to accept
 * @returns {Array<Object>}
 */
const eligible = (emails, allowedDomains) =>
  (Array.isArray(emails) ? emails : []).filter(
    (entry) => entry?.verified === true && isAllowedEmailDomain(entry.email, allowedDomains)
  );

/**
 * Pick the single address to enroll with, deterministically
 *
 * Ranked by allow-list order, then GitHub "primary", then alphabetically. GitHub returns the
 * list in no guaranteed order, so without a total ranking the stored address could change
 * between two enrollments of the same user.
 * @param {Array<{email: string, verified: boolean, primary?: boolean}>} emails - GitHub email list
 * @param {string[]} [allowedDomains] - Domains to accept
 * @returns {string|null} Lower-cased address, or null when none qualifies
 */
export const pickEnrollmentEmail = (emails, allowedDomains = ALLOWED_EMAIL_DOMAINS) => {
  const candidates = eligible(emails, allowedDomains)
    .map((entry) => ({
      address: entry.email.trim().toLowerCase(),
      rank: allowedDomains.indexOf(domainOf(entry.email)),
      primary: entry.primary === true,
    }))
    .sort((a, b) =>
      a.rank - b.rank ||
      Number(b.primary) - Number(a.primary) ||
      a.address.localeCompare(b.address)
    );

  return candidates.length > 0 ? candidates[0].address : null;
};

/**
 * Human-readable domain list for the enrollment page
 * @returns {string} e.g. "@acme.com, @acme-labs.com or @acme.io"
 */
export const formatAllowedEmailDomains = (allowedDomains = ALLOWED_EMAIL_DOMAINS) => {
  const withAt = allowedDomains.map((domain) => `@${domain}`);

  if (withAt.length <= 1) {
    return withAt.join('');
  }

  return `${withAt.slice(0, -1).join(', ')} or ${withAt[withAt.length - 1]}`;
};
