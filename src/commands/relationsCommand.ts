import { parseArgs } from "../lib/parseArgs.ts"
import { refuseUnknownFlags } from "../lib/refuseUnknownFlags.ts"
import { rel } from "../lib/rel.ts"
import { Store } from "../store/Store.ts"
import { atomicWrite } from "../lib/atomicWrite.ts"
import { bodyField } from "../record/bodyField.ts"
import { fieldsOf } from "../record/descriptor.ts"
import { emit } from "../lib/emit.ts"
import { expectedMirrors } from "../record/expectedMirrors.ts"
import { ownersReadIn } from "../record/ownersReadIn.ts"
import { parseRecord } from "../record/records.ts"
import { serialize } from "../record/serialize.ts"
import { storageOf } from "../record/storageOf.ts"
import type { Relation } from "../record/types.ts"
import type { Fields, Flags } from "../types.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { warnIfStale } from "../compile/warnIfStale.ts"

/**
 * `dt relations [<collection>] [--json]` — every two-way pair the compiled runtime declares — and
 * `dt relations rebuild <collection> [--drop <field>]`.
 *
 * Rebuild is not a convenience verb: `check` prints "<mirror>: stale — run: dreamteamer relations
 * rebuild <target>", so this IS the other half of that sentence and has to repair exactly the state
 * check flags. That is why the staleness comparison below is character-for-character the one in
 * check.js — two spellings of "stale" would send the operator round a loop that never converges.
 */
/** Reads the compiled relations, so it gets the same staleness warning every record verb gets. */
export async function relationsCommand(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  warnIfStale(ws.root)
  const store = new Store(ws)
  const { flags, pos } = parseArgs(args)
  const rebuilding = pos[0] === "rebuild"
  refuseUnknownFlags(store, (rebuilding ? pos[1] : pos[0]) ?? "", rebuilding ? "rebuild" : "relations", flags)
  if (rebuilding) return relationsRebuild(store, flags, pos)

  // `store.relations()` is `relationsOf(this.descriptors)` memoized per Store — going through it
  // rather than calling relationsOf here keeps one decoder for the whole process.
  // The name is VALIDATED, exactly as `rebuild` validates it: without this a typo answered "no
  // two-way relations touch nosuch" at exit 0 — the same sentence a correctly-spelled collection
  // with no relations gets, so a misspelling reads as a fact about the workspace.
  if (pos[0]) store.descriptor(pos[0])
  const rows = store.relations().filter(r => !pos[0] || r.owner === pos[0] || r.target === pos[0])
  if (flags.json) {
    emit(JSON.stringify(rows, null, 2))
    return 0
  }
  if (!rows.length) {
    console.log(pos[0] ? `no two-way relations touch ${pos[0]}` : "no two-way relations declared")
    return 0
  }
  // `[]` on the mirror is cardinality, not decoration: it is the difference between a field the
  // operator can read as one reference and one they have to iterate.
  const cells = rows.map(r => [
    `${r.owner}.${r.field}`,
    `${r.target}.${r.mirror}${r.unique ? "" : "[]"}`,
    r.kind,
    r.onDelete,
  ])
  const width = (i: number): number => Math.max(...cells.map(c => c[i].length))
  const [w0, w1, w2] = [width(0), width(1), width(2)]
  for (const c of cells) console.log(`${c[0].padEnd(w0)}  →  ${c[1].padEnd(w1)}  ${c[2].padEnd(w2)}  ${c[3]}`)
  return 0
}

function relationsRebuild(store: Store, flags: Flags, pos: string[]) {
  const collection = pos[1]
  if (!collection) throw new Error("usage: dreamteamer relations rebuild <collection> [--drop <field>]")
  const d = store.descriptor(collection)
  // The two shapes compile refuses to stamp a mirror onto, refused again here — because --drop
  // writes even when NO relation targets this collection, and `serialize` has no branch for
  // `format: binary`: it would replace the record's own bytes (an SVG, a PDF) with frontmatter.
  if (!store.canRewrite(collection)) {
    const why = storageOf(d).runtime ? "a compiled source" : "stored as `format: binary`"
    throw new Error(`"${collection}" is ${why} — it carries no generated mirrors and this verb will not rewrite it.`)
  }
  // `--drop` LAST on the line parses as the boolean `true`. Quietly treating that as "no --drop"
  // printed a green "rebuilt 0 records", which the operator reads as "the residue key is gone" —
  // the one sentence that must never be said falsely by a repair verb.
  if ("drop" in flags && (typeof flags.drop !== "string" || !flags.drop.trim())) {
    throw new Error("--drop needs a field name: dreamteamer relations rebuild <collection> --drop <field>")
  }
  const drop = typeof flags.drop === "string" ? flags.drop : null
  if (drop && fieldsOf(d)[drop])
    throw new Error(
      `"${drop}" is a live field of ${collection} — --drop only removes keys the schema no longer declares.`
    )

  // Expectations computed ONCE per relation, over a single pass of each owning collection. The
  // store's own `applyMirrorEdits` re-walks the owners per write, which is right for one edit and
  // quadratic for a whole collection — so rebuild does not build on it.
  const unreadableOwners: string[] = []
  // PER REPO, like check.js and the store: an owner in another repo (a record layer, or this
  // workspace against a module-owned target) implies no mirror on a target it cannot be committed with
  const perRepo = (r: Relation) => {
    const groups = new Map<string, { id: string; fields: Fields }[]>()
    for (const o of parseEach(store, r.owner, f => unreadableOwners.push(rel(store.root, f)))) {
      const repo = store.repoOfFile(store.descriptor(r.owner), o.file)
      if (!groups.has(repo)) groups.set(repo, [])
      groups.get(repo).push(o)
    }
    return new Map([...groups].map(([repo, os]) => [repo, expectedMirrors(r, os)]))
  }
  const expected = store
    .relations()
    .filter(r => r.target === collection)
    .map(r => ({ r, exp: perRepo(r) }))
  // An owner that will not parse takes its edges with it — and rebuild would then DELETE the mirror
  // values those edges justify. Refuse while nothing has been written yet; a skip here is data loss,
  // unlike a skip on the target side below, which only leaves a record unrepaired.
  if (unreadableOwners.length) {
    throw new Error(
      `cannot rebuild ${collection}: ${unreadableOwners.join(", ")} will not parse — fix the owning record first (\`dreamteamer check\` names the syntax error).`
    )
  }

  let rebuilt = 0
  // The write lock, like every other write verb: several agents work in one tree, and a concurrent
  // `dt set` landing mid-sweep would be clobbered back to the pre-set mirror value.
  store.withWriteLock(() => {
    for (const { id, file, fields } of parseEach(store, collection, f =>
      console.warn(`⚠ ${rel(store.root, f)}: parse error, skipped — \`dreamteamer check\` reports it`)
    )) {
      let changed = false
      const repo = store.repoOfFile(d, file)
      for (const { r, exp } of expected) {
        // a layer's mirror justified by owners this workspace does not read from that layer is
        // left exactly as the layer wrote it — rebuilding it from here deleted it (ownersReadIn)
        if (store.layerOfFile(d, file) && !ownersReadIn(store.descriptor(r.owner), repo)) continue
        const want = exp.get(repo)?.get(id)
        const have = fields[r.mirror]
        // ⚠ COERCE THE WAY AJV DOES. `check` validates with `coerceTypes: 'array'`, which mutates
        // the record in place BEFORE its relation pass — so it compares a coerced value while this
        // reads the raw parse. Unmatched, the two disagree in both directions: `recordings: 5`
        // crashed the spread here ("(have ?? []) is not iterable") on the very record check had
        // just named, mid-loop and after earlier writes; and `recordings: recordings/cap` read as
        // stale here while check called it fine.
        const list = Array.isArray(have) ? have : have == null ? [] : [have]
        // the comparison check.js makes: a unique relation mirrors to a scalar, everything else
        // to a sorted array, and absent reads the same as empty
        const same = r.unique
          ? (have ?? null) === (want ?? null)
          : JSON.stringify([...list].sort()) === JSON.stringify(want ?? [])
        if (same) continue
        if (want == null) delete fields[r.mirror]
        else fields[r.mirror] = want
        changed = true
      }
      if (drop && drop in fields) {
        delete fields[drop]
        changed = true
      }
      // each record is written AT MOST ONCE, whatever number of relations point at it
      if (changed && atomicWrite(file, serialize(d, fields))) rebuilt++
    }
  })
  if (flags.json) {
    emit(JSON.stringify({ collection, rebuilt }))
    return 0
  }
  // auto-commit is off by default, so these writes are sitting dirty — but only say so when
  // something actually landed; a commit hint after "rebuilt 0" is an instruction to do nothing.
  const hint = rebuilt ? ` — run: dreamteamer commit ${collection}` : ""
  console.log(`✔ rebuilt ${rebuilt} record${rebuilt === 1 ? "" : "s"}${hint}`)
  return 0
}

/** `store.readAll` for a reader that must SURVIVE a bad record. It is a generator, so a parse error
 *  mid-walk cannot be resumed past — and rebuild is the one reader that has already written by the
 *  time a later record blows up, so an abort leaves a partial sweep behind an error naming no file
 *  at all. Here the bad record is handed to `onError` and skipped, and the walk finishes. */
function* parseEach(
  store: Store,
  collection: string,
  onError: (file: string, e: Error) => void
): Generator<{ id: string; file: string; fields: Fields }> {
  const d = store.descriptor(collection)
  const bf = bodyField(d)
  const rows = [...store.ids(collection)].map(([id, file]) => ({ id, file }))
  for (const { id, file } of rows) {
    let fields
    try {
      fields = parseRecord(file, d, bf)
    } catch (e) {
      onError(file, e)
      continue
    }
    yield { id, file, fields }
  }
}
