import { mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { DtError } from "../lib/DtError.ts"
import type { Model } from "../types/Model.ts"
import type { Module } from "../types/Module.ts"
import type { Skill } from "../types/Skill.ts"
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
    exports: model.exports,
    issues: model.issues,
  }
  return res
}

/** Project the resolved model into derived, gitignorable files. Never touches git, never writes outside <root>/.dt. */
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
  return Object.keys(files).map((t) => join(out, t))
}
