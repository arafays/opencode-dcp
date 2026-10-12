import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RECENT_COMPRESSIONS } from "../lib/tui-bridge";
import { RefRegistry } from "../lib/refs";
import { startEventPump } from "../lib/events";
import { createLogger } from "../lib/logger";
import { UsageTracker, armManualPruneReminder, takeManualPruneReminder } from "../lib/nudges";
import { PRUNE_REQUEST_PREFIX } from "../lib/prompts";
import { StateStore, applyCompression } from "../lib/state/store";
import { createSessionState, hydrateSessionState } from "../lib/state/types";
import { TranscriptMirror } from "../lib/transcript/mirror";
import { scanTranscript } from "../lib/transcript/scan";
import type { WireMessage } from "../lib/types";

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
  // Production shape: the context hook projects the visible transcript's dense,
  // ascending mNNNN aliases on every dispatch (RefRegistry.project), so msg:1
  // is m0001 and msg:5 is m0005.
  refs.project(["msg:1", "msg:2", "msg:3", "msg:4", "msg:5"]);

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
  assert.equal(refs.byKey.get("msg:1"), undefined);
  assert.equal(refs.byKey.get("msg:2"), undefined);
  assert.equal(refs.byKey.get("msg:3"), "m0003");
  assert.equal(refs.byKey.get("msg:4"), "m0004");
  assert.equal(refs.byKey.get("msg:5"), "m0005");

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
  assert.equal(refs.byKey.get("msg:1"), undefined);
  assert.equal(refs.byKey.get("msg:2"), undefined);
  assert.equal(refs.byKey.get("msg:3"), undefined);
  // Live keys keep their refs.
  assert.equal(refs.byKey.get("msg:4"), "m0004");
  assert.equal(refs.byKey.get("msg:5"), "m0005");

  // The release is a map drop, not a renumber: the freed slots are only
  // reclaimed by the next dispatch's projection, which is what keeps the
  // surviving mNNNN ascending. (A second `prune` in the same dispatch must NOT
  // be able to re-resolve m0001..m0003 - the table above proves it cannot.)
  assert.deepEqual([...refs.byKey], [
    ["msg:4", "m0004"],
    ["msg:5", "m0005"],
  ]);
});

// -- event pump ---------------------------------------------------------------

const PUMP_SESSION = "ses_events";
/** `session.usage.updated` payload shape (`data.tokens`). */
const USAGE_EVENT_TOKENS = { input: 1000, output: 100, reasoning: 0, cache: { read: 500, write: 0 } };
/** `UsageTracker` shape, which the pump derives from the payload above. */
const USAGE_INFO = { input: 1000, output: 100, reasoning: 0, cacheRead: 500, cacheWrite: 0 };

interface PumpHarness {
  store: StateStore;
  mirror: TranscriptMirror;
  usage: UsageTracker;
}

function pumpHarness(): PumpHarness {
  return { store: new StateStore(undefined), mirror: new TranscriptMirror(), usage: new UsageTracker() };
}

/** Populates all three per-session structures the pump is meant to clear. */
async function seedPumpState(deps: PumpHarness): Promise<void> {
  await deps.store.ensure(PUMP_SESSION);
  deps.mirror.update(PUMP_SESSION, scanTranscript([{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }]));
  deps.usage.record(PUMP_SESSION, USAGE_INFO);
  deps.usage.record(PUMP_SESSION, { ...USAGE_INFO, input: 2400 });
}

/** True while any per-session structure still holds state. */
function pumpStateSurvived(deps: PumpHarness): boolean {
  return (
    deps.store.peek(PUMP_SESSION) !== undefined ||
    deps.mirror.get(PUMP_SESSION) !== undefined ||
    deps.usage.totalFor(PUMP_SESSION) > 0
  );
}

/**
 * Runs `startEventPump` over one scripted stream and returns once the stream is
 * exhausted. `subscribe` is a factory (the pump reconnects with a fresh one),
 * so each call yields its own iterator. The pump is only aborted AFTER the last
 * event is consumed - aborting first would short-circuit its per-event
 * `signal.aborted` check and skip the stream entirely.
 */
async function runPump(events: Array<Record<string, unknown>>, deps: PumpHarness): Promise<void> {
  const controller = new AbortController();
  let drained: () => void = () => {};
  const exhausted = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const pump = startEventPump({
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
        drained();
      },
    }),
    ...deps,
    logger: createLogger(false),
    signal: controller.signal,
  });
  await exhausted;
  controller.abort();
  await pump;
}

test("every session-lifecycle event the pump handles drops all DCP state", async () => {
  // These six names are the pump's reset set. Each is a verbatim member of the
  // generated server event union (packages/client/src/promise/generated/
  // types.ts); if a future bump renames one it simply stops arriving and the
  // pump would silently stop resetting, so the set is pinned here instead of
  // staying implicit in a switch statement.
  for (const type of [
    "session.compaction.started",
    "session.compaction.ended",
    "session.compaction.failed",
    "session.revert.committed",
    "session.forked",
    "session.deleted",
  ]) {
    const deps = pumpHarness();
    await seedPumpState(deps);
    assert.equal(pumpStateSurvived(deps), true, "precondition: state exists before the event");
    await runPump([{ type, data: { sessionID: PUMP_SESSION } }], deps);
    assert.equal(pumpStateSurvived(deps), false, `${type} must reset DCP state`);
  }
});

test("session.usage.updated feeds the tracker without resetting state", async () => {
  const deps = pumpHarness();
  await runPump(
    [
      { type: "session.usage.updated", data: { sessionID: PUMP_SESSION, tokens: USAGE_EVENT_TOKENS } },
      {
        type: "session.usage.updated",
        data: { sessionID: PUMP_SESSION, tokens: { ...USAGE_EVENT_TOKENS, input: 2400 } },
      },
    ],
    deps,
  );

  // The first update only arms the baseline, the second records the delta.
  assert.equal(deps.usage.totalFor(PUMP_SESSION), 1400);
});

test("a session-lifecycle event clears an armed manual-prune reminder", async () => {
  const stored = `${PRUNE_REQUEST_PREFIX} Focus: x`;
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: stored }] },
  ]

  // Sanity: while armed and the stored turn is present, a dispatch consumes it,
  // and the take is one-shot (a second take is a no-op).
  armManualPruneReminder(PUMP_SESSION, "<dcp-system-reminder>manual</dcp-system-reminder>", stored)
  assert.equal(
    takeManualPruneReminder(PUMP_SESSION, messages),
    "<dcp-system-reminder>manual</dcp-system-reminder>",
  )
  assert.equal(takeManualPruneReminder(PUMP_SESSION, messages), undefined, "the take is one-shot")

  // Re-arm, then let the pump reset the session: the reminder must be cleared
  // rather than left armed for a later unrelated dispatch. `messages` carries
  // the stored opener, so `undefined` here proves the disarm, not a miss.
  armManualPruneReminder(PUMP_SESSION, "<dcp-system-reminder>manual</dcp-system-reminder>", stored)
  await runPump([{ type: "session.deleted", data: { sessionID: PUMP_SESSION } }], pumpHarness())
  assert.equal(takeManualPruneReminder(PUMP_SESSION, messages), undefined)
})

test("auxiliary and non-history events never clear DCP state", async () => {
  const deps = pumpHarness();
  await seedPumpState(deps);
  const before = deps.usage.totalFor(PUMP_SESSION);
  assert.ok(before > 0, "precondition: usage baseline is armed");

  await runPump(
    [
      // Auxiliary costs from title/compaction would pollute the context
      // estimate, so `usage.recorded` is deliberately not tracked either.
      { type: "session.usage.recorded", data: { sessionID: PUMP_SESSION, tokens: USAGE_EVENT_TOKENS } },
      // A staged/cleared revert moves the pending boundary without truncating
      // history - only `committed` does.
      { type: "session.revert.staged", data: { sessionID: PUMP_SESSION, revert: {} } },
      { type: "session.revert.cleared", data: { sessionID: PUMP_SESSION } },
      // Streamed compaction text, idle notification, session creation.
      { type: "session.compaction.delta", data: { sessionID: PUMP_SESSION, text: "summary" } },
      { type: "session.idle", data: { sessionID: PUMP_SESSION } },
      { type: "session.created", data: { sessionID: PUMP_SESSION } },
      // Another session's deletion must not disturb this one.
      { type: "session.deleted", data: { sessionID: "ses_other" } },
      // No sessionID at all.
      { type: "session.deleted", data: {} },
    ],
    deps,
  );

  assert.equal(pumpStateSurvived(deps), true);
  assert.equal(deps.usage.totalFor(PUMP_SESSION), before);
});
