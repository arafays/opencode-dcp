import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MESSAGE_REF_MAX_INDEX,
  RefRegistry,
  formatBlockRef,
  formatMessageIdTag,
  formatMessageRef,
  parseBlockRef,
  parseMessageRef,
  type RefRegistryJson,
} from "../lib/refs";

test("formatMessageRef pads to four digits and rejects out-of-range indices", () => {
  assert.equal(formatMessageRef(1), "m0001");
  assert.equal(formatMessageRef(42), "m0042");
  assert.equal(formatMessageRef(9999), "m9999");
  assert.throws(() => formatMessageRef(0));
  assert.throws(() => formatMessageRef(10000));
  assert.throws(() => formatMessageRef(1.5));
});

test("formatBlockRef validates positive integers", () => {
  assert.equal(formatBlockRef(1), "b1");
  assert.equal(formatBlockRef(12), "b12");
  assert.throws(() => formatBlockRef(0));
});

test("parse functions round-trip and reject malformed refs", () => {
  assert.equal(parseMessageRef("m0001"), 1);
  assert.equal(parseMessageRef("M0042"), 42);
  assert.equal(parseMessageRef("m001"), null);
  assert.equal(parseMessageRef("x0001"), null);
  assert.equal(parseBlockRef("b7"), 7);
  assert.equal(parseBlockRef("b0"), null);
  assert.equal(parseBlockRef("m0001"), null);
});

test("formatMessageIdTag wraps the ref", () => {
  assert.equal(formatMessageIdTag("m0001"), "\n<dcp-message-id>m0001</dcp-message-id>");
});

test("RefRegistry projects stable sequential aliases", () => {
  const registry = new RefRegistry();
  assert.equal(registry.project(["key:a", "key:b"]), 0);
  assert.deepEqual([...registry.byKey], [
    ["key:a", "m0001"],
    ["key:b", "m0002"],
  ]);
  // Stable across a re-projection of the same visible transcript: the tags the
  // model read last dispatch are byte-identical to the ones it reads next.
  assert.equal(registry.project(["key:a", "key:b"]), 0);
  assert.equal(registry.keyOf("m0001"), "key:a");
  assert.equal(registry.byKey.get("key:b"), "m0002");
  assert.equal(registry.keyOf("m9999"), undefined);
});

test("RefRegistry survives a JSON round trip", () => {
  const registry = new RefRegistry();
  registry.project(["k1", "k2"]);
  const restored = RefRegistry.from(registry.toJSON());
  assert.deepEqual(restored.toJSON(), registry.toJSON());
  // A resumed session keeps the persisted aliases...
  assert.equal(restored.byKey.get("k1"), "m0001");
  assert.equal(restored.keyOf("m0002"), "k2");
  // ...and the next dispatch's projection numbers the visible transcript
  // densely, so a newly arrived tail message still lands at the next index.
  assert.equal(restored.project(["k1", "k2", "k3"]), 0);
  assert.equal(restored.byKey.get("k3"), "m0003");
});

test("RefRegistry.release drops both directions of an alias and ignores unknown keys", () => {
  const registry = new RefRegistry();
  registry.project(["key:a", "key:b", "key:c"]);

  // Releasing a subset drops both directions of the alias.
  registry.release(["key:b"]);
  assert.equal(registry.byKey.get("key:b"), undefined);
  assert.equal(registry.keyOf("m0002"), undefined);
  // Unrelated refs keep their aliases.
  assert.equal(registry.byKey.get("key:a"), "m0001");
  assert.equal(registry.byKey.get("key:c"), "m0003");

  // Unknown keys are a no-op; known keys release cleanly.
  registry.release(["missing", "key:a", "also-missing"]);
  assert.equal(registry.byKey.get("key:a"), undefined);
  assert.equal(registry.keyOf("m0001"), undefined);
  assert.equal(registry.byKey.get("key:c"), "m0003");

  // A freed slot is NOT re-used in place: only a projection renumbers, and it
  // renumbers the whole visible transcript densely from m0001.
  registry.project(["key:c", "key:d"]);
  assert.deepEqual([...registry.byKey], [
    ["key:c", "m0001"],
    ["key:d", "m0002"],
  ]);
});

test("RefRegistry.release does not rewind the next-alias high-water mark", () => {
  const registry = new RefRegistry();
  registry.project(["k1", "k2", "k3"]);

  // Freeing m0001 and m0003 drops both directions of the alias and leaves the
  // high-water mark untouched. `release` used to rewind `next` to the LOWEST
  // free slot, which is what let the next new message be numbered below
  // messages that were still visible to the model.
  registry.release(["k1", "k3"]);
  assert.equal(registry.byKey.get("k1"), undefined);
  assert.equal(registry.keyOf("m0003"), undefined);
  assert.equal(registry.byKey.get("k2"), "m0002");
  assert.equal(registry.next, 4);

  // The next dispatch's projection is what restores the ordering.
  registry.project(["k2", "k4"]);
  assert.equal(registry.byKey.get("k2"), "m0001");
  assert.equal(registry.byKey.get("k4"), "m0002");
});

// -- per-dispatch projection --------------------------------------------------

/** `mNNNN` for a 1-based index. */
function ref(index: number): string {
  return `m${String(index).padStart(4, "0")}`;
}

/**
 * Asserts the dispatch invariant for a linearly ordered list of visible keys:
 * every key is aliased, the refs are dense from m0001 and strictly ascending
 * in transcript order, and each ref resolves back to its own key.
 */
function assertProjected(registry: RefRegistry, keys: string[]): string[] {
  const refs = keys.map((key) => registry.byKey.get(key)!);
  for (const [i, key] of keys.entries()) {
    assert.equal(refs[i], ref(i + 1), `${key} must be aliased ${ref(i + 1)}`);
    assert.equal(registry.keyOf(refs[i]!), key, `${refs[i]} must resolve back to ${key}`);
  }
  return refs;
}

test("project numbers the visible transcript densely from m0001, in order", () => {
  const registry = new RefRegistry();
  // A pre-existing (possibly inverted) table is replaced wholesale.
  registry.project(["stale"]);
  assert.equal(registry.project(["a", "b", "c"]), 0);
  assert.deepEqual([...registry.byKey], [["a", "m0001"], ["b", "m0002"], ["c", "m0003"]]);
  assert.deepEqual([...registry.byRef], [["m0001", "a"], ["m0002", "b"], ["m0003", "c"]]);
  assert.equal(registry.byKey.get("stale"), undefined);
  assert.equal(registry.next, 4);

  // Re-projecting the same keys is a no-op (tags stay byte-identical between
  // dispatches that only append).
  assert.equal(registry.project(["a", "b", "c"]), 0);
  assertProjected(registry, ["a", "b", "c"]);

  // A repeated key keeps its FIRST position instead of claiming a second slot
  // (which would emit two conflicting tags for one message).
  assert.equal(registry.project(["a", "b", "a", "c"]), 0);
  assertProjected(registry, ["a", "b", "c"]);
});

test("projections interleaved with releases stay dense and ascending", () => {
  const registry = new RefRegistry();
  const covered = new Set<string>();
  const transcript: string[] = [];
  const visible = () => transcript.filter((key) => !covered.has(key));
  /** One dispatch: new messages arrive, the visible set is projected, then an
   *  optional compression covers the oldest N of them. */
  const dispatch = (newMessages: number, cover: number) => {
    for (let i = 0; i < newMessages; i++) transcript.push(`msg:${transcript.length}`);
    assert.equal(registry.project(visible()), 0);
    assertProjected(registry, visible());
    if (cover === 0) return;
    const coveredNow = visible().slice(0, cover);
    for (const key of coveredNow) covered.add(key);
    registry.release(coveredNow);
  };

  dispatch(6, 3);
  dispatch(4, 2);
  dispatch(2, 0);
  dispatch(5, 1);
  // The dispatch after the last compression is what re-numbers the survivors.
  dispatch(0, 0);

  // The surviving tail is one unbroken ascending run...
  const live = visible();
  assert.ok(live.length > 8, "expected a transcript to survive the compressions");
  assertProjected(registry, live);
  // ...starting at m0001, never at a high-water mark left over from earlier.
  assert.equal(registry.byKey.get(live[0]!), "m0001");
  // Nothing covered is still addressable: the model must never see an alias
  // for a message it cannot read.
  for (const key of covered) assert.equal(registry.byKey.get(key), undefined);
});

// Production regression (beta-12). The session-long allocator handed a
// compressed-away low slot to the next new message while the survivors kept
// their high numbers, so the tags the model read were `... m0259, m0194,
// m0196 ...`. It concluded "earlier-processed blocks have high numbers",
// emitted inverted ranges (`m0006..m0129`, `m0021..m0020`), had 9 of 26
// prune calls die, and stopped pruning entirely.
test("the m0259 -> m0194 inversion cannot survive a dispatch projection", () => {
  // The registry exactly as that session persisted it: 95 visible messages
  // tagged m0071..m0259 (every other index - assistant messages consume a
  // ref but are never tagged), then 33 messages that arrived after a
  // compression freed the low slots and were handed m0194..m0258, with
  // `next` rewound to 1 while 77 refs were still live.
  const head = Array.from({ length: 95 }, (_, i) => `head:${i}`);
  const tail = Array.from({ length: 33 }, (_, i) => `tail:${i}`);
  const legacy: RefRegistryJson = { byKey: {}, byRef: {}, next: 1 };
  for (const [i, key] of head.entries()) legacy.byKey[key] = ref(71 + i * 2);
  for (const [i, key] of tail.entries()) legacy.byKey[key] = ref(194 + i * 2);
  for (const [key, value] of Object.entries(legacy.byKey)) legacy.byRef[value] = key;

  // Characterize the failure: ordered by transcript position, the legacy
  // aliases invert at the junction.
  const legacyOrder = [...head, ...tail].map((key) => legacy.byKey[key]!);
  assert.deepEqual(legacyOrder.slice(92, 97), ["m0255", "m0257", "m0259", "m0194", "m0196"]);
  let inversions = 0;
  for (let i = 1; i < legacyOrder.length; i++) {
    if (parseMessageRef(legacyOrder[i - 1]!)! >= parseMessageRef(legacyOrder[i]!)!) inversions += 1;
  }
  assert.equal(inversions, 1, "the legacy table must reproduce the reported inversion");

  // A session resumed from that blob loads without throwing...
  const registry = RefRegistry.from(legacy);
  assert.equal(registry.keyOf("m0259"), "head:94");
  assert.equal(registry.keyOf("m0194"), "tail:0");
  // ...and the very next dispatch re-projects the visible transcript, which
  // is dense, ascending, and resolvable key by key.
  const visible = [...head, ...tail];
  assert.equal(registry.project(visible), 0);
  const refs = assertProjected(registry, visible);
  assert.equal(refs.at(-1), ref(visible.length));
});

// The mechanism, isolated: the legacy `release` rewound `next` to the LOWEST
// free slot, so allocating one key after a compression could hand a number
// LOWER than a key that was still visible and earlier in the transcript.
test("an interior release can no longer hand out a lower number than a live key", () => {
  const registry = new RefRegistry();
  const live = Array.from({ length: 259 }, (_, i) => `msg:${i}`);

  // Dispatch 1: the whole transcript.
  registry.project(live);
  assert.equal(registry.byKey.get("msg:0"), "m0001");
  assert.equal(registry.byKey.get("msg:258"), "m0259");

  // A compression covers an INTERIOR range, holding m0194..m0258.
  const covered = live.slice(193, 258);
  registry.release(covered);
  for (const key of covered) assert.equal(registry.byKey.get(key), undefined);

  // The survivors still carry the tags the model already read: the release is
  // pure map surgery, so no live key is renumbered underneath the transcript.
  const survivors = live.filter((key) => !covered.includes(key));
  for (const key of survivors) {
    assert.equal(
      registry.byKey.get(key),
      ref(live.indexOf(key) + 1),
      `${key} must keep its pre-compression address`,
    );
  }

  // And the next dispatch, which is what the model actually reads, is a single
  // unbroken ascending run over survivors + arrivals.
  const arriving = Array.from({ length: 20 }, (_, i) => `msg:new:${i}`);
  assert.equal(registry.project([...survivors, ...arriving]), 0);
  assertProjected(registry, [...survivors, ...arriving]);
});

test("project clamps at the ref cap instead of throwing", () => {
  const registry = new RefRegistry();
  const keys = Array.from({ length: MESSAGE_REF_MAX_INDEX + 5 }, (_, i) => `msg:${i}`);
  const unaliased = registry.project(keys);
  assert.equal(unaliased, 5);
  assert.equal(registry.byKey.get(keys[0]!), "m0001");
  assert.equal(registry.byKey.get(keys[MESSAGE_REF_MAX_INDEX - 1]!), ref(MESSAGE_REF_MAX_INDEX));
  // The overflow tail is unaddressable, never wrong: every emitted ref still
  // resolves back to its own key.
  for (let i = 0; i < MESSAGE_REF_MAX_INDEX; i++) {
    assert.equal(registry.keyOf(ref(i + 1)), keys[i]!);
  }
  assert.equal(registry.byKey.get(keys[MESSAGE_REF_MAX_INDEX]!), undefined);
});

test("RefRegistry.from tolerates missing, partial and corrupt blobs", () => {
  const empty = { byKey: {}, byRef: {}, next: 1 };
  assert.doesNotThrow(() => RefRegistry.from(undefined));
  assert.deepEqual(RefRegistry.from(undefined).toJSON(), empty);
  assert.deepEqual(RefRegistry.from({} as never).toJSON(), empty);
  assert.deepEqual(RefRegistry.from(null as never).toJSON(), empty);

  // Structurally wrong shapes load as empty rather than throwing mid-dispatch.
  for (const blob of ["nope", 7, [], { byKey: "x", byRef: 3 }] as never[]) {
    assert.deepEqual(RefRegistry.from(blob).toJSON(), empty);
  }

  // A legacy blob survives the round trip, and `next` is re-derived from the
  // live aliases rather than trusted (a rewound/stale value would misreport the
  // high-water mark; a corrupt one could push it past the cap).
  const registry = new RefRegistry();
  registry.project(["a", "b", "c"]);
  const restored = RefRegistry.from({ ...registry.toJSON(), next: 1 });
  assert.equal(restored.byKey.get("c"), "m0003");
  assert.equal(restored.next, 4);
  assert.equal(restored.project(["a", "b", "c", "d"]), 0);
  assert.equal(restored.byKey.get("d"), "m0004");
  assert.doesNotThrow(() => RefRegistry.from({ ...registry.toJSON(), next: "wat" } as never));
});

