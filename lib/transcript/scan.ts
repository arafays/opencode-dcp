import { toolResultToText, type WireMessage } from "../types"

/**
 * Index built from the inbound transcript at each model dispatch.
 *
 * Stable keys: `message.id` when present (and unique), otherwise the positional
 * form `${role}#${index}`. Transcript prefixes are append-only between
 * compactions/reverts (which reset DCP state), so keys stay stable across
 * requests and can be persisted inside compression blocks.
 */

export interface ToolCallInfo {
  callId: string
  name: string
  input: unknown
  /** False while the call is pending/running. */
  hasResult: boolean
  isError: boolean
  outputText: string
  /** Transcript key of the result message (empty while pending). */
  key: string
  /** Inbound transcript index of the result message (-1 while pending). */
  index: number
  /** Turn number the result belongs to (1-based count of user messages up to it). */
  turn: number
}

export interface UserEntry {
  key: string
  index: number
  text: string
}

export interface TranscriptIndex {
  messages: WireMessage[]
  keys: string[]
  tools: Map<string, ToolCallInfo>
  /** Call IDs in transcript order of their results (pending calls last). */
  toolOrder: string[]
  users: UserEntry[]
  turnCount: number
}

export function scanTranscript(messages: WireMessage[]): TranscriptIndex {
  const keys = assignKeys(messages)

  // First pass: collect tool invocations declared by assistant messages.
  const inputs = new Map<string, { name: string; input: unknown; index: number }>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool-call" && typeof part.id === "string" && !inputs.has(part.id)) {
        inputs.set(part.id, { name: part.name, input: part.input, index })
      }
    }
  }

  // Second pass: match results and user entries.
  const tools = new Map<string, ToolCallInfo>()
  const toolOrder: string[] = []
  const users: UserEntry[] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === "user") {
      const text = message.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      users.push({ key: keys[index]!, index, text })
      continue
    }
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      const declared = inputs.get(part.id)
      if (!declared || tools.has(part.id)) continue
      tools.set(part.id, {
        callId: part.id,
        name: declared.name,
        input: declared.input,
        hasResult: true,
        isError: part.result.type === "error",
        outputText: toolResultToText(part.result),
        key: keys[index]!,
        index,
        turn: 0,
      })
      toolOrder.push(part.id)
    }
  }

  // Pending calls (no result yet) appear in order after completed ones.
  for (const [callId, declared] of inputs) {
    if (!tools.has(callId)) {
      tools.set(callId, {
        callId,
        name: declared.name,
        input: declared.input,
        hasResult: false,
        isError: false,
        outputText: "",
        key: "",
        index: -1,
        turn: 0,
      })
      toolOrder.push(callId)
    }
  }

  const turnCount = users.length
  let userIdx = 0
  for (let index = 0; index < messages.length; index++) {
    while (userIdx < users.length && users[userIdx]!.index <= index) userIdx++
    void index
  }
  // Turn per tool = number of user messages at or before its result position.
  for (const info of tools.values()) {
    if (info.index < 0) {
      info.turn = turnCount + 1
      continue
    }
    info.turn = users.filter((user) => user.index <= info.index).length
  }

  return { messages, keys, tools, toolOrder, users, turnCount }
}

function assignKeys(messages: WireMessage[]): string[] {
  const keys = new Array<string>(messages.length)
  const seenIds = new Map<string, number>()
  for (let index = 0; index < messages.length; index++) {
    const id = messages[index]?.id
    if (typeof id === "string" && id.length > 0) {
      seenIds.set(id, (seenIds.get(id) ?? 0) + 1)
    }
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    const id = message.id
    if (typeof id === "string" && id.length > 0 && seenIds.get(id) === 1) {
      keys[index] = `id:${id}`
    } else {
      keys[index] = `${message.role}#${index}`
    }
  }
  return keys
}

/** Turn number a transcript index belongs to. */
export function turnAt(users: UserEntry[], index: number): number {
  return users.filter((user) => user.index <= index).length
}
