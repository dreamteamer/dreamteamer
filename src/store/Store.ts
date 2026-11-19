import Ajv from "ajv"
import addFormats from "ajv-formats"
import fs from "node:fs"
import path from "node:path"
import { bodyField } from "../record/bodyField.ts"
import { ownerIdOf } from "../record/ownerIdOf.ts"
import { parseRef } from "../record/parseRef.ts"
import { placedRoot, placementOf } from "../record/placement.ts"
import { placementOfFile } from "./lib/placementOfFile.ts"
import { assertSafeId, parseRecord } from "../record/records.ts"
import { relationsOf } from "../record/relationsOf.ts"
import { storageOf } from "../record/storageOf.ts"
import { symlinkBelow } from "../lib/symlinkBelow.ts"
import type { Under } from "../record/types.ts"
import { loadDescriptors } from "../runtime/loadDescriptors.ts"
import { namespaces as compiledNamespaces, runtimeDir } from "../runtime/runtime.ts"
import { NO_RUNTIME } from "../runtime/consts.ts"
import { sourceRoots as compiledSourceRoots } from "../runtime/sourceRoots.ts"
import type { Descriptor, Descriptors, Fields } from "../types.ts"
import { writableDescriptor } from "./lib/writableDescriptor.ts"
import { refuseMirrorWrites } from "./lib/refuseMirrorWrites.ts"
import { refuseEngineWrites } from "./lib/refuseEngineWrites.ts"
import { refuseDuplicateValues } from "./lib/refuseDuplicateValues.ts"
import { applyMirrorEdits } from "./lib/applyMirrorEdits.ts"
import { filePath } from "./lib/filePath.ts"
import { recordRoot } from "./recordRoot.ts"
import { gitHead } from "./gitHead.ts"
import { ids } from "./ids.ts"
import { idsKey } from "./lib/idsKey.ts"
import { indexAdd } from "./lib/indexAdd.ts"
import { walkIds } from "./lib/walkIds.ts"
import { walkRoot } from "./lib/walkRoot.ts"
import { placedChildrenIn } from "./lib/placedChildrenIn.ts"
import { moveRecord } from "./lib/moveRecord.ts"
import { external } from "./external.ts"
import { vouched } from "./vouched.ts"
import { createdOf } from "./createdOf.ts"
import { addedDates } from "./addedDates.ts"
import { revert } from "./revert.ts"
import { relocatePlan } from "./relocatePlan.ts"
import { relocate } from "./relocate.ts"
import { validate } from "./lib/validate.ts"
import { qualifyBareRefs } from "./lib/qualifyBareRefs.ts"
import { checkRefs } from "./lib/checkRefs.ts"
import { add } from "./add.ts"
import { addFile } from "./addFile.ts"
import { set } from "./set.ts"
import { pathAt } from "./lib/pathAt.ts"
import { assertUnambiguous } from "./lib/assertUnambiguous.ts"
import { rm } from "./rm.ts"
import { rename } from "./rename.ts"
import { recordFiles } from "./recordFiles.ts"
import { findInboundRefs } from "./findInboundRefs.ts"
import { rewriteRefsBatch } from "./rewriteRefsBatch.ts"
import { writeLockPath } from "./writeLockPath.ts"
import { withWriteLock } from "./withWriteLock.ts"
import { commit } from "./lib/commit.ts"
import { commitIn } from "./lib/commitIn.ts"
import type { ResolvedRoot, RewriteResult, RelocatePlan, Undo } from "./types.ts"
import { escapeRe } from "../lib/escapeRe.ts"
import { pruneEmptyDirs } from "./lib/pruneEmptyDirs.ts"
export class Store {
  root: string
  runtime: string
  autoCommit: boolean
  ajv: InstanceType<typeof Ajv.default>
  namespaces: string[]
  descriptors: Descriptors
  _idsCache: Map<string, { key: string; ids: Map<string, string> }>
  _duplicates: Map<string, Map<string, string[]>>
  _head: string | undefined
  _lockPath: string
  _outside: string[]
  _repos: string[]
  _relations: ReturnType<typeof relationsOf>
  _addedDates: Map<string, Map<string, string>>
  constructor({ root, pkg }: { root: string; pkg?: unknown }) {
    this.root = root
    this.runtime = runtimeDir(root)
    // Committing is POLICY, not durability — a write is on disk either way. Default OFF:
    // `dt commit` is what publishes. `"auto-commit": true` restores the old behaviour of one
    // commit per mutation.
    this.autoCommit =
      ((pkg ?? readPkg(root)) as { dreamteamer?: { auto_commit?: unknown } }).dreamteamer?.auto_commit === true
    this.ajv = new (Ajv as unknown as typeof Ajv.default)({
      allErrors: true,
      strict: false,
      useDefaults: true,
      coerceTypes: "array",
    })
    ;(addFormats as unknown as typeof addFormats.default)(this.ajv)
    this.ajv.addFormat("markdown", true)
    this._idsCache = new Map() // collection -> { key, ids } (see ids())
    this._duplicates = new Map() // placed collection -> id -> [files], refreshed by every walk (see assertUnambiguous)
    this._head = undefined // memoized `git rev-parse HEAD` (see gitHead())
    const descriptors = loadDescriptors(root)
    if (!descriptors) throw new Error(NO_RUNTIME)
    this.descriptors = descriptors
    // The closed set every reference is split against (see src/namespace.ts). Read once per Store:
    // it is compile output, and a Store is already rebuilt whenever the runtime changes.
    this.namespaces = compiledNamespaces(root) as string[]
  }

  descriptor(collection: string): Descriptor {
    const d = this.descriptors.get(collection)
    if (!d) throw new Error(`unknown collection "${collection}" (known: ${[...this.descriptors.keys()].join(", ")})`)
    return d
  }

  /**
   * data/state collections are writable through the store; runtime-based (knowhow/meta)
   * entities are edited as SOURCES + compile — refuse politely.
   */
  writableDescriptor(collection: string): Descriptor {
    return writableDescriptor(this, collection)
  }

  /**
   * Can the store rewrite this collection's records AT ALL? The two shapes it cannot are the same
   * pair `applyMirrorEdits` bails on: a runtime-based record is a build artifact under
   * `.dreamteamer/` whose source lives elsewhere, and a `format: binary` record's bytes ARE the record
   * — `serialize` has no branch for it, so a write would replace an SVG with frontmatter. A
   * predicate rather than a throw, because the callers that need this are CHOOSING a path (rm's
   * set-null falls back to restrict) rather than refusing a request.
   */
  canRewrite(collection: string): boolean {
    const d = this.descriptors.get(collection)
    return !!d && !storageOf(d).runtime && storageOf(d).format !== "binary"
  }

  /**
   * Relations, decoded ONCE per Store — the same reasoning as `namespaces` in the constructor: this
   * is compile output, and a Store is already rebuilt whenever the runtime changes.
   */
  relations() {
    return (this._relations ??= relationsOf(this.descriptors))
  }

  /**
   * A generated mirror sits on the TARGET's schema, so it looks like any other field to whoever
   * holds the descriptor — and `readOnly` is documentation, not a gate: ajv does not enforce it.
   * Left alone, a hand-set mirror is a value the engine recomputes from the owning side, and the
   * two disagree silently. Refuse instead, and name the write that WOULD have worked: "this field
   * is generated" without the owning side is a dead end.
   */
  refuseMirrorWrites(collection: string, id: string | null | undefined, changed: Iterable<string>): void {
    return refuseMirrorWrites(this, collection, id, changed)
  }

  // descriptor v2: the fields the engine writes, and values that must be unique
  // Read from `compiled.fields`, the resolved v2 field list — the first reader of it in the store.
  // A collection compiled from a v1 source has no `compiled` block, and none of this applies to it.

  /**
   * `derived` (stored, engine-written: `created`) and `virtual` (computed on read: `id`,
   * `last_modified`) fields are refused from every writer, naming which they are.
   */
  refuseEngineWrites(d: Descriptor, changed: Iterable<string>): void {
    return refuseEngineWrites(this, d, changed)
  }

  /**
   * `unique: true` on a scalar field: no two records of the collection may hold one value. Null and
   * absent never claim. Only the keys being written are asked, so an unrelated edit to a record
   * that already shares a value is not where that conflict is reported — `check` is.
   */
  refuseDuplicateValues(d: Descriptor, collection: string, id: string, fields: Fields, keys: string[]) {
    return refuseDuplicateValues(this, d, collection, id, fields, keys)
  }

  /**
   * Mirror maintenance for ONE owner-record write: rewrites every TARGET whose mirror has to change
   * so it says what `after` implies, and hands back those files plus the undo that puts them back.
   * The values written are exactly what `expectedMirrors` computes, which is what `check` compares
   * against — the two read the same relation rows, so they cannot disagree about what a mirror holds.
   *
   * Runs INSIDE withWriteLock, after the owner file is on disk. Nothing is validated here: an attach
   * was proved by `checkRefs` before the lock — to exist, or to be external (vouched for by an exports
   * manifest, no record here to mirror onto) — and a detach is removal, which cannot dangle.
   *
   * ⚠ ALL-OR-NOTHING, by its own hand. The one refusal it can raise (a unique owner) is discoverable only
   * ON a target, i.e. partway through a loop that may already have rewritten other targets — so a
   * throw undoes its own work before it propagates, and the caller is left with exactly one thing to
   * roll back: the owner write.
   *
   * @returns {{files: string[], undo: () => void}}
   */
  applyMirrorEdits(
    d: Descriptor,
    id: string,
    before: Fields | null,
    after: Fields | null,
    ownerFile?: string | null
  ): { files: string[]; undo: Undo } {
    return applyMirrorEdits(this, d, id, before, after, ownerFile)
  }

  /**
   * The collection's OWN folder. For a collection stored under another (`storage.under`) this is
   * the FALLBACK root — where a record with no owner lives — and not an enumeration of where its
   * records are: that is `ids()`, and the directories git has to be asked about are `recordDirs`.
   */
  dir(d: Descriptor): string {
    return path.resolve(storageOf(d).runtime ? this.runtime : this.root, this.rootPath(d))
  }

  /**
   * The write root's path as compile resolved it — absolute for an env-pointed root outside the
   * workspace, which is why every root is `path.resolve`d and never `path.join`ed. ⚠ An env-pointed
   * root that could NOT render on this machine refuses HERE, at the first verb that would touch it:
   * the alternative was reading and writing a literal `${env:NAME}/` folder with every verb saying ✔.
   */
  rootPath(d: Descriptor): string {
    const s = storageOf(d)
    if (s.unavailable)
      throw new Error(
        `collection "${d.name}" keeps its records at ${s.path}, which cannot render on this machine — ${s.unavailable}. Set it in .env and run dreamteamer compile; nothing was read or written.`
      )
    return s.path
  }

  /** The parent collection's folder, for a collection stored under one. */
  parentDir(d: Descriptor): string {
    return this.dir(this.descriptor(placementOf(d).collection))
  }

  /**
   * Every directory a record of `d` can sit in: its own root, plus the parent collection's root when
   * it is stored under one. What `commit` scopes `git status` to and what a surface asks git about.
   */
  recordDirs(d: Descriptor): string[] {
    const own = placementOf(d) ? [this.dir(d), this.parentDir(d)] : [this.dir(d)]
    return [
      ...own,
      ...this.rootsOf(d)
        .slice(1)
        .map(r => r.abs),
    ]
  }

  /**
   * Every root a record of `d` can be READ from, write root first, then each record layer — another
   * workspace cloned under git_modules/ whose manifest entry lists this collection.
   */
  rootsOf(d: Descriptor): ResolvedRoot[] {
    this.rootPath(d) // the refusal, before any root is resolved
    return storageOf(d).roots.map(r => ({
      ...r,
      abs: path.resolve(storageOf(d).runtime ? this.runtime : this.root, r.path),
    }))
  }

  /** Does a record layer contribute to `d`? Such a collection is indexed across every root. */
  layered(d: Descriptor): boolean {
    return storageOf(d).layers.length > 0
  }

  /**
   * The file an owner in `ownerRepo` keeps the mirror of `collection/id` in: the record that answers
   * the id when it sits in that repo, else null (the id is another repo's, and mirrors stay per repo). The one place the choice is made — the mirror
   * pass writes it and rm's guard credits it, so the two cannot disagree.
   */
  mirrorFileFor(collection: string, id: string, ownerRepo: string): string | null {
    const d = this.descriptor(collection)
    const answering = this.ids(collection).get(id)
    if (!answering) return null
    if (this.repoOfFile(d, answering) === ownerRepo) return answering
    return null
  }

  /**
   * The layer an existing file of `d` was read from — `{ layer, path, repo, abs }` — or null for a
   * file in the write root. What decides which repo an edit of it commits to.
   */
  layerOfFile(d: Descriptor, file: string): ResolvedRoot | null {
    const abs = path.resolve(file)
    return (
      this.rootsOf(d)
        .slice(1)
        .find(r => abs.startsWith(path.resolve(r.abs) + path.sep)) ?? null
    )
  }

  /** The git repo that owns a file of `d`, workspace-relative: a layer's when a layer holds it. */
  repoOfFile(d: Descriptor, file: string): string {
    return this.layerOfFile(d, file)?.repo ?? storageOf(d).repo
  }

  /**
   * WHERE a record is read from, and which repo commits it — what `dt get --json` and `dt list
   * --json` say as `$file` and `$repo`. `file` is workspace-relative, `repo` the workspace-relative
   * repo root (`.`, `git_modules/<clone>`); a collection kept outside every repo here (an
   * env-pointed root) answers its absolute file and `repo: null` — it is never committed.
   */
  locate(collection: string, id: string): { file: string; repo: string | null } {
    const file = this.ids(collection).get(id)
    if (!file) throw new Error(`${collection}/${id}: no such record`)
    return this.locationOf(this.descriptor(collection), file)
  }

  /** `locate` for a file already in hand — one row of a listing, without a second index lookup. */
  locationOf(d: Descriptor, file: string): { file: string; repo: string | null } {
    if (storageOf(d).external) return { file: path.resolve(file), repo: null }
    return { file: path.relative(this.root, file).split(path.sep).join("/"), repo: this.repoOfFile(d, file) }
  }

  /**
   * The file a record of `d` with these `fields` belongs at. For a placed collection the owner
   * field decides the root — the parent's folder, or the fallback root when it is empty — so a
   * caller that has no fields (a bare id) must go through the index instead (recordRoot).
   */
  filePath(d: Descriptor, id: string, ext?: string, fields?: Fields): string {
    return filePath(this, d, id, ext, fields)
  }

  /** The root a record with these fields belongs under: the owner's child folder, or the fallback. */
  rootFor(d: Descriptor, fields: Fields | null | undefined): string {
    const under = placementOf(d)
    if (!under || !fields) return this.dir(d)
    const parentId = ownerIdOf(fields, under, v => parseRef(v, this.namespaces))
    if (parentId) assertSafeId(parentId) // a parsed ref, but it is about to be fs-joined
    return placedRoot(under, this.dir(d), this.parentDir(d), parentId)
  }

  /**
   * The root an EXISTING file of `d` sits under — the inverse of rootFor, for pruning and for the
   * observed-vs-declared comparison. Falls back to the collection's own root for a file found
   * under neither, which cannot happen for a file the index produced.
   */
  rootOfFile(d: Descriptor, file: string): string {
    const under = placementOf(d)
    if (!under) return this.dir(d)
    return placementOfFile(under, file, this.dir(d), this.parentDir(d))?.root ?? this.dir(d)
  }

  /** the on-disk unit of a record: its folder for folder shapes, its file otherwise */
  recordRoot(d: Descriptor, id: string): string {
    return recordRoot(this, d, id)
  }

  /**
   * Current HEAD, MEMOIZED PER STORE — one rev-parse per process rather than one per `ids()` call.
   *
   * ⚠ THE SUBPROCESS WAS THE COST OF THE CACHE, not of the walk it avoids. `ids()` asks this on
   * EVERY call, hit or miss, and a `git rev-parse` is ~10ms of process spawn. Profiled on a
   * 4,186-record workspace, a one-hop relational filter — which resolves one referenced record per
   * row, and `read()` goes through the id index — spent 1,525ms of a 1,677ms command in this one
   * method. Reproduced by `npm run perf` at 1/14 the scale: 300 rows, 301 spawns.
   *
   * ⚠ INVALIDATED BY WHATEVER RUNS `git commit` — `headMoved()`, below. It used to be dropped on
   * the way OUT of every write lock instead, on the reasoning that everything able to move HEAD
   * takes that lock. Two things were wrong with it. It was not TRUE — `commitPending` (`dt commit`,
   * the verb that exists to move HEAD) takes no lock at all — and it was far too WIDE: with
   * `auto-commit` off, which is the default, a record write moves nothing, and dropping the memo
   * anyway cost the next `ids()` call a ~10ms subprocess to re-read a sha that had not changed. A
   * run of 400 adds paid 400 of them: 9.9ms of the 10.7ms an add cost, measured on a generated
   * collection. Naming the four commit sites is both narrower and more honest than naming the lock.
   *
   * What the memo does give up, stated rather than discovered: ANOTHER process committing during
   * this one's lifetime no longer invalidates the id map. It costs nothing real — a commit does not
   * change which record files exist, and one that does (a checkout, a revert) moves the collection
   * directory's mtime, which is the other half of the key. A CLI process runs one verb, and the
   * server already rebuilds its Store when the manifest moves.
   */
  gitHead() {
    return gitHead(this)
  }

  /**
   * "This process just committed" — said by the four places that run `git commit` while a Store is
   * alive: `commit()` below, `commitPending`, and schema-ops' two source commits. See gitHead.
   */
  headMoved() {
    this._head = undefined
  }

  ids(collection: string): Map<string, string> {
    return ids(this, collection)
  }

  /**
   * The validity key `ids()` compares against, as its own method because `add` restates it AFTER
   * its write — the only way an index it just extended can still be accepted by the next call.
   * For a placed collection the PARENT root's mtime is in it too: a new parent folder is a new
   * place records can be, and nothing under the fallback root moves when one appears.
   */
  _idsKey(d: Descriptor): string {
    return idsKey(this, d)
  }

  /**
   * Refuse a placed write whose path crosses a symlink inside the parent collection's root — a link
   * there points anywhere, and "inside the parent's folder" is the whole promise (R2).
   */
  _assertContained(d: Descriptor, file: string): void {
    const under = placementOf(d)
    if (!under) return
    const link = symlinkBelow(this.parentDir(d), file)
    if (link)
      throw new Error(
        `${path.relative(this.root, link)} is a symlink — a placed record is written only inside its parent's real folder, never through a link. nothing was written.`
      )
  }

  /**
   * The id index this add invalidated, handed back with ONE MORE ENTRY rather than thrown away.
   *
   * ⚠ A RUN OF ADDS WAS QUADRATIC, and the walk was the smaller half of it. `add` needs the ids
   * that already exist in order to generate one that is unique, so every add called `ids()` — which
   * asked `git rev-parse HEAD` for its key and then re-walked the collection from disk, because the
   * previous add had deleted the very memo it was rebuilding. Measured on a generated 400-record
   * collection: 10.7 ms/rec, of which 9.9 ms was the subprocess (see gitHead) and 0.68 ms the
   * walk — and the walk is the term that GROWS. An add with an explicit id, which calls neither,
   * costs 0.18 ms. After both: 0.57 ms, one subprocess for the whole run.
   *
   * The entry is INSERTED IN WALK ORDER, never appended. `ids()` iteration order is what `dt list`
   * prints when nobody passes `--sort`, so an index that ordered records differently from a cold
   * rebuild would make that order depend on how many writes the process had done first.
   *
   * The honest gap it adds, beside the two `ids()` already states: the key is stated from a stat
   * taken just AFTER this write, so a record another process dropped into the same directory in
   * that window goes unnoticed until something else moves the mtime. Same shape and same size as
   * the cross-process gap the memo already accepts.
   */
  _indexAdd(
    collection: string,
    memo: { key: string; ids: Map<string, string> } | undefined,
    id: string,
    file: string
  ): void {
    return indexAdd(this, collection, memo, id, file)
  }

  _walkIds(d: Descriptor, dir: string): Map<string, string> {
    return walkIds(this, d, dir)
  }

  /**
   * The records of `d` under ONE root — `[id, file]` pairs, in walk order. A folder-shape record is
   * its entry file; anything else is a file whose name parses as a record of `d`.
   */
  _walkRoot(d: Descriptor, root: string): Generator<[id: string, file: string]> {
    return walkRoot(this, d, root)
  }

  /**
   * The parent record folders of a folder-shape collection that hold records of a collection
   * stored under it — the reason `rm` and `rename` on a parent have to look inside the folder.
   */
  placedChildrenIn(d: Descriptor, unit: string): { collection: string; under: Under; count: number }[] {
    return placedChildrenIn(this, d, unit)
  }

  /**
   * Drop the id memo of every collection stored under `collection` — a parent folder that moved or
   * went carries their files with it.
   */
  _dropPlacedUnder(collection: string): void {
    for (const c of this.descriptors.values())
      if (placementOf(c)?.collection === collection) this._idsCache.delete(c.name)
  }

  /**
   * Move one record file to the root its fields now say it belongs in — the ONE place a placed
   * record changes folders. Creates the destination's parents, prunes the emptied ones up to the
   * root it left (so a company's `meetings/` folder disappears with its last meeting), and hands
   * back the undo. The caller has already refused an occupied destination.
   */
  _moveRecord(d: Descriptor, from: string, to: string): Undo {
    return moveRecord(this, d, from, to)
  }

  /**
   * Empty directories a placed record left behind: its date folders up to the root it sat in, and —
   * inside a parent folder — that root itself (`northwind/meetings/`), never the parent folder and
   * never the collection's own fallback root.
   */
  _pruneAround(d: Descriptor, file: string): void {
    const under = placementOf(d)
    const where = under ? placementOfFile(under, file, this.dir(d), this.parentDir(d)) : null
    const root = where?.root ?? this.dir(d)
    pruneEmptyDirs(path.dirname(file), root)
    if (where?.parentId) pruneEmptyDirs(root, path.join(this.parentDir(d), where.parentId))
  }

  /**
   * An id no root here holds that an exports manifest vouches for (cr-dt-004): `{ label, from?, manifest }`,
   * or null. The manifest is the referring record's repo's — `referrer` (`<collection>/<id>`), else this
   * workspace's — and it answers only where its holder is not read here: exactly where `check` says
   * external. A referrer this workspace does not read is refused, naming it.
   */
  external(
    collection: string,
    id: string,
    opts?: { referrer?: string }
  ): { label: string; from?: string; manifest: string } | null {
    return external(this, collection, id, opts)
  }

  /**
   * The entry the exports manifest of `repo` (a layer name; null: the write root) holds for an id, with
   * `seen` when its holder is read here — or null. The one reading `external` and `checkRefs` share.
   */
  vouched(
    collection: string,
    id: string,
    repo: string | null = null
  ): { label: string; from?: string; manifest: string; seen: boolean } | null {
    return vouched(this, collection, id, repo)
  }

  read(collection: string, id: string): { fields: Fields; file: string } {
    const d = this.descriptor(collection)
    const file = this.ids(collection).get(id)
    if (!file) throw new Error(`${collection}/${id}: no such record`)
    return { fields: parseRecord(file, d, bodyField(d)), file, descriptor: d } as { fields: Fields; file: string }
  }

  /**
   * A record's `created`, READ — never written — when the record predates the stamp.
   * The stamp wins. Without one: the id's own date when the collection's ids are made from
   * `created` (that date is what the stamp would have said), else the first commit holding the file,
   * following renames, which also covers a binary record with no frontmatter. Undefined for a
   * collection without a `created` field (a runtime kind), and for a record no commit holds yet.
   */
  createdOf(collection: string, id: string, fields: Fields, file: string): string | undefined {
    return createdOf(this, collection, id, fields, file)
  }

  /**
   * When each file of a collection first entered history, following renames — ONE `git log` for the
   * whole collection, cached for this Store, so a list can answer `created` for every row.
   * @returns {Map<string, string>} root-relative path -> ISO date of the commit that added it
   */
  addedDates(collection: string): Map<string, string> {
    return addedDates(this, collection)
  }

  /**
   * list-path reader: ONE directory walk for the whole collection (review finding 2:
   * per-id read() re-walked the dir — O(N²) lists, 46s at 3k records).
   */
  *readAll(collection: string): Generator<{ id: string; fields: Fields; file: string }> {
    const d = this.descriptor(collection)
    const bf = bodyField(d)
    for (const [id, file] of this.ids(collection)) {
      yield { id, file, fields: parseRecord(file, d, bf) }
    }
  }

  /** restore a record to its content at `hash` — validated like any other write, one commit. */
  revert(
    collection: string,
    id: string,
    hash: string
  ): { id: string; reverted: boolean; hash?: string; file?: string } {
    return revert(this, collection, id, hash)
  }

  /**
   * What `relocate` would do: every record of `collection` whose file is not where the compiled
   * descriptor says it belongs, as `{ id, from, to, why }` — plus the problems that make the plan
   * unsafe to apply. Read-only. Two kinds of drift are recognised:
   *
   *  - `placement`: a placed record whose folder disagrees with its owner field — hand-moved, written
   *    by an engine from before `storage.under` existed, or sitting in the fallback root after the
   *    annotation was switched on. The field is the truth; the file moves.
   *  - `shape`: a FILE record (`<id>.<suffix>.md`) at the root of a collection that is now
   *    `shape: folder` — the state a collection is in the moment its descriptor gains a folder shape so
   *    something can live inside its records. The bytes move to `<id>/<entry>`; the id is unchanged.
   *
   * A destination that already exists is a PROBLEM, never a silent overwrite: two files claiming one
   * id is exactly the ambiguity `check` reports, and resolving it is a decision, not a move.
   */
  relocatePlan(collection: string, only?: string[] | null): RelocatePlan
  relocatePlan(
    collection: string,
    only: string[] | null,
    opts: { toRoot?: boolean }
  ): RelocatePlan<"placement" | "shape" | "to-root">
  relocatePlan(
    collection: string,
    only?: string[] | null,
    opts?: { toRoot?: boolean }
  ): RelocatePlan<"placement" | "shape" | "to-root"> {
    return relocatePlan(this, collection, only, opts)
  }

  /**
   * Reconcile files to the compiled descriptor — the explicit operation that turns a `check`
   * placement report into a clean tree. Ids and references are untouched: only files move. Refuses
   * rather than partially applies: a planned destination that exists, or a source git still has
   * pending changes for, stops the whole plan (publish first — a move on top of an unpublished edit
   * is two changes under one subject, and the second hides the first). A second run after success
   * plans nothing and does nothing.
   */
  relocate(collection: string, opts?: { only?: string[] | null; dryRun?: boolean }): RelocatePlan & { applied: boolean }
  relocate(
    collection: string,
    opts: { only?: string[] | null; dryRun?: boolean; toRoot?: boolean }
  ): RelocatePlan<"placement" | "shape" | "to-root"> & { applied: boolean }
  relocate(
    collection: string,
    opts?: { only?: string[] | null; dryRun?: boolean; toRoot?: boolean }
  ): RelocatePlan<"placement" | "shape" | "to-root"> & { applied: boolean } {
    return relocate(this, collection, opts)
  }

  validate(d: Descriptor, fields: Fields, opts?: { skipRefs?: boolean; repo?: string | null }): Fields {
    return validate(this, d, fields, opts)
  }

  /**
   * Bare ids are accepted on INPUT for a field whose target set has exactly one member, and
   * qualified HERE — the same choke point that canonicalizes datetimes (normalizeRecord), for the
   * same reason: add/set reach disk through validate(), so the file always carries the one
   * canonical spelling. The deliberate exception is `revert`: it restores committed historical
   * BYTES verbatim (that is the whole point of a revert), calling validate() only to prove the
   * historical content still parses — never on the text that actually reaches atomicWrite. So a
   * bare ref that was committed past this choke point (hand-edited, or written by an older engine)
   * stays bare when reverted TO; `check` is what flags it, not this method. Union and '*' fields
   * never qualify: the prefix is the only type information those values carry. A value that
   * already parses as a ref is never rewritten — so a qualified-but-wrong id fails downstream as a
   * precise dangling reference, not as malformed syntax. Known limit: a slash-carrying bare id
   * (path-shaped ids) parses as a ref and is not qualified; the checkRefs error then names the
   * misread collection.
   */
  qualifyBareRefs(d: Descriptor, fields: Fields): void {
    return qualifyBareRefs(this, d, fields)
  }

  /** `repo` is the referring record's: the layer that holds it, null for the write root. */
  checkRefs(d: Descriptor, fields: Fields, repo: string | null = null): void {
    return checkRefs(this, d, fields, repo)
  }

  add(
    collection: string,
    fields: Fields,
    opts?: { id?: string }
  ): {
    id: string
    file: string
    idFallback: { field?: string; value: string; id: string } | null
    deprecated?: string[]
  } {
    return add(this, collection, fields, opts)
  }

  /**
   * Import a file AS a record. There are no fields to validate and nothing to serialize, which is
   * why this is a sibling of add() rather than a branch inside it — the two share their last three
   * lines and nothing else.
   */
  addFile(collection: string, id: string, srcPath: string, opts?: { force?: boolean }): { id: string; file: string } {
    return addFile(this, collection, id, srcPath, opts)
  }

  set(collection: string, id: string, changes: Fields): { id: string; file: string } {
    return set(this, collection, id, changes)
  }

  /**
   * Where a placed record's file was at `hash`, workspace-relative — or null when the commit holds no
   * file for that id (or the collection is conventional, where today's path IS the historical one).
   * One `git ls-tree` over the roots the collection can occupy, mapped back through the same
   * path→record rule `commit` and `changes` use.
   */
  pathAt(d: Descriptor, id: string, hash: string): string | null {
    return pathAt(this, d, id, hash)
  }

  /**
   * Refuse to WRITE to an id that two files claim. The index keeps the first claimant so reads
   * still answer, but a write would land on one copy and leave the other saying something else —
   * the exact ambiguity `check` reports, made worse under a verb that printed ✔.
   */
  assertUnambiguous(collection: string, id: string): void {
    return assertUnambiguous(this, collection, id)
  }

  /**
   * Did the owner field of a placed record change between two versions of it? Compared as PARSED
   * owner ids, because `before` comes off disk and may spell the reference bare.
   */
  ownerChanged(d: Descriptor, before: Fields, after: Fields): boolean {
    const under = placementOf(d)
    if (!under) return false
    const prior = { ...before }
    this.qualifyBareRefs(d, prior)
    const parse = (v: string) => parseRef(v, this.namespaces)
    return ownerIdOf(prior, under, parse) !== ownerIdOf(after, under, parse)
  }

  /**
   * Removal, against relations. `rm`'s guard is a TEXT SCAN over every record file — any file whose
   * bytes contain `<collection>/<id>` refuses the removal — and that was exactly right while every
   * inbound reference was somebody's hand-written data. It stopped being right the day the engine
   * started writing references of its own: the scan cannot tell a mirror it wrote from a value a
   * human typed, so it refused on the strength of its own bookkeeping and left `--force` — which
   * removes the record AND leaves the mirror pointing at nothing — as the only way through.
   *
   * So inbound references split three ways, and only the third refuses:
   *
   * MINE — the mirror entries this record's own FKs put on their targets. Detached here, through the
   * SAME pass add/set/revert use: `applyMirrorEdits(d, id, fields, null)` is precisely "this owner
   * now claims nothing", so there is one implementation of what a detach means, not two.
   *
   * THEIRS, UNDER A RULE — an owner's FK pointing AT this record where the relation declares
   * `x-on-delete: set-null`. The schema author has already said what should happen; do it, in this
   * same commit.
   *
   * THEIRS — everything else: `x-on-delete: restrict` (the default), and every prose or unmodelled
   * reference the scan finds. Still refused, still escapable with `--force`, which still reports how
   * many references it left dangling.
   */
  rm(collection: string, id: string, opts?: { force?: boolean }): { id: string; inboundIgnored: number } {
    return rm(this, collection, id, opts)
  }

  rename(
    collection: string,
    oldId: string,
    newId: string
  ): { id: string; rewrites: number; touched?: number; skipped?: number; ambiguous?: number } {
    return rename(this, collection, oldId, newId)
  }

  /** exact-ref matching with a boundary so contacts/jane never matches contacts/jane-doe */
  refRegex(ref: string): RegExp {
    return new RegExp(`${escapeRe(ref)}(?![\\w/-])`, "g")
  }

  /**
   * Every record in the workspace whose id ENDS in `base`, as `<collection>/<id>`. What decides
   * whether a bare `[[base]]` wikilink names one thing — see rewriteRefs. Asked of the id index of
   * every collection rather than of a text scan, because the question is about records, not files.
   */
  basenameOwners(base: string): string[] {
    const out: string[] = []
    for (const name of this.descriptors.keys()) {
      for (const id of this.ids(name).keys()) if (id.split("/").pop() === base) out.push(`${name}/${id}`)
    }
    return out
  }

  /**
   * ⚠ EACH FILE EXACTLY ONCE. The `modules` collection's storage.path is `modules` and
   * `sourceRoots()` includes the workspace root, so walking it RE-YIELDS every module source that
   * its own kind's walk already produced — 173 files in one real vault, every module source
   * among them.
   *
   * That was harmless while every rewrite was idempotent, and stopped being harmless the day
   * namespaces arrived: replacing `draft-docs/x` with `rnd/draft-docs/x` is NOT idempotent,
   * because the result still contains the pattern. A second pass wrote
   * `data/rnd/rnd/draft-docs/x` into module-source comments during a real migration. Dedupe HERE
   * rather than making each caller idempotent — `findInboundRefs` is a caller too, and its counts
   * were quietly doubled by the same walk.
   */
  recordFiles() {
    return recordFiles(this)
  }

  /**
   * every compiled module (review finding 10: this layer never learned decision 24 — rename
   * silently skipped git_modules sources), read off the manifest rather than by re-discovering
   * modules, which is what used to make the store import the compiler. See runtime.js.
   */
  sourceRoots() {
    return compiledSourceRoots(this.root)
  }

  findInboundRefs(ref: string): string[] {
    return findInboundRefs(this, ref)
  }

  /**
   * decision 7 (un-parked): structured surfaces (frontmatter, yaml/json records) rewrite
   * unconditionally; PROSE bodies rewrite only inside `[[…]]` wikilinks — raw-text matching
   * corrupted look-alike URLs (review finding 4). raw body occurrences are counted and reported,
   * never touched.
   *
   * ⚠ A WIKILINK IS BARE MORE OFTEN THAN IT IS QUALIFIED. `[[ada]]` is what a person types and what
   * every wikilink editor writes; `[[people/ada]]` is the disciplined spelling. Only the qualified
   * form was followed, and the failure was SILENT in both directions — the link dangled, and the
   * skipped-prose counter matched the qualified form too, so it was not even reported as skipped.
   * "Wikilinks are maintained" was true of the shape nobody writes.
   *
   * So a rename that changes the BASENAME runs a second pass over bodies, and it refuses to guess:
   * `[[ada]]` follows the rename only when `ada` is the basename of exactly one record in the whole
   * workspace (`basenameOwners`, asked AFTER the move, so the renamed record is no longer among
   * them). When something else claims it too the link is left exactly as it is and counted into
   * `ambiguous`, which `rename` reports by file — an unfollowed link somebody knows about is a
   * different thing from one nobody does. A rename that keeps the basename (`collections rename`,
   * where only the collection moves) runs no bare pass at all: those links still name what they
   * always named.
   */
  rewriteRefs(oldRef: string, newRef: string): RewriteResult {
    return this.rewriteRefsBatch([[oldRef, newRef]])
  }

  /**
   * The same rewrite, for MANY old→new pairs at once: each record file is opened ONCE and every
   * pair is applied to the bytes in hand, in the order given.
   *
   * ⚠ THIS IS THE WHOLE IMPLEMENTATION — `rewriteRefs` is the batch of one. A second single-pair
   * copy of the rules above (prose scoping, the bare-basename ambiguity test, the boundary) is
   * exactly the drift this method exists to avoid.
   *
   * ⚠ WHY A BATCH, MEASURED. `collections rename` called this once per record id, and walked every
   * record file a second time before that to snapshot them for rollback: `npm run perf --
   * --records=400 --filler=100` cost 410,678 reads and 6.39s for 400 ids over 504 files — ~800
   * passes over the same bytes to rewrite 4 references. One pass answers every pair: 1,075 and
   * 0.16s.
   *
   * The pre-filter is a NEGATIVE one and nothing else: a file whose text lacks the prefix every
   * needle starts with cannot contain any of them, so it is skipped unread-twice — but a file that
   * has it is still matched by the boundary-aware regexes below, never by the prefix. A prefix
   * match would follow `data/tasks/` in a path and `…/ledger/alpha-x` in a URL.
   *
   * ⚠ THE SNAPSHOT IS TAKEN HERE, not by the caller. `rename` used to snapshot what
   * `findInboundRefs` reported — the QUALIFIED occurrences — which is not the set this method
   * writes: a body holding only `[[ada]]` is rewritten below and was in nobody's rollback. The
   * bytes are already in hand at the point of the write, so this is the one place that cannot be
   * out of step with it — and a failure part-way through undoes what it already wrote before it
   * throws, so a caller's own rollback never has to guess how far it got.
   *
   * `skipped` and `ambiguous` entries carry the pair that produced them (`oldRef`/`newRef`, plus
   * the `base` and its `claimants`), because in a batch there is no single one to imply.
   */
  rewriteRefsBatch(pairs: [oldRef: string, newRef: string][]): RewriteResult {
    return rewriteRefsBatch(this, pairs)
  }

  /**
   * Where the cross-process write lock lives.
   *
   * ⚠ IT BELONGS TO THE REPOSITORY, NOT TO THE CHECKOUT. What it protects is `.git/index.lock`
   * and `HEAD` — both of which are SHARED by every worktree of a repo, while `.dreamteamer/` is
   * gitignored build output that each checkout has its own copy of. A lock in the runtime folder
   * therefore serialized a single checkout against itself and left two worktrees of one repo free
   * to collide on exactly the files it exists to guard. `--git-common-dir` is the one path that
   * resolves to the same place from the primary and from every linked worktree.
   *
   * The runtime folder stays the fallback, because a workspace need not be a git repo at all and
   * a store that cannot lock is worse than one that locks narrowly.
   */
  writeLockPath() {
    return writeLockPath(this)
  }

  // write serialization + rollback (review finding 3; reinstates the v2 commit
  // queue idea in sync form). within ONE process Node's sync fs/exec already serializes;
  // the lock guards CLI-beside-server cross-process races on .git/index.lock. a commit
  // failure UNDOES the write, so "one mutation = one commit" fails CLOSED and
  // "nothing was written" stays true.
  withWriteLock<T>(fn: () => T): T {
    return withWriteLock(this, fn)
  }

  /**
   * Persist, or don't — `auto-commit` decides. The files are already on disk in both cases;
   * this only chooses whether they are published now or by a later `dt commit`.
   * `repo` is the workspace-relative root of the git repo that owns them ('.' = workspace).
   */
  commit(files: string[], subject: string, undo: Undo | null, repo?: string): void {
    return commit(this, files, subject, undo, repo)
  }

  _commitIn(cwd: string, files: string[], subject: string, undo: Undo | null): void {
    return commitIn(this, cwd, files, subject, undo)
  }
}

function readPkg(root: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  } catch {
    return {}
  }
}
