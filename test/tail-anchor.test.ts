import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveOptions } from "../lib/config";
import { createLogger } from "../lib/logger";
import { applyCompressionBlocks } from "../lib/prune";
import { pruneToolDefinition } from "../lib/prune-tool";
import { RefRegistry } from "../lib/refs";
import { applyCompression, StateStore, TAIL_ANCHOR } from "../lib/state/store";
import { createSessionState, hydrateSessionState, type SessionState } from "../lib/state/types";
import { TranscriptMirror } from "../lib/transcript/mirror";
import { scanTranscript } from "../lib/transcript/scan";
import type { WireMessage } from "../lib/types";

const user = (id: string): WireMessage => ({ id, role: "user", content: [{ type: "text", text: id }] });

function compress(state: SessionState, ids: string[], anchorKey = TAIL_ANCHOR) {
  return applyCompression({
    state,
    refs: new RefRegistry(),
    topic: "Completed work",
    summary: "Retained findings",
    coveredKeys: ids.map((id) => `id:${id}`),
    coveredToolIds: [],
    coveredTokens: 500,
    consumedBlockIds: [],
    anchorKey,
  });
}

function render(state: SessionState, ids: string[]) {
  const messages = ids.map(user);
  applyCompressionBlocks(state, messages, scanTranscript(messages).keys);
  return messages;
}

test("tail summaries preserve the previous outbound prefix as turns are appended", () => {
  const state = createSessionState("s");
  compress(state, ["old1", "old2"]);
  const ids = ["prefix", "old1", "old2"];
  let previous = render(state, ids);
  for (let i = 0; i < 20; i++) {
    ids.push(`new${i}`);
    const next = render(state, ids);
    assert.deepEqual(next.slice(0, previous.length), previous);
    assert.deepEqual(next.at(-1), user(`new${i}`));
    previous = next;
  }
});

test("a missing successor uses the last surviving covered key, not covered-key array order", () => {
  const state = createSessionState("s");
  const block = compress(state, ["old2", "absent", "old1"], "id:missing");
  const messages = render(state, ["prefix", "old1", "old2", "new"]);
  assert.deepEqual(messages, [user("prefix"), { role: "user", content: [{ type: "text", text: block.summary }] }, user("new")]);
});

test("valid successor anchors retain their existing position", () => {
  const state = createSessionState("s");
  const block = compress(state, ["old"], "id:next");
  assert.deepEqual(render(state, ["old", "gap", "next", "new"]), [
    user("gap"), { role: "user", content: [{ type: "text", text: block.summary }] }, user("next"), user("new"),
  ]);
});

test("multiple tail summaries stay in chronological order around uncovered messages", () => {
  const state = createSessionState("s");
  const first = compress(state, ["old1"]);
  const second = compress(state, ["old2"]);
  assert.deepEqual(render(state, ["old1", "gap", "old2", "new"]), [
    { role: "user", content: [{ type: "text", text: first.summary }] }, user("gap"),
    { role: "user", content: [{ type: "text", text: second.summary }] }, user("new"),
  ]);
});

test("persisted tail blocks are repaired without rewriting their state", () => {
  const state = createSessionState("s");
  const block = compress(state, ["old"]);
  const restored = hydrateSessionState(JSON.parse(JSON.stringify(state)), "s");
  const saved = JSON.stringify(restored);
  assert.deepEqual(render(restored, ["old", "new"]), [
    { role: "user", content: [{ type: "text", text: block.summary }] }, user("new"),
  ]);
  assert.equal(JSON.stringify(restored), saved);
});

test("blocks with no surviving anchor or covered keys retain the end fallback", () => {
  const state = createSessionState("s");
  const block = compress(state, ["absent"]);
  assert.deepEqual(render(state, ["new"]), [
    user("new"), { role: "user", content: [{ type: "text", text: block.summary }] },
  ]);
});

test("prune resolves a tail summary before messages appended after compression", async () => {
  const session = "s";
  const store = new StateStore(undefined);
  const runtime = await store.ensure(session);
  const first = compress(runtime.state, ["old"]);
  const messages = [user("old"), user("new")];
  const index = scanTranscript(messages);
  const mirror = new TranscriptMirror();
  mirror.update(session, index);
  runtime.refs.project([index.keys[1]!]);
  const tool = pruneToolDefinition({
    store, mirror, logger: createLogger(false), config: resolveOptions(undefined, () => {}),
    getModelContextLimit: () => 200_000, getUsageTokens: () => 0,
  });
  await tool.execute({
    topic: "Combine findings",
    content: [{ startId: "b1", endId: "m0001", summary: "(b1) New findings" }],
  }, { sessionID: session });
  assert.equal(first.active, false);
  assert.deepEqual(runtime.state.blocks["2"]!.coveredKeys, index.keys);
  assert.deepEqual(runtime.state.blocks["2"]!.consumedBlockIds, [1]);
});
