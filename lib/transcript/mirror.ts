import type { TranscriptIndex } from "./scan"

/**
 * Remembers the most recent transcript index per session. The context hook
 * refreshes it on every dispatch; the compress tool reads it at execution
 * time (the transcript barely changes between a dispatch and a tool call in
 * the same turn, and the model can only reference IDs it was shown).
 */
export class TranscriptMirror {
  private readonly latest = new Map<string, TranscriptIndex>()

  update(sessionId: string, index: TranscriptIndex): void {
    this.latest.set(sessionId, index)
  }

  get(sessionId: string): TranscriptIndex | undefined {
    return this.latest.get(sessionId)
  }

  drop(sessionId: string): void {
    this.latest.delete(sessionId)
  }
}
