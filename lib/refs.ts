/**
 * Stable boundary-ID system. Every transcript message gets a short alias
 * (`m0001`, `m0002`, ...) that the model uses as compress boundaries;
 * compressed blocks are addressed as `b1`, `b2`, ...
 *
 * Refs are allocated per session and persist for the session lifetime so the
 * model sees stable IDs across requests.
 */

const MESSAGE_REF_REGEX = /^m(\d{4})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
export const MESSAGE_ID_TAG_NAME = "dcp-message-id"

const MESSAGE_REF_WIDTH = 4
const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 9999

export function formatMessageRef(index: number): string {
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
    throw new Error(`Message ref index out of bounds: ${index}. Supported range is 1-${MESSAGE_REF_MAX_INDEX}.`)
  }
  return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`
}

export function formatBlockRef(blockId: number): string {
  if (!Number.isInteger(blockId) || blockId < 1) throw new Error(`Invalid block ID: ${blockId}`)
  return `b${blockId}`
}

export function parseMessageRef(ref: string): number | null {
  const match = ref.trim().toLowerCase().match(MESSAGE_REF_REGEX)
  if (!match) return null
  const index = Number.parseInt(match[1]!, 10)
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) return null
  return index
}

export function parseBlockRef(ref: string): number | null {
  const match = ref.trim().toLowerCase().match(BLOCK_REF_REGEX)
  if (!match) return null
  const id = Number.parseInt(match[1]!, 10)
  return Number.isInteger(id) ? id : null
}

export function formatMessageIdTag(ref: string): string {
  return `\n<${MESSAGE_ID_TAG_NAME}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

/** Bidirectional alias registry, JSON-serializable for persistence. */
export interface RefRegistryJson {
  byKey: Record<string, string>
  byRef: Record<string, string>
  next: number
}

export class RefRegistry {
  readonly byKey = new Map<string, string>()
  readonly byRef = new Map<string, string>()
  next = 1

  static from(json: RefRegistryJson | undefined): RefRegistry {
    const registry = new RefRegistry()
    if (!json) return registry
    for (const [key, ref] of Object.entries(json.byKey ?? {})) registry.byKey.set(key, ref)
    for (const [ref, key] of Object.entries(json.byRef ?? {})) registry.byRef.set(ref, key)
    registry.next = Number.isInteger(json.next) && json.next >= 1 ? json.next : 1
    return registry
  }

  toJSON(): RefRegistryJson {
    return {
      byKey: Object.fromEntries(this.byKey),
      byRef: Object.fromEntries(this.byRef),
      next: this.next,
    }
  }

  /** Returns the existing ref for a key or allocates the next free one. */
  ensure(key: string): string {
    const existing = this.byKey.get(key)
    if (existing) return existing
    let candidate = Math.max(MESSAGE_REF_MIN_INDEX, this.next)
    while (candidate <= MESSAGE_REF_MAX_INDEX) {
      const ref = formatMessageRef(candidate)
      if (!this.byRef.has(ref)) {
        this.next = candidate + 1
        this.byKey.set(key, ref)
        this.byRef.set(ref, key)
        return ref
      }
      candidate++
    }
    throw new Error(
      `DCP message alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} refs in one session.`,
    )
  }

  keyOf(ref: string): string | undefined {
    return this.byRef.get(ref)
  }

  refOf(key: string): string | undefined {
    return this.byKey.get(key)
  }
}
