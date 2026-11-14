import path from "node:path"
import type { Entry, LoadedExtension } from "../types.ts"
import { buildCollectionsIndex } from "./buildCollectionsIndex.ts"
import { buildModulesIndex } from "./buildModulesIndex.ts"
import type { Contributions, HarnessOut } from "./types.ts"

/**
 * Run every piece of EXTENSION code the harness pass needs — contributed renderers and orientation
 * paragraphs — and return plain data. Compile calls this BEFORE it replaces a single runtime byte: a
 * renderer that throws used to do so halfway through materialization, leaving new descriptors beside
 * the old manifest (review F7). Anything invalid is refused here with the extension's name.
 */
export function renderContributions({
  entries,
  harnesses,
  version = "unknown",
  extensions = [],
}: {
  entries: Map<string, Entry>
  harnesses: string[]
  version?: string
  extensions?: LoadedExtension[]
}): Contributions {
  const rendered: Contributions["rendered"] = []
  const paragraphs: string[] = []
  for (const e of extensions) {
    const where = (what: string): string => `extension ${e.name}: ${what}`
    try {
      const p = typeof e.orientation === "function" ? e.orientation({ entries }) : e.orientation
      if (typeof p === "string" && p.trim()) paragraphs.push(p)
    } catch (err) {
      throw new Error(where(`orientation failed — ${err.message}`), { cause: err })
    }
    for (const [id, render] of Object.entries(e.harnesses ?? {})) {
      if (!harnesses.includes(id)) continue
      let out: HarnessOut
      try {
        out =
          (render({
            entries,
            version,
            collections: buildCollectionsIndex(entries),
            modules: buildModulesIndex(entries),
          }) as HarnessOut | null | undefined) ?? {}
      } catch (err) {
        throw new Error(where(`harness "${id}" failed — ${err.message}`), { cause: err })
      }
      for (const [file, content] of Object.entries(out.blocks ?? {})) {
        const norm = path.posix.normalize(file)
        if (path.isAbsolute(file) || norm.startsWith("..") || norm.includes("/../"))
          throw new Error(where(`harness "${id}" writes "${file}", which is not a path inside the workspace`))
        if (content != null && typeof content !== "string")
          throw new Error(
            where(
              `harness "${id}" returned a ${typeof content} block for ${file} — a block is text, or null to remove it`
            )
          )
      }
      rendered.push([id, out])
    }
  }
  return { rendered, paragraphs }
}
