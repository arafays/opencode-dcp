import assert from "node:assert/strict";
import { test } from "node:test";

import { createContextHook } from "../lib/transform";
import type { TransformDeps } from "../lib/transform";
import { resolveOptions } from "../lib/config";
import { createLogger } from "../lib/logger";
import { UsageTracker } from "../lib/nudges";
import { StateStore, applyCompression } from "../lib/state/store";
import { TranscriptMirror } from "../lib/transcript/mirror";
import { pruneToolDefinition } from "../lib/prune-tool";
import { estimateTokens, measureMessagesChars } from "../lib/tui-bridge";
import type { WireMessage } from "../lib/types";

const CONFIG = resolveOptions(undefined, () => {});
const SESSION = "ses_transform";

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
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: { type: "text", value: "...auth files..." },
        },
      ],
    },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "findings so far" }] },
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
      content: [
        {
          type: "tool-result",
          id: "c3",
          name: "edit",
          result: { type: "text", value: "wrote file" },
        },
      ],
    },
  ];
}

function harness(depsOverride: Partial<TransformDeps> = {}) {
  const store = new StateStore(undefined);
  const mirror = new TranscriptMirror();
  const deps: TransformDeps = {
    config: CONFIG,
    logger: createLogger(false),
    store,
    mirror,
    usage: new UsageTracker(),
    isSubAgent: async () => false,
    catalogContextLimit: async () => 200_000,
    ...depsOverride,
  };
  const hook = createContextHook(deps);
  return { store, mirror, deps, hook };
}

function run(hook: ReturnType<typeof createContextHook>, messages: WireMessage[]) {
  return hook({
    sessionID: SESSION,
    agent: "default",
    model: { providerID: "p", id: "m" },
    system: [],
    messages,
  });
}

/** Concatenated text of every `<dcp-system-reminder>` in the transcript. */
function remindersOf(messages: WireMessage[]): string {
  return messages
    .flatMap((m) => m.content)
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .filter((text) => text.includes("dcp-system-reminder"))
    .join("\n");
}

/** Returns mNNNN/bN tags attached to each outbound message, in order. */
function tagsOf(messages: WireMessage[]): string[] {
  function textOf(m: WireMessage): string {
    return m.content
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "tool-result" && p.result.type === "text") return String(p.result.value);
        return "";
      })
      .join("\n");
  }
  return messages.map((m) => {
    const match = textOf(m).match(/<dcp-message-id>([^<]*)<\/dcp-message-id>/);
    return match ? match[1]! : "";
  });
}

test("boundary tags stay aligned with post-compression messages", async () => {
  const { store, mirror, hook } = harness();

  const dispatch = (messages: WireMessage[]) =>
    hook({
      sessionID: SESSION,
      agent: "default",
      model: { providerID: "p", id: "m" },
      system: [],
      messages,
    });

  // Dispatch 1: no compression. User/tool messages carry mNNNN; assistant
  // messages are intentionally untagged.
  let messages = fixture();
  await dispatch(messages);
  assert.deepEqual(tagsOf(messages), ["m0001", "", "m0003", "", "m0005", "", "m0007"]);

  // Prune the first four messages (u1..a2) into block b1.
  const tool = pruneToolDefinition({
    store,
    mirror,
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => 200_000,
    getUsageTokens: () => 0,
  });
  const result = await tool.execute(
    {
      topic: "Auth exploration",
      content: [{ startId: "m0001", endId: "m0004", summary: "Explored auth." }],
    },
    { sessionID: SESSION },
  );
  assert.ok(!String(result.content).startsWith("prune failed"));

  // Dispatch 2: compression active. The outbound array was mutated (covered
  // ranges removed, synthetic block spliced), so tags must be re-derived from
  // the post-compression array - not the original pre-compression keys.
  messages = fixture();
  await dispatch(messages);

  // Synthetic block carries b1; remaining real messages keep their correct,
  // non-conflicting mNNNN IDs (m0005 for u2, m0006 for a3, m0007 for t3).
  // The trailing synthetic message is the post-prune ack reminder, injected
  // after boundary tagging - so it deliberately carries no ID of its own.
  const dispatch2Tags = tagsOf(messages);
  assert.deepEqual(dispatch2Tags.slice(0, 4), ["b1", "m0005", "", "m0007"]);
  assert.equal(dispatch2Tags.at(-1), "");

  // No duplicate/conflicting IDs: each emitted mNNNN maps to a distinct key.
  const emitted = tagsOf(messages).filter((t) => t.startsWith("m"));
  assert.equal(new Set(emitted).size, emitted.length);

  // Regression for the reported symptom: "prune only works the first time".
  // After a compression the model addresses messages by the tags it was shown.
  // Under the buggy code those tags mapped to pre-compression keys whose
  // messages were already removed, so a second prune failed with
  // "does not exist". Here we prune again using the *displayed* tag for u2
  // (index 1) through t3 (index 3) and require it to succeed and yield b2.
  const postTags = tagsOf(messages);
  const u2Tag = postTags[1]!; // "m0005" on fixed code, "m0002" on buggy code
  const t3Tag = postTags[3]!; // "m0007" on fixed code, "m0004" on buggy code
  const second = await tool.execute(
    {
      topic: "Implement auth",
      content: [{ startId: u2Tag, endId: t3Tag, summary: "Implemented auth." }],
    },
    { sessionID: SESSION },
  );
  assert.ok(!String(second.content).startsWith("prune failed"), String(second.content));
  assert.match(String(second.content), /b2/);
});

// Regression: after a server restart or a revert/compaction commit the
// in-memory UsageTracker is blind (0 until the second post-reset usage
// event), so the nudge gate must not rely on it alone. The transcript
// measurement taken in the same hook is the floor: a near-full window must
// always arm the nudge, or the dispatch overflows the model window with a
// provider 400 (reported: 256K tokens = 98% of a 262K window, no nudge).
test("context nudge arms from the measured transcript when usage tracking is blind", async () => {
  const { hook } = harness();

  // 580_000 chars / 4 = ~145K tokens >= 70% of the 200K catalog window.
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: `context${"x".repeat(580_000)}` }] },
  ];
  await run(hook, messages);

  const reminders = remindersOf(messages);
  assert.match(reminders, /Context is ~[\d,]+ tokens: \d+% of the [\d,]+-token pruning budget/);
  // The reminder rides the synthetic message appended at the transcript tail.
  const last = messages.at(-1)!;
  assert.equal(last.role, "user");
  const part = last.content[0]!;
  const text = part.type === "text" ? part.text : "";
  assert.match(text, /dcp-system-reminder/);
});

test("small transcript with a blind tracker stays silent", async () => {
  const { hook } = harness();
  const messages = fixture();
  await run(hook, messages);
  assert.equal(remindersOf(messages), "");
});

test("provider-reported usage above budget still arms the nudge", async () => {
  // Max() semantics: the tracker estimate wins when it exceeds the
  // measurement (small fixture measures ~0, warm tracker reports 150K).
  // Both denominators are named: the BUDGET (70% of the 200K catalog window
  // = 140K, so 150K reads ~107%) and the window itself (~75%).
  const tracker = new UsageTracker();
  tracker.record(SESSION, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  tracker.record(SESSION, { input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const { hook } = harness({ usage: tracker });
  const messages = fixture();
  await run(hook, messages);
  assert.match(
    remindersOf(messages),
    /Context is ~150,000 tokens: 107% of the 140,000-token pruning budget \(~75% of the 200,000-token model window\)/,
  );
});

test("dispatch seeds a blind usage tracker with the measured transcript", async () => {
  // Post-restart/post-revert the tracker has no baseline; the dispatch-time
  // measurement becomes its occupancy estimate, so `totalFor` consumers -
  // like the prune tool's usage note - are not blind for the first dispatch.
  const tracker = new UsageTracker();
  const { hook } = harness({ usage: tracker });
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: `context${"x".repeat(40_000)}` }] },
  ];
  await run(hook, messages);

  const measured = estimateTokens(measureMessagesChars(messages));
  assert.ok(measured > 0);
  assert.equal(tracker.totalFor(SESSION), measured);
});

test("sub-agent sessions are skipped before any state or mirror work", async () => {
  const calledWith: string[] = [];
  const { store, mirror, hook } = harness({
    isSubAgent: async (id) => {
      calledWith.push(id);
      return true;
    },
  });
  await run(hook, fixture());
  assert.deepEqual(calledWith, [SESSION]);
  // The gate runs before store.ensure / mirror.update: no memory entry and no
  // mirror snapshot leak for the skipped session.
  assert.equal(store.peek(SESSION), undefined);
  assert.equal(mirror.get(SESSION), undefined);
});

test("assignRefs skips keys already covered by an active compression block", async () => {
  const { store, hook } = harness();
  const runtime = await store.ensure(SESSION);
  applyCompression({
    state: runtime.state,
    refs: runtime.refs,
    topic: "Auth exploration",
    summary: "Explored auth.",
    coveredKeys: ["id:u1", "id:a1"],
    coveredToolIds: ["c1"],
    coveredTokens: 100,
    consumedBlockIds: [],
    anchorKey: "id:t1",
  });
  await run(hook, fixture());

  // Covered keys are invisible to the model: no refs are burned on them.
  assert.equal(runtime.refs.refOf("id:u1"), undefined);
  assert.equal(runtime.refs.refOf("id:a1"), undefined);
  // Uncovered keys still allocate refs, starting from m0001.
  assert.equal(runtime.refs.refOf("id:t1"), "m0001");
  assert.equal(runtime.refs.refOf("id:u2"), "m0003");
});

test("dispatch stats carry the resolved context limit for the TUI", async () => {
  const published: Array<Parameters<NonNullable<TransformDeps["publishStats"]>>[0]> = [];
  const { hook } = harness({ publishStats: (input) => published.push(input) });
  await run(hook, fixture());

  assert.equal(published.length, 1);
  assert.equal(published[0]?.dispatch.contextLimit, 200_000);
  assert.ok((published[0]?.dispatch.tokensBefore ?? 0) > 0);
});

// The reported bug: after the model pruned, the reminder STAYED in context -
// `applyCompression` clears the rate-limit anchors and the warm provider delta
// still described the pre-prune prompt, so the very next dispatch re-nudged
// with the number the model had just acted on. The dispatch after a prune must
// instead acknowledge the prune with a fresh measurement and go quiet.
test("the dispatch after a prune acknowledges with fresh numbers instead of re-nudging", async () => {
  const { store, mirror, deps, hook } = harness();
  // Warm tracker reporting a pre-prune 150K (the stale arm).
  deps.usage.record(SESSION, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  deps.usage.record(SESSION, { input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

  // Dispatch 1: over budget, so the pressure reminder fires.
  const first = fixture();
  await run(hook, first);
  assert.match(remindersOf(first), /Context is ~150,000 tokens/);

  // The model does what the reminder asked and prunes.
  const tool = pruneToolDefinition({
    store,
    mirror,
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => 200_000,
    getUsageTokens: () => 150_000,
    markPruned: (id) => deps.usage.markPruned(id),
  });
  const pruned = await tool.execute(
    {
      topic: "Auth exploration",
      content: [{ startId: "m0001", endId: "m0004", summary: "Explored auth." }],
    },
    { sessionID: SESSION },
  );
  assert.ok(String(pruned.content).includes("b1"), String(pruned.content));

  // Dispatch 2: the ack wins over the nudge, quotes the fresh measurement
  // (the stale 150K must not reappear), and resolves the earlier reminder.
  const second = fixture();
  await run(hook, second);
  const ack = remindersOf(second);
  assert.match(ack, /Prune applied \(b1\)/);
  assert.ok(!ack.includes("150,000"), ack);
  assert.match(ack, /No further pruning needed/);

  // Dispatch 3: the ack is consumed and the measurement is still under budget,
  // so nothing is injected. `markPruned` zeroed the pre-prune delta and dropped
  // the baseline, so dispatch 2 re-seeded the tracker from its own (small)
  // measurement - a current number recorded against the new epoch, which
  // clears staleness rather than carrying the stale 150,000 forward.
  assert.equal(deps.usage.isStale(SESSION), false);
  assert.ok(deps.usage.totalFor(SESSION) > 0);
  assert.ok(deps.usage.totalFor(SESSION) < 140_000);
  const third = fixture();
  await run(hook, third);
  assert.equal(remindersOf(third), "");
});

// The ack must forward `lastCompression.messagesCovered`: while over budget,
// a pure re-summarize (0 new messages) gets the "do not repeat" wording, a
// pass that covered messages keeps the standard "prune again only if ..."
// wording. The fixture keeps one huge message OUTSIDE every pruned range so
// the measured transcript stays over budget across all three dispatches.
test("the ack forwards messagesCovered: a zero-message re-summarize must not repeat", async () => {
  const { store, mirror, deps, hook } = harness();

  const bigFixture = (): WireMessage[] => [
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: `context${"x".repeat(580_000)}` }],
    },
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "read", input: {} }],
    },
    {
      id: "t1",
      role: "tool",
      content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "one" } }],
    },
    { id: "u2", role: "user", content: [{ type: "text", text: "now implement" }] },
  ];

  const tool = pruneToolDefinition({
    store,
    mirror,
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => 200_000,
    getUsageTokens: () => 0,
    markPruned: (id) => deps.usage.markPruned(id),
  });

  // Dispatch 1: ~145K measured >= the 140K budget, so the pressure reminder
  // arms (refs: u1=m0001, a1=m0002, tool:c1=m0003, u2=m0004).
  const first = bigFixture();
  await run(hook, first);
  assert.match(remindersOf(first), /Context is ~[\d,]+ tokens/);

  // Prune a small section (2 messages); the huge u1 stays outside it.
  const pruned = await tool.execute(
    {
      topic: "Read the file",
      content: [
        {
          startId: "m0002",
          endId: "m0003",
          summary: "dense original findings and decisions ".repeat(18),
        },
      ],
    },
    { sessionID: SESSION },
  );
  assert.ok(String(pruned.content).includes("b1"), String(pruned.content));

  // Dispatch 2: still over budget (u1 intact). The ack covers a pass that
  // DID cover messages, so the standard wording applies.
  const second = bigFixture();
  await run(hook, second);
  const coveredAck = remindersOf(second);
  assert.match(coveredAck, /Prune applied \(b1\)/);
  assert.match(coveredAck, /Still above the pruning budget/);
  assert.ok(!coveredAck.includes("covered no new messages"), coveredAck);

  // Re-summarize b1 with a substantially shorter summary (clears the
  // zero-gain floor, covers 0 new messages).
  const tightened = await tool.execute(
    { topic: "Tighten", content: [{ startId: "b1", endId: "b1", summary: "tight one-liner about c1" }] },
    { sessionID: SESSION },
  );
  assert.match(String(tightened.content), /^Re-summarized already-compressed content/);

  // Dispatch 3: over budget still, but the LAST compression covered no new
  // messages - the ack must say so and forbid repeating the pass.
  const third = bigFixture();
  await run(hook, third);
  const zeroAck = remindersOf(third);
  assert.match(zeroAck, /Prune applied \(b2\)/);
  assert.match(zeroAck, /covered no new messages/);
  assert.ok(!zeroAck.includes("Still above the pruning budget"), zeroAck);
});
