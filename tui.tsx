/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode-ai/plugin/tui"
import { For, Show } from "solid-js"

/**
 * DCP TUI companion. Loaded by the OpenCode TUI from this package's `./tui`
 * export (the server plugin sets `tui: true`). Reads the stats snapshot the
 * server-side plugin writes into
 * `<state>/opencode/<channel>/tui/plugin.opencode.dcp.tui.stats.json` —
 * the exact file backing `ctx.storage.store("stats")` — so updates appear
 * live while a session runs.
 *
 * Enabled by default; disable via the TUI-side registration options
 * (`options.enabled === false`), e.g. in `~/.config/opencode/cli.json`:
 * `"plugins": [{ "package": ".../tui.tsx", "options": { "enabled": false } }]`.
 * Server-side plugin options are NOT visible here; disabling the server side
 * (`{ "tui": { "enabled": false } }` on the server plugin) stops stats writes,
 * after which this companion renders nothing.
 */

interface CompressionEventRecord {
  at: number
  blockId: number
  topic: string
  ranges: number
  messagesCovered: number
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
    messagesOut: number
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
      percent >= 0 ? ctx.theme.text.success : ctx.theme.text.subdued

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
                                  {record.ranges === 1 ? "" : "s"} · {record.messagesCovered} msg ·{" "}
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
        ],
      }))
      return null
    }

    const disposeCommands = ctx.ui.slot({ append: "app", render: () => <Commands /> })

    // Slot claims are owned by the plugin scope and released automatically.
    return () => {
      disposeFooter()
      disposeCommands()
    }
  },
})
