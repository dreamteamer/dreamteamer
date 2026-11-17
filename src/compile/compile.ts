import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { deliver } from "../harness/deliver.ts"
import { readStamp } from "../harness/readStamp.ts"
import { sourceHashes } from "../harness/sourceHashes.ts"
import { asNames } from "../lib/asNames.ts"
import { asObject } from "../lib/asObject.ts"
import { asOptional } from "../lib/asOptional.ts"
import { DtError } from "../lib/DtError.ts"
import { isObject } from "../lib/isObject.ts"
import { engineVersion } from "../lib/engineVersion.ts"
import type { Model } from "../types/Model.ts"
import type { Module } from "../types/Module.ts"
import type { Skill } from "../types/Skill.ts"
import { compileRuntime } from "./compileRuntime.ts"
import { instructions } from "./instructions.ts"

/** the model with every path relative to the workspace, so it is the same wherever the workspace is checked out */
function portable(model: Model) {
  const res: Model = {
    root: ".",
    modules: model.modules.map((t) => {
      const m: Module = {
        name: t.name,
        version: t.version,
        dir: relative(model.root, t.dir),
        origin: t.origin,
        title: t.title,
        namespaces: t.namespaces,
        dependencies: t.dependencies,
        peers: t.peers,
        unsupported: t.unsupported,
      }
      return m
    }),
    collections: model.collections,
    skills: model.skills.map((t) => {
      const s: Skill = {
        name: t.name,
        module: t.module,
        description: t.description,
        path: relative(model.root, t.path),
      }
      return s
    }),
    peers: model.peers,
    sources: Object.fromEntries(
      Object.entries(model.sources).map(([k, ids]) => [
        k,
        Object.fromEntries(Object.entries(ids).map(([id, p]) => [id, relative(model.root, p)])),
      ]),
    ),
    exports: model.exports,
    issues: model.issues,
  }
  return res
}

/**
 * Project the resolved model into derived files: `.dt/` (instructions, the model, and `stamp.json`: each source's hash
 * and the harness files delivered), the released engine's compiled layout under `.dreamteamer/`, and what the
 * harnesses named in `dreamteamer.harnesses` load. Never touches git, never writes outside the workspace.
 */
export function compile(model: Model): string[] {
  const errors = model.issues.filter((t) => t.severity === "error")
  if (errors.length) throw new DtError("the workspace model has errors — nothing compiled; fix them first", errors)
  const out = join(model.root, ".dt")
  mkdirSync(out, { recursive: true })
  const files = {
    "model.json": JSON.stringify(portable(model), null, 2) + "\n",
    "AGENTS.md": instructions(model),
    ".gitignore": "*\n",
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text)
  const n = compileRuntime(model, engineVersion())
  const res = [...Object.keys(files).map((t) => join(out, t)), `${join(model.root, ".dreamteamer")} (${n} files)`]
  const cfg = asObject(JSON.parse(readFileSync(join(model.root, "package.json"), "utf8")), "package.json").dreamteamer
  const named = isObject(cfg) ? asOptional(cfg.harnesses, "package.json: dreamteamer.harnesses", asNames) : undefined
  const was = readStamp(model.root)?.outputs ?? []
  const outputs = named ? deliver(model, named, was) : was
  writeFileSync(join(out, "stamp.json"), JSON.stringify({ sources: sourceHashes(model), outputs }, null, 2) + "\n")
  return named ? [...res, `harnesses ${named.join(", ") || "none"} → ${outputs.length} files`] : res
}
