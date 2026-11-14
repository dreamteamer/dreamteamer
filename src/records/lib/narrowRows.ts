import { Store } from "../../record/Store.ts"
import type { Descriptor, Flags } from "../../types.ts"
import { LIST_META_FLAGS } from "./consts.ts"
import { oneValue } from "../../lib/oneValue.ts"
import { load } from "../../lib/yaml.ts"
import { unknownTokens } from "../../record/unknownTokens.ts"
import { VALUE_TOKENS } from "../../record/consts.ts"
import { fieldsOf, jsonSchemaOf } from "../../record/descriptor.ts"
import { nearest } from "../../lib/nearest.ts"
import { recordResolver } from "./recordResolver.ts"
import { bodyField } from "../../record/bodyField.ts"
import { matchesFilter } from "./matchesFilter.ts"
import { sortRows } from "./sortRows.ts"

/**
 * The rows one `list` invocation actually wants — narrowed, ordered, bodies dropped.
 *
 * ⚠ ONE implementation: the generic `list` case is its only caller today, and an interceptor that
 * adds columns calls it rather than copying it — a second copy is how `--sort` ends up working on
 * one collection and not on another.
 */
export function narrowRows(store: Store, d: Descriptor, collection: string, flags: Flags) {
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
