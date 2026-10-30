# opencode-dcp

Dynamic Context Pruning (DCP) for **OpenCode V2** — the official OpenCode release.

Keeps the model's context window high-signal by letting the model compress closed
sections of the conversation into dense technical summaries, pruning superseded
tool outputs, and nudging when context pressure crosses a budget.

Requires [OpenCode V2](https://opencode.ai/v2/docs).

## Install

```sh
opencode plugin add opencode-dcp
```

This installs the package into OpenCode's plugin cache and registers its server
entrypoint in your global config. The TUI companion loads automatically; no
extra step is needed.

To configure it in a project, add it to `opencode.jsonc` (or
`.opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-dcp",
      "options": {
        "maxContextLimit": "70%"
      }
    }
  ]
}
```

## What it does

DCP transforms only the outbound transcript sent to the model; stored session
history is never modified.

- **Compression** — the model calls `prune` to replace closed conversation
  sections with dense summaries. Ranges are addressed by boundary IDs (`m0001…`
  for messages, `b1…` for compressed blocks).
- **Tool-output pruning** — superseded and errored tool outputs are replaced
  with short placeholders. Protected tools are never touched.
- **Context nudges** — when usage crosses `maxContextLimit`, the model is
  reminded to prune. Reminders quote both the pruning budget and the model
  window, and a completed prune is acknowledged on the next dispatch.
- **TUI panel** — a companion panel shows live savings, a prune summary card,
  and a per-session compression report.

The model drives pruning itself with the `prune` tool. It selects non-overlapping
ranges and writes one dense summary per range. A range may cover previously
pruned blocks: including `(bN)` carries that block's content forward; omitting it
drops the block from context. Deduplication and error-purge strategies run at
compression time so idle sessions keep a stable prompt-cache prefix. State is
scoped per session and survives restarts.

## TUI panel

The companion TUI module is enabled by default and shows:

- **Prompt footer status** — live outbound-token savings from the last dispatch
  (`DCP −38% · 8.1k pruned`), or the measured window pressure while no blocks
  are active (`DCP idle · 62% of window`).
- **Prune summary card** — appears when a compression lands and auto-hides after
  30 seconds. Shows cumulative savings, context usage, and the pruned section's
  before/after sizes.
- **Compression report** — per-session totals, last-dispatch delta, cumulative
  savings, and recent compression events. Open it from the command palette
  (`DCP: compression report`) or pin the summary card with
  `DCP: toggle prune summary card`.

Disable the panel with:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-dcp",
      "options": { "tui": { "enabled": false } }
    }
  ]
}
```

## Commands

| Command | Effect |
| ------- | ------ |
| `/dcp-prune [focus]` | Instructs the model to run a pruning pass now |

## Options

All optional (defaults shown):

```jsonc
{
  "enabled": true,
  "debug": false,
  "allowSubAgents": false,          // run inside sub-agent sessions
  "maxContextLimit": 70000,         // absolute tokens, or "NN%" of the model window
  "nudgeFrequency": 5,              // min messages between nudges
  "iterationNudgeThreshold": 0,     // messages since last user turn before an iteration nudge (0 = off)
  "protectedTools": [],             // globs never auto-pruned ("mcp*")
  "protectedFilePatterns": [],      // path globs never auto-pruned ("secrets/**")
  "tui": { "enabled": true },       // companion TUI panel (stats + report)
  "strategies": {
    "deduplication": { "enabled": true, "protectedTools": [] },
    "purgeErrors":   { "enabled": true, "turns": 4, "protectedTools": [] }
  }
}
```

Permissions: the tool's permission action is `prune`; gate it with normal V2
permission rules (`{ "action": "prune", "effect": "allow" }`).

## License

MIT. See [LICENSE](./LICENSE).
