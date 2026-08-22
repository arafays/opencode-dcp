import assert from "node:assert/strict"
import { test } from "node:test"

import {
  RefRegistry,
  formatBlockRef,
  formatMessageIdTag,
  formatMessageRef,
  parseBlockRef,
  parseBoundaryId,
  parseMessageRef,
} from "../lib/refs"

test("formatMessageRef pads to four digits and rejects out-of-range indices", () => {
  assert.equal(formatMessageRef(1), "m0001")
  assert.equal(formatMessageRef(42), "m0042")
  assert.equal(formatMessageRef(9999), "m9999")
  assert.throws(() => formatMessageRef(0))
  assert.throws(() => formatMessageRef(10000))
  assert.throws(() => formatMessageRef(1.5))
})

test("formatBlockRef validates positive integers", () => {
  assert.equal(formatBlockRef(1), "b1")
  assert.equal(formatBlockRef(12), "b12")
  assert.throws(() => formatBlockRef(0))
})

test("parse functions round-trip and reject malformed refs", () => {
  assert.equal(parseMessageRef("m0001"), 1)
  assert.equal(parseMessageRef("M0042"), 42)
  assert.equal(parseMessageRef("m001"), null)
  assert.equal(parseMessageRef("x0001"), null)
  assert.equal(parseBlockRef("b7"), 7)
  assert.equal(parseBlockRef("b0"), null)
  assert.equal(parseBlockRef("m0001"), null)

  const message = parseBoundaryId("m0012")
  assert.deepEqual(message, { kind: "message", ref: "m0012", index: 12 })
  const block = parseBoundaryId(" B3 ")
  assert.deepEqual(block, { kind: "block", ref: "b3", blockId: 3 })
  assert.equal(parseBoundaryId("nope"), null)
})

test("formatMessageIdTag serializes attributes safely", () => {
  assert.equal(formatMessageIdTag("m0001"), "\n<dcp-message-id>m0001</dcp-message-id>")
  const tagged = formatMessageIdTag("b2", { topic: 'auth "scope"' })
  assert.match(tagged, /topic="auth &quot;scope&quot;"/)
})

test("RefRegistry allocates stable sequential aliases", () => {
  const registry = new RefRegistry()
  assert.equal(registry.ensure("key:a"), "m0001")
  assert.equal(registry.ensure("key:b"), "m0002")
  // Stable on repeat lookups.
  assert.equal(registry.ensure("key:a"), "m0001")
  assert.equal(registry.keyOf("m0001"), "key:a")
  assert.equal(registry.refOf("key:b"), "m0002")
  assert.equal(registry.keyOf("m9999"), undefined)
})

test("RefRegistry survives a JSON round trip", () => {
  const registry = new RefRegistry()
  registry.ensure("k1")
  registry.ensure("k2")
  const restored = RefRegistry.from(registry.toJSON())
  assert.equal(restored.ensure("k1"), "m0001")
  assert.equal(restored.ensure("k3"), "m0003")
})

test("RefRegistry skips gaps left by external allocations", () => {
  const registry = new RefRegistry()
  registry.byKey.set("k1", "m0001")
  registry.byRef.set("m0001", "k1")
  registry.next = 1
  assert.equal(registry.ensure("k2"), "m0002")
})
