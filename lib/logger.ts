import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Debug logger writing into opencode's own log file (~/.local/share/opencode/log/opencode.log),
 * mirroring its structured line format (`timestamp=… level=… run=… message=…`), so plugin output
 * lands wherever `tail -f ~/.local/share/opencode/log/opencode.log` already looks. Plugin
 * `console.error` is invisible in normal TUI runs (the background server's stderr is discarded),
 * and the promise plugin API exposes no logger — this is the sanctioned destination.
 * If the write fails, falls back to stderr so output is never silently dropped.
 */
export interface Logger {
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// opencode-v2 packages/util/src/global.ts: `log: path.join(data, "log")` where data is the XDG
// data dir for "opencode".
function opencodeLogDir(): string {
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");
  return path.join(data, "opencode", "log");
}

// Same value-shape rule as opencode's formatter (logging.ts): bare word when it can't be
// misparsed, JSON string otherwise.
function format(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return /^[^\s="\\]+$/.test(str) ? str : JSON.stringify(str);
}

function line(level: string, message: string, data?: Record<string, unknown>): string {
  const parts = [
    `timestamp=${new Date().toISOString()}`,
    `level=${level}`,
    "component=dcp",
    `message=${format(message)}`,
  ];
  if (data) for (const [key, value] of Object.entries(data)) parts.push(`${key}=${format(value)}`);
  return `${parts.join(" ")}\n`;
}

export function createLogger(debug: boolean): Logger {
  const write = (level: "WARN" | "DEBUG", message: string, data?: Record<string, unknown>) => {
    const text = line(level, message, data);
    try {
      fs.mkdirSync(opencodeLogDir(), { recursive: true });
      // appendFileSync opens with O_APPEND: atomic tail-append next to opencode's own writer.
      fs.appendFileSync(path.join(opencodeLogDir(), "opencode.log"), text);
    } catch {
      try {
        process.stderr.write(text);
      } catch {
        // never let logging break the plugin
      }
    }
  };
  return {
    warn: (message, data) => write("WARN", message, data),
    debug: (message, data) => {
      if (debug) write("DEBUG", message, data);
    },
  };
}
