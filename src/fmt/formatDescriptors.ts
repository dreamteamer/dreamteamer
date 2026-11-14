import path from "node:path"
import fs from "node:fs"
import { formatSource } from "./formatSource.ts"
import { Store } from "../store/Store.ts"
import { walk } from "../lib/walk.ts"
import { load } from "../lib/yaml.ts"
import type { Workspace } from "../types.ts"
import { V2_KEYS } from "../compile/consts.ts"
import { kindDir } from "../compile/compile.ts"
import { discoverModules } from "../workspace/discoverModules.ts"
import { isV2 } from "../compile/isV2.ts"
import type { RepoCommit, SourceDoc } from "../workspace/types.ts"
import { v1Refusal } from "../compile/v1Refusal.ts"
import { writeGated } from "../workspace/writeGated.ts"

/**
 * `dt fmt [<collection>]` — rewrite descriptor and mixin sources in block style with their top-level
 * keys in canonical order (`formatSource`). One collection's sources, or every inline source.
 *
 * A source under `git_modules/` or `node_modules/` belongs to another repo and is only counted: it
 * is formatted there. A v1 source is refused, every one listed, before anything is written. The
 * write goes through `writeGated` — comment guard, compile gate, one commit per repo.
 * @returns {{ changed: string[], unchanged: number, skipped: string[], commits?: object[] }}
 */
export function formatDescriptors(
  ws: Workspace,
  { collection = null, dryRun = false }: { collection?: string | null; dryRun?: boolean } = {}
): { changed: string[]; unchanged: number; skipped: string[]; commits?: RepoCommit[] } {
  const roots = [{ root: ws.root, channel: "inline" }, ...discoverModules(ws.root, ws.pkg).modules]
  const rel = (f: string): string => path.relative(ws.root, f)
  type Src = { file: string; text: string; doc: SourceDoc | null; kind: string }
  const sources: Src[] = [],
    skipped: Src[] = []
  for (const { root, channel } of roots) {
    for (const [kind, suffix] of [
      ["collections", ".collection.yaml"],
      ["mixins", ".mixin.yaml"],
    ]) {
      const dir = kindDir(root, kind)
      if ((collection && kind === "mixins") || !fs.existsSync(dir)) continue
      for (const file of [...walk(dir)].filter(f => f.endsWith(suffix))) {
        const text = fs.readFileSync(file, "utf8")
        let doc
        try {
          doc = load<SourceDoc | null>(text)
        } catch (e) {
          throw new Error(`${rel(file)}: ${e.message.split("\n")[0]} — fix the YAML, then re-run dt fmt`, { cause: e })
        }
        if (collection && doc?.name !== collection) continue
        ;(channel === "inline" ? sources : skipped).push({ file, text, doc, kind })
      }
    }
  }
  if (collection && !sources.length && !skipped.length)
    throw new Error(`no source declares collection "${collection}" — dt list collections names them`)
  const v1 = sources.filter(s => s.kind === "collections" && !isV2(s.doc)).map(s => rel(s.file))
  if (v1.length) throw new Error(v1Refusal(v1.sort()))
  const edits = sources.map(s => ({ ...s, out: formatSource(s.text, V2_KEYS) })).filter(s => s.out !== s.text)
  const result = {
    changed: edits.map(s => rel(s.file)),
    unchanged: sources.length - edits.length,
    skipped: skipped.map(s => rel(s.file)),
  }
  if (dryRun || !edits.length) return result
  const out = writeGated(
    ws,
    new Store(ws),
    edits.map(s => s.file),
    `dreamteamer: fmt ${edits.length} descriptor source(s)`,
    () => {
      for (const s of edits) fs.writeFileSync(s.file, s.out)
    }
  )
  return { ...result, commits: out.commits }
}
