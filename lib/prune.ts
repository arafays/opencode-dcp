import { ALWAYS_PROTECTED_TOOLS, type DcpOptions } from "./config"
import { matchesGlob } from "./protected"
import { formatMessageIdTag } from "./refs"
import { activeBlocks, TAIL_ANCHOR } from "./state/store"
import type { SessionState } from "./state/types"
import { createSyntheticBlockMessage, mapTextParts, stripHallucinatedTags, withToolInputReplaced, withToolResultReplaced } from "./transcript/edit"
import { makeToolResultReplacement, type WireMessage } from "./types"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"

/**
 * Outbound-only transforms applied to the transcript right before model
 * dispatch. Stored session data is never modified: edits swap in new message
 * objects or splice the hook's array.
 */

/** Replaces outputs of pruned tool calls with a short placeholder. */
export function pruneToolOutputs(
  state: SessionState,
  messages: WireMessage[],
  config: DcpOptions,
): void {
  const prunedIds = Object.keys(state.prunedTools)
  if (prunedIds.length === 0) return
  const prunedSet = new Set(prunedIds)
  const alwaysProtected = new Set([...ALWAYS_PROTECTED_TOOLS])
  const isProtectedName = (name: string | undefined): boolean => {
    const normalized = (name ?? "").toLowerCase()
    if (alwaysProtected.has(normalized)) return true
    return config.protectedTools.some((pattern) => matchesGlob(pattern, normalized))
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || message.role !== "tool") continue

    // Blank string inputs of pruned ERRORED calls (assistant message holds them).
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      if (!prunedSet.has(part.id)) continue
      if (part.result.type !== "error") continue
      const callName = part.name
      if (isProtectedName(callName)) continue
      // Find the matching assistant tool-call input and scrub strings.
      for (let j = i - 1; j >= 0; j--) {
        const candidate = messages[j]
        if (!candidate) continue
        if (candidate.role === "user") break
        if (candidate.role !== "assistant") continue
        const hasCall = candidate.content.some(
          (inner) => inner.type === "tool-call" && inner.id === part.id,
        )
        if (!hasCall) continue
        const input = candidate.content.find(
          (inner) => inner.type === "tool-call" && inner.id === part.id,
        )
        if (input && input.type === "tool-call" && typeof input.input === "object" && input.input !== null) {
          const scrubbed: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(input.input as Record<string, unknown>)) {
            scrubbed[key] = typeof value === "string" ? PRUNED_TOOL_ERROR_INPUT_REPLACEMENT : value
          }
          messages[j] = withToolInputReplaced(candidate, part.id, scrubbed)
        }
        break
      }
    }

    // Replace the output text itself.
    let next = message
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      if (!prunedSet.has(part.id)) continue
      if (isProtectedName(part.name)) continue
      next = withToolResultReplaced(next, part.id, makeToolResultReplacement(PRUNED_TOOL_OUTPUT_REPLACEMENT))
    }
    if (next !== message) messages[i] = next
  }
}

/**
 * Applies active compression blocks: removes covered messages from the
 * outbound array and splices one synthetic summary user-message per block at
 * its anchor position ("tail" anchors append at the end).
 */
export function applyCompressionBlocks(state: SessionState, messages: WireMessage[], keys: string[]): void {
  const blocks = activeBlocks(state)
  if (blocks.length === 0) return

  const keyToIndex = new Map<string, number>()
  for (let i = 0; i < keys.length; i++) keyToIndex.set(keys[i]!, i)

  interface Splice {
    at: number
    summary: string
  }
  const splices: Splice[] = []
  const covered = new Set<string>()

  for (const block of blocks) {
    for (const key of block.coveredKeys) covered.add(key)
    const anchorIndex =
      block.anchorKey === TAIL_ANCHOR ? -2 : (keyToIndex.get(block.anchorKey) ?? -2)
    splices.push({ at: anchorIndex, summary: block.summary })
  }

  const kept: WireMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    // Insert summaries anchored to this position before the message itself.
    for (const splice of splices.filter((entry) => entry.at === i)) {
      kept.push(createSyntheticBlockMessage(splice.summary))
    }
    const key = keys[i]
    if (key !== undefined && covered.has(key)) continue
    kept.push(messages[i]!)
  }
  for (const splice of splices.filter((entry) => entry.at === -2)) {
    kept.push(createSyntheticBlockMessage(splice.summary))
  }

  messages.length = 0
  messages.push(...kept)
}

/**
 * Injects `<dcp-message-id>` boundary tags into the outbound transcript:
 * appended to user text parts and to textual tool results. Also strips DCP
 * tags the model hallucinated into its own assistant output.
 */
export function injectBoundaryTags(refsByKey: Map<string, string>, messages: WireMessage[], keys: string[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message) continue

    if (message.role === "assistant") {
      const hasText = message.content.some(
        (part) => part.type === "text" && part.text.includes("dcp-"),
      )
      if (hasText) {
        messages[i] = mapTextParts(message, stripHallucinatedTags)
      }
      continue
    }

    const key = keys[i]
    if (key === undefined) continue
    const ref = refsByKey.get(key)
    if (!ref) continue
    const tag = formatMessageIdTag(ref)

    if (message.role === "user") {
      const next = appendToLastTextPartSafe(message, tag)
      if (next !== message) messages[i] = next
      continue
    }

    if (message.role === "tool") {
      let next = message
      for (const part of message.content) {
        if (part.type !== "tool-result" || part.result.type !== "text") continue
        if (typeof part.result.value !== "string") continue
        if (part.result.value.includes("dcp-message-id")) continue
        const updated = { ...part, result: { type: "text" as const, value: part.result.value + tag } }
        next = {
          ...next,
          content: next.content.map((inner) => (inner === part ? updated : inner)),
        }
      }
      if (next !== message) messages[i] = next
    }
  }
}

function appendToLastTextPartSafe(message: WireMessage, suffix: string): WireMessage {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i]
    if (part && part.type === "text" && !part.text.includes("dcp-message-id")) {
      const content = [...message.content]
      content[i] = { ...part, text: part.text + suffix }
      return { ...message, content }
    }
    if (part && part.type === "text") return message // already tagged
  }
  return message
}
