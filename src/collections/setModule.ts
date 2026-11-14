import path from "node:path"
import { editWorkspacePkg } from "./editWorkspacePkg.ts"
import { IN_NODE_MODULES, editModulePkg, moduleRecord, packageNameOf } from "./schema-ops.ts"
import type { Store } from "../record/Store.ts"
import type { DreamteamerBlock, Workspace } from "../types.ts"
import { writeGated } from "../workspace/writeGated.ts"

/** The settable fields of a `modules` record, and how each translates from the record-shaped value
 *  the operator types to the form the source file uses. */
const MODULE_SETTABLE: Record<
  string,
  { key: keyof DreamteamerBlock & string; from: (v: unknown, store: Store) => unknown }
> = {
  description: { key: "description", from: v => String(v) },
  dependencies: { key: "dependencies", from: (v, store) => asList(v).map(r => moduleIdFromRef(r, store)) },
  // the collections a module references but does not own — names, never references, in the source
  peer_collections: { key: "peer_collections", from: v => asList(v).map(r => String(r).replace(/^collections\//, "")) },
  // §8. A namespace is a plain name, not a reference — there is no `namespaces` collection and
  // there should not be: the value's whole job is to be parseable before anything has compiled.
  namespaces: {
    key: "namespaces",
    from: v =>
      asList(v)
        .map(x => x.replace(/^\/+|\/+$/g, ""))
        .filter(Boolean),
  },
}

const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v).split(",")).map(s => String(s).trim()).filter(Boolean)

/** `modules/core` → the package name `core` spells. A bare `core` is accepted and named as a
 *  mistake-in-waiting rather than silently: a reference VALUE is `<collection>/<id>` everywhere else
 *  in this engine, and `check` rejects the bare form. */
function moduleIdFromRef(ref: unknown, store: Store): string | undefined {
  const s = String(ref)
  if (!s.startsWith("modules/")) {
    throw new Error(
      `dependencies takes record-shaped values — write "modules/${s}", not "${s}" (a reference is <collection>/<id> everywhere in this engine).`
    )
  }
  return packageNameOf(store, s.slice("modules/".length))
}

export function setModule(ws: Workspace, store: Store, id: string, changes: Record<string, unknown>) {
  const rec = moduleRecord(store, id)
  const unknown = Object.keys(changes).filter(k => !(k in MODULE_SETTABLE))
  if (unknown.length) {
    throw new Error(
      `"${unknown[0]}" is not a settable field of modules — settable: ${Object.keys(MODULE_SETTABLE).join(", ")}. Everything else on a module record is PROJECTED by compile from its package.json.`
    )
  }
  const file = path.join(ws.root, rec.fields.path, "package.json")
  if (IN_NODE_MODULES(rec.fields.path)) {
    throw new Error(
      `module "${id}" ships from node_modules (${rec.fields.path}) — a write there is erased by the next \`npm install\`. Vendor it into modules/ or install it as a git module.`
    )
  }
  const changed: string[] = []
  // ⚠ THE WORKSPACE'S REDUNDANT COPY GOES IN THE SAME WRITE. Declaring a namespace on the module
  // is what makes the workspace-level entry redundant, and compile WARNS about it — so leaving it
  // behind makes the warning permanent and the fix a second command nobody is told to run.
  const wsFile = path.join(ws.root, "package.json")
  const files = "namespaces" in changes ? [file, wsFile] : [file]
  const gate = writeGated(
    ws,
    store,
    files,
    `dreamteamer: modules set ${id}`,
    () => {
      let declared: string[] = []
      editModulePkg(file, dt => {
        for (const [k, raw] of Object.entries(changes)) {
          const spec = MODULE_SETTABLE[k]
          // An empty value REMOVES the key — the same convention `store.set` has always had for a
          // record field, extended to the package.json a module record is projected from.
          if (raw === "" || raw === null) {
            delete dt[spec.key]
            changed.push(k)
            continue
          }
          const value = spec.from(raw, store)
          if (Array.isArray(value) && !value.length) {
            delete dt[spec.key]
            changed.push(k)
            continue
          }
          dt[spec.key] = value
          changed.push(k)
          if (k === "namespaces") declared = value as string[] // the namespaces spec maps to a list
        }
      })
      if (declared.length) {
        editWorkspacePkg(ws, dt => {
          if (!Array.isArray(dt.namespaces)) return
          dt.namespaces = dt.namespaces.filter(n => !declared.includes(String(n).replace(/^\/+|\/+$/g, "")))
          if (!dt.namespaces.length) delete dt.namespaces
        })
      }
    },
    undefined,
    { commentsMayDecrease: true }
  )
  return { id, file, changed, commits: gate.commits, unchanged: gate.unchanged }
}
