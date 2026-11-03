/**
 * A figure, read from something somebody else wrote: a URL path segment, a form field, a forge's
 * JSON - text of unknown shape, every time.
 *
 * `parseInt` is the trap this avoids: it reads a number off the front and discards the rest, so
 * `12abc` becomes 12 and GitLab's capped `1000+` becomes 1000 - a figure nobody measured, stored
 * as though somebody had. The shape is therefore checked BEFORE the value, which also covers
 * `Number('')` being 0 and `Number(' 3 ')` being 3.
 *
 * @param {*} value - Text, a number, null, undefined, a blank field
 * @returns {?number} A non-negative safe integer, or null when it is not one
 */
export const asCount = (value) => {
  const text = String(value ?? '');

  if (!/^[0-9]+$/.test(text)) {
    return null;
  }

  const count = Number(text);

  return Number.isSafeInteger(count) ? count : null;
};
