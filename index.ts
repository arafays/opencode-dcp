import { Plugin } from "@opencode-ai/plugin"

import { pruneToolDefinition } from "./lib/prune-tool"
import { resolveOptions } from "./lib/config"
import { registerCommands } from "./lib/commands"
import { startEventPump } from "./lib/events"
import { createLogger } from "./lib/logger"
import { UsageTracker } from "./lib/nudges"
import { StateStore } from "./lib/state/store"
import { createContextHook, sessionTotals, type SessionContextEvent } from "./lib/transform"
import { TranscriptMirror } from "./lib/transcript/mirror"
import {
  buildStatsSnapshot,
  writeTuiStats,
  type CompressionEventRecord,
  type TuiStatsSnapshot,
} from "./lib/tui-bridge"

/**
 * OpenCode Dynamic Context Pruning (DCP) - V2 plugin.
 *
 * Keeps the model's context window high-signal by:
 *  - injecting DCP instructions into the system prompt,
 *  - exposing a model-driven `prune` tool that replaces closed conversation
 *    ranges with the model's own technical summaries,
 *  - pruning superseded tool outputs and running dedupe/purge-error strategies
 *    at compression time,
 *  - nudging the model when context usage crosses the configured budget.
 *
 * All edits are outbound-only: stored session history is never modified.
 */

const PLUGIN_ID = "opencode.dcp"

export default Plugin.define({
  id: PLUGIN_ID,
  // Ships a TUI companion module ("./tui" export); loaded by the OpenCode TUI.
  tui: true,
  setup: async (ctx) => {
    const config = resolveOptions(ctx.options, (message) =>
      console.error(`[dcp] config warning: ${message}`),
    )
    const logger = createLogger(config.debug)

    if (!config.enabled) {
      logger.info("disabled by configuration")
      return
    }

    const store = new StateStore(ctx.storage)
    const mirror = new TranscriptMirror()
    const usage = new UsageTracker()

    // Model context-window cache (provider/model -> tokens).
    const contextLimits = new Map<string, number | undefined>()
    let catalogListed = false
    const catalogContextLimit = async (
      providerID: string,
      modelId: string,
    ): Promise<number | undefined> => {
      const key = `${providerID}/${modelId}`
      if (!catalogListed && !contextLimits.has(key)) {
        try {
          const response = await ctx.catalog.model.list()
          const models = unwrapList<{
            providerID: string
            id: string
            limit?: { context?: number }
          }>(response)
          for (const model of models ?? []) {
            if (typeof model?.providerID === "string" && typeof model?.id === "string") {
              contextLimits.set(
                `${model.providerID}/${model.id}`,
                typeof model.limit?.context === "number" ? model.limit.context : undefined,
              )
            }
          }
        } catch (error) {
          logger.warn("failed to list model catalog for context limits", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        catalogListed = true
      }
      return contextLimits.get(key)
    }

    // Last model seen per session (the compress tool reports usage against it).
    const lastModel = new Map<string, { providerID: string; id: string }>()

    // TUI stats bridge: one shared snapshot per plugin generation, merged on
    // every dispatch and compression, written to the TUI's watched storage.
    let statsSnapshot: TuiStatsSnapshot | undefined
    const publishStats = config.tui.enabled
      ? (input: {
          sessionId: string
          model?: string
          dispatch?: import("./lib/tui-bridge").DispatchMetrics
          compression?: CompressionEventRecord
          totals: ReturnType<typeof sessionTotals>
        }) => {
          const next = buildStatsSnapshot(statsSnapshot, input)
          statsSnapshot = next
          writeTuiStats(next)
        }
      : undefined
    const recordCompression = publishStats
      ? (input: { sessionId: string; record: CompressionEventRecord }) => {
          const runtime = store.peek(input.sessionId)
          if (!runtime) return
          publishStats({
            sessionId: input.sessionId,
            compression: input.record,
            totals: sessionTotals(runtime.state),
          })
        }
      : undefined

    // Sub-agent detection with a per-process cache.
    const subAgentCache = new Map<string, boolean>()
    const isSubAgent = async (sessionId: string): Promise<boolean> => {
      const cached = subAgentCache.get(sessionId)
      if (cached !== undefined) return cached
      let result = false
      try {
        const response = await ctx.session.get({ sessionID: sessionId })
        const parentID = unwrapData<{ parentID?: string }>(response)?.parentID
        result = typeof parentID === "string" && parentID.length > 0
      } catch {
        result = false
      }
      subAgentCache.set(sessionId, result)
      return result
    }

    const handleContext = createContextHook({
      config,
      logger,
      store,
      mirror,
      usage,
      isSubAgent,
      catalogContextLimit,
      publishStats: (input) => {
        if (!publishStats) return
        publishStats({
          sessionId: input.sessionId,
          model: input.model,
          dispatch: input.dispatch,
          totals: input.totals,
        })
      },
    })

    await ctx.session.hook("context", async (event) => {
      const typed = event as unknown as SessionContextEvent
      if (typed.model) lastModel.set(typed.sessionID, { providerID: typed.model.providerID, id: typed.model.id })
      await handleContext(typed)
    })

    await ctx.tool.transform((tools) => {
      addTool(
        tools as unknown as AddableTools,
        pruneToolDefinition({
          store,
          mirror,
          logger,
          config,
          getModelContextLimit: (sessionId) => {
            const model = lastModel.get(sessionId)
            if (!model) return undefined
            const key = `${model.providerID}/${model.id}`
            const cached = contextLimits.get(key)
            if (cached !== undefined || catalogListed) return cached
            // Populate asynchronously; the next dispatch/prune sees it.
            void catalogContextLimit(model.providerID, model.id).catch(() => {})
            return undefined
          },
          getUsageTokens: (sessionId) => usage.totalFor(sessionId),
          recordCompression,
        }),
      )
    })

    await ctx.command.transform((draft) => {
      registerCommands(draft)
    })

    // Background event pump; aborted when the plugin unloads.
    const controller = new AbortController()
    void startEventPump({
      subscribe: () => ctx.event.subscribe(),
      store,
      mirror,
      usage,
      logger,
      signal: controller.signal,
    })

    logger.info("initialized", {
      maxContextLimit: config.maxContextLimit,
      strategies: {
        deduplication: config.strategies.deduplication.enabled,
        purgeErrors: config.strategies.purgeErrors.enabled,
      },
      allowSubAgents: config.allowSubAgents,
    })

    return () => {
      controller.abort()
    }
  },
})

// -- helpers -----------------------------------------------------------------

function unwrapData<T>(response: unknown): T | undefined {
  if (typeof response === "object" && response !== null && "data" in response) {
    return (response as { data?: T }).data
  }
  return response as T | undefined
}

function unwrapList<T>(response: unknown): T[] | undefined {
  const data = unwrapData<T[]>(response)
  return Array.isArray(data) ? data : Array.isArray(response) ? (response as T[]) : undefined
}

/**
 * Tool registration compatibility across beta generations.
 *
 * - Current tagged `@opencode-ai/plugin@beta` types: `tools.add(tool)` where the
 *   definition object carries `name` and registration `options`.
 * - Documented V2 shape: `tools.add(name, tool, options?)`.
 *
 * Declared-function arity distinguishes them reliably (`options?` is excluded
 * from `Function.length`).
 */
type AddableTools = { add: (...args: unknown[]) => void }

function addTool(tools: AddableTools, definition: { name: string } & Record<string, unknown>): void {
  if (typeof tools.add !== "function") return
  if (tools.add.length >= 2) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { name, options, ...tool } = definition
    tools.add(name, tool, options)
  } else {
    tools.add(definition)
  }
}
