import assert from "node:assert/strict"
import { test } from "node:test"

import { createContextHook } from "../lib/transform"
import type { SessionContextEvent, TransformDeps } from "../lib/transform"
import { resolveOptions } from "../lib/config"
import { createLogger } from "../lib/logger"
import { StateStore } from "../lib/state/store"
import { TranscriptMirror } from "../lib/transcript/mirror"
import { pruneToolDefinition } from "../lib/prune-tool"
import type { WireMessage } from "../lib/types"

const CONFIG = resolveOptions(undefined, () => {})
const SESSION = "ses_transform"

function fixture(): WireMessage[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "explore auth" }] },
    { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { filePath: "a.ts" } }] },
    { id: "t1", role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "...auth files..." } }] },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "findings so far" }] },
    { id: "u2", role: "user", content: [{ type: "text", text: "implement now" }] },
    { id: "a3", role: "assistant", content: [{ type: "tool-call", id: "c3", name: "edit", input: {} }, { type: "text", text: "working" }] },
    { id: "t3", role: "tool", content: [{ type: "tool-result", id: "c3", name: "edit", result: { type: "text", value: "wrote file" } }] },
  ]
}

function harness() {
  const store = new StateStore(undefined)
  const mirror = new TranscriptMirror()
  const deps: TransformDeps = {
    config: CONFIG,
    logger: createLogger(false),
    store,
    mirror,
    usage: { totalFor: () => 0 } as any,
    isSubAgent: async () => false,
    catalogContextLimit: async () => 200_000,
  }
  const hook = createContextHook(deps)
  return { store, mirror, deps, hook }
}

/** Returns mNNNN/bN tags attached to each outbound message, in order. */
function tagsOf(messages: WireMessage[]): string[] {
  function textOf(m: WireMessage): string {
    return m.content
      .map((p) => {
        if (p.type === "text") return p.text
        if (p.type === "tool-result" && p.result.type === "text") return String(p.result.value)
        return ""
      })
      .join("\n")
  }
  return messages.map((m) => {
    const match = textOf(m).match(/<dcp-message-id>([^<]*)<\/dcp-message-id>/)
    return match ? match[1]! : ""
  })
}

test("boundary tags stay aligned with post-compression messages", async () => {
  const { store, mirror, hook } = harness()

  const dispatch = (messages: WireMessage[]) =>
    hook({
      sessionID: SESSION,
      agent: "default",
      model: { providerID: "p", id: "m" },
      system: [],
      messages,
    })

  // Dispatch 1: no compression. User/tool messages carry mNNNN; assistant
  // messages are intentionally untagged.
  let messages = fixture()
  await dispatch(messages)
  assert.deepEqual(tagsOf(messages), ["m0001", "", "m0003", "", "m0005", "", "m0007"])

  // Prune the first four messages (u1..a2) into block b1.
  const tool = pruneToolDefinition({
    store,
    mirror,
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => 200_000,
    getUsageTokens: () => 0,
  })
  const result = await tool.execute(
    { topic: "Auth exploration", content: [{ startId: "m0001", endId: "m0004", summary: "Explored auth." }] },
    { sessionID: SESSION },
  )
  assert.ok(!String(result.content).startsWith("prune failed"))

  // Dispatch 2: compression active. The outbound array was mutated (covered
  // ranges removed, synthetic block spliced), so tags must be re-derived from
  // the post-compression array - not the original pre-compression keys.
  messages = fixture()
  await dispatch(messages)

  // Synthetic block carries b1; remaining real messages keep their correct,
  // non-conflicting mNNNN IDs (m0005 for u2, m0006 for a3, m0007 for t3).
  assert.deepEqual(tagsOf(messages), ["b1", "m0005", "", "m0007"])

  // No duplicate/conflicting IDs: each emitted mNNNN maps to a distinct key.
  const emitted = tagsOf(messages).filter((t) => t.startsWith("m"))
  assert.equal(new Set(emitted).size, emitted.length)

  // Regression for the reported symptom: "prune only works the first time".
  // After a compression the model addresses messages by the tags it was shown.
  // Under the buggy code those tags mapped to pre-compression keys whose
  // messages were already removed, so a second prune failed with
  // "does not exist". Here we prune again using the *displayed* tag for u2
  // (index 1) through t3 (index 3) and require it to succeed and yield b2.
  const postTags = tagsOf(messages)
  const u2Tag = postTags[1]! // "m0005" on fixed code, "m0002" on buggy code
  const t3Tag = postTags[3]! // "m0007" on fixed code, "m0004" on buggy code
  const second = await tool.execute(
    { topic: "Implement auth", content: [{ startId: u2Tag, endId: t3Tag, summary: "Implemented auth." }] },
    { sessionID: SESSION },
  )
  assert.ok(!String(second.content).startsWith("prune failed"), String(second.content))
  assert.match(String(second.content), /b2/)
})
