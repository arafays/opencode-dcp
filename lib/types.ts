/**
 * Structural types for the outbound model transcript that OpenCode V2 hands
 * to `ctx.session.hook("context", ...)`.
 *
 * These mirror `@opencode-ai/ai` schema types (`packages/ai/src/schema/messages.ts`)
 * structurally so this plugin does not need a runtime dependency on that package.
 * Plain objects with these exact shapes are what the hook receives and what the
 * pipeline is allowed to substitute back into the array.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool"

export interface SystemPart {
  type: "text"
  text: string
}

export interface TextPart {
  type: "text"
  text: string
}

export interface MediaPart {
  type: "media"
  mediaType: string
  data: string | Uint8Array
  filename?: string
}

/** Assistant-declared tool invocation. */
export interface ToolCallPart {
  type: "tool-call"
  id: string
  name: string
  input: unknown
}

export interface ToolTextContent {
  type: "text"
  text: string
}

export interface ToolFileContent {
  type: "file"
  uri: string
  mime: string
  name?: string
}

export type ToolContent = ToolTextContent | ToolFileContent

export type ToolResultValue =
  | { type: "json"; value: unknown }
  | { type: "text"; value: unknown }
  | { type: "error"; value: unknown }
  | { type: "content"; value: ToolContent[] }

/** Model-visible result of a tool call, carried by a role:"tool" message. */
export interface ToolResultPart {
  type: "tool-result"
  id: string
  name: string
  result: ToolResultValue
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
}

export type ContentPart =
  | TextPart
  | MediaPart
  | ToolCallPart
  | ToolResultPart
  | ReasoningPart

/**
 * One entry of the outbound transcript. Instances may be Effect Schema class
 * objects; the pipeline treats them structurally and always replaces array
 * slots instead of deep-mutating stored messages.
 */
export interface WireMessage {
  id?: string
  role: MessageRole
  content: ContentPart[]
  metadata?: Record<string, unknown>
}

/** Flattens a tool result value to the text the model effectively sees. */
export function toolResultToText(value: ToolResultValue): string {
  switch (value.type) {
    case "text":
      return typeof value.value === "string" ? value.value : JSON.stringify(value.value) ?? String(value.value)
    case "json":
      try {
        return JSON.stringify(value.value) ?? String(value.value)
      } catch {
        return String(value.value)
      }
    case "error":
      try {
        return JSON.stringify(value.value) ?? String(value.value)
      } catch {
        return String(value.value)
      }
    case "content":
      return value.value
        .map((item) => (item.type === "text" ? item.text : `[file:${item.mime}]`))
        .join("\n")
  }
}

export function makeToolResultReplacement(text: string): ToolResultValue {
  return { type: "text", value: text }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
