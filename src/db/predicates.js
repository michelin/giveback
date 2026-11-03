/**
 * The SQL predicates more than one module in this directory asks the same question with.
 *
 * Imported rather than restated, so the contribution report and the Operations tab cannot answer
 * "is this ours" or "did a person open this" by two different rules. Both expect the registry
 * aliased `r` and the contribution aliased `p`.
 */

/**
 * The owner segment of the repository's CURRENT name, matched against the configured list
 *
 * The list is `$1` in every query that reads this. Lower-cased on both sides: GitHub logins are
 * case-insensitive and the configured value is hand-typed.
 *
 * A constant, not a function taking a column: there is exactly one name worth asking this of,
 * the registry's current one. A column parameter would let a caller point it at the copy frozen
 * on the contribution, and a repository transferred out of an owned organisation would then
 * count as ours for ever.
 */
export const IS_OWN = "lower(split_part(r.full_name, '/', 1)) = ANY($1)";

/**
 * Only the pull requests a PERSON opened
 *
 * `user_type` is GitHub's own word for the account behind a pull request, frozen on the
 * contribution when it was hydrated, and 'Bot' is what it says for Dependabot, Renovate and
 * every other automated author. A dependency bump is not a contribution to open source, and one
 * busy repository produces hundreds of them: at the time this was added, 407 of the 1,144 stored
 * pull requests were a bot's, and 325 of those counted as merged contributions. Every figure on
 * the report - opened, merged, closed, awaiting a verdict - was inflated by them.
 *
 * The rows are kept rather than deleted: what a bot opened and a person merged is real
 * maintenance work, and the day it becomes a figure of its own the data has to still be there.
 * This narrows the reading, not the collection.
 *
 * `= 'User'` rather than `<> 'Bot'`, so a type nobody has seen yet - and a NULL, which no row
 * carries today - stays out of a figure about people until somebody decides it belongs there.
 */
export const BY_A_PERSON = "p.user_type = 'User'";
