import path from "node:path"
import fs from "node:fs"
import { baseDescriptorSource } from "../lib/baseDescriptorSource.ts"
import { descriptorSources } from "./lib/descriptorSources.ts"
import { mixinSources } from "./lib/mixinSources.ts"
import { pruneEmpty, workspaceSystemDir } from "../lib/schema-ops.ts"
import { IN_NODE_MODULES } from "../lib/consts.ts"
import { viewSources } from "./lib/viewSources.ts"
import type { Store } from "../record/Store.ts"
import { isRuntime } from "../record/descriptor.ts"
import { idFromRecordPath } from "../record/idFromRecordPath.ts"
import { baseNameOf, defaultStoragePath, namespaceOf } from "../record/namespace.ts"
import { singular } from "../lib/singular.ts"
import { storageOf } from "../record/storageOf.ts"
import { walk } from "../lib/walk.ts"
import { writeSource } from "../lib/writeSource.ts"
import { commentCount, load } from "../lib/yaml.ts"
import { readManifest } from "../runtime/runtime.ts"
import type { Descriptor, Field, PackageJson, Workspace } from "../types.ts"
import { commitByRepo } from "../workspace/commitByRepo.ts"
import { compile, kindDir } from "../workspace/compile.ts"
import type { SourceDoc } from "../workspace/types.ts"

/**
 * WHERE A COLLECTION'S DESCRIPTOR ACTUALLY LIVES — asked of the manifest, not assumed.
 *
 * `renameCollection` used to derive this from `workspaceSystemDir`, which silently meant "only the
 * workspace module's own collections can be renamed". That is the wrong line. The guard exists to
 * stop a write that will be ERASED, and the thing that erases writes is `npm install` — so the test
 * is `node_modules/`, not "which module". A module whose sources are inline in the workspace repo is
 * under the same git history as everything else and is perfectly safe to rewrite; refusing it made
 * `collections rename` unusable for exactly the migration it was built for, because a workspace's
 * domain collections almost always live in a module.
 *
 * Returns `{ dir, file, overlays, sources }` — the base's kind dir to write into (the SAME module the
 * descriptor came from, so a rename never teleports a collection into the workspace module) and its
 * file; each overlay as `{ dir, file }` in ITS module, so the rename carries it along; and every
 * descriptor source that contributed, so the caller can refuse the cases this cannot honestly do.
 */
function descriptorSourceDir(ws: Workspace, name: string) {
  // The base is the source without `overlay: true` — see baseDescriptorSource; discovery order
  // says nothing about which source is which.
  const { base, overlays, sources } = baseDescriptorSource(ws, name)
  // ⚠ `dir` IS THE OWNING MODULE'S `collections/` KIND DIR — asked of the manifest's module list,
  // not re-derived by stripping the collection's name off the source path. That arithmetic only
  // worked while the source path mirrored the name, which a module owning its own namespace need
  // not do (see baseDescriptorSource). `file` is the ACTUAL path, so a caller renaming it moves the
  // file that exists rather than a path it assumed.
  const roots = (readManifest(ws.root)?.modules ?? []).map(m => (m.root === "." ? "" : `${m.root}/`))
  const at = (rel: string): { dir: string; file: string } => {
    const mod = roots.filter(r => r === "" || rel.startsWith(r)).sort((a, b) => b.length - a.length)[0] ?? ""
    return { dir: kindDir(path.join(ws.root, mod), "collections"), file: path.join(ws.root, rel) }
  }
  if (!base) return { dir: null, file: null, overlays: overlays.map(at), sources }
  return { ...at(base), overlays: overlays.map(at), sources }
}

/**
 * Rename a collection — descriptor, records, and every inbound reference, in ONE commit.
 *
 * This exists because namespacing EXISTING data was otherwise a hand migration: `git mv` the
 * descriptor, edit `name` and `storage.path`, `git mv` the record folder, re-suffix every file, then
 * find and rewrite every reference — six steps with no gate, where forgetting the last one dangles
 * every link silently. `dt collections rename doctors health/doctors` is the whole thing.
 *
 * DERIVED-VS-AUTHORED is the rule for both moving parts, the same rule `createCollection` uses:
 *  - `storage.path` moves only if it was DERIVED (equal to the default for the old name). An authored
 *    path is a deliberate choice about where records live and a rename must not overrule it.
 *  - `storage.suffix` is re-derived only if it was DERIVED (the singular of the old base name), because
 *    otherwise the filenames would start lying about what they hold. `doctors` → `health/doctors` keeps
 *    the base name, so nothing is re-suffixed — which is the common case and the cheap one.
 *
 * References are rewritten by asking the STORE to do it, in ONE batch of old→new pairs, rather than
 * by matching the collection prefix with a new regex. `store.rewriteRefsBatch` already knows the
 * boundary rules and already scopes prose to `[[wikilinks]]` (decision 7) — a fresh `oldName/`
 * pattern would have to relearn both, and would corrupt `data/tasks/` in a path or a URL on its
 * first outing.
 *
 * ⚠ IT USED TO BE O(records x files), TWICE, and the history is worth keeping because each stage was
 * measured and each was wrong about the one after it. Measured 2026-08-17 on a real 2,291-record
 * collection in a 3,391-file workspace: 3 minutes, 142s of it system time, 7.7M file reads to
 * rewrite ZERO references — the pass ran per id whether or not anything pointed at the collection.
 * Reproduced 2026-08-22 by `npm run perf -- --records=2291 --filler=1100`, which generates a
 * workspace that shape, and the real number was **15.6M reads, not 7.7M**: `captureRefs` walked
 * every record file for the rollback snapshot before `rewriteRefs` walked them all again, so 7.7M
 * was the PER-PASS number. That is what a generated fixture is for — the finding was right about the
 * shape and off by 2x on the count, and no comment could have told you.
 *
 * Both factors are gone as of 2026-09-01. The rewrite is one pass for every id, and the snapshot
 * pass disappeared entirely because the rewrite snapshots what it writes as it writes it.
 * `--records=400 --filler=100`, the same machine, best of three: 6.39s and 410,678 reads → 0.16s
 * and 1,075 — which is 504 files twice over, the batch pass and the `collections/<name>` one.
 */
export function renameCollection(ws: Workspace, store: Store, oldName: string, newName: string) {
  const d = store.descriptor(oldName) // throws with the known-collection list if absent
  if (!newName) throw new Error("missing new collection name")
  if (oldName === newName) return { renamed: false as const, name: newName }

  // ⚠ THE COMPILED SET (§8) — the declaration may live in any module's package.json now, and the
  // union is what compile stamped into the manifest.
  const declared = store.namespaces
  if (newName.includes("/") && !namespaceOf(newName, declared)) {
    throw new Error(
      `namespace "${newName.slice(0, newName.lastIndexOf("/"))}" is not declared — declare it where the collection will live (dt set modules/<m> namespaces=<ns>), or in dreamteamer.namespaces for a workspace-level one.`
    )
  }
  if (store.descriptors.has(newName)) throw new Error(`collection "${newName}" already exists`)
  if (isRuntime(d)) throw new Error(`"${oldName}" is a compiled source, not a data collection — it cannot be renamed`)
  // Its records are spread across the parent's folders, and the per-file re-suffix below walks ONE
  // directory. Refused rather than half-done — the fix is small and nothing has asked for it yet.
  if (storageOf(d).under)
    throw new Error(
      `"${oldName}" is stored under ${storageOf(d).under.collection} (storage.under) — renaming a placed collection is not supported yet. The supported order: dreamteamer relocate ${oldName} --to-root · remove storage.under from its descriptor · compile · rename · declare storage.under again · compile · dreamteamer relocate ${newName}`
    )

  // The descriptor is renamed IN THE MODULE THAT SHIPS IT — see `descriptorSourceDir` — and so is
  // every overlay of it, each in its own module: an overlay names only the collection, so one left
  // behind would overlay a collection with no base. Refused where doing it halfway is worse than not
  // doing it:
  const { dir: sourceDir, file: sourceFile, overlays, sources } = descriptorSourceDir(ws, oldName)
  const shipped = sources.find(p => IN_NODE_MODULES(p))
  if (shipped) {
    throw new Error(
      `"${oldName}" ships from node_modules (${shipped}) — a write there is erased by the next \`npm install\`. rename it in its own repo and release.`
    )
  }
  // An overlay's `storage` wins over the base's, and the path and suffix are re-derived from the
  // base's below — so an overlay that sets either has no rename this can do honestly.
  const overlayMoves = overlays.map(({ dir, file }) => {
    const text = fs.readFileSync(file, "utf8")
    const odoc = load<SourceDoc | null>(text)
    const set = (["path", "suffix"] as const).filter(k => odoc?.storage?.[k] !== undefined)
    if (set.length)
      throw new Error(
        `${path.relative(ws.root, file)} overlays "${oldName}" and sets storage.${set.join(" and storage.")} — move ${set.length === 1 ? "it" : "them"} into the base descriptor, then rename. nothing was renamed.`
      )
    const to = path.join(dir, `${newName}.collection.yaml`)
    if (to !== file && fs.existsSync(to))
      throw new Error(`${path.relative(ws.root, to)} already exists — move or remove it first; nothing was renamed`)
    return { file, to, text, doc: odoc }
  })
  // The base's ACTUAL path, not one rebuilt from the name — a module that owns its namespace may
  // author `collections/positions.collection.yaml` as `hr/positions`, and rebuilding the path then
  // named a file that does not exist.
  const src = sourceFile ?? path.join(workspaceSystemDir(ws, "collections"), `${oldName}.collection.yaml`)
  const dest = path.join(sourceDir ?? workspaceSystemDir(ws, "collections"), `${newName}.collection.yaml`)
  if (!fs.existsSync(src)) {
    throw new Error(
      `"${oldName}" has no writable descriptor source — the manifest names none under a module in this workspace. it may be contributed by the engine itself.`
    )
  }

  const doc = load<SourceDoc | null>(fs.readFileSync(src, "utf8"))
  const dataPath = ws.pkg.dreamteamer?.data_path ?? "data"
  // `d` is the COMPILED descriptor, so its storage.path already carries any module prefix; the
  // authored source is what we compare against, and what we rewrite.
  const authoredPath = String(doc.storage?.path ?? "")
  const pathWasDerived = authoredPath === "" || authoredPath === defaultStoragePath(oldName, declared, dataPath)
  const newPath = pathWasDerived ? defaultStoragePath(newName, declared, dataPath) : authoredPath

  const oldBase = baseNameOf(oldName, declared)
  const newBase = baseNameOf(newName, declared)
  const oldSuffix = storageOf(d).suffix
  // AUTHORED is the test: an absent suffix is compile's default and follows the name by itself. An
  // authored one that merely spells the old default is re-derived too, so filenames keep telling the
  // truth about what they hold.
  const authoredSuffix = doc.storage?.suffix
  const suffixWasDerived = authoredSuffix === undefined || authoredSuffix === singular(oldBase)
  const newSuffix = suffixWasDerived ? singular(newBase) : oldSuffix

  // Every id BEFORE anything moves — the store's index is keyed on the old collection.
  const ids = [...store.ids(oldName).keys()]
  for (const [id, f] of store.ids(oldName)) {
    const layer = store.layerOfFile(d, f)
    if (layer)
      throw new Error(
        `${oldName}/${id} is held by layer ${layer.layer} (${layer.path}) — a collection with records in a record layer is renamed in that workspace first; nothing was renamed`
      )
  }
  const oldDir = store.dir(d)
  const newDir = path.join(ws.root, newPath)
  if (newDir !== oldDir && fs.existsSync(newDir)) {
    throw new Error(`${newPath} already exists on disk — move or remove it first; nothing was renamed`)
  }

  // ---- rollback state, captured before the first mutation --------------------------------------
  const srcBytes = fs.readFileSync(src)
  let movedData = false
  const resuffixed: [string, string][] = []
  const undo = () => {
    for (const [from, to] of resuffixed) {
      if (fs.existsSync(to)) fs.renameSync(to, from)
    }
    if (movedData && fs.existsSync(newDir)) {
      fs.mkdirSync(path.dirname(oldDir), { recursive: true })
      fs.renameSync(newDir, oldDir)
      pruneEmpty(path.dirname(newDir), path.join(ws.root, dataPath))
    }
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, srcBytes)
    if (dest !== src) fs.rmSync(dest, { force: true })
    for (const o of overlayMoves) {
      fs.mkdirSync(path.dirname(o.file), { recursive: true })
      fs.writeFileSync(o.file, o.text)
      if (o.to !== o.file) fs.rmSync(o.to, { force: true })
    }
  }

  return store.withWriteLock(() => {
    // ⚠ THERE IS NO CAPTURE PASS ANY MORE. This used to ask `findInboundRefs` per id — a full walk
    // of every record file — purely to snapshot the referencing files for rollback, and then step 2
    // walked them all again to rewrite them: the same bytes read twice, per id. The rewrite
    // snapshots what it writes as it writes it (`store.rewriteRefsBatch`), so its own `restore` is
    // the rollback and the pre-walk is pure cost. `refFiles` holds the sources steps 4 and 5
    // rewrite (descriptors, mixins, views, package.json files), which no record walk visits.
    const refFiles = new Map()
    const rootPkg = path.join(ws.root, "package.json")
    const undoRewrites: (() => void)[] = []
    const restoreRefs = () => {
      // reverse-chronological: one file can be written by both ref passes, and undoing the earlier
      // write first would leave the later one standing
      for (const u of [...undoRewrites].reverse()) u()
      for (const [f, bytes] of refFiles) {
        fs.mkdirSync(path.dirname(f), { recursive: true }) // pruneEmpty may have taken the parent
        fs.writeFileSync(f, bytes)
      }
    }

    const touched = new Set<string>()
    let rewrites = 0
    try {
      // 1. the descriptor source, at its new path — ROUND-TRIPPED, never re-dumped.
      //
      // ⚠ `fs.writeFileSync(dest, dump(doc))` destroyed every comment in the descriptor, and a
      // descriptor's comments are where this project keeps its reasoning: 194 lines across 24
      // files in one real migration, including 22-line headers stating what belongs in a
      // collection and which failure mode it guards against. The record survived; the thinking
      // did not, and nothing said so.
      //
      // A rename changes `name`, and `storage.path`/`storage.suffix` only where they are AUTHORED —
      // an absent one is compile's default and follows the name by itself. `writeSource` rewrites
      // exactly those; every other byte is restored from the source it was parsed out of. The parse
      // afterwards still proves the edit landed rather than trusting the writer, and the comment
      // count is asserted here because a rename does not go through `writeGated`'s invariant.
      const beforeText = srcBytes.toString("utf8")
      doc.name = newName
      if (authoredPath !== "") doc.storage.path = newPath
      if (authoredSuffix !== undefined) doc.storage.suffix = newSuffix
      const edited = writeSource(beforeText, doc)
      const parsed = load<SourceDoc | null>(edited)
      if (
        parsed?.name !== newName ||
        (authoredPath !== "" && parsed?.storage?.path !== newPath) ||
        (authoredSuffix !== undefined && parsed?.storage?.suffix !== newSuffix)
      ) {
        throw new Error(
          `could not rewrite ${path.relative(ws.root, src)} in place — name/storage.path/storage.suffix did not take. nothing was changed.`
        )
      }
      if (commentCount(edited) < commentCount(beforeText)) {
        throw new Error(
          `renaming "${oldName}" would lose ${commentCount(beforeText) - commentCount(edited)} comment line(s) from ${path.relative(ws.root, src)} — nothing was changed.`
        )
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, edited)
      if (dest !== src) fs.rmSync(src)
      touched.add(src)
      touched.add(dest)
      // each overlay the same way: only its `name` changes, round-tripped over its own bytes
      for (const o of overlayMoves) {
        o.doc.name = newName
        const out = writeSource(o.text, o.doc)
        if (load<SourceDoc | null>(out)?.name !== newName || commentCount(out) < commentCount(o.text)) {
          throw new Error(
            `could not rewrite ${path.relative(ws.root, o.file)} in place — its name did not take without reformatting it. nothing was changed.`
          )
        }
        fs.mkdirSync(path.dirname(o.to), { recursive: true })
        fs.writeFileSync(o.to, out)
        if (o.to !== o.file) fs.rmSync(o.file)
        touched.add(o.file)
        touched.add(o.to)
      }

      // 2. INBOUND REFERENCES FIRST, while the records are still where the store thinks they are.
      //
      // ⚠ This used to run AFTER the folder move and it silently missed every SELF-reference.
      // `store.rewriteRefs` walks `recordFiles()`, which resolves each collection's directory
      // from the descriptor loaded when the Store was built — i.e. the OLD `storage.path`. Move
      // the records first and that walk finds an empty directory, so a record pointing at its
      // own collection is never rewritten and dangles the moment compile catches up.
      //
      // It is not a corner case: it hit `finance/accounts`, where every card and loan carries
      // `settled_by: <the account that settles it>` — 5 dangling refs out of 11 records, found
      // only because `check` ran afterwards. Doing the rewrite first needs no descriptor reload
      // and no second code path: the files are still at the old path, which is exactly what the
      // old refs say.
      // ONE pass for every id, not one pass per id — see `store.rewriteRefsBatch`. The
      // `collections/<name>` retarget stays its own call: it is a different ref (into the
      // `collections` collection), and folding it in would put a needle in the batch that shares
      // no prefix with the rest and so switch the negative pre-filter off for all of them.
      const out = store.rewriteRefsBatch(ids.map(id => [`${oldName}/${id}`, `${newName}/${id}`]))
      undoRewrites.push(out.restore)
      rewrites += out.rewrites
      for (const f of out.touched) touched.add(f)
      const collOut = store.rewriteRefs(`collections/${oldName}`, `collections/${newName}`)
      undoRewrites.push(collOut.restore)
      rewrites += collOut.rewrites
      for (const f of collOut.touched) touched.add(f)

      // 3. the record folder, then the per-file suffix if it was derived
      if (newDir !== oldDir && fs.existsSync(oldDir)) {
        fs.mkdirSync(path.dirname(newDir), { recursive: true })
        fs.renameSync(oldDir, newDir)
        movedData = true
        pruneEmpty(path.dirname(oldDir), path.join(ws.root, dataPath))
      }
      if (newSuffix !== oldSuffix && fs.existsSync(newDir)) {
        // Match on the OLD suffix, keep whatever extension the file already had — an opaque
        // record's extension is its own, and a re-suffix must not rename it into another format.
        const old = { storage: { ...storageOf(d), suffix: oldSuffix } }
        for (const file of walk(newDir)) {
          const id = idFromRecordPath(old as unknown as Descriptor, path.relative(newDir, file))
          if (id === null) continue
          const to = path.join(
            newDir,
            `${id}.${newSuffix}${path.basename(file).slice(path.basename(id).length + oldSuffix.length + 1)}`
          )
          fs.renameSync(file, to)
          resuffixed.push([file, to])
        }
      }
      if (movedData) {
        touched.add(oldDir)
        touched.add(newDir)
      }

      // 4. every SOURCE naming the collection bare: a field's `type` (scalar or union, nested
      //    object fields and map values included) in every collection and mixin, and the
      //    `collection: collections/<name>` a ui-view or binding is over. Not a `<collection>/<id>`
      //    ref, so step 2 cannot see it — and leaving it makes compile fail on an unknown type.
      //
      // ⚠ ROUND-TRIPPED, for the same reason step 1 is: a descriptor's comments are where its
      // module writes down why the collection exists. The edit is made on the parsed value and
      // `writeSource` puts it back over the original bytes; the parse afterwards proves it landed.
      const sourcesNaming = [
        ...descriptorSources(ws, store).map(f => ({
          f,
          edit: (doc: SourceDoc): boolean => retargetTypes(doc.fields, oldName, newName),
        })),
        ...mixinSources(store).map(({ file }) => ({
          f: file,
          edit: (doc: SourceDoc): boolean => retargetTypes(doc.fields, oldName, newName),
        })),
        ...viewSources(store).map(({ file }) => ({
          f: file,
          edit: (doc: SourceDoc): boolean => {
            if (doc.collection !== `collections/${oldName}`) return false
            doc.collection = `collections/${newName}`
            return true
          },
        })),
      ]
      for (const { f, edit } of sourcesNaming) {
        const before = fs.readFileSync(f, "utf8")
        const probe = load<SourceDoc | null>(before)
        if (!probe || typeof probe !== "object" || !edit(probe)) continue
        const after = writeSource(before, probe)
        const reparsed = load<SourceDoc | null>(after)
        if (!reparsed || edit(reparsed) || commentCount(after) < commentCount(before)) {
          throw new Error(
            `could not retarget "${oldName}" in ${path.relative(ws.root, f)} without reformatting it — nothing was changed.`
          )
        }
        if (!refFiles.has(f)) refFiles.set(f, Buffer.from(before))
        fs.writeFileSync(f, after)
        touched.add(f)
        rewrites++
      }

      // 5. every module's `dreamteamer.peer_collections` naming the collection: the list that
      //    lets a module overlay or reference it while it is installed. Step 4 retargeted those
      //    types and overlays, so a peer list left on the old name makes compile refuse them.
      for (const f of modulePackageFiles(ws)) {
        const before = fs.readFileSync(f, "utf8")
        let pkg
        try {
          pkg = JSON.parse(before)
        } catch {
          continue
        }
        const peers = pkg?.dreamteamer?.peer_collections
        if (!Array.isArray(peers) || !peers.includes(oldName)) continue
        pkg.dreamteamer.peer_collections = peers.map(p => (p === oldName ? newName : p))
        if (!refFiles.has(f)) refFiles.set(f, Buffer.from(before))
        fs.writeFileSync(f, JSON.stringify(pkg, null, "\t") + "\n")
        if (f === rootPkg) refreshWorkspacePkg(ws)
        touched.add(f)
        rewrites++
      }

      compile(ws) // the gate: an uncompilable rename never reaches history
    } catch (e) {
      // ⚠ undo() FIRST. A captured file can be a SELF-reference — a record of the collection being
      // renamed — so its path only exists again once undo() has moved the folder back. Restoring
      // before that wrote into a directory that was no longer there, and the ENOENT masked the
      // error actually being rolled back from.
      undo()
      restoreRefs()
      if (refFiles.has(rootPkg)) refreshWorkspacePkg(ws)
      try {
        compile(ws)
      } catch {
        /* pre-rename sources were compilable */
      }
      throw e
    }

    // The pathspec filter now lives in `commitByRepo`, per repo — `isTracked` has to run in the
    // repo that would track the path, and running it at the workspace root answered "no" for
    // every path inside a git-shape module.
    const rels = [...touched].map(f => path.relative(ws.root, f))
    let commits
    try {
      commits = commitByRepo(ws, store, rels, `dreamteamer: collections rename ${oldName} → ${newName}`)
    } catch (e) {
      undo()
      restoreRefs()
      if (refFiles.has(rootPkg)) refreshWorkspacePkg(ws)
      try {
        compile(ws)
      } catch {
        /* pre-rename sources were compilable */
      }
      throw new Error(
        `git commit failed — the rename was rolled back, nothing was changed. (${e.message.split("\n")[0]})`,
        { cause: e }
      )
    }

    return {
      renamed: true as const,
      name: newName,
      records: ids.length,
      rewrites,
      commits,
      from: path.relative(ws.root, oldDir),
      to: path.relative(ws.root, newDir),
      suffix: newSuffix !== oldSuffix ? { from: oldSuffix, to: newSuffix } : null,
      pathKept: pathWasDerived ? null : authoredPath,
    }
  })
}

/** Every package.json in this workspace that can declare `peer_collections` — the workspace's own
 *  and each module's outside node_modules (a write there is erased by the next install). */
function modulePackageFiles(ws: Workspace): string[] {
  const roots = new Set([".", ...(readManifest(ws.root)?.modules ?? []).map(m => m.root)])
  return [...roots]
    .filter(r => typeof r === "string" && !IN_NODE_MODULES(r))
    .map(r => path.join(ws.root, r, "package.json"))
    .filter(f => fs.existsSync(f))
}

/** Re-read the workspace package.json into `ws.pkg` in place — `compile({root, pkg})` reads the
 *  object it was handed, not the file. */
function refreshWorkspacePkg(ws: Workspace): void {
  let pkg: PackageJson
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ws.root, "package.json"), "utf8"))
  } catch {
    return
  }
  for (const k of Object.keys(ws.pkg)) delete ws.pkg[k]
  Object.assign(ws.pkg, pkg)
}

/** Rewrite a field `type` naming `oldName` → `newName` — a scalar type or a union member, at any
 *  depth of object `fields` and map `values`. Returns true if anything changed. */
function retargetTypes(fields: Record<string, Field>, oldName: string, newName: string) {
  let changed = false
  for (const f of Object.values(fields ?? {})) {
    if (!f || typeof f !== "object") continue
    if (f.type === oldName) {
      f.type = newName
      changed = true
    } else if (Array.isArray(f.type) && f.type.includes(oldName)) {
      f.type = f.type.map(t => (t === oldName ? newName : t))
      changed = true
    }
    if (f.fields && retargetTypes(f.fields, oldName, newName)) changed = true
    if (f.values && typeof f.values === "object") {
      if (f.values.type !== undefined && retargetTypes({ v: f.values }, oldName, newName)) changed = true
    } else if (f.values === oldName) {
      f.values = newName
      changed = true
    }
  }
  return changed
}
