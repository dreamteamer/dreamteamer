import fs from "node:fs"
import { addField } from "./collections/addField.ts"
import { commandsFor } from "./collections/commandsFor.ts"
import { contributedNotes } from "./collections/contributedNotes.ts"
import { createCollection } from "./collections/createCollection.ts"
import { createModule } from "./collections/createModule.ts"
import { createSkill } from "./collections/createSkill.ts"
import { distinctValues } from "./collections/distinctValues.ts"
import { fieldFromFlags } from "./collections/fieldFromFlags.ts"
import { history } from "./collections/history.ts"
import { historyDiff } from "./collections/historyDiff.ts"
import { isEntityKind } from "./collections/isEntityKind.ts"
import { keyBetween } from "./collections/keyBetween.ts"
import { matchesFilter } from "./collections/matchesFilter.ts"
import { moveCollection } from "./collections/moveCollection.ts"
import { moveUiView } from "./collections/moveUiView.ts"
import { nearest } from "./collections/nearest.ts"
import { parseArgs } from "./collections/parseArgs.ts"
import { placementKey } from "./collections/placementKey.ts"
import { recordResolver } from "./collections/recordResolver.ts"
import { refuseHandAuthored } from "./collections/refuseHandAuthored.ts"
import { refuseUnknownFlags } from "./collections/refuseUnknownFlags.ts"
import { rel } from "./collections/rel.ts"
import { removeCollection } from "./collections/removeCollection.ts"
import { removeEntity } from "./collections/removeEntity.ts"
import { removeField } from "./collections/removeField.ts"
import { removeModule } from "./collections/removeModule.ts"
import { removeUiView } from "./collections/removeUiView.ts"
import { renameCollection } from "./collections/renameCollection.ts"
import { renameEntity } from "./collections/renameEntity.ts"
import { renameField } from "./collections/renameField.ts"
import { renameModule } from "./collections/renameModule.ts"
import { renameValue } from "./collections/renameValue.ts"
import { ensureAllRepos, ensureRepo } from "./collections/repos.ts"
import { saveUiView } from "./collections/saveUiView.ts"
import { collectionSourceFileFor } from "./collections/schema-ops.ts"
import { setCollectionScalars } from "./collections/setCollectionScalars.ts"
import { setEntityFrontmatter } from "./collections/setEntityFrontmatter.ts"
import { setModule } from "./collections/setModule.ts"
import { sortRows } from "./collections/sortRows.ts"
import { updateField } from "./collections/updateField.ts"
import { Store } from "./record/Store.ts"
import { bodyField } from "./record/bodyField.ts"
import { fieldsOf, jsonSchemaOf, positionFieldOf, recordTitleOf, targetsOf } from "./record/descriptor.ts"
import { displayOf } from "./record/displayOf.ts"
import { emit } from "./record/emit.ts"
import { VALUE_TOKENS } from "./record/consts.ts"
import { baseNameOf, defaultStoragePath } from "./record/namespace.ts"
import { storageOf } from "./record/storageOf.ts"
import { slug } from "./record/template.ts"
import { unknownTokens } from "./record/unknownTokens.ts"
import { dump, load } from "./record/yaml.ts"
import type { Descriptor, Field, Fields, Flags, Workspace } from "./types.ts"
import { KINDS } from "./workspace/consts.ts"
import { reportCommits } from "./workspace/reportCommits.ts"

// A schema op returns a different shape per outcome (dry run · nothing to do · committed); a caller that
// reads whichever keys are there wants them as ONE type, each optional, each keeping its real type.
type KeysOf<U> = U extends unknown ? keyof U : never

type Flat<U> = { [K in KeysOf<U>]?: U extends Partial<Record<K, infer V>> ? V : never }

/** `list` flags that are options, not `field=value` shorthand filters. */
const LIST_META_FLAGS = new Set(["json", "filter", "where", "sort"])

export function collectionCommand(ws: Workspace, collection: string, verb: string, args: string[]) {
  const store = new Store(ws)
  const { flags, pos } = parseArgs(args)
  refuseUnknownFlags(store, collection, verb, flags)

  // ---- system verbs: source writes, never the runtime ----------
  // These MUST come before the generic switch: their collections are system-stored, so the
  // ordinary record path refuses them ("… are system sources") and always would.
  if (collection === "collections" && verb === "add") return metaCollectionsAdd(ws, store, flags)
  if (collection === "collections" && verb === "rm") return metaCollectionsRm(ws, store, flags, pos)
  if (collection === "collections" && verb === "rename") return metaCollectionsRename(ws, store, flags, pos)
  if (collection === "collections" && verb === "set") return metaCollectionsSet(ws, store, flags, pos)
  if (collection === "collections" && verb === "get" && flags.module !== undefined)
    return metaCollectionsGet(ws, store, flags, pos)
  if (collection === "collections" && verb === "reorder") return metaCollectionsMove(ws, store, flags, pos)
  if (collection === "commands" && verb === "for") return metaCommandsFor(ws, store, flags, pos)
  if (collection === "ui-views" && ["add", "set", "rm"].includes(verb)) return metaUiView(ws, store, verb, flags, pos)
  if (collection === "modules" && verb === "add") return metaModulesAdd(ws, store, flags)
  if (collection === "modules" && verb === "rm") return metaModulesRm(ws, store, flags, pos)
  if (collection === "modules" && verb === "rename") return metaModulesRename(ws, store, flags, pos)
  if (collection === "modules" && verb === "set") return metaModulesSet(ws, store, flags, pos)
  if (collection === "repos" && verb === "ensure") return metaReposEnsure(ws, flags, pos)
  if (verb === "add-field") return metaAddField(ws, store, collection, flags)
  if (verb === "set-field") return metaUpdateField(ws, store, collection, flags)
  if (verb === "rm-field") return metaRemoveField(ws, store, collection, flags)
  if (verb === "rename-field") return metaRenameField(ws, store, collection, flags)
  if (verb === "rename-value") return metaRenameValue(ws, store, collection, flags, pos)

  // ---- the identity entities. §3.1's last row: `add` scaffolds a skill and is refused WITH THE
  // PATH for the five hand-authored kinds; `set` edits frontmatter; `rm` and `rename` work on all
  // six. Keyed on the collection NAME rather than on `storage.base` because these six are the
  // ones with a source-file shape — `modules` is projected and `collections` has its own verbs.
  if (isEntityKind(store, collection) && ["add", "set", "rm", "rename"].includes(verb)) {
    return metaEntityVerb(ws, store, collection, verb, flags, pos)
  }
  // `revert` on ANY system entity: its history is git's, and `store.revert` writes a RECORD.
  if (verb === "revert" && storageOf(store.descriptors.get(collection)).runtime) {
    const src = sourceHintFor(store, collection)
    throw new Error(
      `${collection}/${pos[0] ?? "<id>"} is a compiled source, so there is no record to revert — its source is in git.\n  git log -- ${src}\n  git checkout <sha> -- ${src}\n  dreamteamer compile`
    )
  }

  const d = store.descriptor(collection)

  // Every record write says WHICH workspace it landed in. `--vault` is OPTIONAL and a bare command
  // resolves from the working directory, so the one thing the flag cannot do is tell you when you
  // forgot it \u2014 this can, for the price of one word, with no state and nothing refused. A write
  // aimed at one workspace and landed in another becomes visible on the very next line of output
  // instead of never: on a machine holding several workspaces most collection NAMES are shared while
  // their fields are not, so the misplaced write succeeds and reports success.
  const at = ws.pkg?.name ? `${ws.pkg.name} \u00b7 ` : ""

  switch (verb) {
    case "list": {
      const { rows, narrowed, files } = narrowRows(store, d, collection, flags)
      // each row says where it is read from and which repo commits it — `$`-keys, because a
      // collection may author a field called `file` or `repo` (an issue tracker's `repo` is one)
      if (flags.json) {
        emit(
          JSON.stringify(
            rows.map(r => ({ ...r, ...whereKeys(store.locationOf(d, files.get(r.id))) })),
            null,
            2
          )
        )
        return 0
      }
      const cols = listColumns(d)
      for (const r of rows) console.log(cols.map(c => fmtCell((r as Record<string, unknown>)[c])).join("  "))
      if (!rows.length) console.log(`(no ${collection}${narrowed ? " matching" : ""})`)
      return 0
    }
    case "get": {
      const id = need(pos, 0, "id")
      // an id no root holds that an exports manifest vouches for (cr-dt-004): named, and still exit 1
      const ext = store.external(collection, id, { referrer: flags.referrer as string })
      if (ext) {
        if (flags.json) emit(JSON.stringify({ $external: { collection, id, ...ext } }, null, 2))
        console.error(
          `${collection}/${id} is not held here — external: "${ext.label}", held by ${ext.from ?? "a workspace the manifest does not name"} (${ext.manifest})`
        )
        return 1
      }
      const { fields, file } = store.read(collection, id)
      // descriptor v2: a record older than the `created` stamp still answers it — read, never written
      const created = store.createdOf(collection, id, fields, file)
      if (created !== undefined && fields.created === undefined) fields.created = created
      if (flags.json) {
        emit(JSON.stringify({ ...fields, id, ...whereKeys(store.locationOf(d, file)) }, null, 2))
        return 0
      }
      console.log(dump(fields).trimEnd())
      return 0
    }
    case "add": {
      // An opaque collection is written by IMPORTING a file: the id is positional (nothing can
      // generate it from fields that do not exist) and the bytes come from --from.
      if (storageOf(d).format === "binary") {
        const id = need(pos, 0, "id")
        if (!flags.from)
          throw new Error(
            `"${collection}" is a \`format: binary\` collection — pass --from <path> with the file to import`
          )
        const { id: written, file } = store.addFile(collection, id, flags.from as string, { force: !!flags.force })
        if (flags.json) emit(JSON.stringify({ id: written, path: rel(ws.root, file) }))
        else console.log(`✔ ${at}${rel(ws.root, file)}`)
        return 0
      }
      if (flags.from)
        throw new Error(`--from imports a file as a record, and "${collection}" is not a \`format: binary\` collection`)
      // ONE bare positional is the record's title — the field `record_title` opens with — so
      // `dt add task "call the bank"` reads as a sentence. Two positionals is a mistake (a flag
      // value that lost its flag), and so is giving the title twice; both are refused by name.
      if (pos.length > 1)
        throw new Error(
          `dt add ${collection} takes ONE positional (the title) and flags for the rest — got ${pos.length}: ${pos.map(p => `"${p}"`).join(" ")}`
        )
      if (pos.length === 1) {
        const titleField = /\{\{\s*([A-Za-z_][\w]*)/.exec(recordTitleOf(d))?.[1]
        if (!titleField || titleField === "id")
          throw new Error(
            `"${collection}" labels its records by id, so there is no title field for "${pos[0]}" to fill — pass fields as --<field> <value>`
          )
        if (titleField in flags)
          throw new Error(
            `the title was given twice — "${pos[0]}" and --${titleField} ${JSON.stringify(flags[titleField])}`
          )
        flags[titleField] = pos[0]
      }
      const fields = coerceArrays(d, stripMeta(flags))
      const { id, file, idFallback, deprecated } = store.add(collection, fields, {
        id: flags.id as string,
      }) as ReturnType<Store["add"]> & { idFallback: { id: string; field: string; value: unknown } | null }
      for (const k of deprecated ?? [])
        console.warn(
          `⚠ ${k} is deprecated on ${collection} — it still validates, and nothing draws it. Check the collection's description for what replaced it.`
        )
      if (flags.json) emit(JSON.stringify({ id, path: rel(ws.root, file), ...(idFallback ? { idFallback } : {}) }))
      else console.log(`✔ ${at}${rel(ws.root, file)}`)
      // ⚠ SAY IT, EVERY TIME. The id was derived from a hash because the value it is generated
      // from carries no a-z0-9 — the write succeeded and the record is fine, but the id is
      // unreadable and unguessable, and nobody finds that out until they try to type it. By
      // then other records reference it and renaming is a migration.
      if (idFallback && !flags.json) {
        console.warn(
          `⚠ id "${idFallback.id}" is a hash, not a name — "${idFallback.field}" (${idFallback.value}) has no latin characters to slug.`
        )
        console.warn(
          "  give this collection a latin handle: id.generate accepts an ORDERED LIST and takes the first that renders —"
        )
        console.warn("      id: { generate: ['{{ code }}', '{{ name | slug }}'] }")
        console.warn("  or pass --id on this write. Renaming later rewrites every reference.")
      }
      return 0
    }
    case "set": {
      const id = need(pos, 0, "id")
      const changes = coerceArrays(d, pairs(pos.slice(1)))
      Object.assign(changes, coerceArrays(d, stripMeta(flags)))
      if (!Object.keys(changes).length) throw new Error("nothing to set — pass key=value pairs or --key value flags")
      const where = store.ids(collection).has(id) ? store.locate(collection, id) : null // a missing id is store.set's to refuse
      store.set(collection, id, changes)
      if (flags.json) emit(JSON.stringify({ id, ...(where ? whereKeys(where) : {}) }))
      else console.log(`✔ ${at}updated${landedIn(where)}`)
      return 0
    }
    // Manual ordering. ONE record is written per move — that is the entire feature; a dense
    // integer would renumber everything below the insertion point and bury the change. The field is
    // the descriptor's `type: position` field, never named here, so a workspace may call it anything.
    case "reorder": {
      const field = positionFieldOf(d)
      if (!field)
        throw new Error(
          `collection "${collection}" has no \`type: position\` field — add one to its descriptor before ordering it by hand.`
        )

      // Blanks sort FIRST (compareValues, via `?? ''`), so unplaced records surface at the top
      // rather than hiding at the bottom, and ties fall back to id order: `walk` reads name-sorted
      // and Array.sort is stable. That is the tiebreak two agents landing on the same key rely on.
      // a position value is a key string (compile pins its pattern); `check` reports one that is not
      const rows: { id: string; key: string }[] = []
      for (const { id: rid, fields } of store.readAll(collection))
        rows.push({ id: rid, key: (fields[field] ?? "") as string })
      sortRows(rows, "key", undefined)

      if (flags.init) {
        // Idempotent: a record that already carries a key keeps it, so --init can be re-run after
        // adding records without disturbing an order the operator set by hand.
        let prev = rows.filter(r => r.key).pop()?.key ?? null
        let written = 0
        for (const r of rows) {
          if (r.key) continue
          prev = keyBetween(prev, null)
          store.set(collection, r.id, { [field]: prev })
          written++
        }
        if (flags.json) emit(JSON.stringify({ placed: written }))
        else console.log(written ? `✔ placed ${written} record(s) in ${field}` : "✔ nothing to place")
        return 0
      }

      const id = need(pos, 0, "id")
      store.set(collection, id, { [field]: placementKey(rows, id, flags, collection) })
      if (flags.json) emit(JSON.stringify({ id }))
      else console.log(`✔ ${at}moved`)
      return 0
    }
    case "rm": {
      const id = need(pos, 0, "id")
      if (flags["dry-run"])
        return dryRunPlan(`rm ${collection}/${id}`, {
          records: store.ids(collection).has(id) ? 1 : 0,
          refs: store.findInboundRefs(`${collection}/${id}`).length,
        })
      const where = store.ids(collection).has(id) ? store.locate(collection, id) : null // a missing id is store.rm's to refuse
      const { inboundIgnored } = store.rm(collection, id, { force: !!flags.force })
      if (flags.json) emit(JSON.stringify({ id, removed: true, inboundIgnored }))
      else
        console.log(
          `✔ ${at}removed${landedIn(where)}${inboundIgnored ? ` (${inboundIgnored} inbound reference(s) left dangling — run \`dreamteamer check\`)` : ""}`
        )
      return 0
    }
    case "rename": {
      const out = store.rename(collection, need(pos, 0, "old id"), need(pos, 1, "new id"))
      if (flags.json) {
        emit(JSON.stringify(out))
        return 0
      }
      console.log(`✔ ${at}renamed ${collection}/${need(pos, 0, "old id")} → ${collection}/${out.id}`)
      if (out.touched) console.log(`✔ rewrote ${out.rewrites} inbound reference(s) across ${out.touched} file(s)`)
      return 0
    }
    // `dreamteamer values meetings status` — the vocabulary a field ACTUALLY uses, so a filter
    // or a command-binding validator can offer a dropdown for a plain `type: string` field that
    // no enum describes (operator: "still no dropdown for many things, visibility, status").
    case "values": {
      const field = need(pos, 0, "field")
      // ⚠ A BARE `--limit` parses as the boolean `true`, and `Number(true)` is 1 — so it
      // truncated the vocabulary to one value while the footer claimed "showing 1", which reads
      // as a fact about the collection. Refused, in `--drop`'s words.
      if ("limit" in flags && !Number.isFinite(Number(oneValue(flags, "limit"))))
        throw new Error(`--limit needs a number: dreamteamer values ${collection} ${field} --limit 20`)
      const out = distinctValues(store, collection, field, {
        limit: flags.limit === undefined ? undefined : Number(flags.limit),
      })
      if (flags.json) {
        emit(JSON.stringify(out, null, 2))
        return 0
      }
      if (out.skipped) {
        console.log(`(${collection}.${field} is a ${out.skipped} field — no value vocabulary)`)
        return 0
      }
      if (!out.values.length) {
        console.log(`(no values set on ${collection}.${field})`)
        return 0
      }
      for (const { value, count } of out.values)
        console.log(count == null ? String(value) : `${String(count).padStart(5)}  ${value}`)
      console.log(
        `— ${out.total} distinct${out.truncated ? ` (showing ${out.values.length})` : ""}, from ${out.source}`
      )
      return 0
    }
    case "history": {
      const id = need(pos, 0, "id")
      const log = history(store, collection, id)
      if (flags.json) {
        emit(JSON.stringify(log, null, 2))
        return 0
      }
      if (!log.length) {
        console.log(`(no history for ${collection}/${id} — not committed yet)`)
        return 0
      }
      for (const c of log) console.log(`${c.hash.slice(0, 7)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.subject}`)
      return 0
    }
    case "diff": {
      const id = need(pos, 0, "id")
      const out = historyDiff(store, collection, id, oneValue(flags, "hash") ?? "HEAD")
      if (flags.json) {
        emit(JSON.stringify(out, null, 2))
        return 0
      }
      console.log(out.diff.trimEnd() || `(no change to ${out.path} in ${out.hash})`)
      return 0
    }
    case "revert": {
      const id = need(pos, 0, "id")
      // the hash is REQUIRED and has no default: "revert" with an implied target is how you
      // destroy the wrong record. `<c> history <id>` is where you get one.
      const hash = oneValue(flags, "hash") ?? pos[1]
      if (!hash)
        throw new Error(`missing --hash <commit> — run \`dreamteamer history ${collection}/${id}\` to pick one`)
      const out = store.revert(collection, id, hash)
      if (flags.json) emit(JSON.stringify(out))
      else
        console.log(
          out.reverted
            ? `✔ reverted ${collection}/${id} to ${String(hash).slice(0, 7)}`
            : `= already identical to ${String(hash).slice(0, 7)} — nothing changed`
        )
      return 0
    }
    default:
      throw new Error(
        `unknown verb "${verb}" — use list | get | add | set | rm | rename | values | history | diff | revert`
      )
  }
}

// Which bound commands apply, in which state (available / done / not-applicable). THE engine
// surface behind the studio's Commands tab (engine/UI parity: the verb lands first, the button
// second).
//
// ⚠ The COLLECTION arrives already resolved, and the ids only ever through `--ids`. This used to
// split its own target at the first slash — which cannot name a namespaced collection, so
// `commands finance/transactions` asked for a collection called "finance" and every namespaced
// target failed. `cli.js` owns reference resolution now (splitRef, longest declared prefix) and is
// the only caller, so a second, weaker splitter here could only ever disagree with it.
function metaCommandsFor(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const collection = need(pos, 0, "collection")
  const ids = (oneValue(flags, "ids") ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  const out = commandsFor(store, collection, ids)
  // what an installed extension says about these records (a session holding one, say) — after the
  // commands, because the commands are the answer and a note is context for it
  const notes = contributedNotes(ws, collection, ids)
  if (flags.json) {
    emit(JSON.stringify({ ...out, notes }, null, 2))
    return 0
  }
  if (!out.commands.length) console.log(`(no commands bound to ${collection})`)
  for (const c of out.commands) {
    if (c.scope === "collection") {
      console.log(`${c.name}  [collection]  ${c.invocation}`)
      continue
    }
    const counts = ids.length
      ? `  ${c.eligible.length}/${ids.length} eligible${c.done.length ? `, ${c.done.length} done` : ""}`
      : "  (no ids given)"
    console.log(`${c.name}  [record]${counts}${c.invocation ? `\n  ${c.invocation}` : ""}`)
  }
  for (const n of notes) console.log(n.error ? `✖ ${n.by}: ${n.text}` : `● ${collection}/${n.id} — ${n.text} (${n.by})`)
  return 0
}

/**
 * `repos ensure <id>` / `repos ensure --all` — materialize declared repos on demand.
 * Lazy by design: `install` deliberately does NOT do this, so a fresh workspace clone is
 * immediately workable without pulling every attached repo (and one unreachable remote can only
 * fail the action you asked for, not the whole install).
 */
function metaReposEnsure(ws: Workspace, flags: Flags, pos: string[]) {
  const results = flags.all ? ensureAllRepos(ws) : [ensureRepo(ws, need(pos, 0, "id"))]
  if (flags.json) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }
  for (const r of results) console.log(r.cloned ? `✔ cloned ${r.path}` : `✔ ${r.path} (present)`)
  if (!results.length) console.log("(no repos declared)")
  return 0
}

// ---- modules ----------------------------------------------------------------------------------
// A module is the one system entity that had no verbs at all, which is what left system-entity CRUD
// incomplete: there was no `add-module`, no `rm-module`, no `rename-field`, and no way to NAME a
// target module. §6.2.

// `dreamteamer add modules --name core [--description "…"]`
function metaModulesAdd(ws: Workspace, store: Store, flags: Flags) {
  // ⚠ BEFORE the write, as `add collections` does it and for the same reason: naming the mistake
  // after the call lands a committed module and then exits 1.
  if (flags.namespace === true)
    throw new Error("--namespace takes a value: dreamteamer add modules --name <id> --namespace <ns>")
  const out = createModule(ws, store, {
    name: oneValue(flags, "name"),
    description: oneValue(flags, "description"),
    namespace: oneValue(flags, "namespace"),
    extension: flags.extension === true || flags.extension === "true",
    pkg: flags.package === undefined ? null : flags.package === true ? true : oneValue(flags, "package"),
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  console.log(`✔ ${out.root}/ — ${out.files.join(" · ")} + ${KIND_COUNT} kind folder(s)`)
  // §6.2 promises the namespace is DECLARED IN THE MODULE, and §8 makes every later
  // `add collections --module <id>` infer it — so the declaration is echoed, because an inferred
  // identity the operator did not type is one they must be able to read back.
  if (out.namespace) console.log(`✔ declared namespace "${out.namespace}" in modules/${out.id}`)
  console.log(
    "✔ compiled — the module is live (add a collection with `dreamteamer add collections --name <c> --module " +
      out.id +
      "`)"
  )
  reportCommits(out.commits)
  return 0
}

// `dreamteamer rm modules/core [--force] [--dry-run]`
function metaModulesRm(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const id = need(pos, 0, "module id")
  const out: Flat<ReturnType<typeof removeModule>> = removeModule(ws, store, id, {
    force: !!flags.force,
    dryRun: !!flags["dry-run"],
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.dryRun)
    return dryRunPlan(`rm modules/${id} --force`, out, [
      out.collections.length ? `sources removed for: ${out.collections.join(", ")}` : null,
      out.withRecords.length ? `records left in place and UNINDEXED: ${out.withRecords.join(", ")}` : null,
      out.dependents.length ? `dependencies entry dropped from: ${out.dependents.join(", ")}` : null,
    ])
  console.log(`✔ removed module ${out.removed}`)
  if (out.withRecords.length) console.log(`  ⚠ records remain and are now unindexed: ${out.withRecords.join(", ")}`)
  if (out.dependents.length) console.log(`  dropped it from ${out.dependents.join(", ")}'s dependencies`)
  console.log("✔ compiled — the module is gone")
  reportCommits(out.commits)
  return 0
}

// `dreamteamer rename modules/core shared`
function metaModulesRename(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const oldId = need(pos, 0, "module id")
  const out = renameModule(ws, store, oldId, need(pos, 1, "new module id"))
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (!out.renamed) {
    console.log(`✔ ${oldId} — already named that, nothing to do`)
    return 0
  }
  console.log(`✔ ${oldId} → ${out.id}`)
  console.log(`  rewrote  ${out.rewrites} reference(s): extends, dependencies, disable and modules/${oldId} refs`)
  console.log("✔ compiled — the rename is live, in ONE commit")
  reportCommits(out.commits)
  return 0
}

// `dreamteamer set modules/hr description="…" dependencies=modules/core`
function metaModulesSet(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const id = need(pos, 0, "module id")
  const changes = { ...pairs(pos.slice(1)), ...stripMeta(flags) }
  if (!Object.keys(changes).length)
    throw new Error("nothing to set — pass key=value pairs (description, namespaces, dependencies, peer_collections)")
  const out = setModule(ws, store, id, changes)
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.unchanged) return alreadyThat(`modules/${id} ${out.changed.join(", ")}`)
  console.log(`✔ ${rel(ws.root, out.file)} — ${out.changed.join(", ")}`)
  console.log("✔ compiled — the module record is up to date")
  reportCommits(out.commits)
  return 0
}

/** How many kind folders `add modules` scaffolds, for its own report. Read off the engine's own
 *  KINDS so the sentence cannot go stale against the list it describes. */
const KIND_COUNT = KINDS.length

/**
 * THE ONE PLAN PRINTER, for every verb that moves records or clears values — one shape, `records N ·
 * refs M · descriptors K · values cleared V`, because a reader comparing two dry runs must not have
 * to work out whether a missing term means zero or means "this verb does not count that".
 *
 * ⚠ FOUR OF THE SIX SPELLINGS DOCUMENTED `--dry-run` AND EXECUTED ANYWAY, and the self-commit made
 * it durable: `dt rm collections/widgets --dry-run --force` printed "✔ removed collection widgets",
 * deleted the source and committed it, at exit 0, against a `dt help` that spells `rm <system>/<id>
 * [--force] [--dry-run]` verbatim. `rm modules/<id>` was the ONE that honoured it. A flag a verb
 * advertises and ignores is worse than one it does not have — the operator's whole reason for typing
 * it is that they are not sure yet.
 *
 * It counts only what it can count WITHOUT doing the op; an unmeasured term is stated as such in
 * `extra` rather than guessed at, per `rename collections`' dry run.
 */
function dryRunPlan(
  what: string,
  plan: { records?: number; refs?: number; descriptors?: number; cleared?: number },
  extra?: unknown[]
) {
  console.log(`dry run — dreamteamer ${what} would:`)
  console.log(
    `  records ${plan.records ?? 0} · refs ${plan.refs ?? 0} · descriptors ${plan.descriptors ?? 0} · values cleared ${plan.cleared ?? 0}`
  )
  for (const line of extra ?? []) if (line) console.log(`  ${line}`)
  return 0
}

// `dreamteamer add collections --name research-docs --mixins docs --id-from '{{ created | date }}--{{ title | slug }}'`
function metaCollectionsAdd(ws: Workspace, store: Store, flags: Flags) {
  // ⚠ BEFORE the write, not after. `--namespace=` is the empty STRING (clear it); a bare
  // `--namespace` parses as `true`, which is a mistake worth naming — and naming it AFTER the call
  // lands a committed collection and then exits 1, which is the one report shape that lies twice.
  if (flags.namespace === true) throw new Error("--namespace takes a value; --namespace '' means no namespace")
  const moduleId = oneValue(flags, "module")
  const out = createCollection(ws, store, {
    name: oneValue(flags, "name"),
    mixins: oneValue(flags, "mixins"),
    idFrom: oneValue(flags, "id-from"),
    namespace: flags.namespace as string | undefined, // a bare flag was refused above; a repeat is the list compile names
    moduleId,
    description: oneValue(flags, "description"),
    suffix: oneValue(flags, "suffix"),
  })
  console.log(`✔ ${out.name}${out.inferred ? ` (namespace inferred from module ${moduleId})` : ""}`)
  console.log(`✔ ${rel(ws.root, out.file)}`)
  if (out.declaredNamespace)
    console.log(
      `✔ declared namespace "${out.declaredNamespace}" in ${moduleId ? `modules/${moduleId}` : "the workspace"}`
    )
  // ⚠ ECHO THE SUFFIX, because it is DERIVED and the derivation is crude on purpose: every record
  // filename carries it (`<id>.<suffix>.md`), and the operator otherwise finds out what it decided
  // by looking at a file. Naming it here, with the override, is the whole papercut.
  if (out.suffixDerived) console.log(`  suffix: ${out.suffix} — override with --suffix <singular>`)
  console.log("✔ compiled — the collection is live (schema ops prove sources with a real compile)")
  reportCommits(out.commits)
  return 0
}

/**
 * `dt set collections/<c> module=<m>` — the MOVE — or the collection-level scalars.
 *
 * ⚠ Never both in one call. `module=` relocates a descriptor and validates the whole reference
 * contract; a scalar rewrites one key in it. Bundling them would make one command that either
 * half-applies or has to be explained, and the operator gets no signal about which happened.
 */
function metaCollectionsSet(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const name = need(pos, 0, "collection name")
  const positional = pairs(pos.slice(1))
  const changes = { ...positional, ...stripMeta(flags) }
  delete changes.module
  delete changes["dry-run"]
  const moveTo = positional.module ?? oneValue(flags, "module")
  if (moveTo !== undefined && Object.keys(changes).length) {
    throw new Error(
      `module= moves the collection to another module and validates the whole reference contract; a scalar rewrites one key in its descriptor. Run them as two commands: dreamteamer set collections/${name} module=${moveTo}, then dreamteamer set collections/${name} ${Object.entries(
        changes
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    )
  }
  if (moveTo !== undefined) {
    const out: Flat<ReturnType<typeof moveCollection>> = moveCollection(ws, store, name, String(moveTo), {
      dryRun: !!flags["dry-run"],
    })
    if (flags.json) {
      emit(JSON.stringify(out))
      return 0
    }
    if (out.dryRun)
      return dryRunPlan(`set collections/${name} module=${moveTo}`, out, [
        `descriptor  ${out.from} → ${out.to} (records stay where they are)`,
      ])
    if (!out.moved) {
      console.log(`✔ ${name} — already owned by ${out.from}, nothing to do`)
      return 0
    }
    console.log(`✔ ${name}: ${out.from} → ${out.to}`)
    console.log(`  records     ${out.records} left in place — a move never changes an id`)
    console.log(`  descriptors ${out.descriptors} rewritten`)
    console.log("✔ compiled — the move is live, in ONE commit")
    reportCommits(out.commits)
    return 0
  }
  if (!Object.keys(changes).length) throw new Error("nothing to set — pass key=value pairs, or module=<id> to move it")
  const out: Flat<ReturnType<typeof setCollectionScalars>> = setCollectionScalars(ws, store, name, changes, {
    moduleId: undefined,
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.unchanged) return alreadyThat(`collections/${name} ${out.changed.join(", ")}`)
  console.log(
    `✔ ${rel(ws.root, out.file)} — ${out.changed.join(", ")}${out.peer ? `, and declared ${out.peer.collection} as a peer collection of ${out.peer.module}` : ""}`
  )
  console.log("✔ compiled — the descriptor is up to date")
  reportCommits(out.commits)
  return 0
}

/**
 * `dt reorder collections/teams --after tasks` — NAV ORDERING, and that is all `reorder` means on a
 * collection. §7's other half: `module=` is the move between modules, `order` is the position in
 * the nav, and giving one verb both meanings is what made "move a collection" ambiguous.
 *
 * ⚠ `order` is a NUMBER on the descriptor, not a fractional index — unlike a record's position field,
 * which uses one because a record collection has thousands of rows and a dense integer would
 * renumber everything below the insertion point. A workspace has tens of collections and their
 * `order` values are hand-authored and readable (10, 40, 140), so a midpoint is the right shape:
 * it writes ONE descriptor and keeps the numbers legible.
 */
function metaCollectionsMove(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const name = need(pos, 0, "collection name")
  store.descriptor(name)
  const rows = [...store.descriptors]
    .map(([id, d]) => ({ id, order: typeof displayOf(d).nav?.order === "number" ? displayOf(d).nav.order : null }))
    .filter(r => r.id !== name && r.order !== null)
    .sort((a, b) => a.order - b.order)
  const anchorId = oneValue(flags, "after") ?? oneValue(flags, "before")
  let next
  if (flags.top) {
    next = rows.length ? rows[0].order - 10 : 10
  } else if (flags.bottom) {
    next = rows.length ? rows[rows.length - 1].order + 10 : 10
  } else {
    if (!anchorId) throw new Error(`dt reorder collections/${name} needs --after <c> | --before <c> | --top | --bottom`)
    const i = rows.findIndex(r => r.id === anchorId)
    if (i < 0)
      throw new Error(
        `"${anchorId}" has no \`display.nav.order\` to sit beside — set one first (dreamteamer set collections/${anchorId} display.nav.order=<n>), or use --top/--bottom.`
      )
    const anchorOrder = rows[i].order
    const neighbour = flags.after ? rows[i + 1]?.order : rows[i - 1]?.order
    // a MIDPOINT when there is a neighbour, a step of 10 when the anchor is at the end — and
    // nothing else is renumbered, which is the whole point
    next =
      neighbour === undefined
        ? flags.after
          ? anchorOrder + 10
          : anchorOrder - 10
        : Math.round((anchorOrder + neighbour) / 2)
    if (next === anchorOrder || next === neighbour) {
      throw new Error(
        `no room between ${anchorId} (${anchorOrder}) and its neighbour (${neighbour}) — the two are adjacent integers. Spread them first: dreamteamer set collections/${anchorId} display.nav.order=<n>.`
      )
    }
  }
  const out = setCollectionScalars(ws, store, name, { "display.nav.order": next })
  if (flags.json) {
    emit(JSON.stringify({ ...out, order: next }))
    return 0
  }
  console.log(`✔ ${name} display.nav.order=${next}`)
  console.log("✔ compiled — the nav order is live")
  reportCommits(out.commits)
  return 0
}

/** `dt get collections/<c> --module <m>` — ONE module's source contribution, not the merged
 *  descriptor. The merged one is what `dt get collections/<c>` prints and what every reader uses;
 *  this is the only way to see what a given module actually wrote, which is the question an overlay
 *  makes unanswerable from the runtime alone. */
function metaCollectionsGet(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const name = need(pos, 0, "collection name")
  const moduleId = oneValue(flags, "module")
  const { file } = collectionSourceFileFor(ws, store, name, moduleId)
  const doc = load<Record<string, unknown>>(fs.readFileSync(file, "utf8"))
  if (flags.json) emit(JSON.stringify({ ...doc, id: name, source: rel(ws.root, file) }, null, 2))
  else console.log(dump(doc).trimEnd())
  return 0
}

// `dreamteamer collections rename doctors health/doctors`, or `… doctors --namespace health`.
// The whole point is that namespacing EXISTING data is one command instead of a six-step hand
// migration whose last step (rewriting references) dangles everything when forgotten.
function metaCollectionsRename(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const [oldName, explicitNew] = pos
  if (!oldName)
    throw new Error("usage: dreamteamer rename collections/<old> <new> | collections/<old> --namespace <ns>")
  // `--namespace health` on its own moves the collection INTO that namespace keeping its bare name,
  // which is the common case and saves retyping it.
  const newName =
    explicitNew ??
    (flags.namespace
      ? `${String(flags.namespace).replace(/^\/+|\/+$/g, "")}/${baseNameOf(oldName, store.namespaces)}`
      : null)
  if (!newName) throw new Error("missing new name — give it positionally or with --namespace <ns>")

  if (flags["dry-run"]) {
    const d = store.descriptor(oldName)
    const records = store.ids(oldName).size
    // ⚠ `refs` is honestly 0 here and the line says so. Counting them would mean running the batch
    // rewrite to find out, which IS the op — and a number the plan cannot know is worse than a
    // stated gap: the plan line has a fixed shape precisely so a reader never has to guess whether
    // a term is zero or unmeasured.
    return dryRunPlan(`rename collections/${oldName} ${newName}`, { records, descriptors: 1 }, [
      `records  ${storageOf(d).path} → ${defaultStoragePath(newName, store.namespaces, ws.pkg.dreamteamer?.data_path ?? "data")}`,
      "refs are counted only by the real run — the rewrite is what discovers them",
    ])
  }
  const out = renameCollection(ws, store, oldName, newName)
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (!out.renamed) {
    console.log(`✔ ${oldName} — already named that, nothing to do`)
    return 0
  }
  console.log(`✔ ${oldName} → ${out.name}`)
  if (out.from !== out.to) console.log(`  records  ${out.from} → ${out.to} (${out.records})`)
  if (out.suffix) console.log(`  suffix   .${out.suffix.from}.md → .${out.suffix.to}.md`)
  if (out.pathKept)
    console.log(`  ⚠ storage.path kept as "${out.pathKept}" — it was authored, so the rename did not overrule it`)
  console.log(`  refs     ${out.rewrites} rewritten`)
  console.log("✔ compiled — the rename is live, in ONE commit")
  reportCommits(out.commits)
  return 0
}

// `dreamteamer collections rm widgets [--force]` — --force is required to drop a collection
// that still has records (removeCollection refuses otherwise, and says so).
function metaCollectionsRm(ws: Workspace, store: Store, flags: Flags, pos: string[]) {
  const name = need(pos, 0, "collection name")
  if (flags["dry-run"])
    return dryRunPlan(`rm collections/${name}`, { records: store.ids(name).size, descriptors: 1 }, [
      `descriptor removed; records under ${storageOf(store.descriptor(name)).path} stay in place and become unindexed`,
    ])
  const out = removeCollection(ws, store, name, { force: !!flags.force })
  if (flags.json) emit(JSON.stringify(out))
  else console.log(`✔ removed collection ${out.removed}`)
  console.log("✔ compiled — the collection is gone")
  reportCommits(out.commits)
  return 0
}

// `dreamteamer add-field health/visits --name kind --enum intake,follow-up --default-value follow-up`
function metaAddField(ws: Workspace, store: Store, collection: string, flags: Flags) {
  const field = fieldFromFlags(store, flags)
  const out = addField(ws, store, collection, {
    name: oneValue(flags, "name"),
    field,
    moduleId: oneValue(flags, "module"),
  })
  if (out.unchanged) return alreadyThat(`${collection}.${out.field}`)
  console.log(`✔ ${rel(ws.root, out.file)}${out.overlay ? " (overlay)" : ""}`)
  console.log("✔ compiled — the field is live")
  reportCommits(out.commits)
  reportMirror(store, collection, out.field, out.value)
  return 0
}

/** The idempotent answer, in `rename-collection`'s words — a command that asks for what is already
 *  there succeeded, and the operator needs to know which field it was talking about. */
function alreadyThat(subject: string): number {
  console.log(`✔ ${subject} — already exactly that, nothing to do`)
  return 0
}

/** A mirror is only correct for records written AFTER it existed: the far side's records already
 *  carrying a value are counted here, with the repair, because `check` flags every one of them the
 *  moment the field lands. */
function reportMirror(store: Store, collection: string, fieldName: string, field: Field): void {
  if (!field?.mirror_of) return
  const t = targetsOf(field)
  const target = Array.isArray(t) ? t[0] : null
  if (!target || !store.descriptors.has(target)) return
  console.log(`  mirror of ${target}.${field.mirror_of}  (generated, read-only)`)
  const n = [...store.readAll(target)].filter(r => r.fields[field.mirror_of] != null).length
  if (n)
    console.log(
      `  ${n} ${target} ${n === 1 ? "record carries" : "records carry"} values — run: dreamteamer relations rebuild ${collection}`
    )
}

// `dreamteamer set-field tasks --name urgent --required false`
// Same flag vocabulary as add-field (one `fieldFromFlags`), applied over the field as its source
// declares it: a flag that is not passed leaves its key alone.
function metaUpdateField(ws: Workspace, store: Store, collection: string, flags: Flags) {
  const name = oneValue(flags, "name")
  if (!name) throw new Error("missing --name <field>")
  const out = updateField(ws, store, collection, name, { flags, moduleId: oneValue(flags, "module") })
  if (out.unchanged) return alreadyThat(`${collection}.${name}`)
  console.log(`✔ ${rel(ws.root, out.file)}${out.overlay ? " (overlay)" : ""}`)
  console.log("✔ compiled — the field is updated")
  reportCommits(out.commits)
  reportMirror(store, collection, name, out.value)
  return 0
}

/** The positions a positional verb rewrites (or refuses on), one line each — what `--dry-run` is
 *  for: the operator reads WHERE before deciding. */
function positionLines(positions: { rel: string; at: string; fixed: boolean; why?: string }[]): string[] {
  return positions.map(p => `${p.fixed ? "  " : "✖ "}${p.rel}  ${p.at}${p.fixed ? "" : ` — ${p.why}`}`)
}

// `dreamteamer rm-field tasks --name urgent`
function metaRemoveField(ws: Workspace, store: Store, collection: string, flags: Flags) {
  const name = oneValue(flags, "name")
  if (!name) throw new Error("missing --name <field>")
  const moduleId = oneValue(flags, "module")
  if (flags["dry-run"]) {
    const plan: Flat<ReturnType<typeof removeField>> = removeField(ws, store, collection, name, {
      moduleId,
      dryRun: true,
    })
    return dryRunPlan(`rm-field ${collection} --name ${name}`, plan, [
      ...positionLines(plan.positions),
      ...positionLines(plan.blocking),
    ])
  }
  const out = removeField(ws, store, collection, name, { moduleId })
  if (flags.json) emit(JSON.stringify(out))
  else console.log(`✔ removed field ${collection}.${out.removed}`)
  console.log("✔ compiled — the field is gone")
  reportCommits(out.commits)
  // The field's own VALUES went with it, and that has to be said out loud: it is the destructive
  // half of a destructive verb, and a silent deletion is a different act from a reported one.
  if (!flags.json && out.cleared)
    console.log(
      `  cleared its values from ${out.cleared} ${collection} record${out.cleared === 1 ? "" : "s"} (git holds them: git show HEAD~1)`
    )
  return 0
}

const SCAFFOLDABLE = new Set(["skills"])

function metaEntityVerb(ws: Workspace, store: Store, kind: string, verb: string, flags: Flags, pos: string[]) {
  const one = kind.replace(/s$/, "")
  if (verb === "add") {
    const name = oneValue(flags, "name")
    if (!SCAFFOLDABLE.has(kind)) refuseHandAuthored(ws, store, kind, name, oneValue(flags, "module"))
    const out = createSkill(ws, store, {
      name,
      description: oneValue(flags, "description"),
      moduleId: oneValue(flags, "module"),
    })
    if (flags.json) {
      emit(JSON.stringify(out))
      return 0
    }
    console.log(`✔ ${rel(ws.root, out.file)}`)
    console.log("✔ compiled — the skill is live (write its body next; the frontmatter is the trigger)")
    reportCommits(out.commits)
    return 0
  }
  if (verb === "rm") {
    const id0 = need(pos, 0, `${one} id`)
    if (flags["dry-run"])
      return dryRunPlan(`rm ${kind}/${id0}`, { descriptors: 1 }, [`the ${one} source is removed; nothing else moves`])
    const out = removeEntity(ws, store, kind, id0)
    if (flags.json) {
      emit(JSON.stringify(out))
      return 0
    }
    console.log(`✔ removed ${one} ${out.removed}`)
    console.log("✔ compiled — it is gone")
    reportCommits(out.commits)
    return 0
  }
  if (verb === "rename") {
    const oldId = need(pos, 0, `${one} id`)
    const out = renameEntity(ws, store, kind, oldId, need(pos, 1, "new id"))
    if (flags.json) {
      emit(JSON.stringify(out))
      return 0
    }
    if (!out.renamed) {
      console.log(`✔ ${oldId} — already named that, nothing to do`)
      return 0
    }
    console.log(`✔ ${kind}/${oldId} → ${kind}/${out.id}`)
    console.log("✔ compiled — the rename is live")
    reportCommits(out.commits)
    return 0
  }
  const id = need(pos, 0, `${one} id`)
  const changes = { ...pairs(pos.slice(1)), ...stripMeta(flags) }
  if (!Object.keys(changes).length)
    throw new Error(`nothing to set — pass key=value pairs (a ${one}'s frontmatter keys)`)
  const out = setEntityFrontmatter(ws, store, kind, id, changes)
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.unchanged) return alreadyThat(`${kind}/${id} ${out.changed.join(", ")}`)
  console.log(`✔ ${rel(ws.root, out.file)} — ${out.changed.join(", ")}`)
  console.log("✔ compiled — the change is live")
  reportCommits(out.commits)
  return 0
}

/** The path `revert`'s refusal names — where a human edits this compiled entity. */
function sourceHintFor(store: Store, collection: string) {
  // ⚠ `modules` is the one system collection that is PROJECTED rather than stored as a kind folder:
  // its source is each module's package.json. Deriving the hint from `storage.path` gave
  // `modules/*/modules/`, which `git ls-files` matches nothing at all — a correct refusal handing
  // over an unusable remedy.
  if (collection === "modules") return "modules/*/package.json"
  return `modules/*/${storageOf(store.descriptors.get(collection)).path ?? collection}/`
}

// `dreamteamer rename-field people --name employer --to company`
function metaRenameField(ws: Workspace, store: Store, collection: string, flags: Flags) {
  const from = oneValue(flags, "name")
  if (!from)
    throw new Error(`missing --name <field>: dreamteamer rename-field ${collection} --name <field> --to <new-name>`)
  const to = oneValue(flags, "to")
  const out: Flat<ReturnType<typeof renameField>> = renameField(ws, store, collection, from, to, {
    dryRun: !!flags["dry-run"],
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.dryRun)
    return dryRunPlan(
      `rename-field ${collection} --name ${from} --to ${to ?? "<new-name>"}`,
      out,
      positionLines(out.positions)
    )
  if (!out.renamed) {
    console.log(`✔ ${collection}.${from} — already named that, nothing to do`)
    return 0
  }
  console.log(`✔ ${collection}.${out.from} → ${collection}.${out.to}`)
  console.log(`  records  ${out.records} rewritten`)
  for (const line of positionLines(out.positions)) console.log(line)
  console.log("✔ compiled — the rename is live, in ONE commit")
  reportCommits(out.commits)
  return 0
}

// `dreamteamer rename-value health/visits status seen done`
function metaRenameValue(ws: Workspace, store: Store, collection: string, flags: Flags, pos: string[]) {
  const [field, from, to] = pos
  if (!field || from === undefined || to === undefined || pos.length > 3)
    throw new Error(`usage: dreamteamer rename-value ${collection} <field> <old> <new> [--dry-run]`)
  const out: Flat<ReturnType<typeof renameValue>> = renameValue(ws, store, collection, field, from, to, {
    dryRun: !!flags["dry-run"],
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.dryRun)
    return dryRunPlan(`rename-value ${collection} ${field} ${from} ${to}`, out, positionLines(out.positions))
  console.log(`✔ ${collection}.${field}: ${from} → ${to}`)
  console.log(`  records  ${out.records} rewritten`)
  for (const line of positionLines(out.positions)) console.log(line)
  console.log("✔ compiled — the rename is live, in ONE commit")
  reportCommits(out.commits)
  return 0
}

// ---- ui-views ---------------------------------------------------------------------------------
// A view is an ordinary record conceptually (decision 49) but a SYSTEM-stored one, so it goes
// through saveUiView's compile gate rather than the record store. Without these verbs everything
// the Layout options panel does — columns, order, sort, layout, filter, nav — was click-only.

/**
 * View keys whose value is a LIST, so `display.list.columns=title,status` means what it says.
 *
 * ⚠ NAMED, not inferred, and that is the whole design: `options` is an open bag with no schema —
 * each layout declares its own keys and unknown ones ride through untouched — so nothing in the
 * runtime can tell a list key from a scalar one. Without this set the comma spelling every other
 * verb accepts for an array (`--tags a,b`) stored the literal string `"title,status"`, which the
 * surface reads with `Array.isArray` and therefore ignores: a view that looked configured, drew
 * the descriptor's `display.list.columns` instead, and reported nothing anywhere.
 *
 * `columns` is honoured by every list layout; `ref_fields` and `value_fields` are the diagram's
 * link-by pickers. `arrangement` is deliberately ABSENT — its elements are objects, so the JSON
 * form is its only honest spelling, and a comma split would quietly produce garbage.
 */
const VIEW_LIST_OPTIONS = new Set([
  "display.list.columns",
  ...["list", "record"].flatMap(b => [`display.${b}.options.ref_fields`, `display.${b}.options.value_fields`]),
])

/** `--filter '{"status":{"_eq":"seen"}}'` style flags, plus dotted `display.list.sort=-date` positionals. The
 *  KEY is passed because the value's shape depends on it: only the key says whether a comma is a
 *  separator or a character. */
function parseViewValue(raw: string | boolean, key: string): unknown {
  if (typeof raw !== "string") return raw
  const t = raw.trim()
  if (t === "true") return true
  if (t === "false") return false
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t)
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t)
    } catch {
      throw new Error(`not valid JSON: ${t}`)
    }
  }
  // ⚠ A QUOTED value is a LITERAL string, and `display.list.sort='""'` is the whole reason the branch
  // exists: `sort: ''` is what the surface requires to round-trip "unsorted" (omit it and the
  // ordering silently reverts to a fallback on the next load), and the dotted grammar could not
  // express it — an empty value UNSETS, by the same convention `dt set` has for a record field.
  // So the quoting is the operator saying "the empty string IS the value"; `assignViewValue`
  // carries that through to `assignPath`.
  if (t.startsWith('"')) {
    try {
      const s = JSON.parse(t)
      if (typeof s === "string") return s
    } catch {
      /* one message for every malformed quoting, below */
    }
    throw new Error(`not a quoted string: ${t} — a literal is written like '"-date"' (and '""' for the empty one)`)
  }
  // An empty value falls through to assignPath, which UNSETS the key — a `columns=` that wrote
  // `columns: []` would be a configured-to-show-nothing view, not a removed setting.
  if (t !== "" && VIEW_LIST_OPTIONS.has(key))
    return t
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  return raw
}

/**
 * Assign `a.b.c` into a nested object, creating plain objects on the way down.
 *
 * An empty or null value REMOVES the key rather than writing `''` — the same convention
 * `store.set` has always used for top-level fields (`if (v === null || v === '') delete next[k]`),
 * extended to the nested paths the meta verbs address. Without it there was no way to take a key
 * back out of a `ui-view`'s `options`, so a superseded option lingered as `provider: ''` and the
 * only cure was `rm` + `add`.
 *
 * Intermediate objects are not created on the way to a delete: unsetting `a.b` on a record with no
 * `a` should leave the record alone, not grow an empty `a: {}`.
 *
 * `explicit` is the escape hatch, and it has exactly one caller: a value the operator QUOTED
 * (`display.list.sort='""'`) is a value, empty or not. Without it the convention above has no exception
 * and `sort: ''` — which the surface needs to mean "unsorted" — is unwritable from the CLI.
 */
function assignPath(target: Record<string, unknown>, dotted: string, value: unknown, explicit = false): void {
  const keys = dotted.split(".")
  const leaf = keys[keys.length - 1]
  const unset = !explicit && (value === null || value === "")
  let node = target
  for (const k of keys.slice(0, -1)) {
    if (node[k] == null || typeof node[k] !== "object" || Array.isArray(node[k])) {
      if (unset) return
      node[k] = {}
    }
    node = node[k] as Record<string, unknown>
  }
  if (unset) delete node[leaf]
  else node[leaf] = value
}

/** One dotted `key=value` write into a view: the value grammar, plus the one signal `assignPath`
 *  cannot recover from the parsed value — whether the operator quoted it. */
function assignViewValue(view: Record<string, unknown>, key: string, raw: string | boolean): void {
  assignPath(view, key, parseViewValue(raw, key), typeof raw === "string" && raw.trim().startsWith('"'))
}

// ⚠ `module` is a VERB OPTION, exactly as it is on every other verb that takes one (see META_FLAGS)
// — it says WHERE the source lands and is never a key of the view. Omitting it here is what wrote
// `module: core` into the yaml as a field.
const VIEW_META_FLAGS = new Set(["id", "json", "force", "module"])

function metaUiView(ws: Workspace, store: Store, verb: string, flags: Flags, pos: string[]) {
  if (verb === "rm") {
    const viewId = need(pos, 0, "ui-view id")
    if (flags["dry-run"])
      return dryRunPlan(`rm ui-views/${viewId}`, { descriptors: 1 }, [
        "the view source is removed; its route stops resolving",
      ])
    const out = removeUiView(ws, store, viewId)
    if (flags.json) emit(JSON.stringify(out))
    else console.log(`✔ removed ui-view ${out.removed}`)
    console.log("✔ compiled — the route is gone")
    reportCommits(out.commits)
    return 0
  }

  // `set` edits what the record already says; `add` starts from nothing. Reading through the
  // store means `set` works on a MODULE-shipped view too — the edit lands as a workspace source
  // that shadows it, which is the same thing saving one in the UI does.
  let view: Record<string, unknown> = {}
  let id = oneValue(flags, "id")
  // `module=` on a set is the MOVE, spelled as it is for a collection (`dt set collections/<c>
  // module=<m>`): a value being written, not the `--module` selector `add` takes.
  const moveArg = verb === "set" ? pos.slice(1).find(p => p.startsWith("module=")) : undefined
  if (moveArg) {
    const viewId = id ?? need(pos, 0, "ui-view id")
    const moveTo = moveArg.slice("module=".length)
    const others = [
      ...pos.slice(1).filter(p => p !== moveArg && p.includes("=")),
      ...Object.keys(flags).filter(k => !VIEW_META_FLAGS.has(k) && k !== "dry-run"),
    ]
    if (others.length)
      throw new Error(
        `module= moves the view to another module; the other keys rewrite it. Run them as two commands: dreamteamer set ui-views/${viewId} module=${moveTo}, then dreamteamer set ui-views/${viewId} ${others.join(" ")}`
      )
    const out: Flat<ReturnType<typeof moveUiView>> = moveUiView(ws, store, viewId, moveTo, {
      dryRun: !!flags["dry-run"],
    })
    if (flags.json) {
      emit(JSON.stringify(out))
      return 0
    }
    if (out.dryRun)
      return dryRunPlan(`set ui-views/${viewId} module=${moveTo}`, { descriptors: 1 }, [
        `view source  ${out.from} → ${out.to} (${out.file})`,
      ])
    if (!out.moved) {
      console.log(`✔ ui-views/${viewId} — already in ${out.to}, nothing to do`)
      return 0
    }
    console.log(`✔ ui-views/${viewId}: ${out.from} → ${out.to} (${out.file})`)
    console.log("✔ compiled — the move is live")
    reportCommits(out.commits)
    return 0
  }
  if (flags["dry-run"])
    throw new Error("--dry-run plans a move (module=<m>); a key write has no plan to show — run it without the flag")
  if (verb === "set") {
    id ??= need(pos, 0, "ui-view id")
    const { fields } = store.read("ui-views", id)
    view = JSON.parse(JSON.stringify(fields))
    delete view.id // the id is the filename, never a body key
    delete view.compiled // compile's, rewritten on every compile
  }

  for (const p of pos.slice(verb === "set" ? 1 : 0)) {
    if (!p.includes("=")) continue
    assignViewValue(view, p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1))
  }
  for (const [k, v] of Object.entries(flags)) {
    if (VIEW_META_FLAGS.has(k)) continue
    // A view key holds ONE value, and a list IS one value — so a repeated flag is a mistake with
    // two spellings to correct it, rather than an array nobody asked for.
    if (Array.isArray(v)) {
      throw new Error(
        `--${k} was given ${v.length} times — a view key takes one value, and a list is written as one: --${k} ${v.join(",")} (or the JSON form '${JSON.stringify(v)}')`
      )
    }
    assignViewValue(view, k, v)
  }

  if (!view.route) throw new Error("missing --route </route> — a view is addressed by its route")
  // same id rule the descriptor declares (`{{ route | slug }}`) and the UI derives, so a view
  // saved from the CLI and one saved from the panel land on the SAME record.
  id ??= slug(view.route as string) // `--route` is a value flag

  const out: Flat<ReturnType<typeof saveUiView>> = saveUiView(ws, store, {
    id,
    view,
    moduleId: oneValue(flags, "module"),
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.unchanged) return alreadyThat(`ui-views/${id}`)
  console.log(`✔ ${rel(ws.root, out.file)}`)
  console.log(`✔ compiled — ${view.route} is live`)
  reportCommits(out.commits)
  return 0
}

/** Read a flag that takes exactly ONE value. A repeat arrives as an array, and dropping it on the
 *  floor (`typeof v === 'string'` reads an array as absent) would answer the wrong question at exit
 *  0 — so it is named instead, with the line that was typed. */
function oneValue(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  if (Array.isArray(v)) {
    throw new Error(
      `--${key} was given ${v.length} times and takes ONE value: ${v.map(x => `--${key} ${x}`).join(" ")}`
    )
  }
  return typeof v === "string" ? v : undefined
}

/** `field=value` positionals, with the same promote-on-repeat rule the flags have. It was
 *  `Object.fromEntries`, which keeps the LAST pair — `dt set c/id tags=a tags=b` wrote `[b]`. */
function pairs(list: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const p of list) {
    if (!p.includes("=")) continue
    const k = p.slice(0, p.indexOf("="))
    const v = p.slice(p.indexOf("=") + 1)
    out[k] = k in out ? ([] as string[]).concat(out[k], v) : v
  }
  return out
}

// ⚠ `module` and `dry-run` are VERB OPTIONS on every verb that takes them, so they may never be
// read as record field names. A collection wanting a field literally called `module` writes it as
// `module=<v>` positionally, which `pairs()` reads and `stripMeta` never sees.
const META_FLAGS = new Set(["id", "json", "force", "filter", "module", "dry-run"])

const stripMeta = (flags: Flags): Flags => Object.fromEntries(Object.entries(flags).filter(([k]) => !META_FLAGS.has(k)))

// CLI values are strings; split comma-lists for array-typed fields (ajv coerces the rest)
function coerceArrays(d: Descriptor, fields: Flags): Fields {
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) {
    const isList = fieldsOf(d)[k]?.many === true
    // An array here means the operator SPELLED the key twice (`--tags a --tags b`, or
    // `tags=a tags=b`). On a list field each sighting is one element — deliberately NOT
    // comma-split again, so a value that contains a comma can be written by repeating the flag.
    if (Array.isArray(v)) {
      if (!isList) {
        throw new Error(
          `${k} was given ${v.length} times (--${k} <value> / ${k}=<value>) and ${k} is not an array field — pass it once`
        )
      }
      out[k] = v
      continue
    }
    out[k] =
      isList && typeof v === "string"
        ? v
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
        : v
  }
  return out
}

function need(pos: string[], i: number, what: string): string {
  if (pos[i] === undefined) throw new Error(`missing <${what}>`)
  return pos[i]
}

const fmtCell = (v: unknown): string => (v === undefined ? "-" : Array.isArray(v) ? v.join(",") : String(v))

/**
 * The rows one `list` invocation actually wants — narrowed, ordered, bodies dropped.
 *
 * ⚠ ONE implementation: the generic `list` case is its only caller today, and an interceptor that
 * adds columns calls it rather than copying it — a second copy is how `--sort` ends up working on
 * one collection and not on another.
 */
function narrowRows(store: Store, d: Descriptor, collection: string, flags: Flags) {
  // EVERY condition, ANDed — a repeated flag composes rather than replacing. `--filter a=1
  // --filter b=2` used to keep only `b=2` and return rows the caller had excluded, which is
  // the one failure a narrowing verb must not have: a listing that answers a question nobody
  // asked, at exit 0. Bare-field flags (`--status todo`) already composed this way; the
  // meta flag now reads the same, and `[].concat` treats one and many alike.
  const filters = Object.entries(flags)
    .filter(([k]) => !LIST_META_FLAGS.has(k))
    .flatMap(([k, v]) => [].concat(v).map(one => [k, one]))
  for (const cond of [].concat(flags.filter ?? [])) {
    const eq = String(cond).indexOf("=")
    // `--filter status` is not a condition. It used to slice into `statu = status`, which
    // matches nothing and reads as a fact about the collection.
    if (eq < 1) throw new Error(`--filter takes <field>=<value> — got "${cond}"`)
    filters.push([String(cond).slice(0, eq), String(cond).slice(eq + 1)])
  }
  // `--where` is the SAME operator set the studio's filter panel emits and saved views
  // store — one `matchesFilter`, so `--where '{"starts":{"_gte":"2026-07-01"}}'` and the
  // panel that produced that JSON cannot disagree about which records match.
  const whereJson = oneValue(flags, "where")
  const where = whereJson ? load(whereJson) : null
  // ⚠ A FLAG NAME IS NOT THE ONLY THING THAT CAN BE MISSPELLED. `--filter nmae=Ada` and
  // `--sort nmae` are correctly spelled FLAGS whose VALUE names a field that does not exist,
  // and both answer at exit 0 — an empty listing and an unsorted one. Same silent-empty class,
  // worse than a bad write because there is nothing to notice. `--where` gets the type check
  // for the same reason: `--where 'name _eq Ada'` yaml-parses to a STRING, and matchesFilter
  // then matched every row.
  if (whereJson && (typeof where !== "object" || where === null))
    throw new Error(
      `--where takes ONE filter OBJECT and got a ${where === null ? "null" : typeof where}: ${whereJson}\n  a condition is {"<field>":{"_eq":"<value>"}} — the shorthand for one equality is --filter <field>=<value>`
    )
  const badTokens = where ? [...unknownTokens(where)] : []
  if (badTokens.length)
    throw new Error(
      `--where holds unknown value token(s) ${badTokens.join(", ")} — the tokens are ${VALUE_TOKENS.join(" and ")}; any other value is a literal without a leading $`
    )
  const sort = oneValue(flags, "sort")
  const vocab = ["id", ...Object.keys(fieldsOf(d))]
  const stray = [...filters.map(([k]) => k), ...(sort ? [String(sort).replace(/^-/, "")] : [])].find(
    f => !vocab.includes(f)
  )
  if (stray)
    throw new Error(
      `${collection} has no field "${stray}"${nearest(stray, vocab) ? ` — did you mean "${nearest(stray, vocab)}"?` : ""} (dt get collections/${collection} lists them)`
    )
  const resolve = where ? recordResolver(store) : null
  const bf = bodyField(d)
  const rows = []
  const files = new Map()
  for (const { id, fields, file } of store.readAll(collection)) {
    // ONE walk, not one per record
    if (!filters.every(([k, v]) => String(fields[k] ?? "") === String(v))) continue
    if (where && !matchesFilter({ ...fields, id }, where, resolve)) continue
    if (bf) delete fields[bf] // bodies don't belong in listings
    rows.push({ ...fields, id }) // record id WINS over any schema field named "id"
    files.set(id, file)
  }
  // sorting was studio-only until now: the browse table ordered records and no CLI
  // invocation could. Same `sortRows` the server and api.ts call, so `--sort -starts`
  // orders date-times by INSTANT across mixed offsets rather than by string.
  if (sort) sortRows(rows, sort, jsonSchemaOf(d))
  return { rows, narrowed: !!(filters.length || where), files }
}

/** A record's location as `--json` carries it: `$file` and `$repo` (null = outside every repo here). */
const whereKeys = ({ file, repo }: { file: string; repo: string | null }) => ({ $file: file, $repo: repo })

/** What a write on an EXISTING record adds to its `✔` line: nothing in the workspace's own repo; the
 *  repo when it is another clone (a layer, a module's list); and that it is never committed when the
 *  root is outside every repo here. The workspace name alone used to be printed wherever it landed. */
function landedIn(where: { file: string; repo: string | null }): string {
  if (!where) return ""
  const { repo } = where
  if (repo === null) return " — outside every git repo here, never committed"
  return repo === "." ? "" : ` in ${repo}`
}

/** `id` first, then the descriptor's own columns — the shape every text listing prints. */
const listColumns = (d: Descriptor): string[] => [
  "id",
  ...(displayOf(d).list?.columns ?? []).map(c => (c === "last_modified" ? "last-modified" : c)).filter(c => c !== "id"),
]
