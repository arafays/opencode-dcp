import { Plugin } from "@opencode/plugin";

import {
  addPruneTool,
  PRUNE_TOOL_NAME,
  pruneToolDefinition,
  pruneToolRegistered,
  type PruneToolEditor,
} from "./lib/prune-tool";
import { resolveOptions } from "./lib/config";
import { registerCommands } from "./lib/commands";
import { startEventPump } from "./lib/events";
import { createLogger } from "./lib/logger";
import { UsageTracker } from "./lib/nudges";
import { StateStore } from "./lib/state/store";
import { createContextHook, sessionTotals, type SessionContextEvent } from "./lib/transform";
import { TranscriptMirror } from "./lib/transcript/mirror";
import {
  buildStatsSnapshot,
  writeTuiStats,
  type CompressionEventRecord,
  type TuiStatsSnapshot,
} from "./lib/tui-bridge";

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

const PLUGIN_ID = "opencode.dcp";

export default Plugin.define({
  id: PLUGIN_ID,
  // Ships a TUI companion module ("./tui" export). The runtime detects it
  // itself (package `./tui` export or sibling tui.* file) — it is not part of
  // the `Plugin` type, and passing `tui: true` here is a type error.
  setup: async (ctx) => {
    // Config warnings predate config resolution (hence a separate logger);
    // warn output ignores the debug flag, it always lands in opencode.log.
    const configWarning = createLogger(false);
    const config = resolveOptions(ctx.options, (message) =>
      configWarning.warn(`config warning: ${message}`),
    );
    const logger = createLogger(config.debug);

    if (!config.enabled) {
      logger.debug("disabled by configuration");
      return;
    }

    const store = new StateStore(ctx.storage);
    const mirror = new TranscriptMirror();
    const usage = new UsageTracker();

    // Model context-window cache (provider/model -> tokens).
    //
    // A model absent from the cache is either "not listed yet" or "listed with
    // no limit" - both resolve to `undefined` and both fall back downstream.
    // The retry gate is what keeps a missing key from re-listing the catalog on
    // every single dispatch: a failed or incomplete listing is retried after
    // `catalogRetryAt`, not never (the old `catalogListed` latch) and not
    // always (an unbounded retry loop).
    const contextLimits = new Map<string, number | undefined>();
    /** Earliest time a (re)listing may run; also caps retries after a failure. */
    let catalogRetryAt = 0;
    const CATALOG_RETRY_MS = 60_000;
    /** In-flight catalog listing; concurrent dispatches await it instead of starting their own. */
    let catalogInflight: Promise<void> | undefined;

    const catalogContextLimit = async (
      providerID: string,
      modelId: string,
    ): Promise<number | undefined> => {
      const key = `${providerID}/${modelId}`;
      if (contextLimits.has(key)) return contextLimits.get(key);
      if (Date.now() < catalogRetryAt) return undefined;
      // Single-flight: catalogRetryAt only arms when a listing COMPLETES, so
      // while one is in flight (a hung modelApi.list above all) every
      // concurrent dispatch would otherwise start its own listing. Followers
      // await the flight, then read whatever it produced (cache entry, or
      // undefined alongside the armed retry gate after a failure).
      if (catalogInflight) {
        await catalogInflight.catch(() => {});
        return contextLimits.get(key);
      }
      const flight = (async () => {
        try {
          const modelApi = (ctx as unknown as CatalogContextShim).model;
          if (!modelApi) throw new Error("plugin context exposes no model domain");
          const response = await modelApi.list();
          const models = unwrapList<{
            providerID: string;
            id: string;
            limit?: { context?: number };
          }>(response);
          // An unparseable payload is a failed listing, not an empty catalog:
          // fall through to the retry gate instead of poisoning the cache.
          if (!models) throw new Error("model catalog response had no data array");
          for (const model of models) {
            if (typeof model?.providerID === "string" && typeof model?.id === "string") {
              contextLimits.set(
                `${model.providerID}/${model.id}`,
                typeof model.limit?.context === "number" ? model.limit.context : undefined,
              );
            }
          }
          // Listed successfully. Any model still missing (a provider that
          // published it later, or one with no limit) is re-checked on this
          // schedule rather than on every dispatch.
          catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
        } catch (error) {
          logger.warn("failed to list model catalog for context limits; retrying later", {
            error: error instanceof Error ? error.message : String(error),
          });
          catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
        }
      })();
      catalogInflight = flight;
      try {
        await flight;
      } finally {
        if (catalogInflight === flight) catalogInflight = undefined;
      }
      return contextLimits.get(key);
    };

    // Last model seen per session (the compress tool reports usage against it).
    const lastModel = new Map<string, { providerID: string; id: string }>();

    // TUI stats bridge: one shared snapshot per plugin generation, merged on
    // every dispatch and compression, written to the TUI's watched storage.
    let statsSnapshot: TuiStatsSnapshot | undefined;
    const publishStats = config.tui.enabled
      ? (input: {
          sessionId: string;
          model?: string;
          dispatch?: import("./lib/tui-bridge").DispatchMetrics;
          compression?: CompressionEventRecord;
          totals: ReturnType<typeof sessionTotals>;
        }) => {
          // The persisted store owns the compression history: this in-memory
          // snapshot resets on every plugin generation (dist rebuild, server
          // restart), and a fresh generation must not rewrite the TUI file
          // without the history it still displays.
          const runtime = store.peek(input.sessionId);
          const next = buildStatsSnapshot(statsSnapshot, {
            ...input,
            recentCompressions: runtime?.state.stats.recentCompressions,
          });
          statsSnapshot = next;
          writeTuiStats(next);
        }
      : undefined;
    const recordCompression = publishStats
      ? (input: { sessionId: string; record: CompressionEventRecord }) => {
          const runtime = store.peek(input.sessionId);
          if (!runtime) return;
          publishStats({
            sessionId: input.sessionId,
            compression: input.record,
            totals: sessionTotals(runtime.state),
          });
        }
      : undefined;

    // Sub-agent detection with a per-process cache.
    const subAgentCache = new Map<string, boolean>();
    const isSubAgent = async (sessionId: string): Promise<boolean> => {
      const cached = subAgentCache.get(sessionId);
      if (cached !== undefined) return cached;
      let result = false;
      try {
        const response = await ctx.session.get({ sessionID: sessionId });
        const parentID = unwrapData<{ parentID?: string }>(response)?.parentID;
        result = typeof parentID === "string" && parentID.length > 0;
      } catch {
        result = false;
      }
      subAgentCache.set(sessionId, result);
      return result;
    };

    const handleContext = createContextHook({
      config,
      logger,
      store,
      mirror,
      usage,
      isSubAgent,
      catalogContextLimit,
      publishStats: (input) => {
        if (!publishStats) return;
        publishStats({
          sessionId: input.sessionId,
          model: input.model,
          dispatch: input.dispatch,
          totals: input.totals,
        });
      },
    });

    await ctx.session.hook("context", async (event) => {
      const typed = event as unknown as SessionContextEvent;
      if (typed.model)
        lastModel.set(typed.sessionID, { providerID: typed.model.providerID, id: typed.model.id });
      await handleContext(typed);
    });

    // Registration failure is otherwise silent, so latch one warning per
    // plugin generation. Core's editor `add` drops a definition that fails
    // `registrationError` and only surfaces the reason through
    // `Effect.logError` in the domain's `notify` (packages/core/src/tool.ts:
    // 206-218) - never to the plugin. Without this the DCP system prompt keeps
    // advertising `prune` while every call fails with core's generic 'No tool
    // named "prune" is currently available'. Tool transforms run on registration
    // and reloads, never per dispatch, and a repeated identical warning adds
    // nothing, so one per generation is the whole budget.
    let registrationWarned = false;
    const warnRegistration = (message: string) => {
      if (registrationWarned) return;
      registrationWarned = true;
      logger.warn(`prune tool NOT registered: ${message}`);
    };

    // Observe prune executions with the authoritative IDs the transcript scan
    // cannot provide (messageID, status, input-decode failures our body never
    // sees). tool.hook has no tool-name filter, so filter client-side; log
    // only — the callback must never throw (a throwing hook fails the tool
    // run) and never mutates.
    //
    // `id` is the `Tool.CallID` the runtime assigns to this call - the same id the
    // tool_call part carries in the transcript, so a log line can be joined
    // straight to the model output that produced it. `input` is deliberately
    // NOT logged: for `prune` it is the model's full re-summarized text (often
    // thousands of tokens per range), and the tool body already logs the
    // failure with its session at debug.
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== PRUNE_TOOL_NAME) return;
      try {
        if (event.status === "error") {
          logger.warn("prune tool call failed", {
            messageID: event.messageID,
            sessionID: event.sessionID,
            agent: event.agent,
            id: event.id,
            // `Tool.Error` is an Effect TaggedError extending Error, so
            // String() renders `Tool.Error: <message>`; the runner wraps any
            // foreign throw into exactly that shape before the hook fires
            // (packages/core/src/tool/runtime.ts:37-45).
            error: String(event.error),
          });
        } else {
          logger.debug("prune tool call completed", {
            messageID: event.messageID,
            sessionID: event.sessionID,
            id: event.id,
          });
        }
      } catch {
        // Defensive: hook callbacks must never propagate.
      }
    });

    await ctx.tool.transform((tools) => {
      const registration = addPruneTool(
        tools as unknown as PruneToolEditor,
        pruneToolDefinition({
          store,
          mirror,
          logger,
          config,
          getModelContextLimit: (sessionId) => {
            const model = lastModel.get(sessionId);
            if (!model) return undefined;
            const key = `${model.providerID}/${model.id}`;
            const cached = contextLimits.get(key);
            if (cached !== undefined) return cached;
            // Wait out an in-flight/recent retry window instead of re-listing
            // the catalog on every single prune call; once the window opens,
            // repopulate asynchronously (the next dispatch/prune sees it).
            if (Date.now() < catalogRetryAt) return undefined;
            void catalogContextLimit(model.providerID, model.id).catch(() => {});
            return undefined;
          },
          getUsageTokens: (sessionId) => usage.totalFor(sessionId),
          markPruned: (sessionId) => usage.markPruned(sessionId),
          recordCompression,
        }),
      );
      if (!registration.ok) warnRegistration(registration.reason);
    });

    // One end-to-end confirmation against the COMMITTED registry, once per
    // plugin generation. `ctx.tool.transform` already rebuilt the draft before
    // it resolved (State.transform registers, then notifies, which runs the
    // transform synchronously - packages/core/src/state.ts:224-249), so this
    // only adds what the editor-local check cannot see: a transform registered
    // later in the chain dropping or shadowing `prune`. `ToolDomain.list` is a
    // plain read of the committed map (adapter -> core `Tool.Interface.list`,
    // packages/core/src/tool.ts:224). Absent on pre-`ToolDomain.list` runtimes,
    // where the editor-local check above already stands.
    //
    // shortcut: this sees only the transforms registered at setup time, so a
    // transform registered after ours that drops `prune` is invisible here;
    // upgrade by re-checking from the context hook, where `canPrune`
    // (lib/transform.ts) already knows per dispatch whether `prune` is exposed.
    if (typeof ctx.tool.list === "function") {
      void ctx.tool
        .list()
        .then((registered) => {
          if (!pruneToolRegistered(registered)) {
            warnRegistration(
              "`prune` is missing from the committed tool registry; a tool transform registered during plugin setup may have removed or overridden it - a transform registered after this plugin's setup is not visible to this check",
            );
          }
        })
        .catch((error) => {
          logger.debug("tool registry check unavailable", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    await ctx.command.transform((draft) => {
      registerCommands(draft, ctx);
    });

    // Background event pump; aborted when the plugin unloads.
    const controller = new AbortController();
    void startEventPump({
      subscribe: () => ctx.event.subscribe({ signal: controller.signal }),
      store,
      mirror,
      usage,
      logger,
      signal: controller.signal,
    });

    // Storage GC — startup reconcile. session.deleted (lib/events.ts) drops
    // state while we're up; sessions deleted while the plugin was down leave
    // orphaned `session/*` keys forever.
    //
    // The plugin contract still exposes no session LIST (SessionDomain picks
    // create/get/remove/switchAgent/switchModel/prompt/generate/command/
    // compact/synthetic/interrupt/update/move/wait/context plus `hook` —
    // packages/plugin/src/promise/session.ts:153-172), so there is no cheaper
    // way to ask "does this session still exist?" than probing each persisted
    // key with session.get.
    //
    // `session.remove` (DELETE /api/session/{id}) and `session.compact` both
    // joined that domain and are deliberately NOT used here: remove DELETES
    // the user's session, so calling it on a key we merely believe is an
    // orphan would destroy a live conversation, and compact spends a model
    // turn to summarise one. Neither can distinguish orphan from live the way
    // a positively identified not-found does.
    //
    // Delete ONLY a positively identified not-found: the declared body carries
    // _tag/name "SessionNotFoundError" (session.get declares 404 —
    // packages/client/src/promise/generated/client.ts:633-642 — and declared()
    // copies body fields onto the Error and sets name = _tag, same file at
    // :2293-2297), its message, or an UnexpectedStatus ClientError whose cause
    // carries status 404. Transport/5xx/malformed errors keep the key — an
    // orphan is cheap, a wrongly deleted live session would lose its
    // compression blocks. storage.scan exists on the context storage but not on
    // our StateStore storage type, so scan via ctx.storage directly.
    const isSessionNotFoundError = (error: unknown): boolean => {
      if (!error || typeof error !== "object") return false;
      const e = error as {
        _tag?: unknown;
        name?: unknown;
        message?: unknown;
        reason?: unknown;
        cause?: unknown;
      };
      if (e._tag === "SessionNotFoundError" || e.name === "SessionNotFoundError") return true;
      if (e.message === "Session not found") return true;
      const cause = e.cause as { status?: unknown } | undefined;
      return e.name === "ClientError" && e.reason === "UnexpectedStatus" && cause?.status === 404;
    };
    void (async () => {
      try {
        const prefix = "session/";
        let after: string | undefined;
        for (;;) {
          const page = await ctx.storage.scan(
            after === undefined ? { prefix } : { prefix, after },
          );
          for (const entry of page.entries) {
            const sessionId = entry.key.slice(prefix.length);
            if (!sessionId) continue;
            try {
              await ctx.session.get({ sessionID: sessionId });
            } catch (error) {
              if (!isSessionNotFoundError(error)) continue;
              await ctx.storage.remove(entry.key);
              logger.debug("storage GC; removed orphaned session state", {
                key: entry.key,
              });
            }
          }
          if (!page.next) break;
          after = page.next;
        }
      } catch (error) {
        logger.warn("startup reconcile failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    logger.debug("initialized", {
      maxContextLimit: config.maxContextLimit,
      strategies: {
        deduplication: config.strategies.deduplication.enabled,
        purgeErrors: config.strategies.purgeErrors.enabled,
      },
      allowSubAgents: config.allowSubAgents,
    });

    return () => {
      controller.abort();
    };
  },
});

// -- helpers -----------------------------------------------------------------

function unwrapData<T>(response: unknown): T | undefined {
  if (typeof response === "object" && response !== null && "data" in response) {
    return (response as { data?: T }).data;
  }
  return response as T | undefined;
}

function unwrapList<T>(response: unknown): T[] | undefined {
  const data = unwrapData<T[]>(response);
  return Array.isArray(data) ? data : Array.isArray(response) ? (response as T[]) : undefined;
}

/**
 * Model catalog access across beta generations.
 *
 * - Current opencode-v2: `catalog` was replaced by `ctx.model` and no longer
 *   exists, so upcoming beta bumps break both typecheck and runtime.
 *
 * The structural type is minimal: it only declares the `list` entrypoint,
 * whose result is normalized by `unwrapList`.
 */
type CatalogContextShim = {
  model?: { list(input?: unknown): Promise<unknown> };
  catalog?: { model?: { list(input?: unknown): Promise<unknown> } };
};
