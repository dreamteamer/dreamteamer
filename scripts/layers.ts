#!/usr/bin/env node
// Who may import whom under src/, by folder.
//
//   node scripts/layers.ts     report the graph; exit 1 on a violation
//
// A file's FOLDER is its layer, so a new file needs no registration:
//
//   src/compile/, src/extensions/, src/lib/, src/record/, src/runtime/, src/setup/, src/store/,
//   src/workspace/                              shared   code two or more commands use
//   src/<command>/                              command  one command's code, and what it owns that others use
//   src/*.ts, src/commands/                     surface  entry points; commands/ holds one file per core verb
//
// Shared code imports only shared code; a command folder imports shared code, its own folder, and
// another command folder's ROOT files — what that command owns and others use (update installs one pin
// later through install/resolveClosure.ts) — never another command's lib/, which is its private helpers.
// A surface imports anything. The shared folders may import each other freely: the record/workspace
// direction this script used to hold was a proxy for the browser-safe `dreamteamer/records` entry, and
// it drove folder layout rather than protecting that entry — what the entry may load is a question of
// its import closure, not of which folder a file sits in.
//
// An unclassified FOLDER under src/ is a failure, not a default: a new command folder is named in
// COMMANDS below, which costs the same sentence of thought adding a core collection does.

import { readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, join, basename, relative, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { typeOnly } from "./import-edges.ts"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src")

// surface folders: commands/ holds the file each core verb dispatches to, and it imports anything
const SURFACE = new Set(["commands"])
const SHARED = new Set(["compile", "extensions", "lib", "record", "runtime", "setup", "store", "workspace"])
// the folders that hold one command's own code
const COMMANDS = new Set([
  "changes",
  "check",
  "collections",
  "doctor",
  "entities",
  "exports",
  "fmt",
  "init",
  "install",
  "modules",
  "records",
  "repos",
  "ui-views",
  "update",
])

// who may import whom. Between two command folders, only another command's root files — checked
// below, not in this table.
const ALLOWED: Record<string, Set<string>> = {
  shared: new Set(["shared"]),
  command: new Set(["shared", "command"]),
  surface: new Set(["shared", "command", "surface"]),
}

/** the layer of a module path ("store/Store"), or null for a folder nobody classified */
const layerOf = (mod: string): string | null => {
  const dir = mod.includes("/") ? mod.split("/")[0] : null
  if (dir === null || SURFACE.has(dir)) return "surface"
  if (SHARED.has(dir)) return "shared"
  return COMMANDS.has(dir) ? "command" : null
}

// every module under src/, sub-folders included, as its path from src/ ("store/Store.ts")
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .map(f => relative(SRC, join(SRC, f)).split("\\").join("/"))
  .filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .sort()
const problems = []
const unknownFolders = new Set<string>()

let edges = 0
for (const f of files) {
  const mod = f.slice(0, -".ts".length)
  const layer = layerOf(mod)
  if (!layer) {
    unknownFolders.add(mod.split("/")[0])
    continue
  }
  const body = readFileSync(join(SRC, f), "utf8")
  // static `import … from './x.ts'` / `export … from './x.ts'`, AND a dynamic `import('./x.ts')` with a
  // literal path — a lazy import is still an edge, and a scanner that skipped them passed a layering
  // the code did not have. (An extension's entry is imported by a COMPUTED path, which names no file
  // under src/ and so is not an edge this graph can have.)
  //
  // A TYPE-ONLY edge (`import type`, `export type`, `typeof import('./x.ts')`) is not one: under
  // verbatimModuleSyntax it is erased by construction, so it can load nothing. That is what lets the
  // contract's shapes live in one top-level file (src/types.ts) that shared code names.
  // `[^'"]*?`, not `[\s\S]*?`: an import clause holds no quote, so a match can never start at an EARLIER
  // import and run on into this one — which read `import fs from "node:fs"` as the head of the next
  // line's `import type`, and called a type-only edge a value edge.
  for (const m of body.matchAll(
    /(?:(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s+|import\(\s*)['"](\.\.?\/[\w./-]+)\.ts['"]/g
  )) {
    if (typeOnly(body, m)) continue
    const target = posix.join(posix.dirname(mod), m[1])
    const targetLayer = layerOf(target)
    if (!targetLayer) continue // the unknown folder is already reported
    edges++
    if (!ALLOWED[layer].has(targetLayer)) {
      problems.push(
        `src/${f} (${layer}) imports src/${target}.ts (${targetLayer}) — ${layer} may only import ${[...ALLOWED[layer]].join(", ")}`
      )
    } else if (
      layer === "command" &&
      targetLayer === "command" &&
      target.split("/")[0] !== mod.split("/")[0] &&
      target.split("/")[1] === "lib"
    ) {
      problems.push(
        `src/${f} imports src/${target}.ts — another command's lib/ holds its private helpers; import that command's root files, or move what both use to src/lib`
      )
    }
  }
}
for (const d of unknownFolders)
  problems.push(
    `src/${d}/ is not a known folder — a command's own folder is named in COMMANDS in ${basename(fileURLToPath(import.meta.url))}; shared code belongs in src/lib or one of the SHARED folders`
  )

// ⚠ A SCANNER THAT READS NOTHING PASSES. A change of quote style or import syntax would leave the
// pattern above matching no edge, and every layer would then be "clean". The engine has well over a
// hundred internal imports; finding none is a broken scanner, not a clean graph.
if (edges < 50)
  problems.push(
    `found only ${edges} import edge(s) under src/ — the import pattern in ${basename(fileURLToPath(import.meta.url))} no longer matches the source`
  )

const count = new Map<string, number>()
for (const f of files) {
  const l = layerOf(f.slice(0, -".ts".length)) ?? "unknown"
  count.set(l, (count.get(l) ?? 0) + 1)
}
for (const [l, n] of count) console.log(`${l.padEnd(9)} ${n} module(s)`)

if (problems.length) {
  console.error(`\n✖ ${problems.length} layering problem${problems.length === 1 ? "" : "s"}:`)
  for (const p of problems) console.error(`    ${p}`)
  process.exit(1)
}
console.log(`\n✔ ${files.length} modules, ${edges} import edges, every edge allowed`)
