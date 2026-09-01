// Places the TUI companion next to the built server entrypoint so local-path
// plugin entries ("../dist") get the runtime's sibling `tui.*` auto-detection
// (the same feature detection the package `./tui` export uses for installs).
// tsup cleans dist/, so this runs after the build, never before.
import { copyFileSync } from "node:fs"

copyFileSync(new URL("../tui.tsx", import.meta.url), new URL("../dist/tui.tsx", import.meta.url))
