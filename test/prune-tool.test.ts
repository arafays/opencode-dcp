import assert from "node:assert/strict";
import { test } from "node:test";

import { pruneToolDefinition, ZERO_GAIN_MIN_TOKENS, type PruneDeps } from "../lib/prune-tool";
import { resolveOptions } from "../lib/config";
import { createLogger } from "../lib/logger";
import { StateStore, type JsonStorage } from "../lib/state/store";
import { TranscriptMirror } from "../lib/transcript/mirror";
import { scanTranscript } from "../lib/transcript/scan";
import { countTokens } from "../lib/tokens";
import type { CompressionEventRecord } from "../lib/tui-bridge";
import type { WireMessage } from "../lib/types";

const CONFIG = resolveOptions(undefined, () => {});
const SESSION = "ses_test";

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
      // Sized so a covered range reclaims >1k tokens: the usage-note test
      // needs the post-prune percent to drop below the raw 75% figure.
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: { type: "text", value: "...auth files... " + "auth route detail. ".repeat(400) },
        },
      ],
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
      content: [
        {
          type: "tool-result",
          id: "c2",
          name: "grep",
          result: { type: "text", value: "...matches..." },
        },
      ],
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

function harness(
  depsOverride: Partial<PruneDeps> = {},
  messages: WireMessage[] = fixture(),
  storage?: JsonStorage,
) {
  const store = new StateStore(storage);
  const mirror = new TranscriptMirror();
  const index = scanTranscript(messages);
  mirror.update(SESSION, index);
  const compressions: CompressionEventRecord[] = [];
  const tool = pruneToolDefinition({
    store,
    mirror,
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => 200_000,
    getUsageTokens: () => 0,
    recordCompression: (input) => compressions.push(input.record),
    ...depsOverride,
  });
  const run = (input: unknown) => tool.execute(input, { sessionID: SESSION });
  return { store, index, messages, run, compressions };
}

/** Plugin-storage spy: records every write so "nothing persisted" is provable. */
function memoryStorage() {
  const writes: Array<{ key: string; value: unknown }> = [];
  const storage: JsonStorage = {
    get: async () => undefined,
    set: async (key, value) => {
      writes.push({ key, value });
    },
    remove: async () => {},
  };
  return { storage, writes };
}

/**
 * A summary whose WRAPPED form is exactly `tokens` tokens, so floor arithmetic
 * in the tests below is exact instead of approximate: the wrapper
 * (`[Compressed conversation section]` + `<dcp-message-id>bN</dcp-message-id>`)
 * is 68 chars = 17 tokens and `countTokens` is chars/4.
 */
const WRAPPER_TOKENS = 18;
function summaryOfTokens(tokens: number): string {
  const length = Math.max(0, (tokens - WRAPPER_TOKENS) * 4);
  assert.equal(
    countTokens(`[Compressed conversation section]\n${"s".repeat(length)}\n<dcp-message-id>b1</dcp-message-id>`),
    tokens,
  );
  return "s".repeat(length);
}

test("prune records a block covering the selected range", async () => {
  const { store, index, run, compressions } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  const result = await run({
    topic: "Auth exploration",
    content: [
      { startId: "m0001", endId: "m0004", summary: "Explored the auth system thoroughly." },
    ],
  });

  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content));
  assert.match(String(result.content), /b1/);
  const state = runtime.state;
  const block = state.blocks["1"]!;
  assert.equal(block.active, true);
  // The range ends at assistant a2; the end-boundary snap pulls its result
  // (t2) into the block so the call/result pair stays atomic.
  assert.equal(block.coveredKeys.length, 5);
  assert.deepEqual(state.activeBlockIds, [1]);
  assert.equal(block.anchorKey, "id:u2");
  assert.deepEqual(block.coveredToolIds, ["c1", "c2"]);
  assert.equal(state.stats.compressRuns, 1);

  // TUI bridge record: one message range, two pruned tool outputs.
  assert.equal(compressions.length, 1);
  assert.equal(compressions[0]?.topic, "Auth exploration");
  assert.equal(compressions[0]?.messagesCovered, 5);
  assert.equal(compressions[0]?.toolsCovered, 2);
  assert.equal(
    compressions[0]?.tokensSaved,
    Math.max(0, compressions[0]!.tokensBefore - compressions[0]!.tokensAfter),
  );
});

test("prune consumes intersected blocks and expands their placeholders", async () => {
  const { store, index, run, compressions } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  await run({
    topic: "First pass",
    content: [{ startId: "m0001", endId: "m0004", summary: "summary text" }],
  });
  // The first compression releases the refs of its covered keys (m0001..m0005:
  // u1, a1, tool:c1, a2 and the end-snap over t2), so the second pass
  // re-addresses the pruned content by its block ID and reaches PAST it to the
  // first uncovered message - u2 holds m0006, the ref after the block's five
  // covered keys - exactly as the model sees it in the post-compression
  // transcript. The range must add a message outside the consumed section or
  // the zero-gain guard rejects it.
  const second = await run({
    topic: "Second pass",
    content: [{ startId: "b1", endId: "m0006", summary: "Folded: (b1) plus more detail." }],
  });

  const state = runtime.state;
  const first = state.blocks["1"]!;
  const secondBlock = state.blocks["2"]!;
  assert.equal(first.active, false);
  assert.equal(secondBlock.active, true);
  assert.deepEqual(state.activeBlockIds, [2]);
  // Merged coverage: the consumed block's 5 keys (its end-boundary snap had
  // already extended over t2) plus the newly covered u2.
  assert.equal(secondBlock.coveredKeys.length, 6);
  assert.ok(secondBlock.coveredKeys.includes("id:u2"));
  assert.ok(secondBlock.consumedBlockIds.includes(1));
  assert.equal(secondBlock.anchorKey, "id:a3");
  // Placeholder was expanded with the folded block's body.
  assert.match(secondBlock.summary, /summary text/);
  assert.match(secondBlock.summary, /plus more detail/);
  assert.match(secondBlock.summary, /<dcp-message-id>b2<\/dcp-message-id>/);
  assert.match(String(second.content), /b2/);

  // Second record folds the consumed block: 6 covered keys minus the 5 the
  // consumed block already held = 1 net new message; both tool outputs ride
  // the merged coverage.
  assert.equal(compressions.length, 2);
  assert.equal(compressions[1]?.messagesCovered, 1);
  assert.equal(compressions[1]?.toolsCovered, 2);
});

test("prune drops a consumed block whose placeholder is omitted", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  await run({
    topic: "First pass",
    // Standing summary of 320 tokens, dropped for a ~22-token one-liner: the
    // 298-token reclaim clears the zero-gain floor max(128, half of 320) = 160
    // - dropping dead content IS a real gain even though the range covers no
    // new messages.
    content: [{ startId: "m0001", endId: "m0004", summary: summaryOfTokens(320) }],
  });
  assert.equal(runtime.state.blocks["1"]!.summaryTokens, 320);
  const second = await run({
    topic: "Second pass",
    // The b1 range re-prunes the stale block (refs of its covered keys were
    // released by the first compression). No (b1) placeholder: the stale
    // block's content is intentionally dropped.
    content: [{ startId: "b1", endId: "b1", summary: "only what matters now" }],
  });

  assert.match(String(second.content), /^Re-summarized already-compressed content/);
  const secondBlock = runtime.state.blocks["2"]!;
  assert.equal(secondBlock.active, true);
  assert.ok(secondBlock.consumedBlockIds.includes(1));
  assert.ok(!secondBlock.summary.includes("ssss"), secondBlock.summary);
  // The dropped 320-token body is gone: only the one-liner stands in for it.
  assert.ok(countTokens(secondBlock.summary) < 40, secondBlock.summary);
});

test("prune rejects a zero-gain re-prune without touching state", async () => {
  const { store, index, run, compressions } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  await run({
    topic: "First pass",
    content: [{ startId: "m0001", endId: "m0004", summary: "summary text" }],
  });
  const state = runtime.state;
  const before = {
    blocks: Object.keys(state.blocks).length,
    nextBlockId: state.nextBlockId,
    compressRuns: state.stats.compressRuns,
    recent: state.stats.recentCompressions.length,
    activeBlockIds: [...state.activeBlockIds],
    pruneSeq: state.pruneSeq,
  };
  // applyCompression clears the rate-limit anchors on success - surviving one
  // proves the rejected call never reached it.
  state.nudgeAnchors = [7];

  // b1..b1 covers exactly the consumed block (newMessages = 0), and a
  // same-size rephrasing reclaims nothing against the floor max(128, half of
  // the standing summary): the whole call must be REJECTED, before any state
  // mutation. A rejection (not a returned result) is what stops the retry loop
  // - the platform reports the call as failed instead of handing the model a
  // "successful" result it can only parse by an English prefix.
  await assert.rejects(
    run({
      topic: "Same size",
      content: [{ startId: "b1", endId: "b1", summary: "Restated: summary text, again." }],
    }),
    (error: Error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /would free too few tokens/);
      assert.match(error.message, /b1\.\.b1 \(already compressed as b1, standing summary 21 tokens\)/);
      assert.match(error.message, /frees 0 of the \d+-token minimum/);
      assert.match(error.message, /no messages outside active compressed sections/);
      assert.match(error.message, /at most half the standing summary/);
      return true;
    },
  );

  // No state mutation: no new block, no run, no record, anchors untouched.
  assert.equal(Object.keys(state.blocks).length, before.blocks);
  assert.equal(state.nextBlockId, before.nextBlockId);
  assert.equal(state.stats.compressRuns, before.compressRuns);
  assert.equal(state.stats.recentCompressions.length, before.recent);
  assert.deepEqual(state.activeBlockIds, before.activeBlockIds);
  assert.equal(state.pruneSeq, before.pruneSeq);
  assert.deepEqual(state.nudgeAnchors, [7]);
  assert.equal(compressions.length, 1);
});

test("a successful prune returns a normal result shape, not an error payload", async () => {
  // The beta.12 blanket catch returned `{content: "context error: …",
  // metadata: {error: true}}` - indistinguishable from success to the model.
  // Nothing on the happy path may carry that shape any more.
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);
  const result = await run({
    topic: "Shape",
    content: [{ startId: "m0001", endId: "m0004", summary: "Explored the auth system." }],
  });

  assert.equal(
    String(result.content),
    "Pruned 5 message(s) into 1 pruned section(s) (b1).",
  );
  assert.ok(!String(result.content).includes("context error"));
  assert.deepEqual(result.metadata, { topic: "Shape", blocks: ["b1"] });
});

test("prune records an honest re-summarize when the fold clears the floor", async () => {
  const { store, index, run, compressions } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // ~610 chars -> a 170-token standing summary, so swapping it for a ~25-token
  // one-liner reclaims 145 tokens and clears the floor max(128, half of 170)
  // = 128: the guard lets this zero-new-message pass through.
  const longSummary = "dense original findings and decisions ".repeat(18);
  await run({
    topic: "First pass",
    content: [{ startId: "m0001", endId: "m0004", summary: longSummary }],
  });
  const first = runtime.state.blocks["1"]!;

  const second = await run({
    topic: "Tighten",
    // No (b1) placeholder: the standing summary is replaced by a one-liner.
    content: [{ startId: "b1", endId: "b1", summary: "tight re-summary of b1 content" }],
  });

  assert.match(String(second.content), /^Re-summarized already-compressed content/);
  assert.match(String(second.content), /do not repeat this pass/);

  const record = compressions[1]!;
  assert.equal(compressions.length, 2);
  assert.equal(record.messagesCovered, 0);
  // "before" is the summary being replaced - NOT the original coverage, whose
  // tokens left the outbound transcript with the first compression.
  assert.equal(record.tokensBefore, countTokens(first.summary));
  assert.equal(record.tokensAfter, countTokens(runtime.state.blocks["2"]!.summary));
  assert.equal(record.tokensSaved, Math.max(0, record.tokensBefore - record.tokensAfter));
  assert.ok(record.tokensSaved > 0);
  assert.ok(record.tokensBefore < compressions[0]!.tokensBefore);
});

test("prune THROWS on overlapping ranges and unknown ids instead of returning them", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // Expected failures are THROWN, never returned as model-visible success
  // content: the runner frames a thrown error as a real tool failure, while a
  // returned `context error: …` string is a COMPLETED tool result the model can
  // only disambiguate by parsing an English prefix (beta.12: 14 of 26 calls
  // "succeeded" while doing nothing, and the model kept retrying).
  await assert.rejects(
    run({
      topic: "Overlap",
      content: [
        { startId: "m0001", endId: "m0002", summary: "one" },
        { startId: "m0002", endId: "m0003", summary: "two" },
      ],
    }),
    /ranges overlap: m0002\.\.m0003 intersects another range/,
  );

  await assert.rejects(
    run({
      topic: "Missing",
      content: [{ startId: "m9999", endId: "m0003", summary: "nope" }],
    }),
    /startId m9999 does not exist in the current context/,
  );

  // Nothing was persisted by either failed call.
  assert.equal(runtime.state.stats.compressRuns, 0);
  assert.deepEqual(runtime.state.activeBlockIds, []);
});

test("prune THROWS on an inverted range", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // m0004 is a3, m0002 is a1: the model addressed the range backwards. This is
  // a defect in the call, not a result - it must not read as a completed prune.
  await assert.rejects(
    run({
      topic: "Inverted",
      content: [{ startId: "m0004", endId: "m0002", summary: "backwards" }],
    }),
    /startId m0004 appears after endId m0002/,
  );

  assert.equal(runtime.state.stats.compressRuns, 0);
  assert.equal(runtime.state.nextBlockId, 1);
  assert.deepEqual(Object.keys(runtime.state.blocks), []);
});

test("prune THROWS on an unknown block boundary id", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  await assert.rejects(
    run({
      topic: "Unknown block",
      content: [{ startId: "b7", endId: "m0003", summary: "references a block that never existed" }],
    }),
    /startId b7 references an unknown compressed block/,
  );

  // A malformed id (neither mNNNN nor bN) is the same class of defect.
  await assert.rejects(
    run({
      topic: "Garbage id",
      content: [{ startId: "block-three", endId: "m0003", summary: "not an id at all" }],
    }),
    /startId "block-three" is not a valid mNNNN or bN ID/,
  );

  assert.equal(runtime.state.stats.compressRuns, 0);
  assert.deepEqual(Object.keys(runtime.state.blocks), []);
});

test("a bad (bN) placeholder in a later range aborts the whole prune atomically", async () => {
  const { storage, writes } = memoryStorage();
  const { store, index, run, compressions } = harness({}, fixture(), storage);
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);
  // applyCompression clears the anchors and releases the covered refs, so
  // both surviving proves the first entry was never applied.
  runtime.state.nudgeAnchors = [7];

  // Entry one is perfectly valid (u1..a2 + the end-snap over t2); entry two
  // folds a block that does not exist. Placeholder expansion runs over ALL
  // plans before the first applyCompression, so the whole call aborts.
  await assert.rejects(
    run({
      topic: "Atomic",
      content: [
        { startId: "m0001", endId: "m0004", summary: "first entry is fine" },
        { startId: "m0006", endId: "m0007", summary: "carries (b9) forward" },
      ],
    }),
    /summary references unknown compressed block b9/,
  );

  const state = runtime.state;
  assert.deepEqual(Object.keys(state.blocks), []);
  assert.deepEqual(state.activeBlockIds, []);
  assert.equal(state.nextBlockId, 1);
  assert.equal(state.stats.compressRuns, 0);
  assert.equal(state.stats.recentCompressions.length, 0);
  assert.equal(state.pruneSeq, 0);
  assert.deepEqual(state.nudgeAnchors, [7]);
  // Refs of the would-be covered keys are still allocated (not released).
  assert.equal(runtime.refs.refOf("id:u1"), "m0001");
  assert.equal(runtime.refs.keyOf("m0004"), "id:a2");
  assert.equal(compressions.length, 0);
  // And nothing at all was persisted: a rejected call never writes state.
  assert.deepEqual(writes, []);
});

test("the zero-gain floor is half the standing summary, just under and just over", async () => {
  const seed = async (standingTokens: number) => {
    const { store, index, run } = harness();
    const runtime = await store.ensure(SESSION);
    for (const key of index.keys) runtime.refs.ensure(key);
    await run({
      topic: "First pass",
      content: [{ startId: "m0001", endId: "m0004", summary: summaryOfTokens(standingTokens) }],
    });
    assert.equal(runtime.state.blocks["1"]!.summaryTokens, standingTokens);
    return { store, run, runtime };
  };

  // 400-token standing summary -> floor = max(128, 200) = 200.
  // A 207-token replacement frees 193: under the floor, rejected.
  const under = await seed(400);
  await assert.rejects(
    under.run({
      topic: "Barely tighter",
      content: [{ startId: "b1", endId: "b1", summary: summaryOfTokens(207) }],
    }),
    /standing summary 400 tokens\) frees 193 of the 200-token minimum/,
  );
  assert.equal(under.runtime.state.blocks["1"]!.active, true);
  assert.equal(under.runtime.state.nextBlockId, 2);

  // 185 tokens frees 215: over the floor, accepted as a real fold.
  const over = await seed(400);
  const accepted = await over.run({
    topic: "Substantially tighter",
    content: [{ startId: "b1", endId: "b1", summary: summaryOfTokens(185) }],
  });
  assert.match(String(accepted.content), /^Re-summarized already-compressed content/);
  assert.equal(over.runtime.state.blocks["1"]!.active, false);
  assert.equal(over.runtime.state.blocks["2"]!.summaryTokens, 185);
});

test("the zero-gain floor has an absolute minimum for small blocks", async () => {
  const seed = async (standingTokens: number) => {
    const { store, index, run } = harness();
    const runtime = await store.ensure(SESSION);
    for (const key of index.keys) runtime.refs.ensure(key);
    await run({
      topic: "First pass",
      content: [{ startId: "m0001", endId: "m0004", summary: summaryOfTokens(standingTokens) }],
    });
    assert.equal(runtime.state.blocks["1"]!.summaryTokens, standingTokens);
    return { store, run, runtime };
  };

  // A 160-token block: half of it is only 80, but a turn that frees 120 tokens
  // costs more than it frees, so the floor stays at ZERO_GAIN_MIN_TOKENS.
  assert.equal(ZERO_GAIN_MIN_TOKENS, 128);
  const under = await seed(160);
  await assert.rejects(
    under.run({
      topic: "Small fold",
      content: [{ startId: "b1", endId: "b1", summary: summaryOfTokens(40) }],
    }),
    /frees 120 of the 128-token minimum/,
  );

  // Dropping it for a ~25-token one-liner frees 135 and is accepted.
  const over = await seed(160);
  const accepted = await over.run({
    topic: "Small drop",
    content: [{ startId: "b1", endId: "b1", summary: "keep" }],
  });
  assert.match(String(accepted.content), /^Re-summarized already-compressed content/);
  assert.equal(over.runtime.state.blocks["2"]!.summaryTokens, countTokens("[Compressed conversation section]\nkeep\n<dcp-message-id>b2</dcp-message-id>"));
  assert.equal(over.runtime.state.blocks["1"]!.active, false);
});

test("prune reports malformed arguments and empty context as thrown failures", async () => {
  const { run } = harness();
  await assert.rejects(
    run({ topic: "", content: [] }),
    /content must be a non-empty array of ranges/,
  );

  const emptyStore = new StateStore(undefined);
  const emptyTool = pruneToolDefinition({
    store: emptyStore,
    mirror: new TranscriptMirror(),
    logger: createLogger(false),
    config: CONFIG,
    getModelContextLimit: () => undefined,
    getUsageTokens: () => 0,
  });
  await assert.rejects(
    emptyTool.execute(
      { topic: "x", content: [{ startId: "m0001", endId: "m0002", summary: "s" }] },
      { sessionID: "ses_other" },
    ),
    /no conversation context is available/,
  );
});

test("prune clears pending nudge anchors on success", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);
  runtime.state.nudgeAnchors = [99];

  await run({
    topic: "Clear anchors",
    content: [{ startId: "m0001", endId: "m0004", summary: "done deal" }],
  });
  assert.deepEqual(runtime.state.nudgeAnchors, []);
});

test("prune reports post-prune occupancy in its usage note", async () => {
  // getUsageTokens reflects the dispatch as sent (pre-prune: a warm tracker
  // delta predates the tool call, a seeded estimate predates the prune), so
  // the note must subtract what this prune removes from the outbound
  // transcript instead of telling the model the window is still near-full.
  const { store, index, run, compressions } = harness({ getUsageTokens: () => 150_000 });
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  const result = await run({
    topic: "Note check",
    content: [{ startId: "m0001", endId: "m0004", summary: "done deal" }],
  });

  const record = compressions[0]!;
  // No consumed blocks in this fixture: reclaimed tokens are exactly the
  // compression record's covered-minus-summaries delta.
  const reclaimed = Math.max(0, record.tokensBefore - record.tokensAfter);
  const expected = Math.round(((150_000 - reclaimed) / 200_000) * 100);
  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content));
  // The note leads with the MODEL WINDOW and names the budget only as a
  // trailing threshold, using the same `contextUsage`/`budgetClause` spellings
  // as the pressure reminder - it must never print a percentage of the budget,
  // which is what the model misread as "the window is full".
  assert.match(String(result.content), new RegExp(`${expected}% of the 200,000-token model window`));
  assert.doesNotMatch(String(result.content), /% of the 140,000-token pruning budget/);
  assert.ok(expected < 75, "note must drop below the pre-prune 75% occupancy");
  // Still above the 140,000 budget at this occupancy, so the note says so
  // rather than implying the pass was enough - and it points at content
  // OUTSIDE the active compressed sections (re-pruning those is a no-op).
  assert.match(
    String(result.content),
    /Prune again only if another meaningfully sized closed section has appeared outside the active compressed sections; otherwise continue working/,
  );
});

test("prune persists the compression record in the session stats", async () => {
  // The TUI bridge's in-memory history dies with every plugin generation
  // (dist rebuild, restart); the record must live in the persisted state
  // store for the card and report to keep showing it.
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  const result = await run({
    topic: "History check",
    content: [{ startId: "m0001", endId: "m0004", summary: "done deal" }],
  });

  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content));
  assert.equal(runtime.state.stats.recentCompressions.length, 1);
  assert.equal(runtime.state.stats.recentCompressions[0]?.topic, "History check");
  assert.equal(runtime.state.stats.recentCompressions[0]?.blockId, 1);
});

// Wire tool results carry no message ids, so id-less role:"tool" messages key
// as `tool:<callId>` from their first tool-result part. These fixtures
// exercise the call/result pair-atomicity snaps at both range boundaries
// (arafays/opencode-dcp#2: an assistant with a covered parallel tool call
// whose sibling result survived orphaned a role:tool message and the provider
// rejected every later dispatch).
function parallelFixture(): WireMessage[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "check both" }] },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "read", input: {} },
        { type: "tool-call", id: "c2", name: "read", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "one" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", id: "c2", name: "read", result: { type: "text", value: "two" } },
      ],
    },
    { id: "u2", role: "user", content: [{ type: "text", text: "now write" }] },
    {
      id: "a2",
      role: "assistant",
      content: [{ type: "tool-call", id: "c3", name: "edit", input: {} }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", id: "c3", name: "edit", result: { type: "text", value: "wrote" } },
      ],
    },
  ];
}

test("prune snaps the end boundary forward over a parallel sibling result", async () => {
  const { store, index, run } = harness({}, parallelFixture());
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // Range ends at assistant a1 whose two results (tool:c1, tool:c2) lie
  // outside it: without the forward snap the anchor would be a standalone tool
  // message and its kept sibling would orphan a1's second tool_call.
  const result = await run({
    topic: "End boundary",
    content: [{ startId: "m0001", endId: "m0002", summary: "s" }],
  });

  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content));
  const block = runtime.state.blocks["1"]!;
  assert.deepEqual(block.coveredKeys, ["id:u1", "id:a1", "tool:c1", "tool:c2"]);
  assert.equal(block.anchorKey, "id:u2");
  assert.deepEqual(block.coveredToolIds, ["c1", "c2"]);
});

test("prune snaps the start boundary back over the issuing assistant", async () => {
  const { store, index, run } = harness({}, parallelFixture());
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // Range starts at a tool result: the issuing assistant must be covered with
  // it, or it would be kept with dangling tool_calls.
  const result = await run({
    topic: "Start boundary",
    content: [{ startId: "m0003", endId: "m0005", summary: "s" }],
  });

  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content));
  const block = runtime.state.blocks["1"]!;
  assert.deepEqual(block.coveredKeys, ["id:a1", "tool:c1", "tool:c2", "id:u2"]);
  assert.equal(block.anchorKey, "id:a2");
  assert.deepEqual(block.coveredToolIds, ["c1", "c2"]);
});

test("prune snaps both boundaries when the range starts mid-batch", async () => {
  const { store, index, run } = harness({}, parallelFixture());
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // Range starts at the second of two parallel results and ends at an
  // assistant whose result follows: the backward snap must absorb the whole
  // tool run plus the issuing assistant, the forward snap the trailing result.
  const result = await run({
    topic: "Both boundaries",
    content: [{ startId: "m0004", endId: "m0006", summary: "s" }],
  });

  assert.ok(!String(result.content).startsWith("prune failed"), String(result.content));
  const block = runtime.state.blocks["1"]!;
  assert.deepEqual(block.coveredKeys, ["id:a1", "tool:c1", "tool:c2", "id:u2", "id:a2", "tool:c3"]);
  assert.equal(block.anchorKey, "tail");
  assert.deepEqual(block.coveredToolIds, ["c1", "c2", "c3"]);
});
