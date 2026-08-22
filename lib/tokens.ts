import * as anthropicTokenizer from "@anthropic-ai/tokenizer"

const countTokensAnthropic = (
  (anthropicTokenizer as { countTokens?: (text: string) => number }).countTokens ??
    (anthropicTokenizer as unknown as { default?: { countTokens?: (text: string) => number } }).default
      ?.countTokens ??
    null
) as ((text: string) => number) | null

/**
 * Token counting with the Anthropic tokenizer and a length/4 fallback.
 * Used for compression bookkeeping (saved tokens, summary sizes), not for
 * authoritative context-usage numbers - those come from provider usage events.
 */
export function countTokens(text: string): number {
  if (!text) return 0
  if (countTokensAnthropic) {
    try {
      return countTokensAnthropic(text)
    } catch {
      // fall through to the estimate
    }
  }
  return Math.round(text.length / 4)
}

export function estimateTokens(texts: string[]): number {
  if (texts.length === 0) return 0
  return countTokens(texts.join("\n"))
}
