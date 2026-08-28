# AGENTS.md

## What this is

OpenCode **V2** plugin implementing Dynamic Context Pruning. Entrypoint `index.ts` (`Plugin.define`); logic in `lib/` split as: `transcript/` (scan → mirror → edit pipeline), `state/store.ts` (persisted per-session state), `prune-tool.ts` (model-invoked `prune` tool), `prune.ts` + `strategies.ts`, `nudges.ts` + `events.ts` (usage event pump), `config.ts` (options resolution), `tui-bridge.ts` (stats snapshot writer). Published to npm as `opencode-dcp`; repo doubles as the plugin's own dev harness via `.opencode/opencode.json`.

## Commands

```sh
npm install
npm run typecheck                          # tsc --noEmit (strict); run this first
npm test                                   # node --import tsx --test test/*.test.ts
node --import tsx --test test/prune.test.ts  # single test file
npm run build                              # tsup (JS) -> dist/, then native tsc emits dist/**/*.d.ts
```

- Tests use `node:test` + `tsx` (no vitest/jest). Pure unit tests: build fixtures as `WireMessage[]`; no server or network needed.
- No lint/format config exists; typecheck + tests are the only gate.
- `mise.toml` pins `aube` (npm-alternative package manager), but the committed lockfile is npm's and all local commands use npm.

## Gotchas

- **TypeScript 7 (native) has no JS Compiler API**: anything that `require("typescript")`s internals breaks (this killed tsup's `dts: true` via rollup-plugin-dts). Declarations must be emitted by the compiler CLI (`tsconfig.build.json`) — keep `dts: false` in tsup.config until TS 7.1's programmatic API ships. The `scripts/fix-dts-extensions.mjs` postbuild makes emitted relative specifiers nodenext-safe.
- **Rebuild before live testing**: `.opencode/opencode.json` loads the plugin from `../dist/index.js`. Source edits have no effect in an OpenCode session until `npm run build`. (`dist/` is gitignored.)
- **Never `npm pack` before `npm publish`**: `prepublishOnly` runs tsup with `clean: true`, wiping `dist/`. Pack *after* publishing. (CI is safe: `release.yml` builds explicitly and publishes with `--ignore-scripts`.)
- **Dependency pinning**: `@opencode-ai/plugin` uses the `beta` dist-tag in `package.json`; the lockfile pins the exact resolved version. Never use a caret range (`^0.0.0-beta-…`) — npm treats any lexically-greater `0.0.0-*` prerelease tag as satisfying the range, and those builds lack the `Plugin` export.
- **Global + dev plugin collision**: two instances of the same plugin ID kill server start with `Duplicate plugin ID: opencode.dcp`. `.opencode/opencode.json` lists `"-opencode.dcp"` (remove-operation, processed after global entries) before its local-path entry. Don't drop that line while the npm package is enabled globally.
- **TUI option shape**: `tui` must be an object (`{ "enabled": false }`), not a bare boolean (used to crash `resolveOptions`).
- **TUI companion auto-load requires a package install**: the TUI only auto-loads a server plugin's `./tui` export when the plugin's source type is `package` (installed via `plugin add`). Local-path entries (`../dist/index.js`) don't get the sidebar/report.

## Release

Publishing is npm OIDC trusted publishing (no `NPM_TOKEN` secret); auth/provenance details live in `.github/workflows/release.yml`. To cut a release: bump version, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Invariants

- **Outbound-only**: the `session.hook("context")` transform may rewrite only the outbound transcript sent to the model. Stored session history is never modified.
- **Stable transcript keys** (`lib/transcript/scan.ts`): `message.id` when unique, else `${role}#${index}`. Keys are persisted inside compression blocks via plugin storage and must survive restarts — changing key derivation invalidates saved sessions.
- Transcripts are append-only between compactions/reverts; those events reset DCP state.
- Dedup/error-purge runs at compression time specifically so idle sessions keep a stable prompt-cache prefix — don't introduce mid-transcript rewrites outside compression.
- Boundary IDs (`m0001…` messages, `b1…` blocks, `<dcp-message-id>` tags) are environment-injected addressing metadata, never model output.
- The `prune` tool name doubles as its V2 permission action (renamed from `compress` to avoid clashing with the platform's built-in compress tool) — don't rename casually.

## Beta API

The V2 plugin API is beta and moving between releases. When `@opencode-ai/plugin` types disagree with runtime behavior, check the opencode-v2 source rather than trusting either alone. `index.ts` carries an arity-based `addTool` shim because `tools.add` changed signature across beta generations.

## Reference repos (wired in `.opencode/opencode.json`)

- `opencode-v2` — OpenCode V2 source: use for plugin API surface (hooks, tool/command transform, storage, events, permissions) and config schema details.
