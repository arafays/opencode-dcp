/** Minimal gated logger. Debug output goes to stderr so it never pollutes model context. */
export interface Logger {
  warn(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
}

export function createLogger(debug: boolean): Logger {
  const write = (message: string, data?: Record<string, unknown>) => {
    console.error(`[dcp] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`)
  }
  return {
    warn: write,
    debug: (message, data) => {
      if (debug) write(message, data)
    },
  }
}
