import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveLimit, resolveOptions } from "../lib/config";
import { UsageTracker, maybeContextNudge, maybeIterationNudge, maybePruneAck, usageTotal } from "../lib/nudges";

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
  assert.match(ack ?? "", /60,000 tokens: 43% of the 140,000-token pruning budget/);
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
    /160,000 tokens: 114% of the 140,000-token pruning budget \(~80% of the 200,000-token model window\)/,
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
