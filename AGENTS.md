# AGENTS.md

## What this is

OpenCode **V2** plugin (`@opencode-ai/plugin@beta`) implementing Dynamic Context Pruning. Entrypoint `index.ts` (`Plugin.define`); logic in `lib/` split as: `transcript/` (scan → mirror → edit pipeline), `state/store.ts` (persisted per-session state), `compress-tool.ts` (model-invoked `compress` tool), `prune.ts` + `strategies.ts`, `nudges.ts` + `events.ts` (usage event pump), `config.ts` (options resolution).

## Commands

```sh
npm install
npm run typecheck                          # tsc --noEmit (strict); run this first
npm test                                   # node --import tsx --test test/*.test.ts
node --import tsx --test test/prune.test.ts  # single test file
npm run build                              # tsup -> dist/
```

- Tests use `node:test` + `tsx` (no vitest/jest). Pure unit tests: build fixtures as `WireMessage[]`; no server or network needed.
- No lint/format config exists; typecheck + tests are the only gate.
- `mise.toml` pins `aube` (an npm-alternative package manager), but the committed lockfile is npm's and all documented commands use npm.

## Gotcha: rebuild before live testing

`.opencode/opencode.json` loads the plugin from `../dist/index.js`. Source edits have no effect in an OpenCode session until you run `npm run build`. Note `dist/` is git-tracked, so builds dirty the tree.

## Invariants

- **Outbound-only**: the `session.hook("context")` transform may rewrite only the outbound transcript sent to the model. Stored session history is never modified.
- **Stable transcript keys** (`lib/transcript/scan.ts`): `message.id` when unique, else `${role}#${index}`. Keys are persisted inside compression blocks via plugin storage and must survive restarts — changing key derivation invalidates saved sessions.
- Transcripts are append-only between compactions/reverts; those events reset DCP state.
- Dedup/error-purge runs at compression time specifically so idle sessions keep a stable prompt-cache prefix — don't introduce mid-transcript rewrites outside compression.
- Boundary IDs (`m0001…` messages, `b1…` blocks, `<dcp-message-id>` tags) are environment-injected addressing metadata, never model output.
- The `compress` tool name doubles as its V2 permission action — don't rename casually.

## Beta API

The V2 plugin API is beta and moving between releases. When `@opencode-ai/plugin@beta` types disagree with runtime behavior, check the opencode-v2 source rather than trusting either alone. `index.ts` carries an arity-based `addTool` shim because `tools.add` changed signature across beta generations.

## Reference repos (wired in `.opencode/opencode.json`)

- `opencode-v2` — OpenCode V2 source: use for plugin API surface (hooks, tool/command transform, storage, events, permissions) and config schema details.
