#!/usr/bin/env node
// The engine has two halves, and the edge between them only goes one way.
//
//   node scripts/layers.ts     report the graph; exit 1 on a violation
//
// RECORD is schema-validated records over git: parse, validate, CRUD, refs, history, filters.
// WORKSPACE is the compiler and the agent-harness surface: modules, `extends`, skills, adapters.
// The seam is BOUNDARY (`runtime.js`) — the compiled `.dreamteamer/` artifact that one half writes
// and the other reads.
//
// WHY THIS IS A SCRIPT AND NOT A COMMENT: the edge was already almost absent — two imports, both
// reaching compile.js for a manifest read — and neither was there on purpose. An invariant nobody
// can violate by accident is worth having; one held up by good intentions gets re-added by the next
// person who needs a manifest in the store. This is deliberately NOT a package split: two packages
// would buy a distribution nobody has asked for and charge it to the extension's engine loader
// (decision 139). One repo, one enforced direction.
//
// An unclassified file under src/ is a FAILURE, not a default — adding one should cost the same
// sentence of thought that adding a core collection does.

import { readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, join, basename, relative, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { typeOnly } from "./import-edges.ts"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src")

const LAYERS = {
  // records over git — must not know that modules, channels or `extends` exist
  record: [
    "lib/store",
    "lib/records",
    "lib/temporal",
    "lib/fractional-index",
    "lib/filter",
    "lib/field-values",
    "commit",
    "lib/events",
    "lib/history",
    "lib/template",
    "lib/yaml",
    "lib/workspace",
    "check",
    "lib/namespace",
    "lib/ref",
    "lib/relations",
    "lib/env-vars",
    "lib/placement",
    "lib/fields",
    "lib/descriptor",
    "lib/exports",
    "lib/types",
  ],
  // the compiled artifact both halves share
  boundary: ["lib/runtime"],
  // the workspace compiler and the harness surface
  workspace: [
    "compile",
    "lib/compile-collections",
    "lib/descriptor-v2",
    "lib/views",
    "lib/harnesses",
    "collections/schema-ops",
    "init",
    "lib/record-commands",
    "lib/semver",
    "lib/checkout",
    "lib/extensions",
    "doctor",
    "lib/setup-contract",
    "setup",
    "setup/env-write",
    "check/alone",
    "collections/scaffold-templates",
    "install",
    "update",
  ],
  // entry points; span both halves by definition (the CLI, the public API, the descriptor→UI read model)
  surface: [
    "cli",
    "collections",
    "lib/presentation",
    "api",
    "records-api",
    "exports",
    "testing",
    "update/update-setup",
  ],
}

// who may import whom. `record` and `boundary` are the constrained half; surfaces are free.
const ALLOWED: Record<string, Set<string>> = {
  record: new Set(["record", "boundary"]),
  boundary: new Set(["record", "boundary"]),
  workspace: new Set(["record", "boundary", "workspace"]),
  surface: new Set(["record", "boundary", "workspace", "surface"]),
}

const layerOf = new Map()
for (const [layer, mods] of Object.entries(LAYERS)) for (const m of mods) layerOf.set(m, layer)

// every module under src/, sub-folders included, as its path from src/ ("lib/store.ts")
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .map(f => relative(SRC, join(SRC, f)).split("\\").join("/"))
  .filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .sort()
const problems = []

let edges = 0
for (const f of files) {
  const mod = f.slice(0, -".ts".length)
  const layer = layerOf.get(mod)
  if (!layer) {
    problems.push(
      `src/${f} is not assigned to a layer — add it to LAYERS in ${basename(fileURLToPath(import.meta.url))} and say which half it belongs to`
    )
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
  // contract's shapes live in one file (src/lib/types.ts) that both halves name.
  for (const m of body.matchAll(
    /(?:(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+|import\(\s*)['"](\.\.?\/[\w./-]+)\.ts['"]/g
  )) {
    if (typeOnly(body, m)) continue
    const target = posix.join(posix.dirname(mod), m[1])
    const targetLayer = layerOf.get(target)
    if (!targetLayer) continue // the missing-assignment failure is already reported on that file
    edges++
    if (!ALLOWED[layer].has(targetLayer)) {
      problems.push(
        `src/${f} (${layer}) imports src/${target}.ts (${targetLayer}) — ${layer} may only import ${[...ALLOWED[layer]].join(", ")}`
      )
    }
  }
}

// ⚠ A SCANNER THAT READS NOTHING PASSES. A change of quote style or import syntax would leave the
// pattern above matching no edge, and every layer would then be "clean". The engine has well over a
// hundred internal imports; finding none is a broken scanner, not a clean graph.
if (edges < 50)
  problems.push(
    `found only ${edges} import edge(s) under src/ — the import pattern in ${basename(fileURLToPath(import.meta.url))} no longer matches the source`
  )

for (const [layer, mods] of Object.entries(LAYERS)) {
  const missing = mods.filter(m => !files.includes(`${m}.ts`))
  if (missing.length)
    problems.push(
      `LAYERS.${layer} names ${missing.map(m => `${m}.ts`).join(", ")}, which no longer exist under src/ — drop them`
    )
  console.log(
    `${layer.padEnd(9)} ${mods
      .filter(m => files.includes(`${m}.ts`))
      .sort()
      .join(" ")}`
  )
}

if (problems.length) {
  console.error(`\n✖ ${problems.length} layering problem${problems.length === 1 ? "" : "s"}:`)
  for (const p of problems) console.error(`    ${p}`)
  process.exit(1)
}
console.log(`\n✔ ${files.length} modules, no record → workspace imports`)
