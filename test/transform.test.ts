import assert from "node:assert/strict"
import { test } from "node:test"

import { createContextHook } from "../lib/transform"
import type { SessionContextEvent, TransformDeps } from "../lib/transform"
import { resolveOptions } from "../lib/config"
import { createLogger } from "../lib/logger"
import { UsageTracker } from "../lib/nudges"
import { StateStore } from "../lib/state/store"
import { TranscriptMirror } from "../lib/transcript/mirror"
import { pruneToolDefinition } from "../lib/prune-tool"
import { estimateTokens, measureMessagesChars } from "../lib/tui-bridge"
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

function harness(depsOverride: Partial<TransformDeps> = {}) {
  const store = new StateStore(undefined)
  const mirror = new TranscriptMirror()
  const deps: TransformDeps = {
    config: CONFIG,
    logger: createLogger(false),
    store,
    mirror,
    usage: new UsageTracker(),
    isSubAgent: async () => false,
    catalogContextLimit: async () => 200_000,
    ...depsOverride,
  }
  const hook = createContextHook(deps)
  return { store, mirror, deps, hook }
}

function run(hook: ReturnType<typeof createContextHook>, messages: WireMessage[]) {
  return hook({
    sessionID: SESSION,
    agent: "default",
    model: { providerID: "p", id: "m" },
    system: [],
    messages,
  })
}

/** Concatenated text of every `<dcp-system-reminder>` in the transcript. */
function remindersOf(messages: WireMessage[]): string {
  return messages
    .flatMap((m) => m.content)
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .filter((text) => text.includes("dcp-system-reminder"))
    .join("\n")
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

// Regression: after a server restart or a revert/compaction commit the
// in-memory UsageTracker is blind (0 until the second post-reset usage
// event), so the nudge gate must not rely on it alone. The transcript
// measurement taken in the same hook is the floor: a near-full window must
// always arm the nudge, or the dispatch overflows the model window with a
// provider 400 (reported: 256K tokens = 98% of a 262K window, no nudge).
test("context nudge arms from the measured transcript when usage tracking is blind", async () => {
  const { hook } = harness()

  // 580_000 chars / 4 = ~145K tokens >= 70% of the 200K catalog window.
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: `context${"x".repeat(580_000)}` }] },
  ]
  await run(hook, messages)

  const reminders = remindersOf(messages)
  assert.match(reminders, /Context at ~\d+% of budget/)
  // The reminder rides the synthetic message appended at the transcript tail.
  const last = messages.at(-1)!
  assert.equal(last.role, "user")
  const part = last.content[0]!
  const text = part.type === "text" ? part.text : ""
  assert.match(text, /dcp-system-reminder/)
})

test("small transcript with a blind tracker stays silent", async () => {
  const { hook } = harness()
  const messages = fixture()
  await run(hook, messages)
  assert.equal(remindersOf(messages), "")
})

test("provider-reported usage above budget still arms the nudge", async () => {
  // Max() semantics: the tracker estimate wins when it exceeds the
  // measurement (small fixture measures ~0, warm tracker reports 150K = 75%).
  const tracker = new UsageTracker()
  tracker.record(SESSION, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  tracker.record(SESSION, { input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  const { hook } = harness({ usage: tracker })
  const messages = fixture()
  await run(hook, messages)
  assert.match(remindersOf(messages), /Context at ~75% of budget/)
})

test("dispatch seeds a blind usage tracker with the measured transcript", async () => {
  // Post-restart/post-revert the tracker has no baseline; the dispatch-time
  // measurement becomes its occupancy estimate, so `totalFor` consumers -
  // like the prune tool's usage note - are not blind for the first dispatch.
  const tracker = new UsageTracker()
  const { hook } = harness({ usage: tracker })
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: `context${"x".repeat(40_000)}` }] },
  ]
  await run(hook, messages)

  const measured = estimateTokens(measureMessagesChars(messages))
  assert.ok(measured > 0)
  assert.equal(tracker.totalFor(SESSION), measured)
})

test("dispatch stats carry the resolved context limit for the TUI", async () => {
  const published: Array<Parameters<NonNullable<TransformDeps["publishStats"]>>[0]> = []
  const { hook } = harness({ publishStats: (input) => published.push(input) })
  await run(hook, fixture())

  assert.equal(published.length, 1)
  assert.equal(published[0]?.dispatch.contextLimit, 200_000)
  assert.ok((published[0]?.dispatch.tokensBefore ?? 0) > 0)
})
