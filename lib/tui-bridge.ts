import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Bridge between the server-side plugin and its TUI companion (`tui.tsx`).
 *
 * The OpenCode TUI loads plugin TUI modules client-side, where
 * `ctx.storage.store(key)` is a JSON file at
 * `<XDG_STATE_HOME>/opencode/<channel>/tui/plugin.<id>.<key>.json` that is
 * fs-watched and hot-reloaded into a reactive Solid store. This module writes
 * our stats snapshot to that exact location (atomic tmp+rename so watchers
 * never observe partial JSON), giving the panel live per-session numbers.
 *
 * The server does not know the TUI channel name ("beta", "local", ...), so we
 * write to every existing channel directory that has a `tui/` subdir. Extra
 * files in unused channels are harmless.
 */

export interface CompressionEventRecord {
  at: number
  blockId: number
  topic: string
  ranges: number
  messagesCovered: number
  /** Tool outputs swallowed by this compression (absent in older snapshots). */
  toolsCovered?: number
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
}

export interface DispatchMetrics {
  at: number
  agent?: string
  model?: string
  messagesIn: number
  tokensBefore: number
  tokensAfter: number
}

export interface SessionTotals {
  dispatches: number
  compressRuns: number
  blocksActive: number
  blocksTotal: number
  /** Estimated tokens of original content replaced by active block summaries. */
  blockTokensCovered: number
  /** Estimated tokens spent on the active summaries themselves. */
  blockTokensSummaries: number
  /** Estimated tokens reclaimed by tool-output pruning (cumulative). */
  prunedTokensTotal: number
  messagesCompressedActive: number
}

export interface SessionStatsSnapshot {
  sessionId: string
  updatedAt: number
  model?: string
  lastDispatch?: DispatchMetrics & { savedTokens: number; savedPercent: number }
  totals: SessionTotals
  recentCompressions: CompressionEventRecord[]
}

export interface TuiStatsSnapshot {
  version: 1
  generatedAt: number
  sessions: Record<string, SessionStatsSnapshot>
}

// Must match the file the TUI companion watches: its plugin context derives
// storage keys as `plugin.<id>.<key>` from its definition id ("opencode.dcp.
// tui") and store key ("stats"). A mismatch means a live panel reading an
// empty file forever.
export const TUI_STATS_KEY = "plugin.opencode.dcp.tui.stats"
const MAX_RECENT_COMPRESSIONS = 10

/** Cheap token estimate (~4 chars/token) used for display-only deltas. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4))
}

/** Sums the text size of wire messages without copying them. */
export function measureMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue
    const record = message as Record<string, unknown>
    total += measurePartChars(record)
  }
  return total
}

function measurePartChars(value: unknown): number {
  if (typeof value === "string") return value.length
  if (typeof value !== "object" || value === null) return 0
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += measurePartChars(item)
    return total
  }
  let total = 0
  for (const item of Object.values(value as Record<string, unknown>)) {
    total += measurePartChars(item)
  }
  return total
}

/** Builds the next snapshot by merging one dispatch/compression update. */
export function buildStatsSnapshot(
  previous: TuiStatsSnapshot | undefined,
  input: {
    sessionId: string
    model?: string
    dispatch?: DispatchMetrics
    compression?: CompressionEventRecord
    totals: SessionTotals
  },
): TuiStatsSnapshot {
  const sessions: Record<string, SessionStatsSnapshot> = {}
  for (const [id, entry] of Object.entries(previous?.sessions ?? {})) {
    if (id === input.sessionId) continue
    sessions[id] = entry
  }

  const prior = previous?.sessions[input.sessionId]
  const recentCompressions = [...(prior?.recentCompressions ?? [])]
  if (input.compression) {
    recentCompressions.push(input.compression)
    while (recentCompressions.length > MAX_RECENT_COMPRESSIONS) recentCompressions.shift()
  }

  const lastDispatch =
    input.dispatch === undefined
      ? prior?.lastDispatch
      : {
          ...input.dispatch,
          savedTokens: Math.max(0, input.dispatch.tokensBefore - input.dispatch.tokensAfter),
          savedPercent:
            input.dispatch.tokensBefore > 0
              ? Math.round(
                  ((input.dispatch.tokensBefore - input.dispatch.tokensAfter) /
                    input.dispatch.tokensBefore) *
                    100,
                )
              : 0,
        }

  sessions[input.sessionId] = {
    sessionId: input.sessionId,
    updatedAt: Date.now(),
    model: input.model ?? prior?.model,
    lastDispatch,
    totals: input.totals,
    recentCompressions,
  }

  return { version: 1, generatedAt: Date.now(), sessions }
}

/**
 * Directories `<stateRoot>/opencode/<channel>/tui` that exist. The state root
 * defaults to the XDG state home; overridable for tests.
 */
export function resolveTuiStateDirs(stateRoot?: string): string[] {
  const root = stateRoot ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  const appDir = path.join(root, "opencode")
  let channels: string[]
  try {
    channels = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const targets: string[] = []
  for (const channel of channels) {
    const tuiDir = path.join(appDir, channel, "tui")
    try {
      mkdirSync(tuiDir, { recursive: true })
      targets.push(tuiDir)
    } catch {
      // Unwritable channel dir: skip.
    }
  }
  return targets
}

/** Writes the snapshot atomically to every TUI storage directory. Never throws. */
export function writeTuiStats(snapshot: TuiStatsSnapshot, stateRoot?: string): void {
  const payload = JSON.stringify(snapshot)
  for (const dir of resolveTuiStateDirs(stateRoot)) {
    const finalPath = path.join(dir, `${TUI_STATS_KEY}.json`)
    const tmpPath = `${finalPath}.tmp-${process.pid}`
    try {
      writeFileSync(tmpPath, payload, "utf8")
      renameSync(tmpPath, finalPath)
    } catch {
      // Display-only bridge: a failed write is silently ignored.
    }
  }
}
