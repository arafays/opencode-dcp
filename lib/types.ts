/**
 * Structural types for the outbound model transcript that OpenCode V2 hands
 * to `ctx.session.hook("context", ...)`.
 *
 * These mirror `@opencode/ai` schema types (`packages/ai/src/schema/messages.ts`)
 * structurally so this plugin does not need a runtime dependency on that package.
 * Plain objects with these exact shapes are what the hook receives and what the
 * pipeline is allowed to substitute back into the array.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface SystemPart {
  type: "text";
  text: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
}

export interface TextPart {
  type: "text";
  text: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: unknown;
}

/**
 * Inline media. Mirrors `@opencode/ai`'s `MediaPart` (packages/ai/src/schema/
 * messages.ts), which nests the payload under a `Media.Asset` rather than
 * flattening `mediaType`/`data` onto the part - the flattened shape is NOT what
 * the hook receives. `measurePartChars` walks `MediaPart -> Asset -> Source`
 * and charges the allowance at the `Source` that owns the bytes, so a wrapper
 * with extra fields still prices correctly.
 */
export interface MediaPart {
  type: "media";
  media: MediaAsset;
  filename?: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: unknown;
}

export interface MediaAsset {
  /** The payload lives here, never inline on the asset. */
  source: MediaSource;
  /** Declared type, sniffed magic bytes, then `application/octet-stream`. */
  mediaType: string;
  kind?: string;
  info?: unknown;
  expiresAt?: number;
  providerMetadata?: unknown;
  headers?: Record<string, string>;
}

/** Tagged union (packages/ai/src/media.ts): the variant owns the bytes. */
export type MediaSource =
  | { type: "bytes"; data: Uint8Array; mediaType: string }
  | { type: "base64"; data: string; mediaType: string }
  /** A handle the provider still materializes; costs a flat allowance. */
  | { type: "url"; url: string; mediaType?: string; expiresAt?: number }
  /** Provider-side handle: OpenAI `file_id`, Gemini file URI, `gs://`, ... */
  | { type: "ref"; provider: string; id: string; mediaType?: string };

/** Assistant-declared tool invocation. */
export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  /**
   * Registry namespace, e.g. the MCP server a tool came from
   * (`packages/core/src/tool/mcp.ts` registers `options.namespace`).
   * {@link qualifiedToolName} folds it into the name the model is shown.
   */
  namespace?: string;
  input: unknown;
  /**
   * The provider ran the tool itself (`google_search`, OpenAI hosted tools).
   * Core's history lowering then emits BOTH the call and its result inside the
   * same assistant message, and the protocol drops the call while replaying the
   * result - so such a result is provider state, never DCP-prunable output.
   */
  providerExecuted?: boolean;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: unknown;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolFileContent {
  type: "file";
  uri: string;
  mime: string;
  name?: string;
}

export type ToolContent = ToolTextContent | ToolFileContent;

export type ToolResultValue =
  | { type: "json"; value: unknown }
  | { type: "text"; value: unknown }
  | { type: "error"; value: unknown }
  | { type: "content"; value: ToolContent[] };

/** Model-visible result of a tool call, carried by a role:"tool" message. */
export interface ToolResultPart {
  type: "tool-result";
  id: string;
  name: string;
  namespace?: string;
  result: ToolResultValue;
  providerExecuted?: boolean;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: unknown;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  /**
   * Reasoning signature replayed verbatim when the provider keys it here rather
   * than in `providerMetadata` (Bedrock Converse,
   * packages/ai/src/protocols/bedrock-converse.ts:262). DCP never rewrites a
   * reasoning part, so this only has to survive copy-on-write edits.
   */
  encrypted?: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: unknown;
}

/**
 * A provider-generated context checkpoint (`CompactionPart` in
 * packages/ai/src/schema/messages.ts). Exactly one of `encrypted` (OpenAI
 * Responses checkpoint) or `text` (Anthropic compaction block) is present, and
 * the payload is provider state that only the originating provider can replay
 * - it is never summarizable text and never prunable tool output, but it IS
 * billed as input, so it must be measured like any other part.
 */
export interface CompactionPart {
  type: "compaction";
  provider: string;
  id?: string;
  encrypted?: string;
  /** Null means the provider failed to produce a summary; history is retained. */
  text?: string | null;
}

/** Reasoning-effort change marker (`Message.effort`), a role:"system" message. */
export interface EffortPart {
  type: "effort";
  effort?: string;
  previous?: string;
}

export type ContentPart =
  | TextPart
  | MediaPart
  | ToolCallPart
  | ToolResultPart
  | ReasoningPart
  | CompactionPart
  | EffortPart;

/**
 * The name a tool is addressed by in the transcript.
 *
 * OpenCode flattens a namespace into the tool's own name before the model ever
 * sees it: core's registry key is `effectiveName(tool)` =
 * `${namespace}_${normalizedName}` (packages/core/src/tool/runtime.ts:278), and
 * the AI layer joins the same way when lowering a request that kept its
 * namespaces (`flattenToolRequest`, packages/ai/src/protocols/shared.ts:308).
 * The wire form is therefore normally `name` alone with `namespace` absent,
 * but a route that keeps namespaces natively (OpenAI Responses) echoes a leaf
 * `name` plus `namespace`. Joining here reproduces the platform's own spelling
 * in both cases, so name-based matching (protection globs, dedupe signatures)
 * stays unambiguous when two tools share a leaf name across namespaces.
 */
export function qualifiedToolName(name: string, namespace?: string): string {
  return namespace === undefined || namespace === "" ? name : `${namespace}_${name}`;
}

/**
 * One entry of the outbound transcript. Instances may be Effect Schema class
 * objects; the pipeline treats them structurally and always replaces array
 * slots instead of deep-mutating stored messages.
 */
export interface WireMessage {
  id?: string;
  role: MessageRole;
  content: ContentPart[];
  metadata?: Record<string, unknown>;
  /**
   * Model-scoped provider state carried by the whole message (Gemini thought
   * signatures, OpenAI item ids). Replayable only against the model that
   * produced it. Every DCP edit is a `{ ...message, content }` copy, so this
   * survives rewrites; it is declared because copy-on-write edits must never
   * silently drop a field the provider needs.
   */
  providerMetadata?: unknown;
  /** Uninterpreted provider payload replayed verbatim. */
  native?: Record<string, unknown>;
}

/** Flattens a tool result value to the text the model effectively sees. */
export function toolResultToText(value: ToolResultValue): string {
  switch (value.type) {
    case "text":
      return typeof value.value === "string"
        ? value.value
        : (JSON.stringify(value.value) ?? String(value.value));
    case "json":
      try {
        return JSON.stringify(value.value) ?? String(value.value);
      } catch {
        return String(value.value);
      }
    case "error":
      try {
        return JSON.stringify(value.value) ?? String(value.value);
      } catch {
        return String(value.value);
      }
    case "content":
      return value.value
        .map((item) => (item.type === "text" ? item.text : `[file:${item.mime}]`))
        .join("\n");
  }
}

export function makeToolResultReplacement(text: string): ToolResultValue {
  return { type: "text", value: text };
}
