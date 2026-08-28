import type { DcpOptions } from "./config"
import type { Logger } from "./logger"
import { maybeContextNudge, maybeIterationNudge, type UsageTracker } from "./nudges"
import { applyCompressionBlocks, injectBoundaryTags, pruneToolOutputs } from "./prune"
import { createSyntheticBlockMessage } from "./transcript/edit"
import type { TranscriptMirror } from "./transcript/mirror"
import { scanTranscript } from "./transcript/scan"
import type { StateStore } from "./state/store"
import type { SessionState } from "./state/types"
import {
  buildStatsSnapshot,
  estimateTokens,
  measureMessagesChars,
  writeTuiStats,
  type DispatchMetrics,
  type SessionTotals,
  type TuiStatsSnapshot,
} from "./tui-bridge"
import { SYSTEM } from "./prompts"
import type { SystemPart, WireMessage } from "./types"

/**
 * The `ctx.session.hook("context", ...)` handler. Runs on every outbound model
 * dispatch and applies the full DCP pipeline to the transcript copy:
 *
 *   scan -> refs -> block application -> pruning -> boundary tags -> nudges
 *
 * All edits are outbound-only: array slots are replaced/spliced, never
 * deep-mutating stored session messages.
 */

/** Built-in agents whose prompts must stay untouched. */
const INTERNAL_AGENTS = new Set(["title", "compaction", "summary"])

export const SYSTEM_PROMPT_MARKER = "You operate in a context-constrained environment."

export interface SessionContextEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  system: SystemPart[]
  messages: WireMessage[]
}

export interface TransformDeps {
  config: DcpOptions
  logger: Logger
  store: StateStore
  mirror: TranscriptMirror
  usage: UsageTracker
  isSubAgent(sessionId: string): Promise<boolean>
  catalogContextLimit(providerID: string, modelId: string): Promise<number | undefined>
  /** Publishes per-session stats to the TUI companion (optional). */
  publishStats?(input: {
    sessionId: string
    model?: string
    dispatch: DispatchMetrics
    totals: SessionTotals
  }): void
}

/** Summarizes persisted session state for the TUI snapshot. */
export function sessionTotals(state: SessionState): SessionTotals {
  const active = state.activeBlockIds
    .map((id) => state.blocks[String(id)])
    .filter((block): block is NonNullable<typeof block> => block !== undefined)
  return {
    dispatches: state.stats.dispatches,
    compressRuns: state.stats.compressRuns,
    blocksActive: active.length,
    blocksTotal: Object.keys(state.blocks).length,
    blockTokensCovered: active.reduce((sum, block) => sum + Math.max(0, block.compressedTokens), 0),
    blockTokensSummaries: active.reduce((sum, block) => sum + Math.max(0, block.summaryTokens), 0),
    prunedTokensTotal: Math.max(0, state.stats.totalPrunedTokens),
    messagesCompressedActive: new Set(active.flatMap((block) => block.coveredKeys)).size,
  }
}

export function createContextHook(deps: TransformDeps) {
  return async function handleContext(event: SessionContextEvent): Promise<void> {
    try {
      if (INTERNAL_AGENTS.has(event.agent)) return
      const messages = event.messages
      if (!Array.isArray(messages) || messages.length === 0) return

      const sessionId = event.sessionID
      const runtime = await deps.store.ensure(sessionId)

      // Mirror first so the compress tool always has a fresh view.
      const index = scanTranscript(messages)
      deps.mirror.update(sessionId, index)

      if (!deps.config.allowSubAgents && (await deps.isSubAgent(sessionId))) {
        deps.logger.debug("skipping sub-agent session", { sessionId })
        return
      }

      const charsBefore = measureMessagesChars(messages)

      injectSystemPrompt(event)
      assignRefs(runtime.refs, index.keys)

      applyCompressionBlocks(runtime.state, messages, index.keys)
      pruneToolOutputs(runtime.state, messages, deps.config)

      // `messages` was mutated by the transforms above (covered ranges removed,
      // synthetic block messages spliced), so its indices no longer line up with
      // the pre-compression `index.keys`. Re-scan to get the post-compression key
      // list before injecting boundary tags, otherwise the model sees misaligned
      // (and conflicting) mNNNN IDs after the first compression.
      const postIndex = scanTranscript(messages)
      injectBoundaryTags(runtime.refs.byKey, messages, postIndex.keys)

      await injectNudges(deps, event, postIndex.keys.length, runtime.state)

      publishDispatchStats(deps, {
        sessionId,
        model: `${event.model.providerID}/${event.model.id}`,
        agent: event.agent,
        messagesIn: messages.length,
        charsBefore,
        charsAfter: measureMessagesChars(messages),
      })
    } catch (error) {
      // A failing hook fails the dispatch - never let DCP break a request.
      deps.logger.warn("context transform failed; passing unmodified context", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function injectSystemPrompt(event: SessionContextEvent): void {
  const alreadyPresent = event.system.some(
    (part) => part.type === "text" && part.text.includes(SYSTEM_PROMPT_MARKER),
  )
  if (alreadyPresent) return
  event.system.push({ type: "text", text: SYSTEM.trimStart() })
}

function assignRefs(refs: { ensure(key: string): string }, keys: string[]): void {
  for (const key of keys) refs.ensure(key)
}

function publishDispatchStats(
  deps: TransformDeps,
  input: {
    sessionId: string
    model: string
    agent: string
    messagesIn: number
    charsBefore: number
    charsAfter: number
  },
): void {
  if (!deps.publishStats) return
  const runtime = deps.store.peek(input.sessionId)
  if (!runtime) return
  runtime.state.stats.dispatches += 1
  try {
    deps.publishStats({
      sessionId: input.sessionId,
      model: input.model,
      dispatch: {
        at: Date.now(),
        agent: input.agent,
        model: input.model,
        messagesIn: input.messagesIn,
        tokensBefore: estimateTokens(input.charsBefore),
        tokensAfter: estimateTokens(input.charsAfter),
      },
      totals: sessionTotals(runtime.state),
    })
  } catch {
    // Display-only bridge.
  }
}

async function injectNudges(
  deps: TransformDeps,
  event: SessionContextEvent,
  messageCount: number,
  state: SessionState,
): Promise<void> {
  const reminders: string[] = []

  const usageTokens = deps.usage.totalFor(event.sessionID)
  if (usageTokens > 0) {
    const limit =
      (await deps.catalogContextLimit(event.model.providerID, event.model.id)) ?? 200_000
    const nudge = maybeContextNudge({
      state,
      config: deps.config,
      usageTokens,
      modelContextLimit: limit,
      messageCount,
    })
    if (nudge) reminders.push(nudge)
  }

  const iterationNudge = maybeIterationNudge({
    config: deps.config,
    messagesSinceUserTurn: countMessagesSinceLastUserTurn(event.messages),
  })
  if (iterationNudge) reminders.push(iterationNudge)

  if (reminders.length > 0 && event.messages.length > 0) {
    event.messages.push(createSyntheticBlockMessage(reminders.join("\n\n")))
  }
}

function countMessagesSinceLastUserTurn(messages: WireMessage[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.role === "user") break
    count++
  }
  return count
}
