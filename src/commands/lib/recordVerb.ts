import { openWorkspace } from "../../openWorkspace.ts"

/**
 * Record verbs, split by what their <target> means. `reorder` and `next` are in NEITHER set: both
 * accept either shape, and which one it is has to be decided against the declared collections.
 */
const REF_VERBS = new Set(["get", "set", "rm", "rename", "history", "diff", "revert"])
const COLLECTION_VERBS = new Set(["list", "add", "values"])

/** Translate `dt <verb> <target> …` into the noun-verb call the implementation layer takes. */
export async function recordVerb(verb: string, args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ warnIfStale }, { targetCommand }, { Store }, { canonicalCollection }, { splitRef }] = await Promise.all([
    import("../../compile/warnIfStale.ts"),
    import("../../targetCommand.ts"),
    import("../../store/Store.ts"),
    import("../../record/ref.ts"),
    import("../../record/splitRef.ts"),
  ])
  warnIfStale(ws.root)
  const [target, ...rest] = args
  if (!target) throw new Error(`dt ${verb} needs a target — see \`dreamteamer help\``)
  // A flag in the target slot is a word-order mistake, not a collection: without this,
  // `dt list --json contacts` reported `unknown collection "--json"` and dumped every name.
  if (target.startsWith("--"))
    throw new Error(`dt ${verb} takes its target BEFORE the flags: dreamteamer ${verb} <target> ${target} …`)
  // A collection may be named by its declared name OR its singular (`dt add task …`); the
  // canonical name is what every layer below sees. An unknown word passes through unchanged so
  // the store's own "unknown collection" sentence, which lists what exists, is the one printed.
  const { descriptors } = new Store(ws)
  const canonical = canonicalCollection(descriptors, target) ?? target
  if (COLLECTION_VERBS.has(verb)) return targetCommand(ws, canonical, verb, rest)
  if (REF_VERBS.has(verb)) {
    const { collection, id } = splitRef(descriptors, target)
    return targetCommand(ws, collection, verb, [id, ...rest])
  }
  // the verbs that take EITHER (`reorder`, `next`) from here: a bare collection is legal for both — `move <collection> --init`,
  // `next <collection>`.
  if (descriptors.has(canonical)) {
    return verb === "reorder"
      ? targetCommand(ws, canonical, "reorder", rest)
      : targetCommand(ws, "commands", "for", [canonical, ...rest])
  }
  const { collection, id } = splitRef(descriptors, target)
  if (verb === "reorder") return targetCommand(ws, collection, "reorder", [id, ...rest])
  // `commands for <c>/<id>` split its own target at the FIRST slash, which cannot name a
  // namespaced collection. splitRef can, so the id is handed over as `--ids` — the same
  // `commandsFor(store, collection, ids)` call, reached without re-encoding the reference.
  // An explicit `--ids` from the caller still wins — by NOT injecting ours, not by ordering. It
  // used to rely on "last flag parsed wins", which stopped being true when a repeated flag started
  // promoting to an array instead of overwriting: the pair would now be refused as a double.
  const ours = rest.some(a => a === "--ids" || a.startsWith("--ids=")) ? [] : ["--ids", id]
  return targetCommand(ws, "commands", "for", [collection, ...ours, ...rest])
}
