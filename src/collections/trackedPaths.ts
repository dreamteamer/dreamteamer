import path from "node:path"
import type { Store } from "../record/Store.ts"
import { RUNTIME_DIR, readManifest } from "../runtime/runtime.ts"

/**
 * The TRACKED file(s) behind a record — what git actually has commits for.
 *
 * For an ordinary data record that is the record itself. For a SYSTEM-stored one (collections,
 * ui-views, skills, agents…) `store.read` hands back the compiled artifact under `.dreamteamer/`,
 * which is gitignored — asking git about it returns nothing, so history silently reported "no
 * history" for every schema and view record. The manifest already maps each runtime entry back to
 * the source(s) that produced it; those are the files with a past.
 *
 * A layered record (a workspace module overriding a module-shipped one) has SEVERAL sources and
 * genuinely changes when any of them does, so all of them are followed.
 */
export function trackedPaths(store: Store, file: string, cwd: string): string[] {
  const rel = path.relative(store.root, file).split(path.sep).join("/") // git pathspecs take `/` on every OS
  if (!rel.startsWith(`${RUNTIME_DIR}/`)) return [path.relative(cwd, file).split(path.sep).join("/")]
  try {
    const key = rel.split("/").slice(1).join("/") // drop the `.dreamteamer/` prefix
    const sources = readManifest(store.root)?.entries?.[key]?.sources ?? []
    const paths = sources.map((s: string | { path: string }) => (typeof s === "string" ? s : s?.path)).filter(Boolean)
    return paths.length ? paths : [rel]
  } catch {
    return [rel] // no manifest (never compiled) — nothing better to offer
  }
}
