import path from "node:path"
import fs from "node:fs"
import { load } from "../lib/yaml.ts"
import { runtimeDir } from "./runtime.ts"
import { STALE_RUNTIME } from "./consts.ts"
import type { Descriptor, Descriptors } from "../types.ts"

/** A kind's folder inside the compiled runtime. */
function runtimeKindDir(root: string, kind: string): string {
  return path.join(runtimeDir(root), kind)
}

/**
 * The merged collection descriptors, keyed by name — or `null` when nothing has been compiled.
 *
 * The ONE place descriptors are read. A descriptor without its `compiled` block was written by an
 * engine that read v1 sources; it is refused with the one message that fixes it, rather than read.
 */
export function loadDescriptors(root: string): Descriptors | null {
  const dir = runtimeKindDir(root, "collections")
  if (!fs.existsSync(dir)) return null
  const out: Descriptors = new Map()
  // RECURSIVE, because a namespaced collection compiles to `collections/<ns>/<name>.collection.yaml`
  // and this loop used to read exactly one directory level. ⚠ That was a SILENT failure, not an
  // error: compile wrote the nested file and reported ✔, this returned a Map without it, and the
  // collection was simply absent — `dt <c> list` said "unknown collection" for something that had
  // just compiled successfully. Keep the walk.
  for (const f of walkDescriptors(dir)) {
    const d = load<Descriptor>(fs.readFileSync(f, "utf8"))
    if (!d?.compiled) throw new Error(STALE_RUNTIME)
    out.set(d.name, d)
  }
  return out
}

/** Every `*.collection.yaml` under a directory, at any depth, in a stable order. */
function walkDescriptors(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkDescriptors(p, out)
    else if (e.name.endsWith(".collection.yaml")) out.push(p)
  }
  return out
}
