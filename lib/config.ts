import type { PluginOptions } from "@opencode-ai/plugin"

export type LimitValue = number | string

export interface DcpOptions {
  /** Master switch. When false the plugin registers nothing. */
  enabled: boolean
  /** Verbose debug logging to stderr. */
  debug: boolean
  /** Allow DCP to run inside sub-agent sessions (default: main sessions only). */
  allowSubAgents: boolean
  /**
   * Context usage that arms the compress nudge. Numbers (or numeric strings like
   * "70000") are absolute tokens; strings ending in % ("70%") are relative to
   * the model context window.
   */
  maxContextLimit: LimitValue
  /** Rate limiter: minimum transcript messages between two context nudges. */
  nudgeFrequency: number
  /** Inject an iteration nudge after this many messages since the last user turn (0 disables). */
  iterationNudgeThreshold: number
  /**
   * Tool names (glob, e.g. "mcp*") whose outputs must never be pruned by any strategy.
   * question/edit/write/patch are always protected.
   */
  protectedTools: string[]
  /** File-path globs; tool calls touching matching paths are never pruned automatically. */
  protectedFilePatterns: string[]
  /** TUI companion panel (enabled by default; renders in the OpenCode TUI). */
  tui: {
    enabled: boolean
  }
  /** Automatic strategies configuration. */
  strategies: {
    deduplication: {
      enabled: boolean
      protectedTools: string[]
    }
    purgeErrors: {
      enabled: boolean
      /** Prune errored tool calls older than this many turns. */
      turns: number
      protectedTools: string[]
    }
  }
}

const DEFAULTS: DcpOptions = {
  enabled: true,
  debug: false,
  allowSubAgents: false,
  maxContextLimit: "70%",
  nudgeFrequency: 5,
  iterationNudgeThreshold: 0,
  protectedTools: [],
  protectedFilePatterns: [],
  tui: { enabled: true },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
  },
}

/** Tools whose outputs are never pruned - they carry decisions or user intent. */
export const ALWAYS_PROTECTED_TOOLS = ["question", "edit", "write", "patch", "compress"]

function isLimitShape(value: unknown): value is LimitValue {
  return (
    (typeof value === "number" && Number.isFinite(value) && value > 0) ||
    // Accepts "70%", "70", and decimal forms like "70.5%"; a bare numeric
    // string is treated as absolute tokens, not a percentage.
    (typeof value === "string" && /^\d+(\.\d+)?%?$/.test(value))
  )
}

function mergeLimit(value: unknown, fallback: LimitValue): LimitValue {
  return isLimitShape(value) ? value : fallback
}

function mergeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

/**
 * Resolves plugin options from the `plugins: [{ package, options }]` config entry.
 * Unknown keys produce a warning; malformed values fall back to defaults per-key.
 */
export function resolveOptions(options: PluginOptions | undefined, warn: (msg: string) => void): DcpOptions {
  const input = (options ?? {}) as Record<string, unknown>
  const known = new Set([
    "enabled",
    "debug",
    "allowSubAgents",
    "maxContextLimit",
    "nudgeFrequency",
    "iterationNudgeThreshold",
    "protectedTools",
    "protectedFilePatterns",
    "tui",
    "strategies",
  ])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warn(`unknown option "${key}" will be ignored`)
  }

  const strategiesInput = (input.strategies ?? {}) as Record<string, Record<string, unknown>>
  const dedupeInput = strategiesInput.deduplication ?? {}
  const purgeInput = strategiesInput.purgeErrors ?? {}
  if (input.tui !== undefined && (typeof input.tui !== "object" || input.tui === null)) {
    warn(`option "tui" must be an object like { "enabled": false }; invalid value ignored`)
  }
  if (input.maxContextLimit !== undefined && !isLimitShape(input.maxContextLimit)) {
    warn(
      `option "maxContextLimit" must be a positive number, a numeric string (e.g. 70000 or "70000"), or a "NN%" string (e.g. "70%"); ` +
        `invalid value ${JSON.stringify(input.maxContextLimit)} ignored, default ${JSON.stringify(DEFAULTS.maxContextLimit)} used`,
    )
  }
  const tuiInput = (
    typeof input.tui === "object" && input.tui !== null ? input.tui : {}
  ) as Record<string, unknown>

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
    debug: typeof input.debug === "boolean" ? input.debug : DEFAULTS.debug,
    allowSubAgents:
      typeof input.allowSubAgents === "boolean" ? input.allowSubAgents : DEFAULTS.allowSubAgents,
    maxContextLimit: mergeLimit(input.maxContextLimit, DEFAULTS.maxContextLimit),
    nudgeFrequency:
      typeof input.nudgeFrequency === "number" && input.nudgeFrequency >= 1
        ? Math.floor(input.nudgeFrequency)
        : DEFAULTS.nudgeFrequency,
    iterationNudgeThreshold:
      typeof input.iterationNudgeThreshold === "number" && input.iterationNudgeThreshold >= 0
        ? Math.floor(input.iterationNudgeThreshold)
        : DEFAULTS.iterationNudgeThreshold,
    protectedTools: mergeStringArray(input.protectedTools) ?? DEFAULTS.protectedTools,
    protectedFilePatterns: mergeStringArray(input.protectedFilePatterns) ?? DEFAULTS.protectedFilePatterns,
    tui: {
      enabled: typeof tuiInput.enabled === "boolean" ? tuiInput.enabled : DEFAULTS.tui.enabled,
    },
    strategies: {
      deduplication: {
        enabled: typeof dedupeInput.enabled === "boolean" ? dedupeInput.enabled : true,
        protectedTools: mergeStringArray(dedupeInput.protectedTools) ?? [],
      },
      purgeErrors: {
        enabled: typeof purgeInput.enabled === "boolean" ? purgeInput.enabled : true,
        turns:
          typeof purgeInput.turns === "number" && purgeInput.turns >= 1 ? Math.floor(purgeInput.turns) : 4,
        protectedTools: mergeStringArray(purgeInput.protectedTools) ?? [],
      },
    },
  }
}

/** Resolves a number, "NN%" or numeric-string limit against a model context window size. */
export function resolveLimit(value: LimitValue, contextWindow: number): number {
  if (typeof value === "number") return Math.round(value)
  if (value.endsWith("%")) {
    const pct = Number.parseFloat(value)
    if (Number.isFinite(pct)) return Math.round((pct / 100) * contextWindow)
    return contextWindow
  }
  // Bare numeric string ("70000") is absolute tokens, not a percentage.
  const tokens = Number.parseFloat(value)
  return Number.isFinite(tokens) ? Math.round(tokens) : contextWindow
}
