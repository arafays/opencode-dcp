<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

# AGENTS.md

## What this is

OpenCode **V2** plugin implementing Dynamic Context Pruning. Entrypoint `index.ts` (`Plugin.define`); logic in `lib/` split as: `transform.ts` (outbound pipeline driven from the `session.hook("context")` handler), `transcript/` (scan → mirror → edit pipeline), `state/store.ts` (persisted per-session state), `prune-tool.ts` (model-invoked `prune` tool), `prune.ts` + `strategies.ts`, `nudges.ts` + `events.ts` (usage event pump), `constants.ts` (shared model-copy formatting: token/percent labels, window fallback), `commands.ts` (`/dcp-prune` re-prompt), `config.ts` (options resolution), `refs.ts` (boundary-ID `mNNNN`/`bN` ref registry), `tui-bridge.ts` (stats snapshot writer for the TUI companion `tui.tsx`). Published to npm as `opencode-dcp`; repo doubles as the plugin's own dev harness via `.opencode/opencode.json`.

## Commands

```sh
aube i                                       # install from aube-lock.yaml
aubr typecheck                            # tsc --noEmit (strict); run this first
aube test                                     # node --import tsx --test test/*.test.ts
node --import tsx --test test/prune.test.ts  # single test file
aubr build                                # tsup -> dist/ (JS + bundled index.d.ts), then copy-tui.mjs
```

- Tests use `node:test` + `tsx` (no vitest/jest). Pure unit tests: build fixtures as `WireMessage[]`; no server or network needed.
- No lint/format config exists; typecheck + tests are the only gate.
- `mise.toml` pins `aube` (npm-alternative package manager) and the committed lockfile is `aube-lock.yaml`. `npm run` scripts still work for typecheck/test/build. aube 2.x's frozen install fails on npm's `package-lock.json` whenever the root manifest has `peerDependencies` (npm never records root peers as importer deps, so the drift check reports "manifest adds X"), and `aube ci` deletes it in favor of its own format — so `package-lock.json` is gitignored; don't commit one.
- `npm run build` is NOT just `tsup`: it is `tsup && node scripts/copy-tui.mjs`. tsup's `dts: true` emits a single bundled `dist/index.d.ts` (no per-file `.d.ts` tree — no separate `tsc` pass). `copy-tui.mjs` copies `tui.tsx` into `dist/` after tsup (which `clean: true` wipes) so the local-path plugin target gets the runtime's sibling `tui.*` auto-detection. `scripts/fix-dts-extensions.mjs` references a `tsconfig.build.json` that no longer exists and is wired to nothing — dead, don't revive it.

## Gotchas

- **Rebuild before live testing**: `.opencode/opencode.json` loads the plugin from `../dist` (a directory — since beta-18743 a configured local plugin target must be a directory containing `index.ts`/`index.js`; a file path is dropped with "configured plugin path must be a directory"). Source edits have no effect in an OpenCode session until `npm run build`. (`dist/` is gitignored.)
- **Tool registration beta compat** (`lib/prune-tool.ts` `addPruneTool`): the tagged `@opencode/plugin` types are `tools.add(tool)` (an older beta documented the positional `add(name, tool, options?)`). The types have settled on one arity, so the `Function.length` shim is gone — don't reintroduce it. `addPruneTool` replaces the old `index.ts` `addTool` shim: it guards that `add` exists, forwards the definition object, and returns an `{ ok } | { ok: false; reason }` verdict so `index.ts` can warn once per generation instead of failing silently (core drops a definition that fails `registrationError` and only tells the domain's `notify`, never the plugin). The `prune` tool is registered with **`options: { codemode: false, permission: "prune" }`** (not `codemode: true`): `packages/core/src/tool.ts` only emits `codemode === false` tools as native definitions, so the full `PRUNE_RANGE` boundary-ID rules ship on every request; `codemode: true` — or leaving it unset, the platform default — folds the tool into the Code Mode `execute` catalog, whose inline listings truncate the first line to 120 chars (`packages/core/src/codemode/catalog.ts`). Note the registration `options` are set **on the definition object** inside `prune-tool.ts`, not by the caller. Do not "restore" `codemode: true`.
- **Never `npm pack` before `npm publish`**: `prepublishOnly` runs tsup with `clean: true`, wiping `dist/`. Pack _after_ publishing. (CI is safe: `release.yml` builds explicitly and publishes with `--ignore-scripts`.)
- **Dependency pinning**: `@opencode/plugin` is a `latest` dist-tag dependency in `package.json`; the lockfile pins the exact resolved version. Never use a caret range on a prerelease (`^0.0.0-beta-…`) — npm treats any lexically-greater `0.0.0-*` prerelease tag as satisfying the range, and those builds lack the `Plugin` export.
- **Never declare `effect` as a dependency.** It was declared at `^3.22.2` until the 2.0.27-upgrade pass and never imported; do not re-add it. The host hard-fails a plugin that loads its own copies of `effect`/`@opencode/plugin`: `packages/cli/src/index.ts` calls `ensurePluginRuntime()` (`packages/plugin/src/runtime.ts:12`), which registers every host `effect`/`@opencode/plugin` specifier as a virtual module via `build.module` (`runtime.ts:20-27`) and installs an `onLoad` filter that **throws** for any file under a plugin's own `node_modules/effect/**` or `node_modules/@opencode/plugin/**` (`runtime.ts:28-34`, pattern at `runtime.ts:3-4`) with `Cannot load "…" from plugin node_modules: … is not provided by OpenCode`. Bare `import "effect"` is safe (the virtual module wins before resolution) but **path-based** loads of the plugin's copy are fatal. The dangerous failure is not the throw but silent version skew: `@opencode/plugin` depends on `effect@4.0.1` while the root `node_modules/effect` was `3.22.2`, so an `import "effect"` in our source would typecheck against Effect 3 types and silently run against the host's Effect 4 — the host's own packaging note (`packages/plugin/README.md:14-16`) calls out both the dual-copy and wrong-major traps. This plugin is pure TypeScript with no Effect usage, so the right declaration is _none at all_; if Effect is ever genuinely needed, follow the README (peer + dev dependency, `^4.0.0`, and keep it external in `tsup.config.ts`).
- **aube silently skips brand-new releases**: `minimumReleaseAge` defaults to 1440 minutes (24h) (`aube config explain minimum-release-age`), so a plain `aube install` right after a release downgrades `latest` to the newest version older than a day — it resolved `@opencode/plugin` 2.0.27 -> 2.0.26 and `@opencode/theme` likewise, and wrote the downgrade into `aube-lock.yaml`. To refresh the lockfile against a freshly published build use `AUBE_MINIMUM_RELEASE_AGE=0 aube install` (or `aube update <pkg>`), then confirm the locked version is the `latest` dist-tag (`npm view <pkg> dist-tags`).

## Release

Publishing is npm OIDC trusted publishing (no `NPM_TOKEN` secret); auth/provenance details live in `.github/workflows/release.yml`. The workflow hard-fails unless the pushed tag matches `package.json` version exactly (`v$(node -p ...)` — GITHUB_REF_NAME must equal it). To cut a release: bump version, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. Every release (betas included) publishes under the `latest` dist-tag; the install/build/test steps run via `aube`, and the tarball is packed into `dist/` _after_ publishing with `--ignore-scripts`.

## Invariants

- **Outbound-only**: the `session.hook("context")` transform may rewrite only the outbound transcript sent to the model. Stored session history is never modified.
- **Stable transcript keys** (`lib/transcript/scan.ts`): `message.id` when unique, else `${role}#${index}`. Keys are persisted inside compression blocks via plugin storage and must survive restarts — changing key derivation invalidates saved sessions.
- Transcripts are append-only between compactions/reverts; those events reset DCP state.
- Dedup/error-purge runs at compression time specifically so idle sessions keep a stable prompt-cache prefix — don't introduce mid-transcript rewrites outside compression.
- Boundary IDs (`m0001…` messages, `b1…` blocks, `<dcp-message-id>` tags) are environment-injected addressing metadata, never model output. They are a **per-dispatch projection** of the visible transcript (`RefRegistry.project`), dense from `m0001` and strictly ascending in transcript order — the model is told to rely on that ordering, so any future change that lets `mNNNN` wrap, reuse a slot below a live one, or grow monotonically across a session reintroduces the `startId m0006 appears after endId m0129` failure mode (9 of 26 prunes died on it in production). `release()` must not rewind `next` to the lowest free index.
- Media is never billed as text. `measurePartChars` charges inline `data:` URIs and `MediaPart`→`Asset`→`Source` payloads a flat per-kind allowance (`MEDIA_TOKEN_ALLOWANCE`); the payload bytes are not characters the provider charges per-4. A 4 MB inline PNG was measured at 1,007,171 tokens (96% of a 1M window) before this, against a real 119k. `ArrayBuffer.isView` short-circuits for the same reason — `Object.values` over a `Uint8Array` allocates per byte.
- The `prune` tool name doubles as its V2 permission action (renamed from `compress` to avoid clashing with the platform's built-in compress tool) — don't rename casually.
- **Expected failures throw.** `prune` defects (unknown/inverted/overlapping boundaries, unknown `bN`, bad `(bN)` placeholder, zero-gain re-summarize) must propagate as thrown errors so the runner marks the call failed. Returning them as `content: "context error: …"` launders a defect into a successful tool result the model cannot distinguish from real output — that regressed in beta.12 and drove a retry loop. Atomicity comes from validating _every_ plan (`resolvePlans` → `expandPlaceholders` → zero-gain guard) before the first `applyCompression`, not from a catch.
- Model-facing numbers have one spelling: the nudge, the prune ack and the prune result share `contextUsage`/`budgetClause` (`lib/constants.ts`) and lead with the **model window**, naming the pruning budget as a trailing threshold. Budget-first copy (`999% of the 150,000-token pruning budget`) read as a catastrophic overflow and drove 26 prunes on a transcript that peaked at 13% of the window. Thresholds quoted in `PRUNE_RANGE` prose must interpolate `ZERO_GAIN_MIN_TOKENS`, never hardcode the number.

## Beta API

The V2 plugin API is beta and moving between releases. When `@opencode/plugin` types disagree with runtime behavior, check the opencode-v2 source rather than trusting either alone. The server side of the plugin context lives in `packages/plugin/src/promise/*.ts` (one domain per file); event payload shapes and `ModelInfo`/`SessionInfo` fields live in `packages/client/src/promise/generated/types.ts`.

## Reference repos (wired in `.opencode/opencode.json`)

- `opencode-v2` — OpenCode V2 source: use for plugin API surface (hooks, tool/command transform, storage, events, permissions) and config schema details.
