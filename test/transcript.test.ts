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
