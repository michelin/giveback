/**
 * The reader's theme, as both pages render it
 *
 * Dark unless the reader chose light. The choice is made with the dashboard's theme button and
 * kept in a cookie the page writes itself, Path=/ so the enrollment page reads it too. The
 * server reads it here and writes it into <html data-theme>, so the first paint is already in
 * the right theme: a script that switched after load would flash the other one first, and the
 * enrollment page runs no script at all.
 *
 * Not signed, and it needs no signing: it picks between two colour sets and nothing else, and
 * anything but "light" reads as the default.
 */

/** The cookie's name. The page writes it, with its attributes, in views/dashboard/core.js. */
export const THEME_COOKIE = 'oss_dashboard_theme';

export const THEMES = Object.freeze({
  dark: { ground: '#080c17' },
  light: { ground: '#e8edf5' },
});

/**
 * @param {import('express').Request} req
 * @returns {'dark'|'light'}
 */
export const themeOf = (req) => {
  const match = new RegExp(`(?:^|;)\\s*${THEME_COOKIE}=([^;]*)`).exec(req.headers?.cookie ?? '');

  return match?.[1].trim() === 'light' ? 'light' : 'dark';
};
