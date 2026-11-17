import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { listFiles } from "../lib/listFiles.ts"
import { messageOf } from "../lib/messageOf.ts"
import type { Issue } from "../types/Issue.ts"
import type { Model } from "../types/Model.ts"
import { get } from "./get.ts"
import { listIds } from "./listIds.ts"
import { tail } from "./tail.ts"
import { validate } from "./validate.ts"
import { claims } from "./refuseTaken.ts"
import { relationsOf } from "../model/relationsOf.ts"
import { expectedMirrors, sameMirror } from "./expectedMirrors.ts"
import { stale } from "../harness/stale.ts"

/** Validate every record of every collection, and report the files no collection recognises; never modifies anything. */
export function check(model: Model) {
  const issues: Issue[] = [...model.issues]
  const unresolved = new Map<string, number>()
  // a source kind's records are the modules' files, checked when the model is built
  const stored = Object.values(model.collections).filter((t) => !isAbsolute(t.storage.path) && !model.sources[t.name])
  // a file belongs to a collection when it sits in the collection's folder and is named as its records are;
  // anything inside a folder-shaped collection belongs to its record
  function claimed(p: string) {
    return stored.some(
      (t) =>
        p.startsWith(join(model.root, t.storage.path) + sep) &&
        (t.storage.shape === "folder" || t.storage.format === "binary" || p.endsWith(tail(t))),
    )
  }
  const strays = new Set<string>()
  let records = 0
  const seen = new Map<string, Map<string, Record<string, unknown>>>()
  for (const c of stored) {
    const base = join(model.root, c.storage.path)
    if (c.storage.format === "binary") {
      if (existsSync(base))
        issues.push({
          severity: "warning",
          where: c.name,
          message: "binary storage is not supported — its files are not checked",
        })
      continue
    }
    let ids: string[]
    try {
      ids = listIds(model, c.name)
    } catch (e) {
      issues.push({ severity: "error", where: c.name, message: `cannot read ${c.storage.path}: ${messageOf(e)}` })
      continue
    }
    const read = new Map<string, Record<string, unknown>>()
    seen.set(c.name, read)
    for (const id of ids) {
      records++
      try {
        const data = get(model, `${c.name}/${id}`).data
        read.set(id, data)
        issues.push(...validate(model, c.name, id, data, unresolved))
      } catch (e) {
        issues.push({
          severity: "error",
          where: `${c.name}/${id}`,
          message: messageOf(e).replace(`${c.name}/${id}: `, ""),
        })
      }
    }
    // a unique value is reported on the second record that holds it, naming the first
    for (const [n, f] of Object.entries(c.fields)) {
      if (!f.unique || f.many) continue
      const first = new Map<unknown, string>()
      for (const [id, data] of read) {
        const v = data[n]
        const was = first.get(v)
        if (!claims(v)) continue
        if (was === undefined) first.set(v, id)
        else
          issues.push({
            severity: "error",
            where: `${c.name}/${id}`,
            message: `${n}: "${String(v)}" is already taken by ${c.name}/${was} (unique)`,
          })
      }
    }
    const data = c.storage.shape !== "folder" && resolve(base) !== resolve(model.root)
    if (data && existsSync(base))
      for (const p of listFiles(base))
        if (!claimed(p) && !strays.has(p) && strays.add(p))
          issues.push({
            severity: "warning",
            where: relative(model.root, p),
            message: `unrecognized file in the ${c.name} folder — a record there is named <id>${tail(c)}`,
          })
  }
  // a reverse field is derived from its owners: say which ones have fallen behind, and how to repair them
  for (const r of relationsOf(model)) {
    const owners = seen.get(r.owner)
    const targets = seen.get(r.target)
    if (!owners || !targets) continue
    const exp = expectedMirrors(r, owners)
    for (const [id, data] of targets)
      if (!sameMirror(r, data[r.mirror], exp.get(id)))
        issues.push({
          severity: "error",
          where: `${r.target}/${id}`,
          message: `${r.mirror}: stale — run: relations rebuild ${r.target}`,
        })
  }
  for (const [name, n] of unresolved)
    issues.push({
      severity: "warning",
      where: name,
      message: `a peer collection that is declared and not installed — ${n} reference(s) to it cannot be resolved`,
    })
  issues.push(...stale(model))
  const res: { records: number; issues: Issue[] } = { records, issues }
  return res
}
