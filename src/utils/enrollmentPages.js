/**
 * Copy for the enrollment outcome page.
 *
 * Every string below is a literal — nothing here comes from a request, which is what makes it
 * safe for the template to render the step text as HTML, and the steps carry links.
 *
 * `tone` and `eyebrow` replace the Font Awesome class this used to carry. The page no longer
 * loads an icon font — nine glyphs were not worth a CDN on the one page a stranger sees, and
 * the dashboard they now share a design with uses colour and type rather than icons. What is
 * left is the part that was actually information: whose problem this is. The tone picks the
 * page's accent colour, the eyebrow says it in words above the title.
 */

/** The three accents views/enroll.ejs knows how to paint. Keep TONES and public/enroll.css in step. */
export const TONES = ['fix', 'neutral', 'fail'];

const PAGES = {
  // The installation has been removed, and the page has to say so — otherwise "install the
  // app" reads as a pointless extra step.
  'no-allowed-email': (domains) => ({
    title: 'Email verification required',
    tone: 'fix',
    eyebrow: 'Action needed',
    lead: `Your GitHub account has no <strong>verified</strong> ${domains} email address. That address is how we recognize you as an employee, so the app was not enrolled and has been removed from your account.`,
    steps: [
      'Open your <a href="https://github.com/settings/emails" target="_blank" rel="noopener noreferrer">GitHub email settings</a>',
      `Add your ${domains} address as a secondary email`,
      'Verify it — GitHub sends a confirmation link to that inbox',
      'Install the app again',
    ],
    cta: 'Install the app',
  }),

  // The app is installed on an organization, or the installation was removed between the
  // redirect and this call.
  'no-installation': () => ({
    title: 'No installation to enroll',
    tone: 'fix',
    eyebrow: 'Action needed',
    lead: 'The app is not installed on your <strong>personal</strong> GitHub account, and only a personal installation can be enrolled.',
    steps: [
      'Install the app again',
      'When GitHub asks where to install it, pick your <strong>personal account</strong>, not an organization',
    ],
    cta: 'Install the app',
  }),

  // A refresh, a bookmark or the back button spent the one-shot OAuth code. Nothing is wrong
  // with the account, so the page must not read as a fault.
  'stale-link': () => ({
    title: 'This link has already been used',
    tone: 'neutral',
    eyebrow: 'Nothing is wrong',
    lead: 'Enrollment links work only once, and this one is spent. Start again from the installation page.',
    steps: [],
    cta: 'Start again',
  }),

  // Deliberately vague: the details are in the logs, not on a public page.
  error: () => ({
    title: 'Something went wrong',
    tone: 'fail',
    eyebrow: 'Our fault',
    lead: 'We could not finish your enrollment. Try again in a moment; if it keeps happening, contact the Open Source team.',
    steps: [],
    cta: 'Try again',
  }),
};

export const DEFAULT_ENROLLMENT_REASON = 'stale-link';

/**
 * Resolve an outcome to its page content, falling back rather than throwing
 *
 * The reason travels in a query string, so it is user input: anything unrecognized gets the
 * neutral page instead of a 500.
 * @param {*} reason - One of the keys of PAGES
 * @param {string} allowedEmailDomains - Human-readable domain list, e.g. "@a.com or @b.com"
 * @returns {{title: string, tone: string, eyebrow: string, lead: string, steps: string[], cta: string}}
 */
export const enrollmentPage = (reason, allowedEmailDomains) => {
  // hasOwn, not a plain lookup: `?reason=constructor` would otherwise resolve to
  // Object.prototype.constructor and be called, and `?reason=__proto__` would throw.
  const key = typeof reason === 'string' && Object.hasOwn(PAGES, reason)
    ? reason
    : DEFAULT_ENROLLMENT_REASON;

  return PAGES[key](allowedEmailDomains);
};
