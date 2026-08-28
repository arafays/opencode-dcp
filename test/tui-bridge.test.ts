import assert from "node:assert/strict"
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  buildStatsSnapshot,
  estimateTokens,
  measureMessagesChars,
  resolveTuiStateDirs,
  writeTuiStats,
  type TuiStatsSnapshot,
} from "../lib/tui-bridge"
import { sessionTotals } from "../lib/transform"
import { createSessionState } from "../lib/state/types"

function tempRoot(): string {
  return path.join(os.tmpdir(), `dcp-tui-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
}

test("estimateTokens approximates chars/4", () => {
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(8), 2)
  assert.equal(estimateTokens(3), 1)
})

test("measureMessagesChars sums text sizes across message shapes", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "abcd" }] },
    { role: "assistant", content: [{ type: "text", text: "abcdef" }] },
  ]
  // "abcd"=4 + role/type keys + "abcdef"=6 plus structural strings.
  const chars = measureMessagesChars(messages)
  assert.ok(chars >= 10)
  assert.equal(measureMessagesChars(undefined), 0)
  assert.equal(measureMessagesChars([]), 0)
})

test("buildStatsSnapshot records dispatch deltas and keeps other sessions", () => {
  const previous = {
    version: 1 as const,
    generatedAt: 1,
    sessions: {
      other: {
        sessionId: "other",
        updatedAt: 5,
        totals: {
          dispatches: 1,
          compressRuns: 0,
          blocksActive: 0,
          blocksTotal: 0,
          blockTokensCovered: 0,
          blockTokensSummaries: 0,
          prunedTokensTotal: 0,
          messagesCompressedActive: 0,
        },
        recentCompressions: [],
      },
    },
  }

  const snapshot = buildStatsSnapshot(previous as TuiStatsSnapshot, {
    sessionId: "s1",
    model: "p/m",
    dispatch: { at: 10, model: "p/m", messagesIn: 4, tokensBefore: 1000, tokensAfter: 600 },
    totals: {
      dispatches: 1,
      compressRuns: 0,
      blocksActive: 0,
      blocksTotal: 0,
      blockTokensCovered: 0,
      blockTokensSummaries: 0,
      prunedTokensTotal: 0,
      messagesCompressedActive: 0,
    },
  })

  assert.ok(snapshot.sessions.other, "other session must survive the merge")
  const entry = snapshot.sessions.s1
  assert.ok(entry)
  assert.equal(entry.lastDispatch?.savedTokens, 400)
  assert.equal(entry.lastDispatch?.savedPercent, 40)
  assert.equal(snapshot.sessions.s1?.model, "p/m")
})

test("buildStatsSnapshot reports negative percent when boundary-ID overhead exceeds savings", () => {
  // Early-session dispatches can grow: injected <dcp-message-id> tags cost
  // tokens before the first compression pays them back. savedTokens clamps at
  // zero, but savedPercent stays signed so the TUI can render "+N%" overhead.
  const snapshot = buildStatsSnapshot(undefined, {
    sessionId: "s1",
    dispatch: { at: 10, messagesIn: 4, tokensBefore: 78200, tokensAfter: 78900 },
    totals: {
      dispatches: 1,
      compressRuns: 0,
      blocksActive: 0,
      blocksTotal: 0,
      blockTokensCovered: 0,
      blockTokensSummaries: 0,
      prunedTokensTotal: 0,
      messagesCompressedActive: 0,
    },
  })
  const entry = snapshot.sessions.s1
  assert.ok(entry?.lastDispatch)
  assert.equal(entry.lastDispatch.savedTokens, 0)
  assert.equal(entry.lastDispatch.savedPercent, -1)
})

test("buildStatsSnapshot caps recent compressions at 10", () => {
  let snapshot: TuiStatsSnapshot | undefined
  for (let index = 0; index < 14; index++) {
    snapshot = buildStatsSnapshot(snapshot, {
      sessionId: "s",
      compression: {
        at: index,
        blockId: index,
        topic: `t${index}`,
        ranges: 1,
        messagesCovered: 2,
        toolsCovered: 3,
        tokensBefore: 100,
        tokensAfter: 20,
        tokensSaved: 80,
      },
      totals: {
        dispatches: index,
        compressRuns: index,
        blocksActive: 1,
        blocksTotal: index,
        blockTokensCovered: 100,
        blockTokensSummaries: 20,
        prunedTokensTotal: 0,
        messagesCompressedActive: 2,
      },
    })
  }
  const list = snapshot?.sessions.s?.recentCompressions ?? []
  assert.equal(list.length, 10)
  assert.equal(list.at(-1)?.topic, "t13")
  assert.equal(list.at(-1)?.toolsCovered, 3)
})

test("sessionTotals summarizes active blocks and pruning", () => {
  const state = createSessionState("s")
  state.blocks["1"] = {
    blockId: 1,
    active: true,
    topic: "a",
    summary: "sum",
    summaryTokens: 20,
    compressedTokens: 100,
    coveredKeys: ["k1", "k2"],
    coveredToolIds: [],
    anchorKey: "tail",
    consumedBlockIds: [],
    createdAt: 0,
  }
  state.activeBlockIds = [1]
  state.stats.totalPrunedTokens = 55
  const totals = sessionTotals(state)
  assert.equal(totals.blocksActive, 1)
  assert.equal(totals.blockTokensCovered, 100)
  assert.equal(totals.blockTokensSummaries, 20)
  assert.equal(totals.messagesCompressedActive, 2)
  assert.equal(totals.prunedTokensTotal, 55)
})

test("writeTuiStats writes into every existing channel tui dir atomically", () => {
  const root = tempRoot()
  try {
    mkdirSync(path.join(root, "opencode", "beta", "tui"), { recursive: true })
    mkdirSync(path.join(root, "opencode", "local", "tui"), { recursive: true })
    writeTuiStats({ version: 1, generatedAt: 7, sessions: {} }, root)
    for (const channel of ["beta", "local"]) {
      const file = path.join(root, "opencode", channel, "tui", "plugin.opencode.dcp.tui.stats.json")
      const parsed = JSON.parse(readFileSync(file, "utf8")) as TuiStatsSnapshot
      assert.equal(parsed.version, 1)
      assert.equal(parsed.generatedAt, 7)
    }
    // No tmp leftovers.
    const entries = readdirSync(path.join(root, "opencode", "beta", "tui"))
    assert.equal(entries.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveTuiStateDirs creates missing tui dirs and tolerates absent roots", () => {
  const root = tempRoot()
  try {
    mkdirSync(path.join(root, "opencode", "beta"), { recursive: true })
    const dirs = resolveTuiStateDirs(root)
    assert.deepEqual(dirs, [path.join(root, "opencode", "beta", "tui")])
    assert.deepEqual(resolveTuiStateDirs(path.join(root, "does-not-exist")), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
