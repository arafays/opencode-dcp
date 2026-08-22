// Dev-only loader alias — NOT a separate plugin.
//
// The TUI companion lives solely in this package's `tui.tsx`, shipped via the
// `./tui` export and auto-loaded by the TUI because the server plugin sets
// `tui: true`. This file exists only so local development against
// `../dist/index.js` (which the TUI would otherwise import directly as a TUI
// module) keeps loading the companion from OpenCode's local-plugin discovery
// directory without duplicating any implementation. Delete freely when testing
// an installed copy of the package.
export { default } from "../../../tui.tsx"
