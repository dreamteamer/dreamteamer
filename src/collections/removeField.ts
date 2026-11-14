import fs from "node:fs"
import { removeFieldPlan } from "./removeFieldPlan.ts"
import { OPTION_FIELD_KEYS, OPTION_FIELD_LISTS, asTree, refusePositions } from "./schema-ops.ts"
import { Store } from "../record/Store.ts"
import { atomicWrite } from "../record/atomicWrite.ts"
import { bodyFieldOf, fieldsOf } from "../record/descriptor.ts"
import { parseRecord } from "../record/records.ts"
import { serialize } from "../record/serialize.ts"
import { writeSource } from "../record/writeSource.ts"
import { load } from "../record/yaml.ts"
import type { Workspace } from "../types.ts"
import type { SourceDoc } from "../workspace/types.ts"
import { writeGated } from "../workspace/writeGated.ts"

/**
 * Clear one field's values from every record of a collection — the other half of removing it.
 *
 * A removed field whose values stay in the files leaves the collection READABLE AND UNWRITABLE: the
 * key is now an unknown field, `check` reports it and the store refuses the next write to that
 * record. So the op that creates the staleness cleans it up, in the same write and the same commit.
 * A mirror is a field like any other here: its values live in this collection's records.
 *
 * ⚠ THIS DELETES DATA, deliberately: removing a field is an explicit destructive schema act, it runs
 * inside the gate's commit, so the previous values are one `git show HEAD~1` away, and the COUNT is
 * returned and printed — a silent deletion and a reported one are different acts.
 *
 * ⚠ THE BODY FIELD needs none of this. With the field gone the descriptor names no body, so the
 * prose is not parsed into `fields` at all and stays in the file as Markdown no field claims.
 */
function clearFieldValues(
  store: Store,
  collection: string,
  fieldName: string
): { files: string[]; undo: () => void; records: number } {
  const d = store.descriptors.get(collection)
  // a binary record has no serialised fields, and a compiled-source collection is a build artifact
  if (!d || !store.canRewrite(collection)) return { files: [], undo: () => {}, records: 0 }
  const bf = bodyFieldOf(d)
  const files: string[] = [],
    undos: (() => void)[] = []
  for (const [, file] of store.ids(collection)) {
    let fields
    try {
      fields = parseRecord(file, d, bf)
    } catch {
      continue
    } // `check` reports a bad record
    if (!(fieldName in fields)) continue
    const previous = fs.readFileSync(file, "utf8")
    delete fields[fieldName]
    atomicWrite(file, serialize(d, fields, previous))
    files.push(file)
    undos.push(() => atomicWrite(file, previous))
  }
  return {
    files,
    undo: () => {
      for (const u of [...undos].reverse()) u()
    },
    records: files.length,
  }
}

/** Prune the field's own presentation from one parsed source, dropping what the prune empties. */
function pruneFieldPresentation(doc: SourceDoc, fieldName: string): void {
  const display = asTree(doc.display)
  if (!display) return
  const list = asTree(display.list)
  if (list) {
    if (Array.isArray(list.columns)) {
      list.columns = list.columns.filter(c => c !== fieldName)
      if (!(list.columns as unknown[]).length) delete list.columns
    }
    if (typeof list.sort === "string" && list.sort.replace(/^-/, "") === fieldName) delete list.sort
    const options = asTree(list.options)
    if (options) {
      for (const k of OPTION_FIELD_KEYS) if (options[k] === fieldName) delete options[k]
      for (const k of OPTION_FIELD_LISTS) {
        const listed = options[k]
        if (!Array.isArray(listed)) continue
        const kept = listed.filter(c => c !== fieldName)
        options[k] = kept
        if (!kept.length) delete options[k]
      }
      if (!Object.keys(options).length) delete list.options
    }
  }
  const record = asTree(display.record)
  for (const k of ["badge", "color_by"]) if (record?.[k] === fieldName) delete record[k]
  const form = asTree(display.form)
  if (form && Array.isArray(form.sections)) {
    form.sections = form.sections
      .map((s: unknown) => {
        const sec = asTree(s)
        return Array.isArray(sec?.fields) ? { ...sec, fields: sec.fields.filter(f => f !== fieldName) } : s
      })
      .filter((s: unknown) => {
        const fields = asTree(s)?.fields
        return !Array.isArray(fields) || fields.length
      })
    if (!(form.sections as unknown[]).length) delete form.sections
  }
  for (const b of Object.keys(display)) {
    const block = asTree(display[b])
    if (block && !Object.keys(block).length) delete display[b]
  }
  if (!Object.keys(display).length) delete doc.display
}

export function removeField(
  ws: Workspace,
  store: Store,
  collection: string,
  fieldName: string,
  { moduleId, dryRun = false }: { moduleId?: string; dryRun?: boolean } = {}
) {
  const plan = removeFieldPlan(ws, store, collection, fieldName, { moduleId })
  if (dryRun) return { ...plan, dryRun: true }
  // ⚠ A NAME ANOTHER POSITION STILL CARRIES IS REFUSED, not left dangling: compile validates every
  // one of them (rule 6), and a template, a constraint, a mirror or a view naming a field that is
  // gone is a decision about what it should say instead — which is the operator's to make.
  refusePositions(`rm-field ${collection} --name ${fieldName}`, plan.blocking)
  const dest = plan.file
  const previousText = fs.readFileSync(dest, "utf8")
  const doc = load<SourceDoc | null>(previousText)
  const out = writeGated(
    ws,
    store,
    [dest],
    `dreamteamer: ${collection} rm-field ${fieldName}`,
    () => {
      delete doc.fields[fieldName]
      pruneFieldPresentation(doc, fieldName)
      // an overlay whose last field is gone adds nothing to the merge — removing its last field
      // removes the file
      if (
        doc.overlay === true &&
        !Object.keys(doc.fields).length &&
        Object.keys(doc).every(k => ["name", "overlay", "fields"].includes(k))
      )
        fs.rmSync(dest)
      else fs.writeFileSync(dest, writeSource(previousText, doc))
    },
    () => {
      const after = new Store(ws) // the runtime as the gate compile just left it
      if (fieldsOf(after.descriptor(collection))[fieldName]) return {}
      const own = clearFieldValues(after, collection, fieldName)
      return { files: own.files, undo: own.undo, cleared: own.records }
      // ⚠ THE ONE OP THAT MAY LOSE A COMMENT: the comment above a field explains THAT field, so
      // removing the field takes it, which is the outcome asked for.
    },
    { commentsMayDecrease: true }
  )
  return { collection, removed: fieldName, cleared: out.cleared, commits: out.commits }
}
