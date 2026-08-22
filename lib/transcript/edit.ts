import type { ContentPart, TextPart, ToolResultValue, WireMessage } from "../types"

/**
 * Copy-on-write message edits. The context hook receives the live transcript;
 * every edit produces NEW message objects so stored session data is untouched,
 * and callers replace slots in (or splice) the hook's array.
 */

/** Returns a copy of the message with its text content transformed. */
export function mapTextParts(
  message: WireMessage,
  transform: (text: string) => string,
): WireMessage {
  let changed = false
  const content: ContentPart[] = message.content.map((part) => {
    if (part.type !== "text") return part
    const next = transform(part.text)
    if (next === part.text) return part
    changed = true
    return { ...part, text: next } satisfies TextPart
  })
  if (!changed) return message
  return { ...message, content }
}

export function appendToLastTextPart(message: WireMessage, suffix: string): WireMessage {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i]
    if (part && part.type === "text") {
      const content = [...message.content]
      content[i] = { ...part, text: part.text + suffix }
      return { ...message, content }
    }
  }
  // No text part present: append one.
  return {
    ...message,
    content: [...message.content, { type: "text", text: suffix.trimStart() }],
  }
}

/** Returns a copy of a role:"tool" message with one result value replaced. */
export function withToolResultReplaced(
  message: WireMessage,
  callId: string,
  replacement: ToolResultValue,
): WireMessage {
  let changed = false
  const content: ContentPart[] = message.content.map((part) => {
    if (part.type !== "tool-result" || part.id !== callId) return part
    changed = true
    return { ...part, result: replacement }
  })
  if (!changed) return message
  return { ...message, content }
}

/** Returns a copy of an assistant message with one tool-call input replaced. */
export function withToolInputReplaced(
  message: WireMessage,
  callId: string,
  replacement: unknown,
): WireMessage {
  let changed = false
  const content: ContentPart[] = message.content.map((part) => {
    if (part.type !== "tool-call" || part.id !== callId) return part
    changed = true
    return { ...part, input: replacement }
  })
  if (!changed) return message
  return { ...message, content }
}

/** Builds the synthetic user message that stands in for compressed ranges. */
export function createSyntheticBlockMessage(summary: string): WireMessage {
  return {
    role: "user",
    content: [{ type: "text", text: summary }],
  }
}

const HALLUCINATED_TAG_REGEX =
  /[ \t]*<\/?dcp-message-id(?:\s[^>]*)?>[ \t]*\n?/g

/** Removes DCP tags echoed by the model from its own output. */
export function stripHallucinatedTags(text: string): string {
  if (!text.includes("dcp-")) return text
  return text.replace(HALLUCINATED_TAG_REGEX, "").replace(/\n{3,}/g, "\n\n")
}
