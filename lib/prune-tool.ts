import type { DcpOptions } from "./config"
import type { Logger } from "./logger"
import { PRUNE_RANGE } from "./prompts"
import { formatBlockRef, parseBlockRef, parseMessageRef } from "./refs"
import { applyCompression, activeBlocks, TAIL_ANCHOR } from "./state/store"
import type { SessionRuntime, StateStore } from "./state/store"
import type { CompressionBlock, SessionState } from "./state/types"
import { countTokens } from "./tokens"
import type { TranscriptIndex } from "./transcript/scan"
import type { TranscriptMirror } from "./transcript/mirror"
import { deduplicate, purgeErrors } from "./strategies"
import { MAX_RECENT_COMPRESSIONS, type CompressionEventRecord } from "./tui-bridge"

/**
 * The model-driven `prune` tool (named to avoid clashing with the platform's
 * default compress/compact tooling). Registered with the platform default
 * (`codemode: true`), which exposes it through the Code Mode `execute`
 * catalog. The model picks conversation ranges using injected
 * boundary IDs (`mNNNN` / `bN`) and writes the summaries; this tool validates
 * the selection, folds in any compression blocks the range consumes, records
 * the resulting state, and persists it. Future context transforms then swap
 * the covered ranges for the synthetic summaries on every dispatch.
 */

export const PRUNE_TOOL_NAME = "prune"

export interface PruneRangeEntry {
  startId: string
  endId: string
  summary: string
}

export interface PruneToolArgs {
  topic: string
  content: PruneRangeEntry[]
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
    },
    content: {
      type: "array",
      description: "One or more ranges to prune, each with start/end boundaries and a summary",
      items: {
        type: "object",
        properties: {
          startId: {
            type: "string",
            description: "Message or block ID marking the beginning of range (e.g. m0001, b2)",
          },
          endId: {
            type: "string",
            description: "Message or block ID marking the end of range (e.g. m0012, b5)",
          },
          summary: {
            type: "string",
            description: "Complete technical summary replacing all content in range",
          },
        },
        required: ["startId", "endId", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["topic", "content"],
  additionalProperties: false,
} as const

export interface PruneDeps {
  store: StateStore
  mirror: TranscriptMirror
  logger: Logger
  config: DcpOptions
  getModelContextLimit: (sessionId: string) => number | undefined
  getUsageTokens: (sessionId: string) => number
  /** Publishes a completed compression to the TUI stats bridge (optional). */
  recordCompression?(input: { sessionId: string; record: CompressionEventRecord }): void
}

export interface PruneToolContext {
  sessionID: string
  progress?: (update: Record<string, unknown>) => Promise<void>
}

interface ResolvedPlan {
  entry: PruneRangeEntry
  coveredKeys: string[]
  coveredToolIds: string[]
  coveredTokens: number
  anchorKey: string
  /** Active blocks fully consumed by this range (summaries fold into the new one). */
  consumedBlockIds: number[]
}

export function pruneToolDefinition(deps: PruneDeps) {
  return {
    name: PRUNE_TOOL_NAME,
    description: PRUNE_RANGE,
    input: INPUT_SCHEMA,
    // Explicitly expose through the CodeMode `execute` catalog: that is how the
    // model reaches this tool in V2. The `codemode` default is not guaranteed
    // across beta releases, so set it explicitly rather than relying on it.
    options: { codemode: true },
    execute: async (input: unknown, context: PruneToolContext) => {
      let args: PruneToolArgs
      try {
        args = validateArgs(input)
      } catch (error) {
        return { content: `prune failed: ${(error as Error).message}` }
      }
      const sessionId = context.sessionID

      const index = deps.mirror.get(sessionId)
      if (!index || index.messages.length === 0) {
        return {
          content:
            "prune failed: no conversation context is available yet. Send a message first.",
        }
      }

      const runtime = await deps.store.ensure(sessionId)

      // Automatic strategies run here so idle sessions keep
      // their provider prompt-cache prefix stable between compressions.
      deduplicate(runtime.state, index, deps.config)
      purgeErrors(runtime.state, index, deps.config)

      let plans: ResolvedPlan[]
      try {
        plans = resolvePlans(args, index, runtime)
      } catch (error) {
        return { content: `prune failed: ${(error as Error).message}` }
      }

      await context.progress?.({ title: `DCP: pruning "${args.topic}"` })

      let totalNewMessages = 0
      let toolsCovered = 0
      let tokensCovered = 0
      let tokensSummaries = 0
      let lastBlockId = 0
      const blockLabels: string[] = []

      try {
        for (const plan of plans) {
          const expandedSummary = expandPlaceholders(plan.entry.summary, runtime.state)
          const block = applyCompression({
            state: runtime.state,
            refs: runtime.refs,
            topic: args.topic,
            summary: expandedSummary,
            coveredKeys: plan.coveredKeys,
            coveredToolIds: plan.coveredToolIds,
            coveredTokens: plan.coveredTokens,
            consumedBlockIds: plan.consumedBlockIds,
            anchorKey: plan.anchorKey,
          })
          const consumedCoverage = plan.consumedBlockIds.reduce(
            (sum, id) => sum + (runtime.state.blocks[String(id)]?.coveredKeys.length ?? 0),
            0,
          )
          totalNewMessages += Math.max(0, plan.coveredKeys.length - consumedCoverage)
          toolsCovered += plan.coveredToolIds.length
          tokensCovered += Math.max(0, plan.coveredTokens)
          tokensSummaries += Math.max(0, block.summaryTokens)
          lastBlockId = block.blockId
          blockLabels.push(formatBlockRef(block.blockId))
        }
      } catch (error) {
        return { content: `prune failed: ${(error as Error).message}` }
      }

      const record: CompressionEventRecord = {
        at: Date.now(),
        blockId: lastBlockId,
        topic: args.topic,
        ranges: plans.length,
        messagesCovered: totalNewMessages,
        toolsCovered,
        tokensBefore: tokensCovered,
        tokensAfter: tokensSummaries,
        tokensSaved: Math.max(0, tokensCovered - tokensSummaries),
      }

      // The record rides in the persisted state (not just the TUI bridge's
      // in-memory snapshot, which resets with every plugin generation) so the
      // compression history survives plugin reloads and server restarts.
      runtime.state.stats.recentCompressions.push(record)
      while (runtime.state.stats.recentCompressions.length > MAX_RECENT_COMPRESSIONS) {
        runtime.state.stats.recentCompressions.shift()
      }

      await deps.store.persist(sessionId)

      try {
        deps.recordCompression?.({ sessionId, record })
      } catch {
        // Display-only bridge.
      }
      deps.logger.debug("compression applied", {
        sessionId,
        topic: args.topic,
        blocks: blockLabels,
        activeBlocks: activeBlocks(runtime.state).length,
        totalPrunedTokens: runtime.state.stats.totalPrunedTokens,
      })

      // Occupancy AFTER this prune: `getUsageTokens` reflects the dispatch as
      // it was sent (a warm tracker's delta predates the tool call, and a
      // post-restart/post-revert seed was taken before the model pruned), so
      // subtract what these compressions actually remove from the outbound
      // transcript - newly covered original content plus consumed block
      // summaries folded out, minus the new summaries standing in for them.
      const usageTokens = deps.getUsageTokens(sessionId)
      const limit = deps.getModelContextLimit(sessionId)
      const consumedSummaryTokens = sumConsumedBlocks(plans, runtime, "summaryTokens")
      const consumedOriginalTokens = sumConsumedBlocks(plans, runtime, "compressedTokens")
      const tokensReclaimed = Math.max(
        0,
        Math.max(0, tokensCovered - consumedOriginalTokens) +
          consumedSummaryTokens -
          tokensSummaries,
      )
      const postPruneUsage = Math.max(0, usageTokens - tokensReclaimed)
      const usageNote =
        postPruneUsage > 0 && limit !== undefined && limit > 0
          ? ` Context usage is now approximately ${Math.round((postPruneUsage / limit) * 100)}% of the window.`
          : ""

      return {
        content: `Pruned ${totalNewMessages} message(s) into ${blockLabels.length} pruned section(s) (${blockLabels.join(", ")}).${usageNote}`,
        metadata: { topic: args.topic, blocks: blockLabels },
      }
    },
  }
}

// -- argument validation -----------------------------------------------------

/** Sums a per-block token field across every block consumed by the plans. */
function sumConsumedBlocks(
  plans: ResolvedPlan[],
  runtime: SessionRuntime,
  field: "summaryTokens" | "compressedTokens",
): number {
  let total = 0
  for (const plan of plans) {
    for (const id of plan.consumedBlockIds) {
      total += Math.max(0, runtime.state.blocks[String(id)]?.[field] ?? 0)
    }
  }
  return total
}

function validateArgs(input: unknown): PruneToolArgs {
  if (typeof input !== "object" || input === null) throw new Error("arguments must be an object")
  const raw = input as Record<string, unknown>
  const topic = typeof raw.topic === "string" && raw.topic.trim().length > 0 ? raw.topic.trim() : "Context pruning"
  const content = Array.isArray(raw.content) ? raw.content : []
  if (content.length === 0) throw new Error("content must be a non-empty array of ranges")
  const entries: PruneRangeEntry[] = []
  for (const item of content) {
    if (typeof item !== "object" || item === null) throw new Error("each range entry must be an object")
    const entry = item as Record<string, unknown>
    const startId = typeof entry.startId === "string" ? entry.startId : ""
    const endId = typeof entry.endId === "string" ? entry.endId : ""
    const summary = typeof entry.summary === "string" ? entry.summary : ""
    if (!startId || !endId) throw new Error("each range needs string startId and endId")
    if (summary.trim().length === 0) throw new Error("each range needs a non-empty summary")
    entries.push({ startId, endId, summary })
  }
  return { topic, content: entries }
}

// -- range resolution --------------------------------------------------------

function resolvePlans(args: PruneToolArgs, index: TranscriptIndex, runtime: SessionRuntime): ResolvedPlan[] {
  const keyToIndex = new Map<string, number>()
  index.keys.forEach((key, i) => keyToIndex.set(key, i))

  const claimedRanges: Array<{ start: number; end: number }> = []
  const plans: ResolvedPlan[] = []

  for (const entry of args.content) {
    const startIndex = boundaryToIndex(entry.startId, index, keyToIndex, runtime, "startId")
    const endIndex = boundaryToIndex(entry.endId, index, keyToIndex, runtime, "endId")
    if (startIndex === undefined || endIndex === undefined) continue
    if (startIndex > endIndex) {
      throw new Error(`startId ${entry.startId} appears after endId ${entry.endId}`)
    }

    // Expand coverage: consuming any part of an active block consumes it whole
    // (prevents dangling block summaries anchored inside removed regions).
    const covered = new Set<string>()
    for (let i = startIndex; i <= endIndex; i++) covered.add(index.keys[i]!)
    const consumedBlockIds: number[] = []
    let changed = true
    while (changed) {
      changed = false
      for (const block of activeBlocks(runtime.state)) {
        if (consumedBlockIds.includes(block.blockId)) continue
        const touches =
          covered.has(block.anchorKey) ||
          block.coveredKeys.some((key) => covered.has(key)) ||
          block.coveredKeys.every((key) => !keyToIndex.has(key))
        if (!touches) continue
        for (const key of block.coveredKeys) covered.add(key)
        consumedBlockIds.push(block.blockId)
        changed = true
      }
    }

    const coveredKeys = [...covered].filter((key) => keyToIndex.has(key))
    coveredKeys.sort((left, right) => (keyToIndex.get(left) ?? 0) - (keyToIndex.get(right) ?? 0))

    // Overlap with an explicitly selected range of another plan is invalid;
    // overlap arising purely through whole-block consumption is fine.
    const start = keyToIndex.get(coveredKeys[0]!) ?? startIndex
    const end = keyToIndex.get(coveredKeys.at(-1)!) ?? endIndex
    for (const range of claimedRanges) {
      const overlapsExplicit =
        !(endIndex < range.start || startIndex > range.end) &&
        !(consumedBlockIds.length > 0 && covered.size > endIndex - startIndex + 1)
      if (overlapsExplicit) {
        throw new Error(`ranges overlap: ${entry.startId}..${entry.endId} intersects another range`)
      }
    }
    claimedRanges.push({ start, end })

    const nextKey = index.keys[endIndex + 1]
    const anchorKey = nextKey ?? TAIL_ANCHOR
    const coveredToolIds = index.toolOrder.filter(
      (callId) => index.tools.get(callId)?.hasResult && covered.has(index.tools.get(callId)!.key),
    )
    plans.push({
      entry,
      coveredKeys,
      coveredToolIds,
      coveredTokens: estimateCoveredTokens(index, coveredKeys),
      anchorKey,
      consumedBlockIds,
    })
  }

  if (plans.length === 0) {
    throw new Error("none of the provided IDs exist in the current context")
  }
  return plans
}

function boundaryToIndex(
  id: string,
  index: TranscriptIndex,
  keyToIndex: Map<string, number>,
  runtime: SessionRuntime,
  field: string,
): number | undefined {
  const parsed = parseBoundaryChecked(id, field)
  if (parsed.kind === "message") {
    const refKey = runtime.refs.keyOf(parsed.ref)
    const idx = refKey !== undefined ? keyToIndex.get(refKey) : undefined
    if (idx !== undefined) return idx
    throw new Error(`${field} ${id} does not exist in the current context`)
  }
  const block = runtime.state.blocks[String(parsed.blockId)]
  if (!block) throw new Error(`${field} ${id} references an unknown compressed block`)
  const indices = block.coveredKeys
    .map((key) => keyToIndex.get(key))
    .filter((value): value is number => value !== undefined)
  if (indices.length === 0) {
    throw new Error(`${field} ${id} references a block with no visible messages`)
  }
  return field === "startId" ? Math.min(...indices) : Math.max(...indices)
}

type ParsedBoundary = { kind: "message"; ref: string } | { kind: "block"; blockId: number }

function parseBoundaryChecked(id: string, field: string): ParsedBoundary {
  const messageIndex = parseMessageRef(id)
  if (messageIndex !== null) return { kind: "message", ref: `m${String(messageIndex).padStart(4, "0")}` }
  const blockId = parseBlockRef(id)
  if (blockId !== null) return { kind: "block", blockId }
  throw new Error(`${field} "${id}" is not a valid mNNNN or bN ID`)
}

// -- summary assembly --------------------------------------------------------

const BLOCK_PLACEHOLDER_REGEX = /\(\s*b(\d+)\s*\)/g

/**
 * Expands `(bN)` placeholders with stored block summaries. Consumed blocks
 * whose placeholder is absent are intentionally DROPPED: their content leaves
 * the outbound transcript (it stays in persisted state, but inactive). This
 * is how the model prunes previously compressed sections whose work is no
 * longer relevant to the current task.
 */
export function expandPlaceholders(summary: string, state: SessionState): string {
  return summary.replace(BLOCK_PLACEHOLDER_REGEX, (_match, digits: string) => {
    const blockId = Number.parseInt(digits, 10)
    const block = state.blocks[String(blockId)]
    if (!block) throw new Error(`summary references unknown compressed block b${blockId}`)
    return stripBlockWrapper(block)
  })
}

/** Unwraps a stored block summary to its bare content for folding. */
export function stripBlockWrapper(block: CompressionBlock): string {
  return block.summary
    .replace(/^\[Compressed conversation section\]\n/, "")
    .replace(/<dcp-message-id>b\d+<\/dcp-message-id>\n?$/, "")
    .trim()
}

function estimateCoveredTokens(index: TranscriptIndex, coveredKeys: string[]): number {
  const coveredSet = new Set(coveredKeys)
  let total = 0
  for (let i = 0; i < index.messages.length; i++) {
    if (!coveredSet.has(index.keys[i]!)) continue
    const message = index.messages[i]!
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") total += countTokens(part.text)
      else if (part.type === "tool-result") total += countTokens(index.tools.get(part.id)?.outputText ?? "")
      else if (part.type === "tool-call") total += countTokens(safeJson(part.input))
    }
  }
  return total
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
