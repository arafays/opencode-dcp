import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveLimit, resolveOptions } from "../lib/config";
import { UsageTracker, maybeContextNudge, maybeIterationNudge, maybePruneAck, usageTotal } from "../lib/nudges";
import { CONTEXT_LIMIT_NUDGE } from "../lib/prompts";

const CONFIG = resolveOptions(undefined, () => {});

test("usageTotal sums all token buckets", () => {
  assert.equal(
    usageTotal({ input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 20 }),
    200,
  );
  assert.equal(usageTotal(undefined), 0);
});

test("context nudge fires at the configured budget and rate-limits", () => {
  const state = { nudgeAnchors: [] as number[] };

  // Below budget (70% of 200000 = 140000): silent.
  const quiet = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 100_000,
    modelContextLimit: 200_000,
    messageCount: 5,
  });
  assert.equal(quiet, undefined);
  assert.deepEqual(state.nudgeAnchors, []);

  // Crossing the budget arms the reminder.
  const first = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 150_000,
    modelContextLimit: 200_000,
    messageCount: 10,
  });
  assert.ok(first?.includes("dcp-system-reminder"));
  assert.deepEqual(state.nudgeAnchors, [10]);

  // Within the frequency window: suppressed.
  const limited = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 160_000,
    modelContextLimit: 200_000,
    messageCount: 12,
  });
  assert.equal(limited, undefined);

  // Past the window it reminds again.
  const again = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 170_000,
    modelContextLimit: 200_000,
    messageCount: 15,
  });
  assert.ok(again);
  assert.deepEqual(state.nudgeAnchors, [10, 15]);
});

test("absolute token budgets and unknown windows behave sanely", () => {
  const absolute = resolveOptions({ maxContextLimit: 50_000 }, () => {});
  const state = { nudgeAnchors: [] as number[] };
  const hit = maybeContextNudge({
    state,
    config: absolute,
    usageTokens: 60_000,
    modelContextLimit: 200_000,
    messageCount: 3,
  });
  assert.ok(hit?.includes("50,000-token pruning budget"), hit);

  // A bare numeric string is absolute tokens, not a percentage.
  const numericString = resolveOptions({ maxContextLimit: "70000" }, () => {});
  assert.equal(numericString.maxContextLimit, "70000");
  assert.equal(resolveLimit(numericString.maxContextLimit, 200_000), 70_000);
  const stringHit = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: numericString,
    usageTokens: 80_000,
    modelContextLimit: 200_000,
    messageCount: 2,
  });
  assert.ok(stringHit?.includes("70,000-token pruning budget"), stringHit);

  // Percentage strings stay relative to the window.
  assert.equal(resolveLimit("35%", 200_000), 70_000);

  // Malformed values fall back to the default.
  const invalid = resolveOptions({ maxContextLimit: "abc" }, () => {});
  assert.equal(invalid.maxContextLimit, CONFIG.maxContextLimit);

  const zeroWindow = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: CONFIG,
    usageTokens: 500,
    modelContextLimit: 0,
    messageCount: 1,
  });
  assert.equal(zeroWindow, undefined);
});

test("iteration nudge respects its threshold", () => {
  assert.equal(maybeIterationNudge({ config: CONFIG, messagesSinceUserTurn: 30 }), undefined);
  const enabled = resolveOptions({ iterationNudgeThreshold: 5 }, () => {});
  const fired = maybeIterationNudge({ config: enabled, messagesSinceUserTurn: 6 });
  assert.match(fired ?? "", /6 messages/);
});

test("UsageTracker reports per-step deltas of cumulative usage events", () => {
  const tracker = new UsageTracker();
  // First event establishes the baseline only.
  tracker.record("s1", { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 });
  assert.equal(tracker.totalFor("s1"), 0);
  // Second event: delta vs baseline approximates current context size.
  tracker.record("s1", { input: 60, output: 15, reasoning: 2, cacheRead: 12, cacheWrite: 8 });
  assert.equal(tracker.totalFor("s1"), 60 + 15 + 2 + 12 + 8 - 21);
  // Cumulative row can shrink after a revert - clamp at 0.
  tracker.record("s1", { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.totalFor("s1"), 0);
  tracker.reset("s1");
  tracker.record("s1", { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.totalFor("s1"), 0);
});

test("UsageTracker seeds occupancy from transcript measurement while blind", () => {
  const tracker = new UsageTracker();

  // Blind (fresh process / post-reset): the dispatch measurement holds, so
  // the first post-restart dispatch is not reported as 0 (issue #1).
  tracker.seed("s1", 145_000);
  assert.equal(tracker.totalFor("s1"), 145_000);

  // Re-seeding tracks the transcript down (post-prune dispatch) as well as up.
  tracker.seed("s1", 40_000);
  assert.equal(tracker.totalFor("s1"), 40_000);

  // Zero/undefined measurements never seed.
  tracker.seed("s2", 0);
  assert.equal(tracker.totalFor("s2"), 0);

  // The first usage event only re-arms the baseline; the seed survives...
  tracker.record("s1", { input: 500_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.totalFor("s1"), 40_000);
  // ...until a real delta replaces it.
  tracker.record("s1", { input: 540_000, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.totalFor("s1"), 40_002);

  // Warm tracker ignores seeds: provider-reported deltas are the better
  // estimate.
  tracker.seed("s1", 145_000);
  assert.equal(tracker.totalFor("s1"), 40_002);

  // Reset drops the seed along with the baseline.
  tracker.reset("s1");
  assert.equal(tracker.totalFor("s1"), 0);
});

test("UsageTracker flags estimates recorded before a prune as stale", () => {
  const tracker = new UsageTracker();
  tracker.record("s1", { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  tracker.record("s1", { input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.totalFor("s1"), 150_000);
  assert.equal(tracker.isStale("s1"), false);

  // A prune invalidates the delta: it describes the PRE-prune prompt, which is
  // the stale number that used to re-arm the nudge on the next dispatch. The
  // estimate is zeroed outright and the baseline dropped, so nothing may
  // re-report 150,000.
  tracker.markPruned("s1");
  assert.equal(tracker.isStale("s1"), true);
  assert.equal(tracker.totalFor("s1"), 0);

  // The next usage event still carries the pre-prune step's totals: without a
  // baseline it only re-arms the delta machinery, so the estimate stays 0 and
  // staleness stands - consumers must trust the transcript measurement.
  tracker.record("s1", { input: 190_000, output: 1_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.isStale("s1"), true);
  assert.equal(tracker.totalFor("s1"), 0);

  // The event after that is the first honest post-prune delta: freshness is
  // restored with exactly that delta, never the pre-prune number.
  tracker.record("s1", { input: 190_000, output: 5_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tracker.isStale("s1"), false);
  assert.equal(tracker.totalFor("s1"), 4_000);

  // A measurement seeded before the prune is stale too; reset clears epochs.
  tracker.reset("s1");
  assert.equal(tracker.isStale("s1"), false);
  tracker.seed("s1", 80_000);
  tracker.markPruned("s1");
  assert.equal(tracker.isStale("s1"), true);
  assert.equal(tracker.totalFor("s1"), 0);

  // markPruned dropped the baseline, so seeding works AGAIN after a prune:
  // the next dispatch's measurement restores the estimate and records against
  // the current epoch, clearing staleness outright (a fresh measurement is a
  // current number, not the pre-prune delta).
  tracker.seed("s1", 80_000);
  assert.equal(tracker.totalFor("s1"), 80_000);
  assert.equal(tracker.isStale("s1"), false);
});

test("post-prune ack fires once, resolves the old reminder, and re-seeds the rate limit", () => {
  const state = { nudgeAnchors: [] as number[], pruneSeq: 0, pruneAckSeq: 0 };
  const dispatch = (messageCount: number, usageTokens: number, blockRef?: string) =>
    maybePruneAck({
      state,
      config: CONFIG,
      usageTokens,
      modelContextLimit: 200_000,
      messageCount,
      blockRef,
    });

  // Nothing pruned yet.
  assert.equal(dispatch(12, 60_000), undefined);

  // applyCompression bumped pruneSeq: the next dispatch answers it once.
  state.pruneSeq = 1;
  const ack = dispatch(12, 60_000, "b7");
  assert.match(ack ?? "", /Prune applied \(b7\)/);
  assert.match(
    ack ?? "",
    /60,000 tokens: 30% of the 200,000-token model window\. The 140,000-token pruning budget is not reached/,
  );
  assert.match(ack ?? "", /No further pruning needed/);
  assert.ok(!ack?.includes("call `prune` on it"), "ack must not re-request a prune");
  assert.equal(state.pruneAckSeq, 1);
  // The ack is itself the rate-limit anchor: no nudge can fire immediately after.
  assert.deepEqual(state.nudgeAnchors, [12]);

  // Second dispatch: already acknowledged, nothing more to say.
  assert.equal(dispatch(13, 61_000), undefined);
  assert.deepEqual(state.nudgeAnchors, [12]);

  // Still above budget after the prune: the ack says so instead of promising quiet.
  state.pruneSeq = 2;
  const over = dispatch(14, 160_000);
  assert.match(
    over ?? "",
    /160,000 tokens: 80% of the 200,000-token model window and above the 140,000-token pruning budget/,
  );
  assert.match(over ?? "", /Still above the pruning budget/);
  assert.deepEqual(state.nudgeAnchors, [12, 14]);
});

test("post-prune ack calls out a zero-message re-summarize while over budget", () => {
  const state = { nudgeAnchors: [] as number[], pruneSeq: 1, pruneAckSeq: 0 };
  const dispatch = (usageTokens: number, messagesCovered?: number) =>
    maybePruneAck({
      state,
      config: CONFIG,
      usageTokens,
      modelContextLimit: 200_000,
      messageCount: 20,
      blockRef: "b3",
      messagesCovered,
    });

  // Over budget + a pure re-summarize (messagesCovered 0): the ack forbids
  // repeating the pass and points at content outside the compressed sections.
  const zero = dispatch(160_000, 0);
  assert.match(zero ?? "", /Prune applied \(b3\)/);
  assert.match(zero ?? "", /covered no new messages/);
  assert.ok(!zero?.includes("Still above the pruning budget"), zero);

  // Over budget + messages actually covered: the standard wording.
  state.pruneSeq = 2;
  const covered = dispatch(160_000, 4);
  assert.match(covered ?? "", /Still above the pruning budget/);

  // Over budget + the field absent (older callers): same standard wording -
  // only an explicit 0 is a re-summarize.
  state.pruneSeq = 3;
  const absent = dispatch(160_000);
  assert.match(absent ?? "", /Still above the pruning budget/);

  // Under budget: unchanged regardless of messagesCovered.
  state.pruneSeq = 4;
  const under = dispatch(60_000, 0);
  assert.match(under ?? "", /No further pruning needed/);
});

// -- pressure copy: window-first, no panic-inducing percentages ---------------
//
// Production defect these lock down: every pressure message led with a
// percentage of the PLUGIN-INTERNAL pruning budget ("999% of the 150,000-token
// pruning budget (~166% of the 1,048,576-token model window)"), and the model
// read the headline as an emergency - "the context is at 493k tokens, way over.
// I MUST prune", "the reminder says 999% of pruning budget... That's critical",
// "Context is 165% / 167% / 168% of the model window" - and reported the
// measurements as inconsistent when the prune tool said "under budget".

/** Every "N% of the ... model window" percentage in a message, as numbers. */
const windowPercents = (text: string) =>
  [...text.matchAll(/(\d+)% of the [\d,]+-token model window/g)].map((m) => Number(m[1]));

/** The token label + window-share clause the message leads its measurement with. */
const leadingClause = (text: string) =>
  /~[\d,]+ tokens: [^.]*model window[^.]*\./.exec(text)?.[0] ?? "";

/** The measurement clause with the nudge's own call to action stripped. */
const measurement = (text: string) => leadingClause(text).replace(/ - prune now\.$/, ".");

test("nudge and ack lead with the model window, never a budget percentage", () => {
  // Absolute 150,000 budget against the real 1,048,576 window - the exact
  // configuration that produced "999% of the pruning budget" in production.
  const config = resolveOptions({ maxContextLimit: 150_000 }, () => {});
  const state = { nudgeAnchors: [] as number[], pruneSeq: 0, pruneAckSeq: 0 };
  const usageTokens = 780_000; // 74% of the window, 5x the budget.
  const window = 1_048_576;

  const nudge = maybeContextNudge({
    state,
    config,
    usageTokens,
    modelContextLimit: window,
    messageCount: 1,
  });
  assert.ok(nudge, "780k is well over the 150k budget, so the nudge must arm");

  state.pruneSeq = 1;
  const ack = maybePruneAck({
    state,
    config,
    usageTokens,
    modelContextLimit: window,
    messageCount: 2,
  });
  assert.ok(ack, "a completed prune must be acknowledged once");

  for (const [label, text] of [
    ["nudge", nudge],
    ["ack", ack],
  ] as const) {
    // The LEADING measurement names the window, not the budget: 780k/1,048,576
    // = 74%, and the 150k budget is a secondary plain threshold. The old copy
    // led with "520% of the 150,000-token pruning budget" here.
    assert.match(
      text,
      /~780,000 tokens: 74% of the 1,048,576-token model window and above the 150,000-token pruning budget/,
      label,
    );
    assert.ok(
      text.indexOf("model window") < text.indexOf("pruning budget"),
      `${label} must name the window before the budget: ${text}`,
    );
    // No budget percentage anywhere: not even parenthetically.
    assert.ok(
      !/\d+% of the [\d,]+-token pruning budget/.test(text),
      `${label} must not print a percentage of the budget: ${text}`,
    );
    // The window share is the real ratio - never a 999% / 168% style figure.
    assert.deepEqual(windowPercents(text), [74], label);
  }

  // Both messages use the SAME number format for the same inputs. (The nudge
  // appends its own call to action; the ack resolves the reminder and states
  // whether another pass is warranted - the NUMBERS must be identical.)
  assert.equal(measurement(nudge), measurement(ack));
  assert.equal(
    measurement(nudge),
    "~780,000 tokens: 74% of the 1,048,576-token model window and above the 150,000-token pruning budget.",
  );
});

test("a measurement above the window says the window is exceeded, not 168%", () => {
  const state = { nudgeAnchors: [] as number[], pruneSeq: 0, pruneAckSeq: 0 };
  // The real transcript case: 1,498,500 tokens against a 1,048,576 window,
  // which the old copy rendered as "999% of the 150,000-token pruning budget
  // (~166% of the 1,048,576-token model window)".
  const config = resolveOptions({ maxContextLimit: 150_000 }, () => {});
  const usageTokens = 1_498_500;
  const window = 1_048_576;

  const nudge = maybeContextNudge({
    state,
    config,
    usageTokens,
    modelContextLimit: window,
    messageCount: 1,
  });
  assert.ok(nudge);
  state.pruneSeq = 1;
  const ack = maybePruneAck({
    state,
    config,
    usageTokens,
    modelContextLimit: window,
    messageCount: 2,
  });
  assert.ok(ack);

  for (const [label, text] of [
    ["nudge", nudge],
    ["ack", ack],
  ] as const) {
    assert.match(
      text,
      /~1,498,500 tokens: this is over the 1,048,576-token model window/,
      label,
    );
    // No percentage of the window is emitted at all once the ratio exceeds
    // 100%: "142% of the model window" is exactly the unreadable figure to
    // avoid, and the model quoted it back as an emergency.
    assert.deepEqual(windowPercents(text), [], label);
    assert.ok(
      !/\b1[0-9]{2}%/.test(text),
      `${label} must not print an over-100% window ratio: ${text}`,
    );
    // The over-estimate is labelled as one, so the model trusts the number
    // instead of concluding the measurements are inconsistent.
    assert.match(text, /\(an over-estimate - the window is full\)/, label);
    // The budget is still named as a plain threshold (never a percentage), and
    // the ask is unchanged: the nudge orders the prune, the ack states whether
    // another pass is warranted.
    assert.match(text, /and above the 150,000-token pruning budget\b/, label);
  }
  assert.match(nudge, /and above the 150,000-token pruning budget - prune now\./);
  assert.match(ack, /Still above the pruning budget/);

  // Just past the window (rounds to 100%) still reads as exceeded, not 100%.
  const justOver = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: CONFIG,
    usageTokens: 100_001,
    modelContextLimit: 100_000,
    messageCount: 1,
  });
  assert.match(justOver ?? "", /this is over the 100,000-token model window/);
  assert.deepEqual(windowPercents(justOver ?? ""), []);

  // Exactly at the window is a legitimate 100%.
  const atWindow = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: CONFIG,
    usageTokens: 100_000,
    modelContextLimit: 100_000,
    messageCount: 1,
  });
  assert.match(atWindow ?? "", /100,000 tokens: 100% of the 100,000-token model window/);
});

test("the budget is named as a plain threshold in both directions", () => {
  const window = 200_000; // 70% budget = 140,000.

  // Under budget: the ack says the budget is not reached - never "43% of the
  // 140,000-token pruning budget" followed by a prune request.
  const state = { nudgeAnchors: [] as number[], pruneSeq: 1, pruneAckSeq: 0 };
  const under = maybePruneAck({
    state,
    config: CONFIG,
    usageTokens: 60_000,
    modelContextLimit: window,
    messageCount: 5,
  });
  assert.match(
    under ?? "",
    /~60,000 tokens: 30% of the 200,000-token model window\. The 140,000-token pruning budget is not reached\./,
  );
  assert.match(under ?? "", /No further pruning needed/);

  // Over budget: both denominators stated plainly, window first.
  state.pruneSeq = 2;
  const over = maybePruneAck({
    state,
    config: CONFIG,
    usageTokens: 140_000,
    modelContextLimit: window,
    messageCount: 6,
    messagesCovered: 3,
  });
  assert.match(
    over ?? "",
    /~140,000 tokens: 70% of the 200,000-token model window and above the 140,000-token pruning budget/,
  );
  assert.match(over ?? "", /Still above the pruning budget/);
});

test("the nudge's own verdict never contradicts its budget clause", () => {
  // Exported directly, below budget: the clause and the trailing verdict must
  // agree. (The gate in maybeContextNudge never renders this, but the two
  // sentences are built from the same comparison, so they cannot disagree.)
  const under = CONTEXT_LIMIT_NUDGE(125_000, 150_000, 1_048_576);
  assert.match(
    under,
    /~125,000 tokens: 12% of the 1,048,576-token model window\. The 150,000-token pruning budget is not reached - no pruning needed\./,
  );
  assert.ok(!under.includes("prune now"), under);

  // At budget it is the other branch, and the wording is the target shape.
  const at = CONTEXT_LIMIT_NUDGE(150_000, 150_000, 1_048_576);
  assert.match(
    at,
    /~150,000 tokens: 14% of the 1,048,576-token model window and above the 150,000-token pruning budget - prune now\./,
  );
});

test("below-budget usage still returns undefined (the gate is unchanged)", () => {
  const state = { nudgeAnchors: [] as number[] };
  // 60,000 tokens is 30% of the 200,000 window and well under the 140,000
  // budget: no reminder, and no anchor consumed.
  assert.equal(
    maybeContextNudge({
      state,
      config: CONFIG,
      usageTokens: 60_000,
      modelContextLimit: 200_000,
      messageCount: 1,
    }),
    undefined,
  );
  assert.deepEqual(state.nudgeAnchors, []);

  // One token under the budget is still silent; the nudge is >= the budget.
  assert.equal(
    maybeContextNudge({
      state,
      config: CONFIG,
      usageTokens: 139_999,
      modelContextLimit: 200_000,
      messageCount: 2,
    }),
    undefined,
  );
  assert.deepEqual(state.nudgeAnchors, []);

  // And at the budget it fires - the boundary is unchanged.
  assert.ok(
    maybeContextNudge({
      state,
      config: CONFIG,
      usageTokens: 140_000,
      modelContextLimit: 200_000,
      messageCount: 3,
    }),
  );
  assert.deepEqual(state.nudgeAnchors, [3]);

  // An unknown window (0) still suppresses everything.
  assert.equal(
    maybeContextNudge({
      state: { nudgeAnchors: [] },
      config: CONFIG,
      usageTokens: 500,
      modelContextLimit: 0,
      messageCount: 1,
    }),
    undefined,
  );
});

test("an absolute budget above the window still resolves a defined window phrase", () => {
  // maxContextLimit as an absolute token count LARGER than the catalog window
  // (a misconfiguration, but one that must not produce unreadable copy): the
  // measurement exceeds the window, so the window clause takes the plain-words
  // branch and the budget is still named as a plain threshold.
  const loose = resolveOptions({ maxContextLimit: 500_000 }, () => {});
  const text = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: loose,
    usageTokens: 600_000,
    modelContextLimit: 200_000,
    messageCount: 1,
  });
  assert.match(text ?? "", /600,000 tokens: this is over the 200,000-token model window/);
  assert.match(text ?? "", /above the 500,000-token pruning budget - prune now\./);
  assert.deepEqual(windowPercents(text ?? ""), []);

  // Budget equal to the window: the model window is the only denominator, and
  // it is still named in the leading clause (at 200,000 it is exactly full).
  const equal = resolveOptions({ maxContextLimit: 200_000 }, () => {});
  const atBudget = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: equal,
    usageTokens: 200_000,
    modelContextLimit: 200_000,
    messageCount: 1,
  });
  assert.match(
    atBudget ?? "",
    /200,000 tokens: 100% of the 200,000-token model window and above the 200,000-token pruning budget/,
  );
});
