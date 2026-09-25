/**
 * Cross-cutting constants and the number formatting every piece of
 * model-facing copy shares. Kept in one leaf module (imports nothing from
 * the rest of `lib/`) so a value that appears in a nudge, a tool result, and
 * a config default can never drift into two different spellings - a reminder
 * and a usage note that disagree on the window or round differently read to
 * the model as stale data.
 */

/**
 * Window assumed when the model catalog has no context limit for the model
 * (not listed yet, no limit published, listing failed). Every percentage that
 * reaches the model resolves against a DEFINED window - the fallback keeps a
 * reminder from having to omit its window parenthetical.
 */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Cap on stored nudge rate-limit anchors (oldest anchor is dropped first). */
export const NUDGE_ANCHOR_CAP = 8;

/**
 * Token counts rendered into model-facing copy.
 */
export function tokenLabel(tokens: number): string {
  return Math.max(0, Math.round(tokens)).toLocaleString();
}

/** Percent of a base, clamped so a bad estimate cannot render absurdly. */
export function percentOf(tokens: number, base: number): number {
  return Math.min(999, Math.max(0, Math.round((tokens / Math.max(1, base)) * 100)));
}

/**
 * Window parenthetical for model-facing copy: the model window and the
 * pruning budget are different denominators, and quoting only one of them is
 * what makes a percentage read as stale or contradictory. Omitted when the
 * window is unknown (0) or is itself the budget.
 */
export function windowClause(tokens: number, budget: number, window: number): string {
  if (window <= 0 || window <= budget) return "";
  return ` (~${percentOf(tokens, window)}% of the ${tokenLabel(window)}-token model window)`;
}
