#!/usr/bin/env node
// The engine has two halves, and the edge between them only goes one way.
//
//   node scripts/layers.ts     report the graph; exit 1 on a violation
//
// RECORD is schema-validated records over git: parse, validate, CRUD, refs, history, filters.
// WORKSPACE is the compiler and the agent-harness surface: modules, `extends`, skills, adapters.
// The seam is BOUNDARY (`src/runtime/`) — the compiled `.dreamteamer/` artifact that one half writes
// and the other reads.
//
// WHY THIS IS A SCRIPT AND NOT A COMMENT: the edge was already almost absent — two imports, both
// reaching the compiler for a manifest read — and neither was there on purpose. An invariant nobody
// can violate by accident is worth having; one held up by good intentions gets re-added by the next
// person who needs a manifest in the store. This is deliberately NOT a package split: two packages
// would buy a distribution nobody has asked for and charge it to the extension's engine loader
// (decision 139). One repo, one enforced direction.
//
// A file's FOLDER is its layer, so a new file needs no registration:
//
//   src/record/      record      shared record code
//   src/runtime/     boundary    the compiled artifact both halves read
//   src/workspace/   workspace   shared workspace code
//   src/<command>/   command     code only that command uses — never another command's
//   src/*.ts         surface     entry points and the function each verb dispatches to
//
// An unclassified FOLDER under src/ is a failure, not a default: a new command folder is named in
// COMMANDS below, which costs the same sentence of thought adding a core collection does.

import { readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, join, basename, relative, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { typeOnly } from "./import-edges.ts"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src")

const SHARED: Record<string, string> = { record: "record", runtime: "boundary", workspace: "workspace" }
// the folders that hold one command's own code
const COMMANDS = new Set(["changes", "check", "collections", "doctor", "exports", "fmt", "init", "install", "update"])

// who may import whom. `record` and `boundary` are the constrained half; surfaces are free. A command
// folder may also import its OWN folder, never another command's — checked below, not in this table.
const ALLOWED: Record<string, Set<string>> = {
  record: new Set(["record", "boundary"]),
  boundary: new Set(["record", "boundary"]),
  workspace: new Set(["record", "boundary", "workspace"]),
  command: new Set(["record", "boundary", "workspace", "command"]),
  surface: new Set(["record", "boundary", "workspace", "command", "surface"]),
}

/** the layer of a module path ("record/Store"), or null for a folder nobody classified */
const layerOf = (mod: string): string | null => {
  const dir = mod.includes("/") ? mod.split("/")[0] : null
  if (dir === null) return "surface"
  if (dir in SHARED) return SHARED[dir]
  return COMMANDS.has(dir) ? "command" : null
}

// every module under src/, sub-folders included, as its path from src/ ("record/Store.ts")
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
  // contract's shapes live in one file (src/types.ts) that both halves name.
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
    } else if (layer === "command" && targetLayer === "command" && target.split("/")[0] !== mod.split("/")[0]) {
      problems.push(
        `src/${f} imports src/${target}.ts — a command folder holds code only its own command uses; what two commands share belongs in src/record, src/runtime or src/workspace`
      )
    }
  }
}
for (const d of unknownFolders)
  problems.push(
    `src/${d}/ is not a known folder — a command's own folder is named in COMMANDS in ${basename(fileURLToPath(import.meta.url))}; shared code belongs in src/record, src/runtime or src/workspace`
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
console.log(`\n✔ ${files.length} modules, ${edges} import edges, no record → workspace imports`)
