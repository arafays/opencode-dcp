import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RECENT_COMPRESSIONS } from "../lib/tui-bridge";
import { RefRegistry } from "../lib/refs";
import { applyCompression } from "../lib/state/store";
import { createSessionState, hydrateSessionState } from "../lib/state/types";

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
  };
}

test("createSessionState starts with an empty compression history", () => {
  assert.deepEqual(createSessionState("s").stats.recentCompressions, []);
});

test("hydrateSessionState defaults the compression history for legacy states", () => {
  const state = hydrateSessionState(
    { sessionId: "s", stats: { totalPrunedTokens: 5, compressRuns: 1, dispatches: 2 } },
    "s",
  );
  assert.deepEqual(state.stats.recentCompressions, []);
  assert.equal(state.stats.compressRuns, 1);
});

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
  );
  assert.equal(state.stats.recentCompressions.length, 2);
  assert.equal(state.stats.recentCompressions[0]?.topic, "t1");
  // toolsCovered is optional: a malformed value drops to undefined, not NaN.
  assert.equal(state.stats.recentCompressions[1]?.topic, "t2");
  assert.equal(state.stats.recentCompressions[1]?.toolsCovered, undefined);
});

test("hydrateSessionState caps the compression history", () => {
  const recentCompressions = Array.from({ length: MAX_RECENT_COMPRESSIONS + 5 }, (_, index) =>
    record(index),
  );
  const state = hydrateSessionState({ sessionId: "s", stats: { recentCompressions } }, "s");
  assert.equal(state.stats.recentCompressions.length, MAX_RECENT_COMPRESSIONS);
  assert.equal(state.stats.recentCompressions.at(-1)?.topic, `t${MAX_RECENT_COMPRESSIONS + 4}`);
});

test("applyCompression releases refs for covered keys and consumed blocks", () => {
  const state = createSessionState("s");
  const refs = new RefRegistry();
  refs.ensure("msg:1");
  refs.ensure("msg:2");
  refs.ensure("msg:3");
  refs.ensure("msg:4");
  refs.ensure("msg:5");

  // First compression covers msg:1 and msg:2; their refs are released.
  applyCompression({
    state,
    refs,
    topic: "t1",
    summary: "first",
    coveredKeys: ["msg:1", "msg:2"],
    coveredToolIds: [],
    coveredTokens: 100,
    consumedBlockIds: [],
    anchorKey: "tail",
  });
  assert.equal(refs.refOf("msg:1"), undefined);
  assert.equal(refs.refOf("msg:2"), undefined);
  assert.equal(refs.refOf("msg:3"), "m0003");
  assert.equal(refs.refOf("msg:4"), "m0004");
  assert.equal(refs.refOf("msg:5"), "m0005");

  // Second compression consumes block 1 and covers msg:3. Consumed block 1's
  // covered keys fold in, so msg:1-3 are all released.
  applyCompression({
    state,
    refs,
    topic: "t2",
    summary: "second",
    coveredKeys: ["msg:3"],
    coveredToolIds: [],
    coveredTokens: 90,
    consumedBlockIds: [1],
    anchorKey: "tail",
  });
  assert.equal(refs.refOf("msg:1"), undefined);
  assert.equal(refs.refOf("msg:2"), undefined);
  assert.equal(refs.refOf("msg:3"), undefined);
  // Live keys keep their refs.
  assert.equal(refs.refOf("msg:4"), "m0004");
  assert.equal(refs.refOf("msg:5"), "m0005");

  // Released slots are reused by the next allocation.
  assert.equal(refs.ensure("msg:6"), "m0001");
});
