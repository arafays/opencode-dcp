/**
 * Stable boundary-ID system. Every transcript message gets a short alias
 * (`m0001`, `m0002`, ...) that the model uses as compress boundaries;
 * compressed blocks are addressed as `b1`, `b2`, ...
 *
 * The alias table is a PER-DISPATCH PROJECTION of the visible transcript, not
 * a session-long allocator: every dispatch rebuilds it from the inbound key
 * list in transcript order (`RefRegistry.project`), so the `mNNNN` the model
 * reads are always dense from `m0001` and strictly increasing in transcript
 * order. The model treats a lower number as "earlier" and selects ranges by
 * comparing the two numbers it sees; a session-long allocator could not
 * honour that, because every compression frees the low slots and the next
 * new message is handed `m0001` again while the survivors keep high numbers
 * (the production shape was `... m0259, m0194, m0196 ...`, which made the
 * model emit inverted ranges like `m0006..m0129` and give up pruning).
 *
 * Appends between compressions are renumbered, never renumbered *around*: a
 * new message lands at the tail, so every existing key keeps its ref and the
 * prompt-cache prefix stays byte-identical. Compression is the only event that
 * shifts the table, and that is exactly when the model is shown fresh tags.
 */

const MESSAGE_REF_REGEX = /^m(\d{4})$/;
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/;
export const MESSAGE_ID_TAG_NAME = "dcp-message-id";

const MESSAGE_REF_WIDTH = 4;
const MESSAGE_REF_MIN_INDEX = 1;
export const MESSAGE_REF_MAX_INDEX = 9999;

export function formatMessageRef(index: number): string {
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
    throw new Error(
      `Message ref index out of bounds: ${index}. Supported range is 1-${MESSAGE_REF_MAX_INDEX}.`,
    );
  }
  return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`;
}

export function formatBlockRef(blockId: number): string {
  if (!Number.isInteger(blockId) || blockId < 1) throw new Error(`Invalid block ID: ${blockId}`);
  return `b${blockId}`;
}

export function parseMessageRef(ref: string): number | null {
  const match = ref.trim().toLowerCase().match(MESSAGE_REF_REGEX);
  if (!match) return null;
  const index = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX)
    return null;
  return index;
}

export function parseBlockRef(ref: string): number | null {
  const match = ref.trim().toLowerCase().match(BLOCK_REF_REGEX);
  if (!match) return null;
  const id = Number.parseInt(match[1]!, 10);
  return Number.isInteger(id) ? id : null;
}

export function formatMessageIdTag(ref: string): string {
  return `\n<${MESSAGE_ID_TAG_NAME}>${ref}</${MESSAGE_ID_TAG_NAME}>`;
}

/** Bidirectional alias registry, JSON-serializable for persistence. */
export interface RefRegistryJson {
  byKey: Record<string, string>;
  byRef: Record<string, string>;
  next: number;
}

export class RefRegistry {
  readonly byKey = new Map<string, string>();
  readonly byRef = new Map<string, string>();
  /** One past the highest index currently allocated (informational). */
  next = MESSAGE_REF_MIN_INDEX;

  /**
   * Rebuilds the alias table from the visible transcript keys **in transcript
   * order**: the first key becomes `m0001`, the second `m0002`, and so on.
   *
   * This is the only sound way to number a transcript, and the one the
   * context hook uses on every dispatch. Duplicate keys keep their first
   * position. Keys past `MESSAGE_REF_MAX_INDEX` are left unaliased (they get
   * no boundary tag, so the model cannot address them) instead of throwing:
   * a >9 999 message transcript must degrade, not fail the dispatch.
   *
   * @returns how many keys were left unaliased (0 in normal operation).
   */
  project(keys: Iterable<string>): number {
    this.byKey.clear();
    this.byRef.clear();
    let index = MESSAGE_REF_MIN_INDEX;
    let overflow = 0;
    for (const key of keys) {
      // First position wins: a repeated key must not claim a second slot or
      // emit a second, conflicting tag.
      if (this.byKey.has(key)) continue;
      if (index > MESSAGE_REF_MAX_INDEX) {
        overflow += 1;
        continue;
      }
      const ref = formatMessageRef(index);
      this.byKey.set(key, ref);
      this.byRef.set(ref, key);
      index += 1;
    }
    this.next = index;
    return overflow;
  }

  /**
   * Drops the alias of each given key (unknown keys are a no-op). Pure map
   * surgery: it deliberately has NO effect on how the next alias is chosen.
   * Compression calls this for every covered key, and the next dispatch
   * re-projects the surviving transcript anyway, so the freed slots are only
   * ever reused by an explicit `project`.
   */
  release(keys: Iterable<string>): void {
    for (const key of keys) {
      const ref = this.byKey.get(key);
      if (!ref) continue;
      this.byKey.delete(key);
      this.byRef.delete(ref);
    }
  }

  keyOf(ref: string): string | undefined {
    return this.byRef.get(ref);
  }

  /**
   * Restores a persisted table. Tolerant by design: the blob comes from
   * plugin storage and may be absent, pre-`project` (session-long allocator
   * that could have produced inverted refs), or structurally partial. Nothing
   * here throws — unusable entries are dropped, and the first dispatch's
   * `project` overwrites the table with an ordered one regardless.
   */
  static from(json: RefRegistryJson | undefined): RefRegistry {
    const registry = new RefRegistry();
    if (!json || typeof json !== "object") return registry;

    // `byRef` is the direction resolution depends on, so it is loaded first
    // and wins any conflict.
    for (const [ref, key] of entries(json.byRef)) {
      if (!isMessageRef(ref) || !key || registry.byRef.has(ref)) continue;
      registry.byRef.set(ref, key);
      if (!registry.byKey.has(key)) registry.byKey.set(key, ref);
    }
    for (const [key, ref] of entries(json.byKey)) {
      if (!key || !isMessageRef(ref) || registry.byKey.has(key)) continue;
      registry.byKey.set(key, ref);
      if (!registry.byRef.has(ref)) registry.byRef.set(ref, key);
    }
    // `next` is re-derived rather than trusted: a stale (or corrupt) persisted
    // value would otherwise misreport the high-water mark.
    registry.next = onePastHighest(registry.byRef.keys());
    return registry;
  }

  toJSON(): RefRegistryJson {
    return {
      byKey: Object.fromEntries(this.byKey),
      byRef: Object.fromEntries(this.byRef),
      next: this.next,
    };
  }
}

/** `Object.entries` over a string map, tolerating any other shape. */
function entries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out.push([key, entry]);
  }
  return out;
}

function isMessageRef(ref: string): boolean {
  return parseMessageRef(ref) !== null;
}

/** One past the highest parseable ref in an iterable (clamped to the cap). */
function onePastHighest(refs: Iterable<string>): number {
  let highest = 0;
  for (const ref of refs) {
    const index = parseMessageRef(ref);
    if (index !== null && index > highest) highest = index;
  }
  return Math.min(highest + 1, MESSAGE_REF_MAX_INDEX + 1);
}
