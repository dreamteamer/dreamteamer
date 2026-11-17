import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { entryOf, tail } from "../store/tail.ts"
import { git } from "./git.ts"
import { parseRef } from "./parseRef.ts"
import type { Store } from "./Store.ts"

/** what each git status letter means for a record */
const VERBS: Record<string, string> = { A: "add", M: "set", D: "rm", R: "rename", "?": "add" }

type Row = { verb: string; collection: string; id: string; file: string }

/** the record a changed file belongs to, or null: a folder record's other files count as its own */
function recordOf(store: Store, rel: string): Omit<Row, "verb"> | null {
  for (const c of Object.values(store.model.collections)) {
    const base = c.storage.path + "/"
    if (store.model.sources[c.name] || !rel.startsWith(base)) continue
    if (c.storage.shape !== "folder") {
      if (rel.endsWith(tail(c))) return { collection: c.name, id: rel.slice(base.length, -tail(c).length), file: rel }
      continue
    }
    for (let d = dirname(rel); d.length > c.storage.path.length; d = dirname(d))
      if (rel === `${d}/${entryOf(c)}` || existsSync(join(store.root, d, entryOf(c))))
        return { collection: c.name, id: d.slice(base.length), file: rel }
  }
  return null
}

/** one line for what the rows change */
function subjectOf(rows: Row[]) {
  if (rows.length === 1) return `dreamteamer: ${rows[0].collection} ${rows[0].verb} ${rows[0].id}`
  return `dreamteamer: ${rows.length} changes across ${[...new Set(rows.map((t) => t.collection))].sort().join(", ")}`
}

/**
 * Publish the records written and not yet committed — all, or those `only` names (a collection or a
 * `<collection>/<id>`) — in one commit of the workspace's repository, their files and nothing else; a dry run only
 * says what would be. Review: the released engine also sweeps in the reverse fields a change dirtied, per repository
 * and under a write lock; this commits what is named, in the workspace's own repository.
 */
export function commitPending(store: Store, opts: { only?: string[]; message?: string; dryRun?: boolean } = {}) {
  const only = opts.only ?? []
  const dirs = Object.values(store.model.collections)
    .filter((t) => !store.model.sources[t.name] && existsSync(join(store.root, t.storage.path)))
    .map((t) => t.storage.path)
  const out = dirs.length ? git(store.root, ["status", "--porcelain", "-z", "-uall", "--", ...new Set(dirs)]) : ""
  // git names each file from the top of its repository; the workspace may sit below it
  const prefix = out ? git(store.root, ["rev-parse", "--show-prefix"]).trim() : ""
  const parts = out.split("\0")
  const rows: Row[] = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    const status = parts[i].slice(0, 2).trim()[0] ?? "M"
    const path = parts[i].slice(3)
    const rec = path.startsWith(prefix) ? recordOf(store, path.slice(prefix.length)) : null
    if (status === "R" || status === "C") i++
    const ref = rec && `${rec.collection}/${rec.id}`
    if (rec && ref && (!only.length || only.includes(rec.collection) || only.includes(ref)))
      rows.push(Object.assign({ verb: VERBS[status] ?? "set" }, rec))
  }
  // a reference nothing is pending under must still name a record: a mistyped one is not "nothing pending"
  for (const t of only) {
    if (store.descriptors.has(t) || rows.some((r) => `${r.collection}/${r.id}` === t)) continue
    const at = parseRef(t, store.namespaces)
    if (!at) throw new DtError(`${t}: not a collection or a <collection>/<id> — nothing committed`)
    store.locate(at.collection, at.id)
  }
  if (!rows.length) return []
  const subject = opts.message ?? subjectOf(rows)
  const files = [...new Set(rows.map((t) => t.file))]
  if (!opts.dryRun) {
    git(store.root, ["add", "-A", "--", ...files])
    git(store.root, ["commit", "--quiet", "-m", subject, "--", ...files])
  }
  const sha = opts.dryRun ? null : git(store.root, ["rev-parse", "--short", "HEAD"]).trim()
  const res = [
    { repo: ".", rows: rows.map((t) => ({ verb: t.verb, collection: t.collection, id: t.id })), subject, sha },
  ]
  return res
}
