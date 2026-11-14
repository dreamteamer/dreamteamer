import { recordRewrites } from "./recordRewrites.ts"
import { renameInDisplay } from "./renameInDisplay.ts"
import { renameMirrorOf } from "./renameMirrorOf.ts"
import { renameOwnField } from "./renameOwnField.ts"
import { renameKey, viewCollection } from "./schema-ops.ts"
import { FILTER_KEYS } from "./consts.ts"
import type { SourceVisitor, Walk } from "./types.ts"
import { walkFilter } from "./walkFilter.ts"
import { walkSources } from "./walkSources.ts"
import type { Store } from "../record/Store.ts"
import { bodyFieldOf, fieldsOf } from "../record/descriptor.ts"
import type { Field, Workspace } from "../types.ts"

// ---- rename-field ------------------------------------------------------------------------------

/** Every position a rename of `collection.from` → `to` rewrites, the records it rewrites, and what
 *  it cannot. Read-only: the dry run IS this. */
export function fieldRenameWalk(
  ws: Workspace,
  store: Store,
  collection: string,
  from: string,
  to: string,
  { records: withRecords = true }: { records?: boolean } = {}
): Walk {
  const fieldsOfColl = (c: string): Record<string, Field> =>
    store.descriptors.has(c) ? fieldsOf(store.descriptor(c)) : {}
  const visit: SourceVisitor = {
    own: (doc, at) => renameOwnField(doc, from, to, at),
    foreign: (doc, at) => renameMirrorOf(doc, collection, from, to, at),
    view: (doc, kind, at) => {
      const over = viewCollection(doc)
      if (over === collection && kind === "ui-views") renameInDisplay(doc.display, from, to, at, "display")
      for (const key of FILTER_KEYS[kind]) {
        walkFilter(
          doc[key],
          over,
          fieldsOfColl,
          {
            field: (node, k, coll, note, label) => {
              if (coll !== collection || k !== from) return
              const rebuilt = renameKey(node, from, to)
              for (const x of Object.keys(node)) delete node[x]
              Object.assign(node, rebuilt)
              note(`${label}.${from}`, undefined, to)
            },
            union: (cond, targets, note, label) => {
              if (targets.includes(collection) && from in cond)
                note(
                  `${label}.${from}`,
                  `a filter hop through a union (${targets.join(", ")}) cannot say which member's "${from}" it means — rewrite it by hand`
                )
            },
          },
          at,
          key
        )
      }
    },
  }
  const { positions, edits } = walkSources(ws, store, collection, visit)
  const d = store.descriptor(collection)
  // the body field has no frontmatter key: its value is the prose, which `serialize` writes back under
  // whatever the descriptor now calls it — the rename, done
  const records =
    !withRecords || from === bodyFieldOf(d)
      ? []
      : recordRewrites(store, collection, fields => (from in fields ? renameKey(fields, from, to) : null))
  return { positions, edits, records }
}
