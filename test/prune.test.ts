import assert from "node:assert/strict"
import { test } from "node:test"

import { resolveOptions } from "../lib/config"
import {
  applyCompressionBlocks,
  injectBoundaryTags,
  pruneToolOutputs,
} from "../lib/prune"
import { applyCompression, wrapCompressedSummary } from "../lib/state/store"
import { createSessionState, type SessionState } from "../lib/state/types"
import { scanTranscript } from "../lib/transcript/scan"
import { stripHallucinatedTags } from "../lib/transcript/edit"
import type { ToolResultPart, WireMessage } from "../lib/types"

const CONFIG = resolveOptions(undefined, () => {})

const PRUNED_PLACEHOLDER = "[Output removed to save context - information superseded or no longer needed]"

function toolMessage(id: string, callId: string, name: string, result: ToolResultPart["result"]): WireMessage {
  return { id, role: "tool", content: [{ type: "tool-result", id: callId, name, result }] }
}

test("pruneToolOutputs replaces pruned outputs with a placeholder", () => {
  const state = createSessionState("s")
  state.prunedTools = { c1: 120 }
  const messages: WireMessage[] = [
    toolMessage("t1", "c1", "read", { type: "json", value: { big: "payload" } }),
    toolMessage("t2", "c2", "grep", { type: "text", value: "keep me" }),
  ]
  pruneToolOutputs(state, messages, CONFIG)
  assert.deepEqual((messages[0]!.content[0] as ToolResultPart).result, { type: "text", value: PRUNED_PLACEHOLDER })
  // Untouched call stays intact.
  assert.equal((messages[1]!.content[0] as ToolResultPart).result.type, "text")
})

test("pruneToolOutputs never touches protected tools", () => {
  const state = createSessionState("s")
  state.prunedTools = { q1: 50 }
  const messages: WireMessage[] = [
    toolMessage("t1", "q1", "question", { type: "json", value: { answers: ["yes"] } }),
  ]
  pruneToolOutputs(state, messages, CONFIG)
  assert.equal((messages[0]!.content[0] as ToolResultPart).result.type, "json")

  const globbed = resolveOptions({ protectedTools: ["mcp*"] }, () => {})
  const state2 = createSessionState("s2")
  state2.prunedTools = { m1: 30 }
  const messages2: WireMessage[] = [
    toolMessage("t1", "m1", "mcpSearch", { type: "json", value: { ok: true } }),
  ]
  pruneToolOutputs(state2, messages2, globbed)
  assert.equal((messages2[0]!.content[0] as ToolResultPart).result.type, "json")
})

test("pruneToolOutputs blanks inputs of pruned errored calls", () => {
  const state = createSessionState("s")
  state.prunedTools = { c9: 10 }
  const messages: WireMessage[] = [
    {
      id: "a9",
      role: "assistant",
      content: [{ type: "tool-call", id: "c9", name: "bash", input: { command: "rm -rf /" } }],
    },
    toolMessage("t9", "c9", "bash", { type: "error", value: { message: "boom" } }),
  ]
  pruneToolOutputs(state, messages, CONFIG)
  const assistant = messages[0]!
  assert.equal(
    (assistant.content[0] as { input: Record<string, unknown> }).input.command,
    "[input removed due to failed tool call]",
  )
  assert.equal((messages[1]!.content[0] as ToolResultPart).result.type, "text")
})

function buildCompressedState(): { state: SessionState; keys: string[]; messages: WireMessage[] } {
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "explore" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "found things" }] },
    { id: "t1", role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "data" } }] },
  ]
  const index = scanTranscript(messages)
  const state = createSessionState("s")
  const block = applyCompression({
    state,
    refs: { ensure: (key: string) => key, keyOf: () => undefined } as never,
    topic: "exploration",
    summary: "summary text",
    coveredKeys: [index.keys[0]!, index.keys[1]!],
    coveredToolIds: [],
    coveredTokens: 500,
    consumedBlockIds: [],
    anchorKey: index.keys[2]!,
  })
  void block
  return { state, keys: index.keys, messages }
}

test("applyCompressionBlocks swaps covered ranges for an anchored summary", () => {
  const { state, keys, messages } = buildCompressedState()
  applyCompressionBlocks(state, messages, keys)
  assert.equal(messages.length, 2)
  const synthetic = messages[0]!
  assert.equal(synthetic.role, "user")
  const text =
    synthetic.content[0]?.type === "text" ? synthetic.content[0].text : ""
  assert.match(text, /\[Compressed conversation section\]/)
  assert.match(text, /summary text/)
  assert.match(text, /<dcp-message-id>b1<\/dcp-message-id>/)
  // The anchor message survives.
  assert.equal(messages[1]!.id, "t1")
})

test("applyCompressionBlocks appends tail-anchored summaries at the end", () => {
  const { state, keys } = buildCompressedState()
  state.blocks["1"]!.anchorKey = "tail"
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "explore" }] },
    { id: "a1", role: "assistant", content: [] },
    { id: "t1", role: "tool", content: [] },
  ]
  applyCompressionBlocks(state, messages, keys)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]!.id, "t1")
  assert.equal(messages[1]!.role, "user")
})

test("injectBoundaryTags tags user texts and textual tool results only", () => {
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "hello" }] },
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "echoed <dcp-message-id>m0042</dcp-message-id>" }],
    },
    {
      id: "t1",
      role: "tool",
      content: [
        { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "output" } },
        { type: "tool-result", id: "c2", name: "read", result: { type: "json", value: { x: 1 } } },
      ],
    },
  ]
  const index = scanTranscript(messages)
  injectBoundaryTags(new Map([["id:u1", "m0001"], ["id:t1", "m0003"]]), messages, index.keys)

  const userText = (messages[0]!.content[0]! as { text: string }).text
  assert.match(userText, /^hello\n<dcp-message-id>m0001<\/dcp-message-id>$/)
  // Hallucinated tag in assistant output is stripped.
  assert.ok(!((messages[1]!.content[0]! as { text: string }).text.includes("dcp-message-id")))
  const results = messages[2]!.content as ToolResultPart[]
  assert.match(results[0]!.result.value as string, /<dcp-message-id>m0003<\/dcp-message-id>$/)
  // JSON results are left untouched.
  assert.deepEqual(results[1]!.result.value, { x: 1 })
})

test("stripHallucinatedTags removes echoed boundary tags", () => {
  const cleaned = stripHallucinatedTags("para\n<dcp-message-id>m0042</dcp-message-id>\ntail")
  assert.ok(!cleaned.includes("dcp-message-id"))
  assert.ok(cleaned.includes("para"))
  assert.ok(cleaned.includes("tail"))
})

test("wrapCompressedSummary produces the canonical wrapper", () => {
  const wrapped = wrapCompressedSummary(3, "body")
  assert.match(wrapped, /^\[Compressed conversation section\]\nbody\n<dcp-message-id>b3<\/dcp-message-id>$/)
})
