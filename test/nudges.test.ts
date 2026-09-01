import assert from "node:assert/strict"
import { test } from "node:test"

import { resolveLimit, resolveOptions } from "../lib/config"
import { UsageTracker, maybeContextNudge, maybeIterationNudge, usageTotal } from "../lib/nudges"

const CONFIG = resolveOptions(undefined, () => {})

test("usageTotal sums all token buckets", () => {
  assert.equal(
    usageTotal({ input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 20 }),
    200,
  )
  assert.equal(usageTotal(undefined), 0)
})

test("context nudge fires at the configured budget and rate-limits", () => {
  const state = { nudgeAnchors: [] as number[] }

  // Below budget (70% of 200000 = 140000): silent.
  const quiet = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 100_000,
    modelContextLimit: 200_000,
    messageCount: 5,
  })
  assert.equal(quiet, undefined)
  assert.deepEqual(state.nudgeAnchors, [])

  // Crossing the budget arms the reminder.
  const first = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 150_000,
    modelContextLimit: 200_000,
    messageCount: 10,
  })
  assert.ok(first?.includes("dcp-system-reminder"))
  assert.deepEqual(state.nudgeAnchors, [10])

  // Within the frequency window: suppressed.
  const limited = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 160_000,
    modelContextLimit: 200_000,
    messageCount: 12,
  })
  assert.equal(limited, undefined)

  // Past the window it reminds again.
  const again = maybeContextNudge({
    state,
    config: CONFIG,
    usageTokens: 170_000,
    modelContextLimit: 200_000,
    messageCount: 15,
  })
  assert.ok(again)
  assert.deepEqual(state.nudgeAnchors, [10, 15])
})

test("absolute token budgets and unknown windows behave sanely", () => {
  const absolute = resolveOptions({ maxContextLimit: 50_000 }, () => {})
  const state = { nudgeAnchors: [] as number[] }
  const hit = maybeContextNudge({
    state,
    config: absolute,
    usageTokens: 60_000,
    modelContextLimit: 200_000,
    messageCount: 3,
  })
  assert.ok(hit?.includes("50,000 tokens"))

  // A bare numeric string is absolute tokens, not a percentage.
  const numericString = resolveOptions({ maxContextLimit: "70000" }, () => {})
  assert.equal(numericString.maxContextLimit, "70000")
  assert.equal(resolveLimit(numericString.maxContextLimit, 200_000), 70_000)
  const stringHit = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: numericString,
    usageTokens: 80_000,
    modelContextLimit: 200_000,
    messageCount: 2,
  })
  assert.ok(stringHit?.includes("70,000 tokens"))

  // Percentage strings stay relative to the window.
  assert.equal(resolveLimit("35%", 200_000), 70_000)

  // Malformed values fall back to the default.
  const invalid = resolveOptions({ maxContextLimit: "abc" }, () => {})
  assert.equal(invalid.maxContextLimit, CONFIG.maxContextLimit)

  const zeroWindow = maybeContextNudge({
    state: { nudgeAnchors: [] },
    config: CONFIG,
    usageTokens: 500,
    modelContextLimit: 0,
    messageCount: 1,
  })
  assert.equal(zeroWindow, undefined)
})

test("iteration nudge respects its threshold", () => {
  assert.equal(maybeIterationNudge({ config: CONFIG, messagesSinceUserTurn: 30 }), undefined)
  const enabled = resolveOptions({ iterationNudgeThreshold: 5 }, () => {})
  const fired = maybeIterationNudge({ config: enabled, messagesSinceUserTurn: 6 })
  assert.match(fired ?? "", /6 messages/)
})

test("UsageTracker reports per-step deltas of cumulative usage events", () => {
  const tracker = new UsageTracker()
  // First event establishes the baseline only.
  tracker.record("s1", { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 })
  assert.equal(tracker.totalFor("s1"), 0)
  // Second event: delta vs baseline approximates current context size.
  tracker.record("s1", { input: 60, output: 15, reasoning: 2, cacheRead: 12, cacheWrite: 8 })
  assert.equal(tracker.totalFor("s1"), (60 + 15 + 2 + 12 + 8) - 21)
  // Cumulative row can shrink after a revert - clamp at 0.
  tracker.record("s1", { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(tracker.totalFor("s1"), 0)
  tracker.reset("s1")
  tracker.record("s1", { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(tracker.totalFor("s1"), 0)
})

test("UsageTracker seeds occupancy from transcript measurement while blind", () => {
  const tracker = new UsageTracker()

  // Blind (fresh process / post-reset): the dispatch measurement holds, so
  // the first post-restart dispatch is not reported as 0 (issue #1).
  tracker.seed("s1", 145_000)
  assert.equal(tracker.totalFor("s1"), 145_000)

  // Re-seeding tracks the transcript down (post-prune dispatch) as well as up.
  tracker.seed("s1", 40_000)
  assert.equal(tracker.totalFor("s1"), 40_000)

  // Zero/undefined measurements never seed.
  tracker.seed("s2", 0)
  assert.equal(tracker.totalFor("s2"), 0)

  // The first usage event only re-arms the baseline; the seed survives...
  tracker.record("s1", { input: 500_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(tracker.totalFor("s1"), 40_000)
  // ...until a real delta replaces it.
  tracker.record("s1", { input: 540_000, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(tracker.totalFor("s1"), 40_002)

  // Warm tracker ignores seeds: provider-reported deltas are the better
  // estimate.
  tracker.seed("s1", 145_000)
  assert.equal(tracker.totalFor("s1"), 40_002)

  // Reset drops the seed along with the baseline.
  tracker.reset("s1")
  assert.equal(tracker.totalFor("s1"), 0)
})
