/**
 * Guards the two model-facing surfaces whose numbers are quoted in more than
 * one place: the copy text and the code enforcing it.
 *
 * Regression context: `PRUNE_RANGE` hardcoded `max(32, 1/4 of the standing
 * summary)` while `prune-tool.ts` enforced a different floor, and the two
 * drifted silently. The other direction is the pressure copy, which led with
 * the pruning budget and made the model read `999% of the budget` as a
 * full context window.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  budgetClause,
  contextUsage,
  ZERO_GAIN_MIN_TOKENS,
  ZERO_GAIN_STANDING_SUMMARY_FRACTION,
} from "../lib/constants";
import { CONTEXT_LIMIT_NUDGE, POST_PRUNE_ACK, PRUNE_RANGE } from "../lib/prompts";
import { ZERO_GAIN_MIN_TOKENS as REEXPORTED } from "../lib/prune-tool";

const BUDGET = 150_000;
const WINDOW = 1_048_576;

test("prune-tool re-exports the single zero-gain constant", () => {
  assert.equal(
    REEXPORTED,
    ZERO_GAIN_MIN_TOKENS,
    "prune-tool must re-export constants.ts, not declare its own copy",
  );
});

test("PRUNE_RANGE quotes the enforced zero-gain floor, not a stale one", () => {
  assert.ok(
    PRUNE_RANGE.includes(`at least ${ZERO_GAIN_MIN_TOKENS} tokens`),
    `PRUNE_RANGE must state the enforced minimum (${ZERO_GAIN_MIN_TOKENS})`,
  );
  const percent = (ZERO_GAIN_STANDING_SUMMARY_FRACTION * 100).toFixed(0);
  assert.ok(
    PRUNE_RANGE.includes(`at most ${percent}%`),
    `PRUNE_RANGE must state the enforced fraction (${percent}%)`,
  );
  // The pre-fix text is the exact failure mode: copy said max(32, 1/4).
  assert.ok(!PRUNE_RANGE.includes("max(32"), "stale max(32, ...) rule is gone");
  assert.ok(!PRUNE_RANGE.includes("1/4 of the standing"), "stale 1/4 rule is gone");
});

test("PRUNE_RANGE tells the model the ID ordering it may rely on", () => {
  // The model gave up on pruning after `startId m0006 appears after endId
  // m0129`; the fix is the dense per-dispatch projection, and this sentence is
  // what lets the model act on it.
  assert.match(PRUNE_RANGE, /strictly ascending in transcript order/);
  assert.match(PRUNE_RANGE, /renumbered every dispatch/);
});

test("a range spanning the whole transcript is described as valid", () => {
  // Production model repeatedly tried whole-transcript ranges and read the
  // failure as a bug; state up front that it is the cheapest option.
  assert.match(PRUNE_RANGE, /m0001 to the last ID/);
});

test("pressure copy never leads with a percentage of the pruning budget", () => {
  for (const [label, text] of [
    ["nudge", CONTEXT_LIMIT_NUDGE(500_000, BUDGET, WINDOW)],
    ["ack", POST_PRUNE_ACK(500_000, BUDGET, WINDOW, "b1", true, 3)],
  ] as const) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\d+% of the ${BUDGET.toLocaleString()}-token pruning budget`),
      `${label} must not headline a percentage of the budget`,
    );
    assert.match(text, /model window/, `${label} must name the window`);
  }
});

test("contextUsage never prints a bare over-100% window percentage", () => {
  // 168% of the window is what the model was shown on a transcript that was
  // really at 12%; a bare >100% figure is indistinguishable from a real
  // overflow, so it is phrased in words instead.
  const over = contextUsage(1_760_000, WINDOW);
  assert.match(over, /over the 1,048,576-token model window/);
  assert.doesNotMatch(over, /\d{3}%/, "no raw window percentage above the window");
  // A plausible ratio still prints a normal percentage.
  assert.match(contextUsage(125_000, WINDOW), /12% of the 1,048,576-token model window/);
});

test("budgetClause states the budget as a threshold, both directions", () => {
  assert.match(budgetClause(500_000, BUDGET), /above the 150,000-token pruning budget/);
  assert.match(budgetClause(100_000, BUDGET), /150,000-token pruning budget is not reached/);
  // The verdict and the clause come from the same comparison, so the
  // contradiction the model reported ("the budget is exceeded but the tool says
  // under budget") cannot be rendered.
  for (const usage of [0, 1, 100_000, BUDGET, BUDGET + 1, 500_000, 2_000_000]) {
    const text = CONTEXT_LIMIT_NUDGE(usage, BUDGET, WINDOW);
    const over = usage >= BUDGET;
    assert.equal(
      text.includes("- prune now."),
      over,
      `verdict must follow the budget comparison at ${usage}`,
    );
    assert.equal(
      text.includes("- no pruning needed."),
      !over,
      `verdict must follow the budget comparison at ${usage}`,
    );
  }
});

test("an unknown window still renders a defined denominator", () => {
  // Every percentage resolves against a defined window, so a reminder never
  // has to omit its parenthetical.
  const text = CONTEXT_LIMIT_NUDGE(500_000, BUDGET, 0);
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /NaN|Infinity|undefined/);
});
