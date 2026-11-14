import type { Workspace, Flags } from "../types.ts"
import { Store } from "../store/Store.ts"
import { storageOf } from "../record/storageOf.ts"
import { sourceHintFor } from "./lib/sourceHintFor.ts"
import { narrowRows } from "./lib/narrowRows.ts"
import { emit } from "../lib/emit.ts"
import { whereKeys } from "./lib/whereKeys.ts"
import { listColumns } from "./lib/listColumns.ts"
import { fmtCell } from "./lib/fmtCell.ts"
import { need } from "../lib/need.ts"
import { dump } from "../lib/yaml.ts"
import { rel } from "../lib/rel.ts"
import { recordTitleOf, positionFieldOf } from "../record/descriptor.ts"
import { coerceArrays } from "./lib/coerceArrays.ts"
import { stripMeta } from "../lib/stripMeta.ts"
import { pairs } from "../lib/pairs.ts"
import { landedIn } from "./lib/landedIn.ts"
import { sortRows } from "./lib/sortRows.ts"
import { keyBetween } from "./lib/keyBetween.ts"
import { placementKey } from "./lib/placementKey.ts"
import { dryRunPlan } from "../lib/dryRunPlan.ts"
import { oneValue } from "../lib/oneValue.ts"
import { distinctValues } from "./distinctValues.ts"
import { history } from "./history.ts"
import { historyDiff } from "./historyDiff.ts"

/** The record verbs on `<collection>[/<id>]`: list · get · add · set · rm · rename · reorder · values ·
 *  history · diff · revert. Reached after every system and field route declined. */
export function recordsCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number {
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
