import type { DcpOptions } from "./config"
import { isToolAutoPrunable } from "./protected"
import type { SessionState } from "./state/types"
import { countTokens } from "./tokens"
import type { TranscriptIndex } from "./transcript/scan"

/**
 * Automatic pruning strategies. They run only
 * while a compression executes (not on every request) so idle sessions keep
 * their provider prompt-cache prefix stable.
 *
 * Both strategies add call IDs to `state.prunedTools`; the per-request prune
 * pass replaces those outputs with a placeholder in the outbound transcript.
 */

export interface StrategyResult {
  added: string[]
  tokensSaved: number
}

/** Prunes older tool calls with identical name+normalized-input, keeping the newest. */
export function deduplicate(
  state: SessionState,
  index: TranscriptIndex,
  config: DcpOptions,
): StrategyResult {
  if (!config.strategies.deduplication.enabled) return empty()

  const groups = new Map<string, string[]>()
  for (const callId of index.toolOrder) {
    const info = index.tools.get(callId)
    if (!info || !info.hasResult || info.isError) continue
    if (state.prunedTools[callId] !== undefined) continue
    if (
      !isToolAutoPrunable(
        info,
        {
          dedupePatterns: config.strategies.deduplication.protectedTools,
          purgePatterns: [],
          filePatterns: config.protectedFilePatterns,
        },
        "dedupe",
      )
    ) {
      continue
    }
    const signature = `${info.name}::${stableStringify(sortKeys(normalizeInput(info.input)))}`
    const group = groups.get(signature)
    if (group) group.push(callId)
    else groups.set(signature, [callId])
  }

  const added: string[] = []
  for (const ids of groups.values()) {
    if (ids.length > 1) added.push(...ids.slice(0, -1))
  }
  return commit(state, index, added)
}

/** Prunes errored tool calls older than N turns. */
export function purgeErrors(
  state: SessionState,
  index: TranscriptIndex,
  config: DcpOptions,
): StrategyResult {
  const turns = config.strategies.purgeErrors.turns
  if (!config.strategies.purgeErrors.enabled || index.turnCount <= turns) return empty()

  const currentTurn = index.turnCount + 1
  const added: string[] = []
  for (const callId of index.toolOrder) {
    const info = index.tools.get(callId)
    if (!info || !info.hasResult || !info.isError) continue
    if (state.prunedTools[callId] !== undefined) continue
    if (currentTurn - info.turn < turns + 1) continue
    if (
      !isToolAutoPrunable(
        info,
        {
          dedupePatterns: [],
          purgePatterns: config.strategies.purgeErrors.protectedTools,
          filePatterns: config.protectedFilePatterns,
        },
        "purge",
      )
    ) {
      continue
    }
    added.push(callId)
  }
  return commit(state, index, added)
}

function commit(
  state: SessionState,
  index: TranscriptIndex,
  callIds: string[],
): StrategyResult {
  let tokensSaved = 0
  for (const callId of callIds) {
    const info = index.tools.get(callId)
    const tokens = countTokens(info?.outputText ?? "")
    state.prunedTools[callId] = tokens
    tokensSaved += tokens
  }
  state.stats.totalPrunedTokens += tokensSaved
  return { added: callIds, tokensSaved }
}

const empty = (): StrategyResult => ({ added: [], tokensSaved: 0 })

function normalizeInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined && value !== null) normalized[key] = value
  }
  return normalized
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== "object" || value === null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return String(value)
  }
}
