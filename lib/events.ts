import type { Logger } from "./logger"
import { UsageTracker } from "./nudges"
import type { StateStore } from "./state/store"
import type { TranscriptMirror } from "./transcript/mirror"

/**
 * Background event pump. Consumes the public server event stream for:
 *
 * - `session.usage.updated`  -> per-session context usage (drives nudges)
 * - `session.compaction.started|ended` -> native compaction rewrites history
 * - `session.compaction.failed`  -> started already reset; history unchanged
 * - `session.revert.committed` -> history truncated: reset DCP
 * - `session.forked`          -> new session id, parent's blocks do not apply
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
    // The public event stream is a per-connection DROPPING queue capped at
    // 4096 that fails the subscriber with an overflow error, and the server
    // may restart and end the stream naturally. Both are normal operational
    // occurrences: `subscribe` is a factory, so reconnecting creates a fresh
    // subscription and keeps usage tracking + compaction resets alive for the
    // session instead of dying permanently. Backoff doubles up to 15s.
    let backoff = 1_000
    while (!signal.aborted) {
      const connectedAt = Date.now()
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
            case "session.compaction.failed":
            case "session.revert.committed":
            case "session.forked":
            case "session.deleted": {
              if (!sessionId) break
              store.reset(sessionId)
              mirror.drop(sessionId)
              usage.reset(sessionId)
              logger.debug("session event; DCP state reset", {
                sessionId,
                reason: event.type,
              })
              // This event is the primary storage-GC path. The complementary
              // startup reconcile lives in index.ts (setup): storage.scan +
              // per-key session.get, deleting only positively identified
              // SessionNotFoundError keys — it catches sessions deleted while
              // the plugin was down, which this in-process listener misses.
              break
            }
            default:
              break
          }
        }
        if (signal.aborted) return
        logger.warn("event stream ended; reconnecting", { reason: "stream closed" })
      } catch (error) {
        if (signal.aborted) return
        logger.warn("event stream failed; reconnecting", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (signal.aborted) return
      // A connection that survived this long was healthy: a fresh drop should
      // retry promptly instead of inheriting a stale doubled backoff.
      if (Date.now() - connectedAt >= 30_000) backoff = 1_000
      await delay(backoff, signal)
      backoff = Math.min(backoff * 2, 15_000)
    }
  })()
}

/**
 * Abort-aware sleep: resolves on timeout OR when `signal` aborts, so teardown
 * never lingers behind an in-flight backoff delay.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
