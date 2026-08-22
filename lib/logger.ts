/** Minimal gated logger. Debug output goes to stderr so it never pollutes model context. */
export interface Logger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
}

export function createLogger(debug: boolean): Logger {
  const write = (level: string, message: string, data?: Record<string, unknown>) => {
    const line = `[dcp] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`
    if (level === "error" || level === "warn") console.error(line)
    else if (debug) console.error(line)
  }
  return {
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    debug: (message, data) => write("debug", message, data),
  }
}
