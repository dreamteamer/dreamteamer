import path from "node:path"
import fs from "node:fs"
import { baseDescriptorSource } from "../lib/baseDescriptorSource.ts"
import { gatedTreeOp } from "../lib/gatedTreeOp.ts"
import { moduleRecord, pruneEmpty } from "../lib/schema-ops.ts"
import { IN_NODE_MODULES } from "../lib/consts.ts"
import type { Store } from "../store/Store.ts"
import { fieldsOf, isRuntime, moduleOf, targetsOf } from "../record/descriptor.ts"
import type { Descriptor, Field, Workspace } from "../types.ts"
import { kindDir } from "../compile/compile.ts"
import { moduleRows } from "../workspace/moduleRows.ts"

// ---- moving a collection between modules -------------------------------------------------------
// §7. `dt set collections/teams module=hr` — NOT `move`/`reorder` (the nav's order is nav.yaml since 0.49). The descriptor
// SOURCE relocates; the RECORDS do not, because a namespace and a `storage.path` are properties of
// the collection rather than of the module, so a move never changes an id and never touches data.

/**
 * WHAT THE MOVE WOULD MAKE ILLEGAL, and what the fix would cost — computed BEFORE anything moves.
 *
 * The reference contract says every collection a field references is owned by the
 * referencing module, declared in its `dependencies`, or named in its `peer_collections`. Moving a
 * collection changes who owns it, so it can break the contract in two directions at once: this
 * collection's own outbound refs, and every inbound ref pointing at it.
 *
 * ⚠ AND THE FIX CAN BE WORSE THAN THE BREAK. `dependencies` must be acyclic, so "add A to B's
 * dependencies" is only a fix when B does not already sit upstream of A — otherwise it is a ring,
 * and the honest answer is `peer_collections` (which names a COLLECTION and therefore cannot cycle)
 * or moving the other collection too. Naming the ring is the difference between a refusal an
 * operator can act on and one they have to re-derive.
 *
 * Reads the compiled projections through the Store rather than re-running discovery: `modules`
 * records carry `dependencies`, each compiled descriptor carries its `module`, and the manifest is
 * what actually compiled.
 */
function moveImpact(
  store: Store,
  name: string,
  toModule: string
): { referrer: string; target: string; owner: string; ring: boolean }[] {
  const mods = moduleRows(store)
  const depsOf = new Map(
    mods.map(m => [m.id, (m.fields.dependencies ?? []).map(r => String(r).replace(/^modules\//, ""))])
  )
  // the module RECORD's `peer_collections`, projected from package.json under the same name
  const peersOf = new Map(
    mods.map(m => [m.id, (m.fields.peer_collections ?? []).map(r => String(r).replace(/^collections\//, ""))])
  )
  const ownerOf = new Map<string, string>()
  for (const [id, d] of store.descriptors) ownerOf.set(id, moduleOf(d))
  ownerOf.set(name, toModule) // the world as the move would leave it

  /** Does `from` reach `to` along `dependencies`? */
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (depsOf.get(from) ?? []).some(d => reaches(d, to, seen))
  }

  const needs: ReturnType<typeof moveImpact> = []
  const add = (referrer: string, target: string): void => {
    const owner = ownerOf.get(target)
    if (!owner || owner === referrer) return
    if ((depsOf.get(referrer) ?? []).includes(owner)) return
    if ((peersOf.get(referrer) ?? []).includes(target)) return
    // CORE_COLLECTIONS is an implicit dependency of every module — the entity kinds the compiler
    // materializes plus `repos`. Asked of the descriptor rather than of a list here: a
    // runtime-stored collection is exactly that set.
    if (isRuntime(store.descriptors.get(target)) || target === "repos") return
    needs.push({ referrer, target, owner, ring: reaches(owner, referrer) })
  }

  for (const [cName, d] of store.descriptors) {
    const referrer = ownerOf.get(cName)
    if (!referrer) continue
    for (const target of outboundTargets(d)) {
      if (cName !== name && target !== name) continue // only edges this move actually re-owns
      add(referrer, target)
    }
  }
  return needs
}

/** Every collection a field of this descriptor references — a scalar or a union, on a top-level
 *  field or inside an object's `fields`. `reference` (any record) names no collection, so it is
 *  skipped: it is exempt from the reference contract by construction. */
function outboundTargets(d: Descriptor): Set<string> {
  const out = new Set<string>()
  const walkFields = (fields: Record<string, Field>) => {
    for (const f of Object.values(fields ?? {})) {
      const t = targetsOf(f)
      if (Array.isArray(t)) for (const x of t) out.add(x)
      if (f?.fields) walkFields(f.fields)
    }
  }
  walkFields(fieldsOf(d))
  return out
}

export function moveCollection(
  ws: Workspace,
  store: Store,
  name: string,
  toModule: string,
  { dryRun = false }: { dryRun?: boolean } = {}
) {
  const d = store.descriptor(name) // throws with the known-collection list
  if (isRuntime(d)) {
    throw new Error(`"${name}" is a compiled source, not a data collection — it has no module to move it to.`)
  }
  const to = moduleRecord(store, toModule) // throws with the known-module list
  const from = moduleOf(d)
  if (from === toModule) return { moved: false, name, from, to: toModule }
  if (IN_NODE_MODULES(to.fields.path)) {
    throw new Error(
      `module "${toModule}" ships from node_modules (${to.fields.path}) — a write there is erased by the next \`npm install\`. Vendor it into modules/ first.`
    )
  }
  const { base } = baseDescriptorSource(ws, name)
  if (!base)
    throw new Error(
      `"${name}" has no writable descriptor source in this workspace — the manifest names none under a module here.`
    )
  if (IN_NODE_MODULES(base)) {
    throw new Error(
      `"${name}" ships from node_modules (${base}) — a write there is erased by the next \`npm install\`. Add fields from your own module instead, which writes an overlay: dreamteamer add-field ${name} --module <your-module> …`
    )
  }

  // ---- the reference contract, BEFORE anything moves ------------------------------------------
  const needs = moveImpact(store, name, toModule)
  const plan = {
    name,
    from,
    to: toModule,
    needs,
    records: store.ids(name).size,
    refs: 0,
    // an overlay names the collection, never the module that owns it, so a move rewrites the base alone
    descriptors: 1,
    cleared: 0,
  }
  if (needs.length) {
    const lines = needs.map(n => {
      const fix = n.ring
        ? `${n.referrer} → ${n.owner} would be a ring (${n.owner} already reaches ${n.referrer}). Add ${n.target} to ${n.referrer}'s peer_collections (dt set modules/${n.referrer} peer_collections=collections/${n.target}), or move ${n.target} as well.`
        : `add it: dt set modules/${n.referrer} dependencies=modules/${n.owner} — or dt set modules/${n.referrer} peer_collections=collections/${n.target} if ${n.referrer} should work without it.`
      return `  ${n.referrer} references ${n.target}, owned by ${n.owner} after the move. ${fix}`
    })
    throw new Error(`move rolled back. ${name} → ${toModule} breaks the reference contract:\n${lines.join("\n")}`)
  }
  if (dryRun) return { ...plan, moved: false, dryRun: true }

  const dest = path.join(kindDir(path.join(ws.root, to.fields.path), "collections"), `${name}.collection.yaml`)
  if (fs.existsSync(dest))
    throw new Error(`${path.relative(ws.root, dest)} already exists — move or remove it first; nothing was moved`)
  const src = path.join(ws.root, base)
  const fromRow = moduleRows(store).find(m => m.id === from)
  // The floor `pruneEmpty` walks up to: the SOURCE MODULE'S OWN collections dir. Deriving it from
  // the path's first segment resolved to `<root>/modules`, which could delete the module's whole
  // `collections/` folder after its last collection left — re-triggering the "contributed no
  // recognised sources" warning for a module whose only kind folder that was.
  const pruneFloor = fromRow ? kindDir(path.join(ws.root, fromRow.fields.path), "collections") : path.dirname(src)

  const snapshots = new Map([[src, fs.readFileSync(src)]])
  const touched = new Set([base, path.relative(ws.root, dest)])
  let moved = false

  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: collections set ${name} module=${toModule}`,
    paths: [...touched],
    mutate: () => {
      // 1. the descriptor itself. Its BYTES, not a re-dump: a descriptor's comments are where a
      //    module writes down why the collection exists, and the move changes no key at all — the
      //    file is identical, at a new path.
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, snapshots.get(src))
      fs.rmSync(src)
      pruneEmpty(path.dirname(src), pruneFloor)
      moved = true

      return { paths: [...touched] }
    },
    undo: () => {
      if (moved && fs.existsSync(dest)) fs.rmSync(dest)
      for (const [f, bytes] of snapshots) {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, bytes)
      }
    },
  })
  return { ...plan, moved: true, commits: out.commits }
}
