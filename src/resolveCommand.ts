import { Store } from "./store/Store.ts"
import { envContext } from "./workspace/envContext.ts"
import { renderTemplate } from "./workspace/renderTemplate.ts"
import { splitRef } from "./record/splitRef.ts"
import type { Workspace } from "./types.ts"

/**
 * `dt resolve '<string>'` | `dt resolve <collection>/<id> <field>` — the ONLY place a `${env:…}`
 * template becomes a value. Records hold the template verbatim; no read path substitutes anything,
 * so a reference means the same thing on every machine and the file says which is which.
 *
 * THE HEURISTIC: the first argument is a REFERENCE iff it contains no `${` AND splits against a
 * declared collection. Both halves are needed. `${` first, because `docs/${env:X}` is ref-SHAPED
 * and must not be split as one — a reference can never contain a template, so the marker decides it
 * outright. Then the split, because a plain path (`/tmp/x`, `nope/q3`) must render to itself rather
 * than report an unknown collection it was never naming. Two accepted consequences: a bare
 * collection name resolves to itself (splitRef refuses it, so it is "just a string"), and in an
 * UNCOMPILED workspace every argument is a string, because there are no descriptors to split
 * against — which keeps `dt resolve '${env:K}'` working before the first compile.
 */
export function resolveCommand(ws: Workspace, args: string[]): number {
  const [target, field] = args
  if (!target)
    throw new Error(
      "dt resolve takes a string template or a <collection>/<id> and a field: dreamteamer resolve '${env:FILES_FOLDER}/x'"
    )
  // resolve has no flags, so a flag-shaped target is a mistake — and the one that costs is
  // `dt resolve --help`, which would otherwise print `--help` back and exit 0.
  if (target.startsWith("--"))
    throw new Error(
      `dt resolve takes a string or a <collection>/<id>, not a flag ("${target}") — see \`dreamteamer help\``
    )
  const ctx = envContext(ws)

  let ref: { collection: string; id: string } | null = null
  let store: Store | null = null
  if (!target.includes("${")) {
    try {
      store = new Store(ws)
      ref = splitRef(store.descriptors, target)
    } catch {
      ref = null
    }
  }
  // An argument nobody reads is a silent wrong answer: `dt resolve docs/q3 source_file garbage`
  // exited 0 on the field it happened to recognise.
  const takes = ref ? 2 : 1
  if (args.length > takes) {
    throw new Error(
      `dt resolve takes ${takes === 1 ? "one string template" : "a reference and ONE field"} — ${args.length - takes} extra argument(s): ${args.slice(takes).join(" ")}`
    )
  }
  if (!ref) {
    console.log(renderTemplate(target, ctx))
    return 0
  }
  if (!field) throw new Error(`dt resolve ${target} needs a field name: dreamteamer resolve ${target} <field>`)
  const { fields } = store.read(ref.collection, ref.id)
  const value = fields[field]
  if (value === undefined) throw new Error(`${target} has no field "${field}"`)
  // RENDER EVERY ITEM BEFORE PRINTING ANY. An array prints one item per line so the output pipes
  // into a shell loop unchanged — and a loop that does not check $? cannot tell a truncated list
  // from a short one, so a failure on item n must not leave items 1..n-1 on stdout. Anything that
  // is not text is refused rather than stringified: a number cannot hold a template.
  const items = Array.isArray(value) ? value : [value]
  const bad = items.findIndex(v => typeof v !== "string") // index, not the value: an item may be null
  if (bad > -1)
    throw new Error(
      `${target} field "${field}" holds a ${typeof items[bad]} — resolve renders text (a string, or a list of them)`
    )
  const rendered = items.map(v => renderTemplate(v, ctx))
  if (rendered.length) console.log(rendered.join("\n"))
  return 0
}
