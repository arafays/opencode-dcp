import assert from "node:assert/strict";
import { test } from "node:test";

import { scanTranscript } from "../lib/transcript/scan";
import type { ToolResultPart, WireMessage } from "../lib/types";

function userMessage(id: string, text: string): WireMessage {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function assistantWithCalls(
  id: string,
  calls: Array<{ id: string; name: string; input?: unknown }>,
): WireMessage {
  return {
    id,
    role: "assistant",
    content: calls.map((call) => ({
      type: "tool-call",
      id: call.id,
      name: call.name,
      input: call.input ?? {},
    })),
  };
}

function toolResult(
  id: string,
  callId: string,
  name: string,
  value: ToolResultPart["result"],
): WireMessage {
  return { id, role: "tool", content: [{ type: "tool-result", id: callId, name, result: value }] };
}

const FIXTURE: WireMessage[] = [
  userMessage("u1", "explore auth"),
  assistantWithCalls("a1", [{ id: "c1", name: "read", input: { filePath: "a.ts" } }]),
  toolResult("t1", "c1", "read", { type: "text", value: "...auth files..." }),
  assistantWithCalls("a2", [{ id: "c2", name: "grep", input: {} }]),
  toolResult("t2", "c2", "grep", { type: "text", value: "...matches..." }),
  userMessage("u2", "implement now"),
  assistantWithCalls("a3", [{ id: "c3", name: "edit", input: {} }]),
  toolResult("t3", "c3", "edit", { type: "text", value: "wrote file" }),
];

test("scanTranscript assigns stable keys from unique message ids", () => {
  const index = scanTranscript(FIXTURE);
  assert.equal(index.keys[0], "id:u1");
  assert.equal(index.keys[7], "id:t3");
});

test("scanTranscript falls back to positional keys for duplicate ids", () => {
  const duplicated: WireMessage[] = [
    { id: "same", role: "user", content: [{ type: "text", text: "one" }] },
    { id: "same", role: "user", content: [{ type: "text", text: "two" }] },
  ];
  const index = scanTranscript(duplicated);
  assert.deepEqual(index.keys, ["user#0", "user#1"]);
});

test("scanTranscript derives stable tool keys from tool-result call ids", () => {
  const index = scanTranscript([
    { id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "read", input: {} }],
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
        { type: "tool-result", id: "c2", name: "grep", result: { type: "text", value: "two" } },
      ],
    },
    { id: "u2", role: "user", content: [{ type: "text", text: "next" }] },
  ]);
  // Id-less tool results key on their callId, surviving range removal.
  assert.equal(index.keys[2], "tool:c1");
  assert.equal(index.keys[3], "tool:c2");
  assert.equal(index.tools.get("c1")!.key, "tool:c1");
  // Messages with unique ids keep the id: form.
  assert.equal(index.keys[4], "id:u2");
});

test("scanTranscript falls back to positional keys for duplicate tool call ids", () => {
  const index = scanTranscript([
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "read", input: {} }],
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
        { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "two" } },
      ],
    },
  ]);
  assert.equal(index.keys[0], "id:a1");
  // tool:c1 is not unique -> positional fallback for both result messages.
  assert.equal(index.keys[1], "tool#1");
  assert.equal(index.keys[2], "tool#2");
});

test("scanTranscript snapshots messages so the mirror survives in-place truncation", () => {
  const original: WireMessage[] = [...FIXTURE];
  const index = scanTranscript(original);
  assert.notEqual(index.messages, original);
  // Simulate applyCompressionBlocks truncating the live array.
  original.length = 0;
  original.push(...FIXTURE.slice(0, 1));
  assert.equal(index.messages.length, FIXTURE.length);
  // keys stay parallel to the snapshot, not the truncated live array.
  assert.equal(index.keys.length, index.messages.length);
});

test("scanTranscript matches tool results to their declarations", () => {
  const index = scanTranscript(FIXTURE);
  assert.equal(index.tools.size, 3);
  const c1 = index.tools.get("c1")!;
  assert.equal(c1.name, "read");
  assert.equal(c1.hasResult, true);
  assert.equal(c1.isError, false);
  assert.equal(c1.outputText, "...auth files...");
  assert.equal(c1.key, "id:t1");
  assert.equal(c1.index, 2);
  assert.ok(index.toolOrder.includes("c1"));
});

test("scanTranscript counts turns as user-message boundaries", () => {
  const index = scanTranscript(FIXTURE);
  assert.equal(index.turnCount, 2);
  // c1 and c2 results both precede the second user message.
  assert.equal(index.tools.get("c1")!.turn, 1);
  assert.equal(index.tools.get("c2")!.turn, 1);
  assert.equal(index.tools.get("c3")!.turn, 2);
  assert.equal(index.users.length, 2);
});

test("scanTranscript records errored and pending calls", () => {
  const withPending: WireMessage[] = [
    ...FIXTURE,
    toolResult("t9", "c9x", "bash", { type: "error", value: { message: "boom" } }),
  ];
  const index = scanTranscript(withPending);
  // c9x has no declaring assistant message -> ignored entirely.
  assert.equal(index.tools.size, 3);

  const withPendingCall: WireMessage[] = [
    ...FIXTURE,
    assistantWithCalls("a4", [{ id: "pending", name: "bash" }]),
  ];
  const pendingIndex = scanTranscript(withPendingCall);
  const pending = pendingIndex.tools.get("pending")!;
  assert.equal(pending.hasResult, false);
  assert.equal(pending.index, -1);
  assert.equal(pending.turn, 3); // turnCount + 1
});

/**
 * A namespaced tool (MCP, `packages/core/src/tool/mcp.ts`) arrives either with
 * the namespace already flattened into `name` (`effectiveName`,
 * packages/core/src/tool/runtime.ts:278) or, on a route that keeps namespaces
 * natively, as a leaf `name` plus `namespace`. Either way the index must key
 * tools by the same joined spelling the model is shown
 * (`qualifiedToolName`, mirroring `flattenToolRequest`,
 * packages/ai/src/protocols/shared.ts:308) - otherwise two tools sharing a leaf
 * name are indistinguishable and name-based protection/dedupe mis-fires.
 */
test("scanTranscript indexes namespaced tools under their qualified name", () => {
  const index = scanTranscript([
    { id: "u1", role: "user", content: [{ type: "text", text: "search" }] },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "search", namespace: "github", input: { q: "dcp" } },
      ],
    },
    {
      id: "t1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "search",
          namespace: "github",
          result: { type: "text", value: "hits" },
        },
      ],
    },
  ]);
  const call = index.tools.get("c1")!;
  assert.equal(call.name, "github_search");
  assert.equal(call.hasResult, true);
});

test("two same-named tools in different namespaces keep distinct identities", () => {
  const index = scanTranscript([
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "search", namespace: "github", input: { q: "dcp" } },
        { type: "tool-call", id: "c2", name: "search", namespace: "linear", input: { q: "dcp" } },
      ],
    },
    {
      id: "t1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "search",
          namespace: "github",
          result: { type: "text", value: "github hits" },
        },
      ],
    },
    {
      id: "t2",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c2",
          name: "search",
          namespace: "linear",
          result: { type: "text", value: "linear hits" },
        },
      ],
    },
  ]);
  assert.equal(index.tools.get("c1")!.name, "github_search");
  assert.equal(index.tools.get("c2")!.name, "linear_search");
  // Same input, different namespace: a dedupe signature over name+input must
  // not group them, or one server's result is pruned as a duplicate of the other.
  const signatures = ["c1", "c2"].map((id) => `${index.tools.get(id)!.name}`);
  assert.deepEqual(new Set(signatures).size, 2);
});

/**
 * Core emits `[call, result]` inside the ASSISTANT message for a
 * provider-executed tool and the protocol replays the result as a hosted item
 * while dropping the call (packages/ai/src/session/runner/to-llm-message.ts:180-200,
 * packages/ai/src/protocols/open-responses.ts:700-728). The text must be
 * measured - a compression covering it is charged for what it removes - but it
 * must never look prunable: `pruneToolOutputs` only rewrites `role:"tool"`
 * messages, so a prunable flag here would report savings that never happen.
 */
test("a provider-executed result is measured but never marked prunable", () => {
  const index = scanTranscript([
    { id: "u1", role: "user", content: [{ type: "text", text: "look it up" }] },
    {
      id: "a1",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          id: "c1",
          name: "google_search",
          input: { q: "dcp" },
          providerExecuted: true,
        },
        {
          type: "tool-result",
          id: "c1",
          name: "google_search",
          result: { type: "text", value: "a very large search result blob" },
          providerExecuted: true,
        },
      ],
    },
  ]);
  const call = index.tools.get("c1")!;
  assert.equal(call.providerExecuted, true);
  assert.equal(call.outputText, "a very large search result blob");
  // Not prunable: no `role:"tool"` message exists to rewrite.
  assert.equal(call.hasResult, false);
  assert.equal(call.key, "");
  assert.equal(call.index, -1);
});

test("a provider-executed error result is reported as an error, still unprunable", () => {
  const index = scanTranscript([
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "google_search", input: {}, providerExecuted: true },
        {
          type: "tool-result",
          id: "c1",
          name: "google_search",
          result: { type: "error", value: "quota" },
          providerExecuted: true,
        },
      ],
    },
  ]);
  const call = index.tools.get("c1")!;
  assert.equal(call.isError, true);
  assert.equal(call.hasResult, false);
  // `toolResultToText` JSON-encodes a non-string error value.
  assert.equal(call.outputText, '"quota"');
});

test("a provider-executed result stays unprunable even in a tool message", () => {
  const index = scanTranscript([
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "google_search", input: {}, providerExecuted: true },
      ],
    },
    {
      id: "t1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "google_search",
          result: { type: "text", value: "hosted result" },
          providerExecuted: true,
        },
      ],
    },
  ]);
  const call = index.tools.get("c1")!;
  assert.equal(call.providerExecuted, true);
  assert.equal(call.hasResult, false);
  assert.equal(call.outputText, "hosted result");
});

/**
 * `CompactionPart`/`EffortPart` (packages/ai/src/schema/messages.ts:196-230)
 * are provider markers, never tool output: they must not be indexed as a tool
 * result, must not disturb message keys, and must not be mistaken for media.
 */
test("compaction and effort parts are ignored by the tool index", () => {
  const messages: WireMessage[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
    { role: "system", content: [{ type: "effort", effort: "high", previous: "low" }] },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "read", input: {} },
        { type: "compaction", provider: "anthropic", text: "earlier conversation summary" },
        { type: "text", text: "done" },
      ],
    },
    toolResult("t1", "c1", "read", { type: "text", value: "data" }),
  ];
  const index = scanTranscript(messages);
  assert.equal(index.keys[1], "system#1");
  assert.equal(index.tools.size, 1);
  assert.equal(index.tools.get("c1")!.outputText, "data");
  // The compaction payload is not attributed to the tool.
  assert.ok(!index.tools.get("c1")!.outputText.includes("earlier conversation"));
  // An effort-only system message is not a user turn.
  assert.equal(index.turnCount, 1);
});
