import { VERB_FLAGS } from "./consts.ts"
import { isEntityKind } from "./isEntityKind.ts"
import { nearest } from "./nearest.ts"
import type { Store } from "../store/Store.ts"
import { storedFieldsOf } from "../record/descriptor.ts"
import { storageOf } from "../record/storageOf.ts"
import type { Flags } from "../types.ts"

export function refuseUnknownFlags(store: Store, collection: string, verb: string, flags: Flags): void {
  // `store` may be null for an entity the store does not know — the refusal is still owed.
  const d = store?.descriptors.get(collection)
  const known =
    VERB_FLAGS[`${collection}:${verb}`] ??
    (isEntityKind(store, collection) && verb === "add" ? VERB_FLAGS["skills:add"] : VERB_FLAGS[verb])
  if (!known) return // no declared vocabulary — left exactly as it was rather than guessed at
  // The OPEN half: a data collection's own fields (shorthand filters and field writes), and the
  // declared keys of an entity `set` writes (`--route` on a view, and dotted `display.list.sort`).
  const system = storageOf(d).runtime
  // ⚠ NO DESCRIPTOR MEANS NO OPEN HALF — offering "plus any field of X" for a thing with no fields
  // would read as though the refused flag were merely misspelled.
  const openOf = !d
    ? null
    : !system
      ? ["list", "add", "set"].includes(verb)
        ? `field of ${collection}`
        : null
      : (collection === "ui-views" && verb !== "rm") || (isEntityKind(store, collection) && verb === "set")
        ? `declared key of ${collection}`
        : null
  const open = openOf ? Object.keys(storedFieldsOf(d)) : []
  const allowed = new Set([...known, ...open])
  for (const f of Object.keys(flags)) {
    if (allowed.has(f) || (openOf && allowed.has(f.split(".")[0]))) continue
    const near = nearest(f, [...allowed])
    throw new Error(
      `unknown flag "--${f}" on \`dt ${verb} ${collection}\`${near ? ` — did you mean --${near}?` : ""}\n  known: ${[
        ...known,
      ]
        .sort()
        .map(k => `--${k}`)
        .join(", ")}${openOf ? `, plus any ${openOf}` : ""}`
    )
  }
  // ⚠ AND THE REPEAT REFUSAL, which used to be 15 hand-written `refuseRepeats(flags)` lines — one
  // per meta verb, and a new verb had to remember it. A SCHEMA verb takes one value per flag (none
  // of them means a list by repetition), so the same table that says which flags exist says which
  // verbs the rule applies to: everything with a closed vocabulary EXCEPT the open halves, where a
  // repeat legitimately composes (`--filter a=1 --filter b=2`, `--tags a --tags b`). `ui-views`
  // keeps its own message, which names both spellings of the fix. ⚠ THE FIELD VERBS COUNT AS SCHEMA
  // VERBS EVEN THOUGH THEIR TARGET IS A DATA COLLECTION — `add-field notes --name x --name y` is the
  // case the old helper was written for, and keying the rule on the target alone excused it.
  if (collection === "ui-views" || (!system && !verb.endsWith("-field") && verb !== "rename-value")) return
  const dup = Object.entries(flags).find((e): e is [string, string[]] => Array.isArray(e[1]))
  if (dup)
    throw new Error(
      `--${dup[0]} was given ${dup[1].length} times, and a schema verb takes ONE value per flag: ${dup[1].map(x => `--${dup[0]} ${x}`).join(" ")}`
    )
}
