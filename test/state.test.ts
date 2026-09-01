import assert from "node:assert/strict"
import { test } from "node:test"

import { MAX_RECENT_COMPRESSIONS } from "../lib/tui-bridge"
import { createSessionState, hydrateSessionState } from "../lib/state/types"

function record(index: number) {
  return {
    at: index,
    blockId: index,
    topic: `t${index}`,
    ranges: 1,
    messagesCovered: 2,
    toolsCovered: 3,
    tokensBefore: 100,
    tokensAfter: 20,
    tokensSaved: 80,
  }
}

test("createSessionState starts with an empty compression history", () => {
  assert.deepEqual(createSessionState("s").stats.recentCompressions, [])
})

test("hydrateSessionState defaults the compression history for legacy states", () => {
  const state = hydrateSessionState(
    { sessionId: "s", stats: { totalPrunedTokens: 5, compressRuns: 1, dispatches: 2 } },
    "s",
  )
  assert.deepEqual(state.stats.recentCompressions, [])
  assert.equal(state.stats.compressRuns, 1)
})

test("hydrateSessionState coerces persisted compression records and drops junk", () => {
  const state = hydrateSessionState(
    {
      sessionId: "s",
      stats: {
        recentCompressions: [
          { topic: "no numbers" },
          7,
          record(1),
          { ...record(2), toolsCovered: "bad" },
        ],
      },
    },
    "s",
  )
  assert.equal(state.stats.recentCompressions.length, 2)
  assert.equal(state.stats.recentCompressions[0]?.topic, "t1")
  // toolsCovered is optional: a malformed value drops to undefined, not NaN.
  assert.equal(state.stats.recentCompressions[1]?.topic, "t2")
  assert.equal(state.stats.recentCompressions[1]?.toolsCovered, undefined)
})

test("hydrateSessionState caps the compression history", () => {
  const recentCompressions = Array.from({ length: MAX_RECENT_COMPRESSIONS + 5 }, (_, index) =>
    record(index),
  )
  const state = hydrateSessionState({ sessionId: "s", stats: { recentCompressions } }, "s")
  assert.equal(state.stats.recentCompressions.length, MAX_RECENT_COMPRESSIONS)
  assert.equal(state.stats.recentCompressions.at(-1)?.topic, `t${MAX_RECENT_COMPRESSIONS + 4}`)
})
