import type { DcpOptions } from "./config"
import { ALWAYS_PROTECTED_TOOLS } from "./config"

/**
 * Protection matching: tool-name globs and file-path globs that automatic
 * pruning must never touch. `question`/`edit`/`write`/`patch`/`compress` are
 * always protected on top of user configuration.
 */

export function matchesGlob(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase()
  const normalizedValue = value.trim().toLowerCase()
  if (normalizedPattern.length === 0) return false
  if (normalizedPattern === "*") return true
  const regex = new RegExp(
    `^${normalizedPattern
      .split("*")
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  )
  return regex.test(normalizedValue)
}

export function isToolNameProtected(toolName: string, patterns: string[]): boolean {
  if (ALWAYS_PROTECTED_TOOLS.includes(toolName.toLowerCase())) return true
  return patterns.some((pattern) => matchesGlob(pattern, toolName))
}

const FILE_PATH_KEYS = ["filePath", "file_path", "file", "path", "filename", "notebookPath"]

/**
 * Extracts likely file paths from a tool input. Handles common keys plus
 * shell-style inputs where the first token looks like a path.
 */
export function getFilePathsFromInput(input: unknown): string[] {
  const found: string[] = []
  collect(input, found, 0)
  return found
}

function collect(value: unknown, found: string[], depth: number): void {
  if (depth > 2 || typeof value !== "object" || value === null) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collect(item, found, depth + 1)
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FILE_PATH_KEYS.includes(key) && typeof item === "string") {
      found.push(item)
    } else if (typeof item === "object" && item !== null) {
      collect(item, found, depth + 1)
    }
  }
}

export function isFilePathProtected(paths: string[], patterns: string[]): boolean {
  if (patterns.length === 0 || paths.length === 0) return false
  return paths.some((path) =>
    patterns.some((pattern) => matchesPathGlob(pattern, path)),
  )
}

/** Path glob: `*` within segments, `**` across segments. */
function matchesPathGlob(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.trim().replace(/^\.\//, "")
  const normalizedPath = path.trim()
  const regex = new RegExp(
    `^${normalizedPattern
      .split("**")
      .map((segment) =>
        segment
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  )
  return regex.test(normalizedPath)
}

export interface ProtectionContext {
  config: DcpOptions
}

export function isToolAutoPrunable(
  info: { name: string; input: unknown },
  protection: { dedupePatterns: string[]; purgePatterns: string[]; filePatterns: string[] },
  kind: "dedupe" | "purge",
): boolean {
  const namePatterns = kind === "dedupe" ? protection.dedupePatterns : protection.purgePatterns
  if (isToolNameProtected(info.name, namePatterns)) return false
  const paths = getFilePathsFromInput(info.input)
  if (isFilePathProtected(paths, protection.filePatterns)) return false
  return true
}
