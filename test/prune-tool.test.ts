import assert from "node:assert/strict";
import { test } from "node:test";

import { pruneToolDefinition, type PruneDeps } from "../lib/prune-tool";
import { resolveOptions } from "../lib/config";
import { createLogger } from "../lib/logger";
import { StateStore } from "../lib/state/store";
import { TranscriptMirror } from "../lib/transcript/mirror";
import { scanTranscript } from "../lib/transcript/scan";
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

function harness(depsOverride: Partial<PruneDeps> = {}, messages: WireMessage[] = fixture()) {
  const store = new StateStore(undefined);
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
  // The first compression releases the refs of its covered keys, so the second
  // pass re-addresses the pruned content by its block ID (b1), exactly as the
  // model sees it in the post-compression transcript.
  const second = await run({
    topic: "Second pass",
    content: [{ startId: "b1", endId: "b1", summary: "Folded: (b1) plus more detail." }],
  });

  const state = runtime.state;
  const first = state.blocks["1"]!;
  const secondBlock = state.blocks["2"]!;
  assert.equal(first.active, false);
  assert.equal(secondBlock.active, true);
  assert.deepEqual(state.activeBlockIds, [2]);
  // Merged coverage: the re-pruned b1 range plus the consumed block's own
  // keys, which the first block's end-boundary snap had already extended over
  // t2.
  assert.equal(secondBlock.coveredKeys.length, 5);
  assert.ok(secondBlock.consumedBlockIds.includes(1));
  // Placeholder was expanded with the folded block's body.
  assert.match(secondBlock.summary, /summary text/);
  assert.match(secondBlock.summary, /plus more detail/);
  assert.match(secondBlock.summary, /<dcp-message-id>b2<\/dcp-message-id>/);
  assert.match(String(second.content), /b2/);

  // Second record folds the consumed block: its explicit range lies entirely
  // inside the first block's coverage, so 0 net new messages; both tool
  // outputs are counted.
  assert.equal(compressions.length, 2);
  assert.equal(compressions[1]?.messagesCovered, 0);
  assert.equal(compressions[1]?.toolsCovered, 2);
});

test("prune drops a consumed block whose placeholder is omitted", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  await run({
    topic: "First pass",
    content: [{ startId: "m0001", endId: "m0004", summary: "stale completed work details" }],
  });
  await run({
    topic: "Second pass",
    // The b1 range re-prunes the stale block (refs of its covered keys were
    // released by the first compression). No (b1) placeholder: the stale
    // block's content is intentionally dropped.
    content: [{ startId: "b1", endId: "b1", summary: "only what matters now" }],
  });

  const secondBlock = runtime.state.blocks["2"]!;
  assert.equal(secondBlock.active, true);
  assert.ok(secondBlock.consumedBlockIds.includes(1));
  assert.ok(!secondBlock.summary.includes("stale completed work details"));
});

test("prune rejects explicitly overlapping ranges and unknown ids", async () => {
  const { store, index, run } = harness();
  const runtime = await store.ensure(SESSION);
  for (const key of index.keys) runtime.refs.ensure(key);

  // Expected failures throw rather than returning success content; the runner
  // frames them as real tool failures ("prune failed: …").
  await assert.rejects(
    run({
      topic: "Overlap",
      content: [
        { startId: "m0001", endId: "m0002", summary: "one" },
        { startId: "m0002", endId: "m0003", summary: "two" },
      ],
    }),
    /ranges overlap/,
  );

  await assert.rejects(
    run({
      topic: "Missing",
      content: [{ startId: "m9999", endId: "m0003", summary: "nope" }],
    }),
    /does not exist in the current context/,
  );
});

test("prune rejects malformed arguments and empty context", async () => {
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
  assert.match(String(result.content), new RegExp(`approximately ${expected}% of the window`));
  assert.ok(expected < 75, "note must drop below the pre-prune 75% occupancy");
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
