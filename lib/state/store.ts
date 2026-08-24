import { formatBlockRef, RefRegistry } from "../refs"
import { countTokens } from "../tokens"
import { createSessionState, hydrateSessionState, type CompressionBlock, type SessionState } from "./types"

/** In-memory per-session bundle: persisted state plus its live ref registry. */
export interface SessionRuntime {
  sessionId: string
  state: SessionState
  refs: RefRegistry
}

export type JsonStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * Per-session state store with an in-memory cache and JSON persistence through
 * the plugin storage KV (namespaced per plugin by the host).
 */
export class StateStore {
  private readonly memory = new Map<string, SessionRuntime>()
  private readonly pending = new Map<string, Promise<SessionRuntime>>()

  constructor(private readonly storage: JsonStorage | undefined) {}

  /** Cached runtime without loading from storage (may be undefined). */
  peek(sessionId: string): SessionRuntime | undefined {
    return this.memory.get(sessionId)
  }

  async ensure(sessionId: string): Promise<SessionRuntime> {
    const cached = this.memory.get(sessionId)
    if (cached) return cached
    const inflight = this.pending.get(sessionId)
    if (inflight) return inflight
    const load = (async () => {
      let state = createSessionState(sessionId)
      if (this.storage) {
        try {
          const stored = await this.storage.get(`session/${sessionId}`)
          state = hydrateSessionState(stored, sessionId)
        } catch {
          // Corrupt or missing entry: start fresh.
        }
      }
      const runtime: SessionRuntime = {
        sessionId,
        state,
        refs: RefRegistry.from(state.refs),
      }
      this.memory.set(sessionId, runtime)
      return runtime
    })()
    this.pending.set(sessionId, load)
    try {
      return await load
    } finally {
      this.pending.delete(sessionId)
    }
  }

  async persist(sessionId: string): Promise<void> {
    const runtime = this.memory.get(sessionId)
    if (!runtime || !this.storage) return
    runtime.state.refs = runtime.refs.toJSON()
    runtime.state.updatedAt = Date.now()
    try {
      await this.storage.set(`session/${sessionId}`, runtime.state as unknown as Record<string, unknown>)
    } catch {
      // Persistence is best-effort; in-memory state keeps working.
    }
  }

  /** Drops all DCP edits for a session (compaction / revert / deletion). */
  reset(sessionId: string): void {
    this.memory.delete(sessionId)
    void this.storage?.remove(`session/${sessionId}`)?.catch(() => {})
  }
}

/** Sentinel anchor key meaning "append at transcript tail". */
export const TAIL_ANCHOR = "tail"

export function allocateBlockId(state: SessionState): number {
  const blockId = state.nextBlockId++
  return blockId
}

export function wrapCompressedSummary(blockId: number, summary: string): string {
  const ref = formatBlockRef(blockId)
  return `[Compressed conversation section]\n${summary.trim()}\n<dcp-message-id>${ref}</dcp-message-id>`
}

/**
 * Applies a validated compression to session state: records the new block,
 * deactivates consumed blocks, and accounts tokens.
 */
export function applyCompression(input: {
  state: SessionState
  refs: RefRegistry
  topic: string
  summary: string
  coveredKeys: string[]
  coveredToolIds: string[]
  coveredTokens: number
  consumedBlockIds: number[]
  anchorKey: string
}): CompressionBlock {
  const { state } = input
  const blockId = allocateBlockId(state)
  const wrapped = wrapCompressedSummary(blockId, input.summary)
  const block: CompressionBlock = {
    blockId,
    active: true,
    topic: input.topic,
    summary: wrapped,
    summaryTokens: countTokens(wrapped),
    compressedTokens: Math.max(0, input.coveredTokens),
    coveredKeys: [...input.coveredKeys],
    coveredToolIds: [...input.coveredToolIds],
    anchorKey: input.anchorKey,
    consumedBlockIds: [...input.consumedBlockIds],
    createdAt: Date.now(),
  }
  state.blocks[String(blockId)] = block

  for (const consumedId of input.consumedBlockIds) {
    const consumed = state.blocks[String(consumedId)]
    if (consumed && consumed.active) {
      consumed.active = false
      state.activeBlockIds = state.activeBlockIds.filter((id) => id !== consumedId)
    }
    // Covered keys of consumed blocks stay covered through the new block.
  }

  // Keys already covered by consumed blocks are re-covered by this block only;
  // keys must not be double-counted in active coverage.
  for (const id of state.activeBlockIds) {
    const other = state.blocks[String(id)]
    if (!other) continue
    other.coveredKeys = other.coveredKeys.filter((key) => !input.coveredKeys.includes(key))
  }

  state.activeBlockIds.push(blockId)
  state.stats.compressRuns += 1
  state.nudgeAnchors = []
  return block
}

/** Active blocks sorted by creation order. */
export function activeBlocks(state: SessionState): CompressionBlock[] {
  return state.activeBlockIds
    .map((id) => state.blocks[String(id)])
    .filter((block): block is CompressionBlock => block !== undefined && block.active)
}
