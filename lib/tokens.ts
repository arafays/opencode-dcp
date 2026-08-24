/**
 * Token estimate (~4 chars/token) for compression bookkeeping (saved tokens,
 * summary sizes). Not used for authoritative context-usage numbers - those
 * come from provider usage events.
 */
export function countTokens(text: string): number {
  return text ? Math.round(text.length / 4) : 0
}
