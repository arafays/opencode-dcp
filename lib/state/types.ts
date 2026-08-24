import type { RefRegistryJson } from "../refs"

/**
 * Per-session DCP state. Everything here describes OUTBOUND-ONLY edits: the
 * stored session history is never modified. State is JSON-serializable so it
 * survives server restarts via the plugin storage KV.
 */

export interface CompressionBlock {
  blockId: number
  active: boolean
  topic: string
  /** Final stored summary (placeholders already expanded), wrapped for display. */
  summary: string
  summaryTokens: number
  /** Estimated tokens the compressed original content occupied. */
  compressedTokens: number
  /** Stable transcript keys covered by this block (removed from context). */
  coveredKeys: string[]
  /** Tool call IDs whose outputs were swallowed by the range. */
  coveredToolIds: string[]
  /** Transcript key right after the covered range; synthetic summary splices in there. "tail" appends at the end. */
  anchorKey: string
  /** Blocks fully consumed by this one (their summaries were folded in). */
  consumedBlockIds: number[]
  createdAt: number
}

export interface SessionStats {
  totalPrunedTokens: number
  compressRuns: number
  /** Outbound dispatches observed since session creation (TUI display). */
  dispatches: number
}

/** callId → estimated tokens saved by pruning that output. */
export type PrunedTools = Record<string, number>

export interface SessionState {
  sessionId: string
  refs: RefRegistryJson
  prunedTools: PrunedTools
  blocks: Record<string, CompressionBlock>
  activeBlockIds: number[]
  nextBlockId: number
  /** Rate-limit anchors for the context nudge (transcript message counts). */
  nudgeAnchors: number[]
  stats: SessionStats
  updatedAt: number
}

export function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    refs: { byKey: {}, byRef: {}, next: 1 },
    prunedTools: {},
    blocks: {},
    activeBlockIds: [],
    nextBlockId: 1,
    nudgeAnchors: [],
    stats: { totalPrunedTokens: 0, compressRuns: 0, dispatches: 0 },
    updatedAt: Date.now(),
  }
}

export function hydrateSessionState(json: unknown, sessionId: string): SessionState {
  const base = createSessionState(sessionId)
  if (typeof json !== "object" || json === null) return base
  const raw = json as Record<string, unknown>
  if (raw.refs && typeof raw.refs === "object") base.refs = raw.refs as RefRegistryJson
  if (raw.prunedTools && typeof raw.prunedTools === "object") {
    for (const [key, value] of Object.entries(raw.prunedTools as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) base.prunedTools[key] = value
    }
  }
  if (raw.blocks && typeof raw.blocks === "object") {
    for (const [key, value] of Object.entries(raw.blocks as Record<string, unknown>)) {
      const block = coerceBlock(value)
      if (block) base.blocks[key] = block
    }
  }
  if (Array.isArray(raw.activeBlockIds)) {
    base.activeBlockIds = raw.activeBlockIds.filter((id): id is number => typeof id === "number")
  }
  if (typeof raw.nextBlockId === "number") base.nextBlockId = Math.max(1, Math.floor(raw.nextBlockId))
  if (Array.isArray(raw.nudgeAnchors)) {
    base.nudgeAnchors = raw.nudgeAnchors.filter((id): id is number => typeof id === "number")
  }
  if (raw.stats && typeof raw.stats === "object") {
    const stats = raw.stats as Record<string, unknown>
    if (typeof stats.totalPrunedTokens === "number") base.stats.totalPrunedTokens = stats.totalPrunedTokens
    if (typeof stats.compressRuns === "number") base.stats.compressRuns = stats.compressRuns
    if (typeof stats.dispatches === "number") base.stats.dispatches = stats.dispatches
  }
  // Drop dangling actives defensively.
  const knownBlocks = new Set(Object.keys(base.blocks))
  base.activeBlockIds = base.activeBlockIds.filter(
    (id) => knownBlocks.has(String(id)) && base.blocks[String(id)]?.active === true,
  )
  return base
}

function coerceBlock(value: unknown): CompressionBlock | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.blockId !== "number" ||
    typeof raw.topic !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.anchorKey !== "string" ||
    !Array.isArray(raw.coveredKeys)
  ) {
    return undefined
  }
  return {
    blockId: raw.blockId,
    active: raw.active === true,
    topic: raw.topic,
    summary: raw.summary,
    summaryTokens: typeof raw.summaryTokens === "number" ? raw.summaryTokens : 0,
    compressedTokens: typeof raw.compressedTokens === "number" ? raw.compressedTokens : 0,
    coveredKeys: raw.coveredKeys.filter((key): key is string => typeof key === "string"),
    coveredToolIds: Array.isArray(raw.coveredToolIds)
      ? raw.coveredToolIds.filter((id): id is string => typeof id === "string")
      : [],
    anchorKey: raw.anchorKey,
    consumedBlockIds: Array.isArray(raw.consumedBlockIds)
      ? raw.consumedBlockIds.filter((id): id is number => typeof id === "number")
      : [],
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
  }
}
