import type { DcpOptions } from "./config"
import { resolveLimit } from "./config"
import { CONTEXT_LIMIT_NUDGE, ITERATION_NUDGE } from "./prompts"

/**
 * Context-pressure nudges. Context occupancy is estimated two ways, and the
 * larger of the two arms the reminder (see `injectNudges` in transform.ts):
 * provider usage events (`session.usage.updated`, tracked per session by the
 * event pump) and the per-dispatch transcript measurement taken in the
 * context hook - the measurement is the floor that keeps the gate armed when
 * the tracker is blind (process restart, revert/compaction reset). When the
 * estimate crosses the configured budget, a reminder is appended to the
 * outbound transcript asking the model to run `prune`.
 *
 * Rate limiting: at most one active nudge per
 * `nudgeFrequency` transcript messages; anchors clear when a compression
 * completes.
 */

export interface UsageInfo {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function usageTotal(usage: UsageInfo | undefined): number {
  if (!usage) return 0
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

/**
 * Tracks CURRENT context occupancy per session.
 *
 * `session.usage.updated` events carry SESSION-LIFETIME CUMULATIVE totals
 * (core increments a per-session row on every step and publishes the row).
 * The current context size is therefore the DELTA between consecutive
 * events - roughly the last step's input + cache traffic + its output,
 * which is what will occupy the window going forward.
 *
 * The first observation after construction/reset only establishes the
 * baseline (usage reads 0); every later event updates `current` to the
 * latest clamped delta. Reverts can decrement the cumulative row, hence
 * clamping at 0.
 */
export class UsageTracker {
  private readonly baseline = new Map<string, UsageInfo>()
  private readonly current = new Map<string, number>()

  record(sessionId: string, tokens: UsageInfo): void {
    const base = this.baseline.get(sessionId)
    this.baseline.set(sessionId, { ...tokens })
    if (!base) {
      this.current.delete(sessionId)
      return
    }
    const delta = usageTotal(tokens) - usageTotal(base)
    this.current.set(sessionId, Math.max(0, delta))
  }

  /** Estimated current context size in tokens for the session. */
  totalFor(sessionId: string): number {
    return this.current.get(sessionId) ?? 0
  }

  reset(sessionId: string): void {
    this.baseline.delete(sessionId)
    this.current.delete(sessionId)
  }
}

/**
 * Decides whether a context nudge should be injected and returns the reminder
 * text, or undefined. Mutates nudge anchors in session state.
 */
export function maybeContextNudge(input: {
  state: { nudgeAnchors: number[] }
  config: DcpOptions
  usageTokens: number
  modelContextLimit: number
  messageCount: number
}): string | undefined {
  const { state, config, messageCount } = input
  const budget = resolveLimit(config.maxContextLimit, input.modelContextLimit)
  if (budget <= 0 || input.usageTokens <= 0) return undefined

  // Rate limit: one nudge per nudgeFrequency messages.
  const lastAnchor = state.nudgeAnchors.at(-1) ?? Number.NEGATIVE_INFINITY
  if (state.nudgeAnchors.length > 0 && messageCount - lastAnchor < config.nudgeFrequency) {
    return undefined
  }

  if (input.usageTokens < budget) return undefined

  state.nudgeAnchors.push(messageCount)
  if (state.nudgeAnchors.length > 8) state.nudgeAnchors.shift()
  const percent = Math.min(999, Math.round((input.usageTokens / Math.max(1, input.modelContextLimit)) * 100))
  return CONTEXT_LIMIT_NUDGE(percent, `${budget.toLocaleString()} tokens`)
}

/** Iteration nudge: many assistant-only messages since the last user turn. */
export function maybeIterationNudge(input: {
  config: DcpOptions
  messagesSinceUserTurn: number
}): string | undefined {
  const threshold = input.config.iterationNudgeThreshold
  if (threshold <= 0) return undefined
  if (input.messagesSinceUserTurn < threshold) return undefined
  return ITERATION_NUDGE(input.messagesSinceUserTurn)
}
