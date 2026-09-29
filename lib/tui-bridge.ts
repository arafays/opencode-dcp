import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Bridge between the server-side plugin and its TUI companion (`tui.tsx`).
 *
 * The OpenCode TUI loads plugin TUI modules client-side, where
 * `ctx.storage.store(key)` is a JSON file at
 * `<XDG_STATE_HOME>/opencode/<channel>/tui/plugin.<id>.<key>.json` that is
 * fs-watched and hot-reloaded into a reactive Solid store. This module writes
 * our stats snapshot to that exact location (atomic tmp+rename so watchers
 * never observe partial JSON), giving the panel live per-session numbers.
 *
 * The server does not know the TUI channel name ("beta", "local", ...), so we
 * write to every existing channel directory that has a `tui/` subdir. Extra
 * files in unused channels are harmless.
 */

export interface CompressionEventRecord {
  at: number;
  blockId: number;
  topic: string;
  ranges: number;
  messagesCovered: number;
  /** Tool outputs swallowed by this compression (absent in older snapshots). */
  toolsCovered?: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

export interface DispatchMetrics {
  at: number;
  agent?: string;
  model?: string;
  messagesIn: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Context window the dispatch was measured against; absent when unknown. */
  contextLimit?: number;
}

export interface SessionTotals {
  dispatches: number;
  compressRuns: number;
  blocksActive: number;
  blocksTotal: number;
  /** Estimated tokens of original content replaced by active block summaries. */
  blockTokensCovered: number;
  /** Estimated tokens spent on the active summaries themselves. */
  blockTokensSummaries: number;
  /** Estimated tokens reclaimed by tool-output pruning (cumulative). */
  prunedTokensTotal: number;
  messagesCompressedActive: number;
}

export interface SessionStatsSnapshot {
  sessionId: string;
  updatedAt: number;
  model?: string;
  lastDispatch?: DispatchMetrics & { savedTokens: number; savedPercent: number };
  totals: SessionTotals;
  recentCompressions: CompressionEventRecord[];
}

export interface TuiStatsSnapshot {
  version: 1;
  generatedAt: number;
  sessions: Record<string, SessionStatsSnapshot>;
}

// Must match the file the TUI companion watches: its plugin context derives
// storage keys as `plugin.<id>.<key>` from its definition id ("opencode.dcp.
// tui") and store key ("stats"). A mismatch means a live panel reading an
// empty file forever.
export const TUI_STATS_KEY = "plugin.opencode.dcp.tui.stats";
/** Cap for the per-session compression history (persisted state and snapshots). */
export const MAX_RECENT_COMPRESSIONS = 10;

/**
 * Characters per token in {@link estimateTokens}'s heuristic. Kept as a named
 * constant because the media allowances below are defined in *characters* so
 * that a flat per-item token cost survives the division.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Tokens charged for one media item, independent of how many bytes encode it.
 *
 * Providers bill media by content geometry, not encoded size: Anthropic
 * charges `(width * height) / 750` for an image (so a 1568px longest edge -
 * their documented maximum - costs ~1,600 tokens) and OpenAI high detail tops
 * out around 2,355, while the wire form we see is 4/3 of the raw file and
 * completely unbounded. Measuring the encoded bytes at 4 chars/token is what
 * let a single 4,028,684-char screenshot read as 1,007,200 "tokens" (96% of a
 * 1,048,576-token window) when the provider actually billed 119,300 tokens
 * (11%) for the whole prompt - the model then pruned in a runaway loop.
 *
 * Audio is billed per second (~32 tokens/second on Gemini) and video as audio
 * plus per-frame tiles, so both get allowances orders of magnitude above an
 * image; a flat figure is still the right shape for them here because the wire
 * form carries no duration. `pdf` extrapolates the usual ~300 tokens/page
 * density to a ~25-page document. `text` is deliberately zero: base64 is only
 * 1.33x the decoded text, so the ordinary chars/token estimate stays within a
 * third of the truth and no special case is needed. `other` (undeclared and
 * `application/octet-stream` payloads) lands at roughly two images.
 *
 * Erring high is deliberate. This feeds the context-pressure gate, where an
 * under-estimate overflows the window; the residual error is capped at a few
 * thousand tokens per item instead of millions.
 */
const MEDIA_TOKEN_ALLOWANCE = {
  image: 1_600,
  audio: 25_000,
  video: 100_000,
  pdf: 8_000,
  text: 0,
  other: 4_000,
} as const;

type MediaKind = keyof typeof MEDIA_TOKEN_ALLOWANCE;

/**
 * Media kind from a MIME type. Mirrors `Media.kindOf` in the OpenCode V2 AI
 * package (`packages/ai/src/media.ts`), splitting its `document` bucket into
 * `pdf` and `text` so encoded text keeps the chars/token estimate.
 */
function mediaKindOf(mediaType: string | undefined): MediaKind {
  if (typeof mediaType !== "string") return "other";
  const lower = mediaType.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  if (lower === "application/pdf") return "pdf";
  if (lower.startsWith("text/")) return "text";
  return "other";
}

/** Character cost of one media item, matching {@link CHARS_PER_TOKEN}. */
function mediaAllowanceChars(kind: MediaKind): number {
  return MEDIA_TOKEN_ALLOWANCE[kind] * CHARS_PER_TOKEN;
}

const DATA_URI_PREFIX = "data:";
/** Longest MIME header a `data:` URI is scanned for; bounds the parse. */
const DATA_URI_MIME_SCAN = 64;

/**
 * Flat media allowance for a `data:<mime>[;...];base64,<payload>` URI, or `-1`
 * when the string is not one (or is a `text/*` payload, which is priced as
 * text). Allocation-free apart from one MIME-sized slice, and O(1) on the
 * common non-`data:` string because of the length and first-char guards.
 *
 * This is what catches `Tool.FileContent.uri` - the Read tool
 * (`packages/core/src/tool/plugin/read.ts`), MCP tool results
 * (`packages/core/src/tool/mcp.ts`, `.../plugin/mcp-resource.ts`) and codemode
 * file results (`packages/core/src/codemode/tool.ts`) all inline media as a
 * data URI under that field.
 */
function dataUriAllowanceChars(value: string): number {
  if (value.length <= DATA_URI_PREFIX.length) return -1;
  if (value.charCodeAt(0) !== 100 /* d */ || !value.startsWith(DATA_URI_PREFIX)) return -1;
  const start = DATA_URI_PREFIX.length;
  const limit = Math.min(value.length, start + DATA_URI_MIME_SCAN);
  let end = start;
  while (end < limit) {
    const code = value.charCodeAt(end);
    if (code === 59 /* ; */ || code === 44 /* , */) break;
    end += 1;
  }
  const kind = mediaKindOf(value.slice(start, end));
  return kind === "text" ? -1 : mediaAllowanceChars(kind);
}

/**
 * Cheap token estimate (~4 chars/token) for display-only deltas and as the
 * always-available floor of the context-nudge gate (see `injectNudges`).
 * Media is already folded into the character total by
 * {@link measureMessagesChars} as a flat per-item allowance.
 */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
}

/**
 * Sums the size of the outbound wire transcript without copying it. Media
 * payloads are charged a flat per-item allowance instead of their encoded
 * length; see {@link MEDIA_TOKEN_ALLOWANCE}.
 */
export function measureMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    total += measurePartChars(record);
  }
  return total;
}

function measurePartChars(value: unknown): number {
  if (typeof value === "string") {
    const media = dataUriAllowanceChars(value);
    return media < 0 ? value.length : media;
  }
  if (typeof value !== "object" || value === null) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += measurePartChars(item);
    return total;
  }
  // Typed arrays are raw bytes, not characters, and `Object.values` over one
  // allocates an entry per byte - a 4MB image would be a 4-million-element
  // walk on every dispatch. The owning media node already charged the
  // allowance, and a bare typed array has no character cost.
  if (ArrayBuffer.isView(value)) return 0;
  return measureObjectChars(value as Record<string, unknown>);
}

/**
 * Sums an object's own enumerable fields, skipping `skipKey` (the field that
 * carries a media payload the caller already charged).
 */
function measureFields(record: Record<string, unknown>, skipKey: string | undefined): number {
  const keys = Object.keys(record);
  let total = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || key === skipKey) continue;
    total += measurePartChars(record[key]);
  }
  return total;
}

function measureObjectChars(record: Record<string, unknown>): number {
  const type = record["type"];
  // Media is charged where the bytes actually live, so the wrappers around it
  // (`MediaPart` -> `Media.Asset` -> `Media.Source`) walk normally and never
  // double-charge on the way down.
  if (type === "media" && record["data"] !== undefined) {
    // Legacy flattened form `{ type, mediaType, data }`. NOT the current wire
    // shape (see `MediaPart` in lib/types.ts, which nests `media.source`) -
    // kept because transcripts persisted by older builds still carry it.
    const kind = mediaKindOf(asString(record["mediaType"]));
    return mediaAllowanceChars(kind) + measureFields(record, "data");
  }
  // `Media.Source` (packages/ai/src/media.ts): `bytes` and `base64` own the
  // payload, `url` and `ref` are handles the provider still materializes.
  // Requiring the same-named companion field keeps ordinary `type`-tagged
  // objects from matching.
  if ((type === "bytes" || type === "base64") && record["data"] !== undefined) {
    const kind = mediaKindOf(asString(record["mediaType"]));
    return mediaAllowanceChars(kind) + measureFields(record, "data");
  }
  if (type === "url" && typeof record["url"] === "string") {
    const kind = mediaKindOf(asString(record["mediaType"]));
    return mediaAllowanceChars(kind) + measureFields(record, undefined);
  }
  if (type === "ref" && typeof record["id"] === "string") {
    const kind = mediaKindOf(asString(record["mediaType"]));
    return mediaAllowanceChars(kind) + measureFields(record, undefined);
  }
  return measureFields(record, undefined);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Builds the next snapshot by merging one dispatch/compression update. */
export function buildStatsSnapshot(
  previous: TuiStatsSnapshot | undefined,
  input: {
    sessionId: string;
    model?: string;
    dispatch?: DispatchMetrics;
    compression?: CompressionEventRecord;
    /**
     * Compression history owned by the persisted session state. The
     * in-memory prior dies with every plugin generation (dist rebuild, server
     * restart) — when provided, it takes precedence over that prior so a
     * fresh generation cannot rewrite the file without the history the TUI
     * companion is still displaying.
     */
    recentCompressions?: CompressionEventRecord[];
    totals: SessionTotals;
  },
): TuiStatsSnapshot {
  const sessions: Record<string, SessionStatsSnapshot> = {};
  for (const [id, entry] of Object.entries(previous?.sessions ?? {})) {
    if (id === input.sessionId) continue;
    sessions[id] = entry;
  }

  const prior = previous?.sessions[input.sessionId];
  const recentCompressions = input.recentCompressions
    ? [...input.recentCompressions]
    : [...(prior?.recentCompressions ?? [])];
  // The caller-provided history already carries records freshly written to
  // the state store; only append when it would otherwise go missing.
  if (input.compression && !recentCompressions.includes(input.compression)) {
    recentCompressions.push(input.compression);
  }
  while (recentCompressions.length > MAX_RECENT_COMPRESSIONS) recentCompressions.shift();

  const lastDispatch =
    input.dispatch === undefined
      ? prior?.lastDispatch
      : {
          ...input.dispatch,
          savedTokens: Math.max(0, input.dispatch.tokensBefore - input.dispatch.tokensAfter),
          savedPercent:
            input.dispatch.tokensBefore > 0
              ? Math.round(
                  ((input.dispatch.tokensBefore - input.dispatch.tokensAfter) /
                    input.dispatch.tokensBefore) *
                    100,
                )
              : 0,
        };

  sessions[input.sessionId] = {
    sessionId: input.sessionId,
    updatedAt: Date.now(),
    model: input.model ?? prior?.model,
    lastDispatch,
    totals: input.totals,
    recentCompressions,
  };

  return { version: 1, generatedAt: Date.now(), sessions };
}

/**
 * Directories `<stateRoot>/opencode/<channel>/tui` that exist. The state root
 * defaults to the XDG state home; overridable for tests.
 */
export function resolveTuiStateDirs(stateRoot?: string): string[] {
  const root =
    stateRoot ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const appDir = path.join(root, "opencode");
  let channels: string[];
  try {
    channels = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const targets: string[] = [];
  for (const channel of channels) {
    const tuiDir = path.join(appDir, channel, "tui");
    try {
      mkdirSync(tuiDir, { recursive: true });
      targets.push(tuiDir);
    } catch {
      // Unwritable channel dir: skip.
    }
  }
  return targets;
}

/** Writes the snapshot atomically to every TUI storage directory. Never throws. */
export function writeTuiStats(snapshot: TuiStatsSnapshot, stateRoot?: string): void {
  const payload = JSON.stringify(snapshot);
  for (const dir of resolveTuiStateDirs(stateRoot)) {
    const finalPath = path.join(dir, `${TUI_STATS_KEY}.json`);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, payload, "utf8");
      renameSync(tmpPath, finalPath);
    } catch {
      // Display-only bridge: a failed write is silently ignored.
    }
  }
}
