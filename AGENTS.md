# AGENTS.md

## What this is

OpenCode **V2** plugin implementing Dynamic Context Pruning. Entrypoint `index.ts` (`Plugin.define`); logic in `lib/` split as: `transform.ts` (outbound pipeline driven from the `session.hook("context")` handler), `transcript/` (scan → mirror → edit pipeline), `state/store.ts` (persisted per-session state), `prune-tool.ts` (model-invoked `prune` tool), `prune.ts` + `strategies.ts`, `nudges.ts` + `events.ts` (usage event pump), `commands.ts` (`/dcp-prune` re-prompt), `config.ts` (options resolution), `refs.ts` (boundary-ID `mNNNN`/`bN` ref registry), `tui-bridge.ts` (stats snapshot writer for the TUI companion `tui.tsx`). Published to npm as `opencode-dcp`; repo doubles as the plugin's own dev harness via `.opencode/opencode.json`.

## Commands

```sh
aube i                                       # install from aube-lock.yaml
npm run typecheck                            # tsc --noEmit (strict); run this first
npm test                                     # node --import tsx --test test/*.test.ts
node --import tsx --test test/prune.test.ts  # single test file
npm run build                                # tsup -> dist/ (JS + bundled index.d.ts), then copy-tui.mjs
```

- Tests use `node:test` + `tsx` (no vitest/jest). Pure unit tests: build fixtures as `WireMessage[]`; no server or network needed.
- No lint/format config exists; typecheck + tests are the only gate.
- `mise.toml` pins `aube` (npm-alternative package manager) and the committed lockfile is `aube-lock.yaml`. `npm run` scripts still work for typecheck/test/build. aube 2.x's frozen install fails on npm's `package-lock.json` whenever the root manifest has `peerDependencies` (npm never records root peers as importer deps, so the drift check reports "manifest adds X"), and `aube ci` deletes it in favor of its own format — so `package-lock.json` is gitignored; don't commit one.
- `npm run build` is NOT just `tsup`: it is `tsup && node scripts/copy-tui.mjs`. tsup's `dts: true` emits a single bundled `dist/index.d.ts` (no per-file `.d.ts` tree — no separate `tsc` pass). `copy-tui.mjs` copies `tui.tsx` into `dist/` after tsup (which `clean: true` wipes) so the local-path plugin target gets the runtime's sibling `tui.*` auto-detection. `scripts/fix-dts-extensions.mjs` references a `tsconfig.build.json` that no longer exists and is wired to nothing — dead, don't revive it.

## Gotchas

- **Rebuild before live testing**: `.opencode/opencode.json` loads the plugin from `../dist` (a directory — since beta-18743 a configured local plugin target must be a directory containing `index.ts`/`index.js`; a file path is dropped with "configured plugin path must be a directory"). Source edits have no effect in an OpenCode session until `npm run build`. (`dist/` is gitignored.)
- **Tool registration beta compat** (`index.ts` `addTool`): the current `@opencode/plugin` types are `tools.add(tool)`, but the documented V2 shape is `add(name, tool, options?)`. The shim distinguishes them by `Function.length` (`>= 2` → positional form, stripping `name`/`options` out of the definition). Keep the shim — drop it only when the tagged types settle on one arity. Also, `options: { codemode: true }` is set explicitly on the `prune` tool because the platform's `codemode` default isn't guaranteed across beta releases.
- **Never `npm pack` before `npm publish`**: `prepublishOnly` runs tsup with `clean: true`, wiping `dist/`. Pack *after* publishing. (CI is safe: `release.yml` builds explicitly and publishes with `--ignore-scripts`.)
- **Dependency pinning**: `@opencode/plugin` is a `latest` dist-tag dependency in `package.json`; the lockfile pins the exact resolved version. Never use a caret range on a prerelease (`^0.0.0-beta-…`) — npm treats any lexically-greater `0.0.0-*` prerelease tag as satisfying the range, and those builds lack the `Plugin` export.

## Release

Publishing is npm OIDC trusted publishing (no `NPM_TOKEN` secret); auth/provenance details live in `.github/workflows/release.yml`. The workflow hard-fails unless the pushed tag matches `package.json` version exactly (`v$(node -p ...)` — GITHUB_REF_NAME must equal it). To cut a release: bump version, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. Every release (betas included) publishes under the `latest` dist-tag; the install/build/test steps run via `aube`, and the tarball is packed into `dist/` *after* publishing with `--ignore-scripts`.

## Invariants

- **Outbound-only**: the `session.hook("context")` transform may rewrite only the outbound transcript sent to the model. Stored session history is never modified.
- **Stable transcript keys** (`lib/transcript/scan.ts`): `message.id` when unique, else `${role}#${index}`. Keys are persisted inside compression blocks via plugin storage and must survive restarts — changing key derivation invalidates saved sessions.
- Transcripts are append-only between compactions/reverts; those events reset DCP state.
- Dedup/error-purge runs at compression time specifically so idle sessions keep a stable prompt-cache prefix — don't introduce mid-transcript rewrites outside compression.
- Boundary IDs (`m0001…` messages, `b1…` blocks, `<dcp-message-id>` tags) are environment-injected addressing metadata, never model output.
- The `prune` tool name doubles as its V2 permission action (renamed from `compress` to avoid clashing with the platform's built-in compress tool) — don't rename casually.

## Beta API

The V2 plugin API is beta and moving between releases. When `@opencode/plugin` types disagree with runtime behavior, check the opencode-v2 source rather than trusting either alone. The server side of the plugin context lives in `packages/plugin/src/promise/*.ts` (one domain per file); event payload shapes and `ModelInfo`/`SessionInfo` fields live in `packages/client/src/promise/generated/types.ts`.

## Reference repos (wired in `.opencode/opencode.json`)

- `opencode-v2` — OpenCode V2 source: use for plugin API surface (hooks, tool/command transform, storage, events, permissions) and config schema details.
