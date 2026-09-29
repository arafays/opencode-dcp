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
 * The ONE spelling of "how full the context is", shared by the pressure
 * nudge, the post-prune ack and the prune tool's usage note. Every
 * model-facing context measurement must go through here, which is what keeps
 * those three messages from contradicting each other on the same dispatch.
 *
 * The MODEL WINDOW leads deliberately. It is the only denominator the model
 * can reason about intuitively; the pruning budget is a plugin-internal
 * threshold. A budget-first percentage ("999% of the 150,000-token pruning
 * budget") is a number no model can reconcile with the window it was trained
 * to watch, and in production it read as a catastrophic emergency - the model
 * quoted "999% of pruning budget" back as "that's critical" and panic-pruned
 * while the real occupancy was 12% of the window.
 *
 * A measurement above the window is a known-bad estimate, not a bigger
 * context: provider usage counts cache reads and a token estimate is
 * chars/4, so the two arms of the estimate routinely overshoot. Printing
 * "168% of the model window" hands the model a number it cannot trust at all
 * (it read one as "165% / 167% / 168% of the model window" across turns and
 * concluded the measurements were broken), so the over-window case is stated
 * in plain words and NO percentage above 100% of the window is ever emitted.
 */
export function contextUsage(tokens: number, window: number): string {
  if (window <= 0) return `~${tokenLabel(tokens)} tokens (model window size unknown)`;
  return `~${tokenLabel(tokens)} tokens: ${windowShare(tokens, window)}`;
}

/**
 * The pruning budget's relation to the measurement, in plain words. Never a
 * percentage: the budget is a threshold, and "114% of the budget" is the
 * number the model over-read. Returns a leading connector so the caller
 * appends its own verdict (" - prune now.") without a second sentence.
 */
export function budgetClause(tokens: number, budget: number): string {
  return tokens >= budget
    ? ` and above the ${tokenLabel(budget)}-token pruning budget`
    : `. The ${tokenLabel(budget)}-token pruning budget is not reached`;
}

/**
 * Share of the window as a phrase. Single source of the window spelling for
 * both the leading clause (`contextUsage`) and the legacy parenthetical
 * (`windowClause`), so the two can never drift into different numbers.
 */
function windowShare(tokens: number, window: number): string {
  if (tokens > window) {
    return `this is over the ${tokenLabel(window)}-token model window (an over-estimate - the window is full)`;
  }
  return `${percentOf(tokens, window)}% of the ${tokenLabel(window)}-token model window`;
}

/**
 * Window parenthetical for model-facing copy, for call sites that already
 * carry a different denominator in the same sentence (the prune tool's usage
 * note). The budget and the window are different denominators, and quoting
 * only one of them is what makes a percentage read as stale or
 * contradictory. Omitted when the window is unknown (0) or is itself the
 * budget; delegates to the same `windowShare` spelling the leading clause
 * uses.
 *
 * New copy should prefer `contextUsage` + `budgetClause`, which lead with the
 * window instead of burying it.
 */
export function windowClause(tokens: number, budget: number, window: number): string {
  if (window <= 0 || window <= budget) return "";
  return ` (${windowShare(tokens, window)})`;
}
