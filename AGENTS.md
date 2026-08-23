# AGENTS.md

## What this is

OpenCode **V2** plugin implementing Dynamic Context Pruning. Entrypoint `index.ts` (`Plugin.define`); logic in `lib/` split as: `transcript/` (scan → mirror → edit pipeline), `state/store.ts` (persisted per-session state), `compress-tool.ts` (model-invoked `compress` tool), `prune.ts` + `strategies.ts`, `nudges.ts` + `events.ts` (usage event pump), `config.ts` (options resolution), `tui-bridge.ts` (stats snapshot writer). Published to npm as `opencode-dcp`; repo doubles as the plugin's own dev harness via `.opencode/opencode.json`.

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

## Gotchas

- **Rebuild before live testing**: `.opencode/opencode.json` loads the plugin from `../dist/index.js`. Source edits have no effect in an OpenCode session until `npm run build`. (`dist/` is gitignored, so builds stay out of commits.)
- **Never `npm pack` before `npm publish`**: `prepublishOnly` re-runs the build with tsup `clean: true`, which **wipes `dist/`** — any tarball packed beforehand silently disappears. This broke CI once; `release.yml` builds explicitly and publishes with `--ignore-scripts`, so `prepublishOnly` never fires in CI — keep packing *after* publishing anyway.
- **Dependency pinning**: `@opencode-ai/plugin` is pinned **exactly** (e.g. `0.0.0-beta-17887`), never with a caret and never the floating `beta` dist-tag — npm resolves any lexically-greater `0.0.0-*` prerelease tag (`windows-fix`, `snapshot-*`, …) as satisfying a caret range over a beta, and those builds lack the `Plugin` export. Bump deliberately when targeting a newer OpenCode beta.
- **CI uses aube**: both workflows install via `jdx/aube-action@v1` and run `aube ci` (frozen clean install) straight off `package-lock.json` — aube reads/writes npm lockfiles in place, so no lockfile migration; local dev commands stay npm. Release installs/builds/packs with aube but publishes via stock `npm publish --provenance --ignore-scripts` under OIDC trusted publishing (aube has no tokenless-auth support yet).
- **Global + dev plugin collision**: OpenCode concatenates global and project `plugin` lists, and two instances of the same plugin ID kill server start/reload with `Duplicate plugin ID: opencode.dcp`. This repo's dev harness coexists with a globally installed `opencode-dcp` because `.opencode/opencode.json` lists `"-opencode.dcp"` (leading `-` = remove-operation, matched by plugin ID, processed after global entries) before its local-path entry. Don't drop that line while the npm package is enabled globally.
- **TUI option shape**: `tui` must be an object (`{ "enabled": false }`). A bare boolean used to crash `resolveOptions` (now warns + falls back, but don't reintroduce it in docs/examples).
- **TUI companion auto-load requires a package install**: the OpenCode TUI only auto-loads a server plugin's `./tui` export when the plugin's source type is `package` (i.e. installed via `plugin add`). Local-path dev entries (`../dist/index.js`) don't get the sidebar/report.

## Release flow

Pushing a tag `v*` triggers `.github/workflows/release.yml`: verifies tag matches `package.json` version → typecheck/test/build → `npm publish --provenance` → GitHub release with the packed tarball. Requirements:

- Repo secret `NPM_TOKEN` is **gone** — publishing uses **npm Trusted Publishing (OIDC)**. One-time prerequisite: configure the *Trusted Publisher* on npmjs.com for `opencode-dcp` (provider: GitHub Actions, repo `arafays/opencode-dcp`, workflow `release.yml`). Requires `id-token: write` and npm ≥ 11.5.1 (workflow installs `npm@latest` first). Don't reintroduce token auth: classic tokens were revoked Dec 2025, granular tokens expire every 90 days and bypass-2FA is being restricted.
- To cut a release: bump version, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Invariants

- **Outbound-only**: the `session.hook("context")` transform may rewrite only the outbound transcript sent to the model. Stored session history is never modified.
- **Stable transcript keys** (`lib/transcript/scan.ts`): `message.id` when unique, else `${role}#${index}`. Keys are persisted inside compression blocks via plugin storage and must survive restarts — changing key derivation invalidates saved sessions.
- Transcripts are append-only between compactions/reverts; those events reset DCP state.
- Dedup/error-purge runs at compression time specifically so idle sessions keep a stable prompt-cache prefix — don't introduce mid-transcript rewrites outside compression.
- Boundary IDs (`m0001…` messages, `b1…` blocks, `<dcp-message-id>` tags) are environment-injected addressing metadata, never model output.
- The `compress` tool name doubles as its V2 permission action — don't rename casually.

## Beta API

The V2 plugin API is beta and moving between releases. When `@opencode-ai/plugin` types disagree with runtime behavior, check the opencode-v2 source rather than trusting either alone. `index.ts` carries an arity-based `addTool` shim because `tools.add` changed signature across beta generations.

## Reference repos (wired in `.opencode/opencode.json`)

- `opencode-v2` — OpenCode V2 source: use for plugin API surface (hooks, tool/command transform, storage, events, permissions) and config schema details.
