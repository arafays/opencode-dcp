import type { Logger } from "./logger"
import { UsageTracker } from "./nudges"
import type { StateStore } from "./state/store"
import type { TranscriptMirror } from "./transcript/mirror"

/**
 * Background event pump. Consumes the public server event stream for:
 *
 * - `session.usage.updated`  -> per-session context usage (drives nudges)
 * - `session.compaction.*`   -> native compaction rewrites history: reset DCP
 * - `session.revert.committed` -> history truncated: reset DCP
 * - `session.deleted`        -> drop all session state
 *
 * The pump runs detached from setup and is aborted via the cleanup function.
 */

interface EventEnvelope {
  type: string
  data?: Record<string, unknown>
}

export function startEventPump(input: {
  subscribe(): AsyncIterable<unknown>
  store: StateStore
  mirror: TranscriptMirror
  usage: UsageTracker
  logger: Logger
  signal: AbortSignal
}): Promise<void> {
  const { store, mirror, usage, logger, signal } = input

  return (async () => {
    try {
      for await (const raw of input.subscribe()) {
        if (signal.aborted) return
        const event = raw as EventEnvelope
        if (!event || typeof event.type !== "string") continue
        const data = (event.data ?? {}) as Record<string, unknown>
        const sessionId = typeof data.sessionID === "string" ? data.sessionID : undefined

        switch (event.type) {
          case "session.usage.updated": {
            // NOTE: deliberately NOT tracking session.usage.recorded - those
            // carry per-record costs from auxiliary sources (title/compaction)
            // and would pollute the per-session context estimate.
            if (!sessionId) break
            const tokens = data.tokens as Record<string, unknown> | undefined
            if (!tokens) break
            usage.record(sessionId, {
              input: numberOr(tokens.input),
              output: numberOr(tokens.output),
              reasoning: numberOr(tokens.reasoning),
              cacheRead: numberOr((tokens.cache as Record<string, unknown> | undefined)?.read),
              cacheWrite: numberOr((tokens.cache as Record<string, unknown> | undefined)?.write),
            })
            break
          }
          case "session.compaction.started":
          case "session.compaction.ended":
          case "session.revert.committed": {
            if (!sessionId) break
            store.reset(sessionId)
            mirror.drop(sessionId)
            usage.drop(sessionId)
            logger.info("session history rewritten; DCP state reset", {
              sessionId,
              reason: event.type,
            })
            break
          }
          case "session.deleted": {
            if (!sessionId) break
            store.reset(sessionId)
            mirror.drop(sessionId)
            usage.drop(sessionId)
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.warn("event pump stopped", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })()
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
