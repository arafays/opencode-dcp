import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RefRegistry,
  formatBlockRef,
  formatMessageIdTag,
  formatMessageRef,
  parseBlockRef,
  parseMessageRef,
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

test("RefRegistry allocates stable sequential aliases", () => {
  const registry = new RefRegistry();
  assert.equal(registry.ensure("key:a"), "m0001");
  assert.equal(registry.ensure("key:b"), "m0002");
  // Stable on repeat lookups.
  assert.equal(registry.ensure("key:a"), "m0001");
  assert.equal(registry.keyOf("m0001"), "key:a");
  assert.equal(registry.refOf("key:b"), "m0002");
  assert.equal(registry.keyOf("m9999"), undefined);
});

test("RefRegistry survives a JSON round trip", () => {
  const registry = new RefRegistry();
  registry.ensure("k1");
  registry.ensure("k2");
  const restored = RefRegistry.from(registry.toJSON());
  assert.equal(restored.ensure("k1"), "m0001");
  assert.equal(restored.ensure("k3"), "m0003");
});

test("RefRegistry skips gaps left by external allocations", () => {
  const registry = new RefRegistry();
  registry.byKey.set("k1", "m0001");
  registry.byRef.set("m0001", "k1");
  registry.next = 1;
  assert.equal(registry.ensure("k2"), "m0002");
});

test("RefRegistry.release frees slots for reuse and ignores unknown keys", () => {
  const registry = new RefRegistry();
  registry.ensure("key:a"); // m0001
  registry.ensure("key:b"); // m0002
  registry.ensure("key:c"); // m0003
  assert.equal(registry.next, 4);

  // Releasing a subset drops both directions of the alias.
  registry.release(["key:b"]);
  assert.equal(registry.refOf("key:b"), undefined);
  assert.equal(registry.keyOf("m0002"), undefined);
  // Unrelated refs keep their aliases.
  assert.equal(registry.refOf("key:a"), "m0001");
  assert.equal(registry.refOf("key:c"), "m0003");

  // Freed slot is reused by the next allocation.
  assert.equal(registry.ensure("key:d"), "m0002");
  assert.equal(registry.keyOf("m0002"), "key:d");

  // Unknown keys are a no-op; known keys release cleanly.
  registry.release(["missing", "key:a", "also-missing"]);
  assert.equal(registry.refOf("key:a"), undefined);
  assert.equal(registry.keyOf("m0001"), undefined);
  assert.equal(registry.refOf("key:c"), "m0003");
  assert.equal(registry.refOf("key:d"), "m0002");

  // The lowest free slot is reused again.
  assert.equal(registry.ensure("key:e"), "m0001");
});

test("RefRegistry.release rewinds next to the lowest freed slot", () => {
  const registry = new RefRegistry();
  registry.ensure("k1"); // m0001
  registry.ensure("k2"); // m0002
  registry.ensure("k3"); // m0003
  // Freeing m0001 and m0003 rewinds next below the current high-water mark.
  registry.release(["k1", "k3"]);
  assert.equal(registry.next, 1);
  assert.equal(registry.ensure("k4"), "m0001");
  // m0002 is still taken, so the next free slot is m0003.
  assert.equal(registry.ensure("k5"), "m0003");
});
