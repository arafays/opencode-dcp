import type { DcpOptions } from "./config";
import { NUDGE_ANCHOR_CAP } from "./constants"
import { resolveLimit } from "./config";
import { CONTEXT_LIMIT_NUDGE, ITERATION_NUDGE, POST_PRUNE_ACK, PRUNE_REQUEST_PREFIX } from "./prompts"
import type { WireMessage } from "./types"

/**
 * Context-pressure reminders. Context occupancy is estimated two ways, and
 * the larger of the two arms the reminder (see `injectNudges` in transform.ts):
 * provider usage events (`session.usage.updated`, tracked per session by the
 * event pump) and the per-dispatch transcript measurement taken in the
 * context hook - the measurement is the floor that keeps the gate armed when
 * the tracker is blind (process restart, revert/compaction reset), and it
 * also reseeds the tracker itself (`UsageTracker.seed`) so the blind window
 * supplies an estimate instead of 0. When the
 * estimate crosses the configured budget, a reminder is appended to the
 * outbound transcript asking the model to run `prune`.
 *
 * Staleness: a provider delta recorded BEFORE the newest prune describes the
 * pre-prune prompt. `UsageTracker.markPruned` zeroes that estimate and drops
 * the baseline so it cannot be re-published (the usage event arriving after a
 * prune still carries the pre-prune step's totals), and `UsageTracker.isStale`
 * flags the window where no post-prune delta exists yet - the hook then trusts
 * the measurement alone instead of maxing the stale number back in, otherwise
 * the model is re-nudged with the pre-prune percentage it just acted on. The
 * prune itself is answered once by `maybePruneAck`, which resolves the earlier
 * reminder and states whether another pass is warranted.
 *
 * Rate limiting: at most one active reminder (nudge or ack) per
 * `nudgeFrequency` transcript messages; anchors clear when a compression
 * completes and the ack immediately re-seeds them.
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
 * baseline (usage reads 0, unless seeded); every later event updates
 * `current` to the latest clamped delta. Reverts can decrement the cumulative
 * row, hence clamping at 0.
 *
 * While blind (no baseline yet - fresh process, or a reset after a
 * revert/compaction/deletion), the context hook seeds `current` from its
 * per-dispatch transcript measurement (`seed`), so occupancy is never
 * under-reported across the baseline-rebuild window.
 */
export class UsageTracker {
  private readonly baseline = new Map<string, UsageInfo>()
  private readonly current = new Map<string, number>()
  /** Prune counter per session; bumped by `markPruned`. */
  private readonly epoch = new Map<string, number>()
  /** Epoch at which `current` was recorded (delta or measurement). */
  private readonly currentEpoch = new Map<string, number>()

  record(sessionId: string, tokens: UsageInfo): void {
    const base = this.baseline.get(sessionId)
    this.baseline.set(sessionId, { ...tokens })
    if (!base) {
      // First event after construction/reset - or the event landing right
      // after a prune, whose baseline markPruned dropped - only arms the
      // baseline; keep any seeded estimate in place until a real delta exists.
      return
    }
    const delta = usageTotal(tokens) - usageTotal(base)
    this.current.set(sessionId, Math.max(0, delta))
    this.currentEpoch.set(sessionId, this.epoch.get(sessionId) ?? 0)
  }

  /**
   * Seeds the occupancy estimate from a dispatch-time transcript measurement
   * while the tracker is blind (no baseline yet: fresh process, or a reset
   * after a revert/compaction/deletion). Overwrites on every blind dispatch
   * so the estimate tracks the transcript down (post-prune) as well as up.
   * No-op once the tracker is warm - provider-reported deltas are the better
   * estimate - and dropped by `reset` along with the baseline.
   */
  seed(sessionId: string, tokens: number): void {
    if (tokens <= 0 || this.baseline.has(sessionId)) return
    this.current.set(sessionId, tokens)
    this.currentEpoch.set(sessionId, this.epoch.get(sessionId) ?? 0)
  }

  /** Estimated current context size in tokens for the session. */
  totalFor(sessionId: string): number {
    return this.current.get(sessionId) ?? 0
  }

  /**
   * Marks a prune as having happened: any estimate on hand describes the
   * PRE-prune prompt. The estimate is zeroed outright (nothing may re-report
   * the number the model just acted on) and the baseline is dropped, so the
   * usage event that lands next - whose totals still include the pre-prune
   * step - only re-arms the delta instead of publishing it; the first honest
   * post-prune delta arrives one event after that. Until a real delta or a
   * fresh measurement records against the new epoch, `isStale` tells consumers
   * to trust the transcript measurement instead.
   */
  markPruned(sessionId: string): void {
    this.epoch.set(sessionId, (this.epoch.get(sessionId) ?? 0) + 1)
    this.current.set(sessionId, 0)
    this.baseline.delete(sessionId)
  }

  /**
   * True while `current` predates the newest prune - i.e. `totalFor` would
   * report the pre-prune occupancy, which is exactly the stale number that
   * makes a model re-prune work it already pruned.
   */
  isStale(sessionId: string): boolean {
    return (this.currentEpoch.get(sessionId) ?? 0) < (this.epoch.get(sessionId) ?? 0)
  }

  reset(sessionId: string): void {
    this.baseline.delete(sessionId)
    this.current.delete(sessionId)
    this.epoch.delete(sessionId)
    this.currentEpoch.delete(sessionId)
  }
}

/** Appends a rate-limit anchor, capped so old anchors cannot linger. */
function pushAnchor(state: { nudgeAnchors: number[] }, messageCount: number): void {
  state.nudgeAnchors.push(messageCount)
  if (state.nudgeAnchors.length > NUDGE_ANCHOR_CAP) state.nudgeAnchors.shift()
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

  pushAnchor(state, messageCount)
  // The reminder names both denominators (budget, and the model window when it
  // differs): a bare percentage of the BUDGET is what reads as a wrong or
  // stale number to a model that only knows its window.
  return CONTEXT_LIMIT_NUDGE(input.usageTokens, budget, input.modelContextLimit)
}

/**
 * One-shot reply to a completed prune, returned on the first dispatch after
 * it and undefined everywhere else (the ack sequence is consumed on sight,
 * whether or not a reminder is rendered).
 *
 * It resolves the pressure reminder the model just acted on - whose
 * percentage predates the prune - with a number measured on THIS dispatch,
 * and states whether another pass is warranted. It also re-seeds the
 * rate-limit anchor, so a fresh nudge cannot fire on the very next dispatch
 * with the pre-prune estimate.
 */
export function maybePruneAck(input: {
  state: { pruneSeq: number; pruneAckSeq: number; nudgeAnchors: number[] }
  config: DcpOptions
  usageTokens: number
  modelContextLimit: number
  messageCount: number
  blockRef?: string
  /** Messages the last compression covered; 0 means a pure re-summarize. */
  messagesCovered?: number
}): string | undefined {
  const { state, config } = input
  if (state.pruneSeq <= state.pruneAckSeq) return undefined
  // Consume first: whatever happens next (restart, an unusual budget) the ack
  // cannot repeat for the same prune.
  state.pruneAckSeq = state.pruneSeq
  pushAnchor(state, input.messageCount)

  const budget = resolveLimit(config.maxContextLimit, input.modelContextLimit)
  if (budget <= 0) return undefined
  return POST_PRUNE_ACK(
    input.usageTokens,
    budget,
    input.modelContextLimit,
    input.blockRef,
    input.usageTokens >= budget,
    input.messagesCovered,
  )
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

/**
 * Manual-prune reminders armed by `/dcp-prune` (lib/commands.ts), keyed by
 * session and consumed on sight by the context hook's next dispatch.
 *
 * Process-local and deliberately NOT persisted, unlike everything in
 * `SessionState`: the reminder exists only to ride the dispatch the command
 * itself triggers. Persisting it would let a stale "prune now" survive a
 * restart and fire into whatever the user happens to say next - strictly worse
 * than the command silently doing nothing.
 *
 * Lifecycle guarantees:
 * - One entry per session, so re-arming REPLACES: repeated invocations cannot
 *   accumulate, and there is no queue to drain.
 * - The command disarms when its `session.prompt` rejects, so an entry exists
 *   only while a dispatch is genuinely pending. A queued prompt may legitimately
 *   wait out a long-running turn, so no wall-clock expiry is applied here -
 *   expiry would drop exactly the reminder a queued invocation still needs.
 * - Keyed by session ID, which is what keeps the sub-agent path honest: a
 *   sub-agent dispatch carries its own ID (and `handleContext` skips it outright
 *   unless `allowSubAgents`), so it can neither consume nor strand the parent
 *   session's reminder.
 * - Released ONLY on a dispatch that actually carries the command's stored turn
 *   (`carriesPruneRequest`), never merely because one is the next to happen. See
 *   that function for why "next dispatch" is the wrong trigger, and why the
 *   invocation's own stored text is the match target rather than the shared
 *   opener.
 */
const pendingManualPrune = new Map<string, { reminder: string; marker: string }>()

/**
 * Arms the one-shot reminder for `sessionId`, replacing any earlier one.
 * `marker` defaults to the bare `PRUNE_REQUEST_PREFIX`; `/dcp-prune` passes its
 * invocation's exact stored text, which is what pins the release to THAT
 * invocation.
 */
export function armManualPruneReminder(
  sessionId: string,
  reminder: string,
  marker: string = PRUNE_REQUEST_PREFIX,
): void {
  pendingManualPrune.set(sessionId, { reminder, marker })
}

/**
 * Drops an armed reminder whose prompt never dispatched (the command's
 * `session.prompt` rejected), so it cannot misfire on a later prompt.
 */
export function disarmManualPruneReminder(sessionId: string): void {
  pendingManualPrune.delete(sessionId)
}

/**
 * True when this outbound transcript actually contains the user turn
 * `/dcp-prune` stored - the condition for releasing an armed reminder.
 *
 * Releasing on "the next dispatch" is wrong for any command run mid-turn, which
 * is when a user actually reaches for `/dcp-prune`. The stored turn does not
 * reach the model immediately: `session.prompt` only ADMITS it to the inbox
 * (packages/core/src/session/session.ts:145-160), and the default `steer`
 * delivery is PROMOTED at a step boundary
 * (packages/core/src/session/inbox.ts:44-45, promote at :495-520) while the
 * step loop selects context BEFORE promoting
 * (packages/core/src/session/runner/llm.ts:165-166). So the in-flight turn's
 * next agentic step dispatches without the user's request in it. Releasing on
 * that step hands the model an unrequested "immediately call `prune`" before it
 * has seen the request, and strips the one-pass/batch guidance from the
 * dispatch that does carry it.
 *
 * Matching the armed invocation's own stored text (the marker, defaulting to
 * the bare `PRUNE_REQUEST_PREFIX`) rather than "the newest user turn" keeps
 * working once the user has sent something else afterwards, and stays correct
 * when the stored turn has since been compressed away: an armed reminder whose
 * request is no longer visible simply stops being released rather than
 * misfiring onto an unrelated turn. An EXACT stored text - not just the shared
 * opener - is what keeps an earlier `/dcp-prune`'s stored turn, which stays in
 * the transcript, from releasing a newer reminder on the first in-flight step.
 */
export function carriesPruneRequest(
  messages: readonly WireMessage[],
  marker: string = PRUNE_REQUEST_PREFIX,
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.content.some(
        (part) => part.type === "text" && part.text.startsWith(marker),
      ),
  )
}

/**
 * Consumes the reminder armed by `/dcp-prune`, but only on a dispatch that
 * carries the command's stored turn (see `carriesPruneRequest`); undefined on
 * every other dispatch, armed entry left in place for the one that does. The
 * single `take` IS the injection point (`injectNudges` queues whatever it
 * returns into the same synthetic block as every other reminder), so one
 * invocation can never be replayed onto a later dispatch.
 *
 * Guard order matters: this runs on every dispatch and the map is empty on
 * almost all of them, so the O(1) lookup comes FIRST and the full transcript
 * scan (`carriesPruneRequest`) only runs when a reminder is actually armed.
 */
export function takeManualPruneReminder(sessionId: string, messages: readonly WireMessage[]): string | undefined {
  const entry = pendingManualPrune.get(sessionId)
  if (entry === undefined) return undefined
  if (!carriesPruneRequest(messages, entry.marker)) return undefined
  pendingManualPrune.delete(sessionId)
  return entry.reminder
}
