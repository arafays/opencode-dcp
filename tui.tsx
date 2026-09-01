/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

/**
 * DCP TUI companion. Loaded by the OpenCode TUI from this package's `./tui`
 * export (feature-detected by the runtime: package `./tui` export or a
 * sibling tui.* file next to the server plugin's index.*). Reads the stats
 * snapshot the server-side plugin writes into
 * `<state>/opencode/<channel>/tui/plugin.opencode.dcp.tui.stats.json` —
 * the exact file backing `ctx.storage.store("stats")` — so updates appear
 * live while a session runs.
 *
 * Enabled by default; disable via the TUI-side registration options
 * (`options.enabled === false`), e.g. in the global `~/.config/opencode/cli.json`:
 * `"plugins": ["-opencode.dcp.tui"]` (remove-directive by plugin ID).
 * Server-side plugin options are NOT visible here; disabling the server side
 * (`{ "tui": { "enabled": false } }` on the server plugin) stops stats writes,
 * after which this companion renders nothing.
 *
 * Besides the footer line and the on-demand report, a prune-summary card is
 * claimed at the `session.composer.top` slot (between the transcript and the
 * composer — the slot tree has no transcript-inline anchor). It pops when a
 * prune compression lands and auto-hides after `options.cardSeconds`
 * (default 30); the "DCP: toggle prune summary card" palette command pins it.
 */

interface CompressionEventRecord {
  at: number
  blockId: number
  topic: string
  ranges: number
  messagesCovered: number
  toolsCovered?: number
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
}

interface SessionStatsSnapshot {
  sessionId: string
  updatedAt: number
  model?: string
  lastDispatch?: {
    at: number
    agent?: string
    model?: string
    messagesIn: number
    tokensBefore: number
    tokensAfter: number
    savedTokens: number
    savedPercent: number
  }
  totals: {
    dispatches: number
    compressRuns: number
    blocksActive: number
    blocksTotal: number
    blockTokensCovered: number
    blockTokensSummaries: number
    prunedTokensTotal: number
    messagesCompressedActive: number
  }
  recentCompressions: CompressionEventRecord[]
}

interface StatsSnapshot {
  version: 1
  generatedAt: number
  sessions: Record<string, SessionStatsSnapshot>
}

const EMPTY_STATS: StatsSnapshot = { version: 1, generatedAt: 0, sessions: {} }

/** How long the prune-summary card stays above the composer after a prune. */
const DEFAULT_CARD_TTL_SECONDS = 30
/** Character width of the card's context-usage bar. */
const CONTEXT_BAR_WIDTH = 28

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function fmtTime(at: number): string {
  if (!at) return "-"
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

function fmtDate(at: number): string {
  if (!at) return "-"
  return new Date(at).toLocaleDateString()
}

/** Fixed-width context bar: `█` for used context, `·` for headroom. */
function contextBar(percent: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return "█".repeat(filled) + "·".repeat(width - filled)
}

export default Plugin.define({
  id: "opencode.dcp.tui",
  setup: (ctx) => {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    if (options.enabled === false) return

    const [stats] = ctx.storage.store<StatsSnapshot>("stats", { initial: EMPTY_STATS })

    const sessionStats = (sessionId?: string) => {
      if (!sessionId) return undefined
      return stats.sessions[sessionId]
    }

    // Semantic theme tokens: green when pruning paid off, amber while the
    // boundary-ID overhead of a fresh block is not yet paid back.
    const savingsColor = (percent: number) =>
      percent >= 0 ? ctx.theme.text.feedback.success.default : ctx.theme.text.subdued

    // Compact always-on line in the prompt footer status area.
    const disposeFooter = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const dispatch = () => sessionStats(input.sessionID)?.lastDispatch
        return (
          <Show when={dispatch()}>
            {(dispatch: () => NonNullable<SessionStatsSnapshot["lastDispatch"]>) => (
              <text>
                <span style={{ fg: ctx.theme.text.default }}>DCP </span>
                <span style={{ fg: savingsColor(dispatch().savedPercent) }}>
                  {dispatch().savedPercent >= 0 ? "−" : "+"}
                  {Math.abs(dispatch().savedPercent)}%
                </span>
                <span style={{ fg: ctx.theme.text.subdued }}>
                  {" "}
                  · {fmtTokens(dispatch().tokensBefore - dispatch().tokensAfter)} pruned
                </span>
              </text>
            )}
          </Show>
        )
      },
    })

    // Prune-summary card. The slot tree publishes no transcript-inline slot
    // (tool parts are host-rendered), so the closest anchor to "in between the
    // session transcript, right after the prune tool runs" is
    // "session.composer.top": the boundary between the transcript and the
    // composer. The card pops the moment a compression record lands in the
    // stats store, then auto-hides after `cardSeconds` (default 30); the
    // "DCP: toggle prune summary card" palette command pins it for the
    // session. Shared pin state lives at setup scope so both the slot render
    // and the keymap layer read the same signal.
    const [cardPinned, setCardPinned] = createSignal(false)

    const CompressionCard = (props: { sessionID: string }) => {
      const cardSeconds = options.cardSeconds
      const ttlMs =
        typeof cardSeconds === "number" && cardSeconds > 0 ? cardSeconds * 1000 : DEFAULT_CARD_TTL_SECONDS * 1000

      const entry = () => sessionStats(props.sessionID)
      const latest = () => {
        const current = entry()
        const recent = current?.recentCompressions
        return recent && recent.length > 0 ? recent[recent.length - 1] : undefined
      }

      const [flashed, setFlashed] = createSignal(false)
      const visible = () => cardPinned() || flashed()

      // Flash only on arrivals: the first observation of a session (TUI open,
      // session switch) is a baseline, so stale history never pops the card.
      // A compression that lands while the card is mounted — the prune tool
      // just returned — starts the auto-hide timer.
      createEffect((previous: { sessionID: string; at?: number } | undefined) => {
        const at = latest()?.at
        if (previous && previous.sessionID !== props.sessionID) {
          setFlashed(false)
        } else if (previous && at && at > (previous.at ?? 0)) {
          setFlashed(true)
          const timer = setTimeout(() => setFlashed(false), ttlMs)
          onCleanup(() => clearTimeout(timer))
        }
        return { sessionID: props.sessionID, at }
      })

      // Context usage from the same source the sidebar's Context section
      // reads: the last assistant token report after the last completed
      // compaction (respecting a revert boundary), matched against the
      // session model's context limit.
      const usage = () => {
        const session = ctx.data.session.get(props.sessionID)
        const messages = ctx.data.session.message.list(props.sessionID)
        if (!session || !messages?.length) return undefined
        const boundary = session.revert?.messageID
        const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
        if (boundary && boundaryIndex === -1) return undefined
        const end = boundaryIndex === -1 ? messages.length : boundaryIndex
        const compactionIndex = messages.findLastIndex(
          (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
        )
        const last = messages.findLast(
          (message, index) =>
            message.type === "assistant" &&
            message.tokens !== undefined &&
            index > compactionIndex &&
            index < end,
        )
        if (!last || last.type !== "assistant" || !last.tokens) return undefined
        const tokens =
          last.tokens.input +
          last.tokens.output +
          last.tokens.reasoning +
          last.tokens.cache.read +
          last.tokens.cache.write
        if (tokens <= 0) return undefined
        const models = ctx.data.location.model.list(session.location)
        const model = models?.find(
          (candidate) => candidate.providerID === last.model.providerID && candidate.id === last.model.id,
        )
        const limit = model?.limit.context
        return {
          tokens,
          limit,
          percent: limit && limit > 0 ? Math.round((tokens / limit) * 100) : undefined,
        }
      }

      // Cumulative savings: tool-output pruning plus the net tokens reclaimed
      // by active compression blocks (original content minus summary cost).
      const totalSaved = () => {
        const current = entry()
        if (!current) return 0
        return (
          Math.max(0, current.totals.prunedTokensTotal) +
          Math.max(0, current.totals.blockTokensCovered - current.totals.blockTokensSummaries)
        )
      }

      const severity = (percent: number) =>
        percent >= 85
          ? ctx.theme.text.feedback.error.default
          : percent >= 60
            ? ctx.theme.text.feedback.warning.default
            : ctx.theme.text.feedback.success.default

      const contextLabel = (value: { tokens: number; limit?: number; percent?: number }) => {
        const head = value.percent !== undefined ? ` ${String(value.percent)}%` : ` ${fmtTokens(value.tokens)}`
        return value.limit ? `${head} of ${fmtTokens(value.limit)} context` : `${head} in context`
      }

      return (
        <Show when={visible() ? latest() : undefined}>
          {(record: () => CompressionEventRecord) => {
            const savedPercent = () =>
              record().tokensBefore > 0 ? Math.round((record().tokensSaved / record().tokensBefore) * 100) : 0
            const context = () => usage()
            return (
              <box
                border
                borderStyle="rounded"
                borderColor={ctx.theme.border.default}
                marginTop={1}
                marginLeft={3}
                marginRight={2}
                paddingLeft={2}
                paddingRight={2}
                flexDirection="column"
              >
                <text>
                  <span style={{ fg: ctx.theme.text.feedback.success.default }}>▪ DCP</span>
                  <span style={{ fg: ctx.theme.text.subdued }}> │ </span>
                  <span style={{ fg: ctx.theme.text.default }}>
                    ~{fmtTokens(totalSaved())} tokens saved total
                  </span>
                </text>
                <Show when={context()}>
                  {(value: () => NonNullable<ReturnType<typeof usage>>) => (
                    <text>
                      <span style={{ fg: severity(value().percent ?? 0) }}>
                        {contextBar(value().percent ?? 0, CONTEXT_BAR_WIDTH)}
                      </span>
                      <span style={{ fg: ctx.theme.text.subdued }}>{contextLabel(value())}</span>
                    </text>
                  )}
                </Show>
                <text>
                  <span style={{ fg: ctx.theme.text.subdued }}>▪ </span>
                  <span style={{ fg: ctx.theme.text.default }}>
                    Compression #{String(entry()?.totals.compressRuns ?? 0)}{" "}
                  </span>
                  <span style={{ fg: ctx.theme.text.subdued }}>(</span>
                  <span style={{ fg: ctx.theme.text.feedback.success.default }}>
                    ~{fmtTokens(record().tokensSaved)} tokens
                  </span>
                  <span style={{ fg: ctx.theme.text.subdued }}>
                    {" "}
                    removed, {String(savedPercent())}% reduction)
                  </span>
                </text>
                <text>
                  <span style={{ fg: ctx.theme.text.subdued }}>→ Topic: </span>
                  <span style={{ fg: ctx.theme.text.default }}>{record().topic}</span>
                </text>
                <text>
                  <span style={{ fg: ctx.theme.text.subdued }}>→ Items: </span>
                  <span style={{ fg: ctx.theme.text.default }}>
                    {String(record().messagesCovered)} message{record().messagesCovered === 1 ? "" : "s"}
                    {record().toolsCovered === undefined
                      ? " compressed"
                      : ` and ${String(record().toolsCovered)} tool${record().toolsCovered === 1 ? "" : "s"} compressed`}
                  </span>
                </text>
                <text fg={ctx.theme.text.subdued}>
                  {fmtTime(record().at)} · {fmtDate(record().at)}
                </text>
              </box>
            )
          }}
        </Show>
      )
    }

    const disposeCard = ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => <CompressionCard sessionID={input.sessionID} />,
    })

    // Detailed report on demand: command palette → "DCP: compression report".
    //
    // Keymap layers must be created while a Solid component is setting up:
    // `ctx.keymap.layer` resolves the TUI's Keymap context at call time, and
    // plugin `setup` runs outside the render tree (no owner), so a direct call
    // here throws "Keymap.Provider is missing". Mounting a component through
    // the always-present "app" slot (the same pattern as OpenCode's built-in
    // plugins) gives the layer an owner, so it registers once and unwinds with
    // that slot's unmount.
    const Commands = () => {
      ctx.keymap.layer(() => ({
        commands: [
          {
            // Palette commands must be addressable: Keymap rejects any
            // `palette: true` entry without an explicit id ("Palette commands
            // require an ID").
            id: "dcp.compression-report",
            title: "DCP: compression report",
            description: "Show what Dynamic Context Pruning compressed in this session",
            group: "DCP",
            palette: true,
            run: () => {
              const route = ctx.ui.router.current()
              const sessionId = route.type === "session" ? route.sessionID : undefined
              ctx.ui.dialog.show(() => {
                const snapshot = () => sessionStats(sessionId)
                return (
                  <box
                    title=" DCP compression report "
                    border
                    padding={1}
                    width="70%"
                    height="60%"
                    backgroundColor={ctx.theme.background.default}
                  >
                    <Show
                      when={snapshot()}
                      fallback={
                        <text fg={ctx.theme.text.subdued}>No DCP activity recorded for this session yet.</text>
                      }
                    >
                      {(snapshot: () => SessionStatsSnapshot) => (
                        <box flexDirection="column" gap={1}>
                          <text>Session</text>
                          <Show when={snapshot().lastDispatch} fallback={<text>no dispatch yet</text>}>
                            {(dispatch: () => NonNullable<SessionStatsSnapshot["lastDispatch"]>) => (
                              <text>
                                Last dispatch {fmtTime(dispatch().at)} ·{" "}
                                <span style={{ fg: savingsColor(dispatch().savedPercent) }}>
                                  {dispatch().savedPercent >= 0 ? "−" : "+"}
                                  {Math.abs(dispatch().savedPercent)}% outbound tokens
                                </span>{" "}
                                ({fmtTokens(dispatch().tokensBefore)} → {fmtTokens(dispatch().tokensAfter)})
                              </text>
                            )}
                          </Show>
                          <text>
                            Dispatches {String(snapshot().totals.dispatches)} · compressions{" "}
                            {String(snapshot().totals.compressRuns)} · active blocks{" "}
                            {String(snapshot().totals.blocksActive)}/{String(snapshot().totals.blocksTotal)}
                          </text>
                          <text>
                            Blocks cover {fmtTokens(snapshot().totals.blockTokensCovered)} tok with{" "}
                            {fmtTokens(snapshot().totals.blockTokensSummaries)} tok of summaries · pruning
                            reclaimed {fmtTokens(snapshot().totals.prunedTokensTotal)} tok
                          </text>
                          <Show when={snapshot().recentCompressions.length > 0}>
                            <text>Recent compressions</text>
                            <For each={[...snapshot().recentCompressions].reverse()}>
                              {(record: CompressionEventRecord) => (
                                <text>
                                  {fmtTime(record.at)} · {record.topic} · {record.ranges} range
                                  {record.ranges === 1 ? "" : "s"} · {record.messagesCovered} msg
                                  {record.toolsCovered === undefined
                                    ? ""
                                    : ` · ${String(record.toolsCovered)} tool${record.toolsCovered === 1 ? "" : "s"}`}{" "}
                                  ·{" "}
                                  <span style={{ fg: ctx.theme.text.feedback.success.default }}>
                                    −{fmtTokens(record.tokensSaved)} tok
                                  </span>
                                </text>
                              )}
                            </For>
                          </Show>
                        </box>
                      )}
                    </Show>
                  </box>
                )
              })
            },
          },
          {
            id: "dcp.compression-card",
            title: "DCP: toggle prune summary card",
            description: "Pin or unpin the prune summary card shown between the transcript and the prompt",
            group: "DCP",
            palette: true,
            run: () => setCardPinned((value) => !value),
          },
        ],
      }))
      return null
    }

    const disposeCommands = ctx.ui.slot({ append: "app", render: () => <Commands /> })

    // Slot claims are owned by the plugin scope and released automatically.
    return () => {
      disposeFooter()
      disposeCard()
      disposeCommands()
    }
  },
})
