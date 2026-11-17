import { join } from "node:path"
import { idsIn } from "../store/idsIn.ts"
import { tail } from "../store/tail.ts"
import type { Collection } from "../types/Collection.ts"
import type { Module } from "../types/Module.ts"
import { moduleId } from "./moduleId.ts"
import { SOURCE_KINDS } from "./SOURCE_KINDS.ts"

/**
 * The records of the source kinds, kind → id → the file each is read from. A collection's id is its name and its file
 * the descriptor that declares it; a module's id is its unscoped name, its file its package.json. Every other kind is
 * read from each module's folder of that name the way the released engine stages it — the id is the file's path
 * there less `.<suffix>.<format>`, and a skill's is its folder. Of two modules shipping one id, the first is kept.
 */
export function readSources(modules: Module[], collections: Record<string, Collection>, files: Map<string, string>) {
  const out: Record<string, Record<string, string>> = {
    collections: Object.fromEntries([...files].filter(([t]) => collections[t]).sort()),
    modules: Object.fromEntries(modules.map((t) => [moduleId(t.name), join(t.dir, "package.json")])),
  }
  for (const kind of SOURCE_KINDS.filter((t) => !out[t])) {
    const c = collections[kind]
    if (!c) continue
    const ids: Record<string, string> = {}
    for (const m of modules) {
      const base = join(m.dir, c.storage.path)
      for (const id of idsIn(base, c)) ids[id] ??= join(base, id + tail(c))
    }
    out[kind] = ids
  }
  return out
}
