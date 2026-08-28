import assert from "node:assert/strict"
import { test } from "node:test"

import { pruneToolDefinition } from "../lib/prune-tool"
import { resolveOptions } from "../lib/config"
import { createLogger } from "../lib/logger"
import { StateStore } from "../lib/state/store"
import { TranscriptMirror } from "../lib/transcript/mirror"
import { scanTranscript } from "../lib/transcript/scan"
import type { CompressionEventRecord } from "../lib/tui-bridge"
import type { ToolResultPart, WireMessage } from "../lib/types"

const CONFIG = resolveOptions(undefined, () => {})
const SESSION = "ses_test"

function fixture(): WireMessage[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "explore auth" }] },
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "read", input: { filePath: "a.ts" } }],
    },
    {
      id: "t1",
      role: "tool",
      content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "...auth files..." } }],
    },
    {
      id: "a2",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c2", name: "grep", input: { pattern: "auth" } },
        { type: "text", text: "findings so far" },
      ],
    },
    {
      id: "t2",
      role: "tool",
      content: [{ type: "tool-result", id: "c2", name: "grep", result: { type: "text", value: "...matches..." } }],
    },
    { id: "u2", role: "user", content: [{ type: "text", text: "implement now" }] },
    {
      id: "a3",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c3", name: "edit", input: {} },
        { type: "text", text: "working" },
      ],
    },
    {
      id: "t3",
      role: "tool",
      content: [{ type: "tool-result", id: "c3", name: "edit", result: { type: "text", value: "wrote file" } }],
    },
  ]
}

function harness() {
  const store = new StateStore(undefined)
  const mirror = new TranscriptMirror()
  const messages = fixture()
  const index = scanTranscript(messages)
  mirror.update(SESSION, index)
  const compressions: CompressionEventRecord[] = []
  const tool = pruneToolDefinition({
    store,
    mirror,
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => 200_000,
    getUsageTokens: () => 0,
    recordCompression: (input) => compressions.push(input.record),
  })
  const run = (input: unknown) => tool.execute(input, { sessionID: SESSION })
  return { store, index, messages, run, compressions }
}

test("prune records a block covering the selected range", async () => {
  const { store, index, run, compressions } = harness()
  const runtime = await store.ensure(SESSION)
  for (const key of index.keys) runtime.refs.ensure(key)

  const result = await run({
    topic: "Auth exploration",
    content: [{ startId: "m0001", endId: "m0004", summary: "Explored the auth system thoroughly." }],
  })

  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content))
  assert.match(String(result.content), /b1/)
  const state = runtime.state
  const block = state.blocks["1"]!
  assert.equal(block.active, true)
  assert.equal(block.coveredKeys.length, 4)
  assert.deepEqual(state.activeBlockIds, [1])
  assert.equal(block.anchorKey, "id:t2")
  assert.deepEqual(block.coveredToolIds, ["c1"])
  assert.equal(state.stats.compressRuns, 1)

  // TUI bridge record: one message range, one pruned tool output.
  assert.equal(compressions.length, 1)
  assert.equal(compressions[0]?.topic, "Auth exploration")
  assert.equal(compressions[0]?.messagesCovered, 4)
  assert.equal(compressions[0]?.toolsCovered, 1)
  assert.equal(compressions[0]?.tokensSaved, Math.max(0, compressions[0]!.tokensBefore - compressions[0]!.tokensAfter))
})

test("prune consumes intersected blocks and expands their placeholders", async () => {
  const { store, index, run, compressions } = harness()
  const runtime = await store.ensure(SESSION)
  for (const key of index.keys) runtime.refs.ensure(key)

  await run({
    topic: "First pass",
    content: [{ startId: "m0001", endId: "m0004", summary: "summary text" }],
  })
  const second = await run({
    topic: "Second pass",
    content: [{ startId: "m0003", endId: "m0005", summary: "Folded: (b1) plus more detail." }],
  })

  const state = runtime.state
  const first = state.blocks["1"]!
  const secondBlock = state.blocks["2"]!
  assert.equal(first.active, false)
  assert.equal(secondBlock.active, true)
  assert.deepEqual(state.activeBlockIds, [2])
  // Merged coverage: original range idx2..4 plus consumed block keys idx0..1.
  assert.equal(secondBlock.coveredKeys.length, 5)
  assert.ok(secondBlock.consumedBlockIds.includes(1))
  // Placeholder was expanded with the folded block's body.
  assert.match(secondBlock.summary, /summary text/)
  assert.match(secondBlock.summary, /plus more detail/)
  assert.match(secondBlock.summary, /<dcp-message-id>b2<\/dcp-message-id>/)
  assert.match(String(second.content), /b2/)

  // Second record folds the consumed block: 1 net new message, both tool
  // outputs (c1 from the folded block, c2 from the new range) counted.
  assert.equal(compressions.length, 2)
  assert.equal(compressions[1]?.messagesCovered, 1)
  assert.equal(compressions[1]?.toolsCovered, 2)
})

test("prune drops a consumed block whose placeholder is omitted", async () => {
  const { store, index, run } = harness()
  const runtime = await store.ensure(SESSION)
  for (const key of index.keys) runtime.refs.ensure(key)

  await run({
    topic: "First pass",
    content: [{ startId: "m0001", endId: "m0004", summary: "stale completed work details" }],
  })
  await run({
    topic: "Second pass",
    // No (b1) placeholder: the stale block's content is intentionally dropped.
    content: [{ startId: "m0003", endId: "m0005", summary: "only what matters now" }],
  })

  const secondBlock = runtime.state.blocks["2"]!
  assert.equal(secondBlock.active, true)
  assert.ok(secondBlock.consumedBlockIds.includes(1))
  assert.ok(!secondBlock.summary.includes("stale completed work details"))
})

test("prune rejects explicitly overlapping ranges and unknown ids", async () => {
  const { store, index, run } = harness()
  const runtime = await store.ensure(SESSION)
  for (const key of index.keys) runtime.refs.ensure(key)

  const overlap = await run({
    topic: "Overlap",
    content: [
      { startId: "m0001", endId: "m0002", summary: "one" },
      { startId: "m0002", endId: "m0003", summary: "two" },
    ],
  })
  assert.match(String(overlap.content), /^prune failed: ranges overlap/)

  const missing = await run({
    topic: "Missing",
    content: [{ startId: "m9999", endId: "m0003", summary: "nope" }],
  })
  assert.match(String(missing.content), /^prune failed:/)
  assert.match(String(missing.content), /does not exist in the current context/)
})

test("prune rejects malformed arguments and empty context", async () => {
  const { run } = harness()
  const badArgs = await run({ topic: "", content: [] })
  assert.match(String(badArgs.content), /^prune failed:/)

  const emptyStore = new StateStore(undefined)
  const emptyTool = pruneToolDefinition({
    store: emptyStore,
    mirror: new TranscriptMirror(),
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => undefined,
    getUsageTokens: () => 0,
  })
  const noContext = await emptyTool.execute(
    { topic: "x", content: [{ startId: "m0001", endId: "m0002", summary: "s" }] },
    { sessionID: "ses_other" },
  )
  assert.match(String(noContext.content), /no conversation context is available/)
})

test("prune clears pending nudge anchors on success", async () => {
  const { store, index, run } = harness()
  const runtime = await store.ensure(SESSION)
  for (const key of index.keys) runtime.refs.ensure(key)
  runtime.state.nudgeAnchors = [99]

  await run({
    topic: "Clear anchors",
    content: [{ startId: "m0001", endId: "m0004", summary: "done deal" }],
  })
  assert.deepEqual(runtime.state.nudgeAnchors, [])
})
