# opencode-dcp

Dynamic Context Pruning (DCP) for **OpenCode V2**.

Keeps the model's context window high-signal by letting the model compress closed
sections of the conversation into its own dense technical summaries, pruning
superseded tool outputs, and nudging when context pressure crosses a budget.

> Requires OpenCode V2 (`opencode2`). The plugin API is beta; pin versions that
> match your OpenCode release.

## Install

```sh
opencode2 plugin add opencode-dcp
```

This installs the package into OpenCode's plugin cache and registers its server
entrypoint in your global config. The TUI companion needs no extra step: the
plugin's definition sets `tui: true`, so a locally connected TUI discovers the
active plugin and loads its `./tui` export from the cache on its own. Or add it
directly to a project config:

```jsonc title=".opencode/opencode.json"
{
  "plugins": [
    {
      "package": "opencode-dcp",
      "options": {
        "debug": false,
        "maxContextLimit": "70%"
      }
    }
  ]
}
```

**Development** (this repo): build first (`npm install && npm run build`), then
point config at the local entrypoint:

```jsonc title=".opencode/opencode.json"
{
  "plugins": [
    {
      "package": "../dist/index.js",
      "options": {
        "debug": true,
        "maxContextLimit": "70%",
        "tui": { "enabled": false }
      }
    }
  ]
}
```

Note: the automatic TUI companion load only applies to packages installed via
`plugin add`. With a local-path entry like above, the sidebar/report stay off
unless you separately register the TUI module (e.g. a `cli.json` `plugins`
entry or a file under `~/.config/opencode/plugins/tui/`).

> Requires OpenCode V2 (`opencode2`). The plugin API is beta; the package pins
> `@opencode-ai/plugin@0.0.0-beta-17887` **exactly** (a caret range over a
> prerelease admits any lexically-greater junk tag, e.g. `windows-fix`, which
> breaks resolution). Republish compatible updates when the
> V2 plugin contract changes.

## How it works

On every model dispatch (`ctx.session.hook("context")`) the plugin transforms the
outbound transcript only — stored session history is never modified:

1. **Scan & mirror** — index the transcript with stable keys; remember it so the
   `compress` tool can resolve ranges.
2. **Boundary IDs** — every message gets an alias `m0001, m0002, …` injected as
   `<dcp-message-id>` tags on user texts and textual tool results. Compressed
   sections are addressed as `b1, b2, …`.
3. **Compression blocks** — active blocks remove their covered ranges and splice
   a synthetic `[Compressed conversation section]` summary at the recorded anchor.
4. **Pruning** — superseded/errored tool outputs are replaced with short
   placeholders (protected tools like `question`/`edit` are never touched).
5. **Nudges** — when provider usage crosses `maxContextLimit`, a reminder asks
   the model to run `compress`; rate-limited by `nudgeFrequency`.

The model calls **`compress`** itself (registered with the platform default
`codemode: true`, so it is exposed through the Code Mode `tools.compress`
catalog in agentic sessions). It picks non-overlapping ranges by boundary ID and writes
an exhaustive summary per range; nested blocks are consumed and their summaries
folded in via `(bN)` placeholders. Deduplication and error-purge strategies run
at compression time so idle sessions keep their prompt-cache prefix stable.
State persists per session across restarts via plugin storage.

## TUI panel

A companion TUI module ships with the package and is **enabled by default**
(the server definition sets `tui: true`). While a session runs it shows:

- **Sidebar footer**: live outbound-token savings of the last dispatch
  (`−38% · 21.3k→13.2k tok`) plus active block count.
- **Command palette → "DCP: compression report"**: per-session totals
  (dispatches, compressions, blocks), last-dispatch delta, cumulative token
  savings from blocks and pruning, and the most recent compression events.

Mechanism: the server plugin writes a stats snapshot to the TUI's watched
storage file (`~/.local/state/opencode/<channel>/tui/plugin.opencode.dcp.tui.stats.json`)
after every dispatch and compression; the TUI module reads it as a reactive
store, so numbers update live. Disabling stops stats writes and quiets the
panel:

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
| `/dcp-compress [focus]` | Instructs the model to run a compression pass now |

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

Permissions: the tool's permission action is `compress`; gate it with normal V2
permission rules (`{ "action": "compress", "effect": "allow" }`).

## Develop

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test test/*.test.ts
npm run build       # tsup -> dist/
```

MIT. See [LICENSE](./LICENSE).
