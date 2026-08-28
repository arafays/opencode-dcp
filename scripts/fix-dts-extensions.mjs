// Post-build step for declaration emit under TypeScript 7.
// `tsc -p tsconfig.build.json` emits per-file .d.ts trees whose relative
// specifiers mirror the extensionless source imports. Extensionless
// specifiers fail to resolve for consumers using moduleResolution
// "node16"/"nodenext", so rewrite them to explicit ".js" specifiers.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = new URL("../dist", import.meta.url).pathname

function* walkDts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkDts(path)
    else if (entry.name.endsWith(".d.ts")) yield path
  }
}

let changed = 0
for (const file of walkDts(root)) {
  // from "./x" | import "./x" | export * from "./x" — relative, no extension
  const fixed = readFileSync(file, "utf8").replace(
    /(\bfrom\s*|\bimport\s*)(['"])(\.\.?\/[^'"']+)\2/g,
    (_, prefix, quote, spec) =>
      /\.[^./]+$/.test(spec) ? `${prefix}${quote}${spec}${quote}` : `${prefix}${quote}${spec}.js${quote}`,
  )
  if (fixed !== readFileSync(file, "utf8")) {
    writeFileSync(file, fixed)
    changed++
  }
}
console.log(`fix-dts-extensions: rewrote ${changed} file(s)`)
