import { qualifiedToolName, toolResultToText, type ToolResultValue, type WireMessage } from "../types"

/**
 * Index built from the inbound transcript at each model dispatch.
 *
 * Stable keys: `message.id` when present (and unique), otherwise `tool:<callId>`
 * derived from an id-less role:"tool" message's first `tool-result` part id
 * (when unique), otherwise the positional form `${role}#${index}`. Positional
 * keys shift after a compression, so id-less tool results prefer the callId
 * form, which survives range removal. Transcript prefixes are append-only
 * between compactions/reverts (which reset DCP state), so keys stay stable
 * across requests and can be persisted inside compression blocks.
 */

export interface ToolCallInfo {
  callId: string
  /**
   * Namespace-qualified tool name, spelled the way the model is shown it (see
   * {@link qualifiedToolName}). Core flattens `namespace_name` into `name`
   * itself, so the two forms never double up; folding a native namespace in
   * here is what keeps two same-named tools apart for protection globs and the
   * dedupe signature.
   */
  name: string
  input: unknown
  /**
   * True when the result lives in a `role:"tool"` message, the only place
   * `pruneToolOutputs` can rewrite it. A provider-executed call (see
   * `providerExecuted`) carries its result inside the ASSISTANT message, so it
   * stays `false` forever - deliberately, or the tool would be marked prunable
   * while `pruneToolOutputs` silently missed it and the prune reported tokens it
   * never reclaimed.
   */
  hasResult: boolean
  isError: boolean
  /** Model-visible result text; filled even for unprunable provider-executed calls. */
  outputText: string
  /** Transcript key of the result message (empty while pending). */
  key: string
  /** Inbound transcript index of the result message (-1 while pending). */
  index: number
  /** Turn number the result belongs to (1-based count of user messages up to it). */
  turn: number
  /** The provider ran the tool itself (google_search, OpenAI hosted tools). */
  providerExecuted: boolean
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

  // First pass: collect tool invocations declared by assistant messages, plus
  // any result the provider returned inside that same message.
  const inputs = new Map<
    string,
    { name: string; input: unknown; index: number; providerExecuted: boolean }
  >()
  const embeddedResults = new Map<string, ToolResultValue>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool-call" && typeof part.id === "string" && !inputs.has(part.id)) {
        inputs.set(part.id, {
          name: qualifiedToolName(part.name, part.namespace),
          input: part.input,
          index,
          providerExecuted: part.providerExecuted === true,
        })
        continue
      }
      // Provider-executed tools (google_search, OpenAI hosted tools) carry
      // their result in the assistant message: core's history lowering emits
      // `[call, result]` for them and the protocol replays the result as a
      // hosted item while dropping the call
      // (`packages/ai/src/protocols/open-responses.ts:700-728`). Measured, but
      // never prunable - see `hasResult`.
      if (part.type === "tool-result" && typeof part.id === "string" && !embeddedResults.has(part.id)) {
        embeddedResults.set(part.id, part.result)
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
      const providerExecuted = declared.providerExecuted || part.providerExecuted === true
      tools.set(part.id, {
        callId: part.id,
        name: declared.name,
        input: declared.input,
        // A provider-executed result is replayed from provider state, not from
        // this text, so it stays unprunable even in a `role:"tool"` message.
        hasResult: !providerExecuted,
        isError: part.result.type === "error",
        outputText: toolResultToText(part.result),
        key: keys[index]!,
        index,
        turn: 0,
        providerExecuted,
      })
      toolOrder.push(part.id)
    }
  }

  // Calls without a `role:"tool"` result: still running, or executed by the
  // provider itself. The latter already carries its text (so a compression
  // covering it is charged for what it removes) but stays `hasResult: false`,
  // which keeps every pruner away from a payload `pruneToolOutputs` cannot
  // rewrite.
  for (const [callId, declared] of inputs) {
    if (!tools.has(callId)) {
      const embedded = embeddedResults.get(callId)
      tools.set(callId, {
        callId,
        name: declared.name,
        input: declared.input,
        hasResult: false,
        isError: embedded?.type === "error",
        outputText: embedded === undefined ? "" : toolResultToText(embedded),
        key: "",
        index: -1,
        turn: 0,
        providerExecuted: declared.providerExecuted || embedded !== undefined,
      })
      toolOrder.push(callId)
    }
  }

  const turnCount = users.length

  // Turn per tool = number of user messages at or before its result position.
  for (const info of tools.values()) {
    if (info.index < 0) {
      info.turn = turnCount + 1
      continue
    }
    info.turn = users.filter((user) => user.index <= info.index).length
  }

  return { messages: [...messages], keys, tools, toolOrder, users, turnCount }
}

function assignKeys(messages: WireMessage[]): string[] {
  const keys = new Array<string>(messages.length)
  const seenIds = new Map<string, number>()
  const seenToolKeys = new Map<string, number>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    const id = message.id
    if (typeof id === "string" && id.length > 0) {
      seenIds.set(id, (seenIds.get(id) ?? 0) + 1)
    }
    const toolKey = toolResultKey(message)
    if (toolKey) {
      seenToolKeys.set(toolKey, (seenToolKeys.get(toolKey) ?? 0) + 1)
    }
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    const id = message.id
    if (typeof id === "string" && id.length > 0 && seenIds.get(id) === 1) {
      keys[index] = `id:${id}`
      continue
    }
    const toolKey = toolResultKey(message)
    if (toolKey && seenToolKeys.get(toolKey) === 1) {
      keys[index] = toolKey
      continue
    }
    keys[index] = `${message.role}#${index}`
  }
  return keys
}

/**
 * `tool:<callId>` derived from the first `tool-result` part of an id-less
 * role:"tool" message. Wire tool results carry no message id, so the callId is
 * the only identity stable enough to survive compression: positional `tool#N`
 * keys shift whenever an earlier range is removed.
 */
function toolResultKey(message: WireMessage | undefined): string | undefined {
  if (!message || message.role !== "tool") return undefined
  for (const part of message.content) {
    if (part.type !== "tool-result") {
      continue
    }
    if (typeof part.id === "string" && part.id.length > 0) return `tool:${part.id}`
    return undefined
  }
  return undefined
}
