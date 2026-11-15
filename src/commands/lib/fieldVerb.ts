import { openWorkspace } from "../../openWorkspace.ts"

// FIELD VERBS (add-field, set-field, rm-field, rename-field, rename-value). Their <target> is a
// collection and everything else is flags, which is the one shape that differs from the record verbs —
// so they share this rather than `recordVerb`. There is no `schema <op>` table any more: system
// entities take the record verbs, and `targetCommand`'s interceptors are the whole dispatch (§4).
//
// ⚠ THE RETIRED SPELLINGS ARE GONE, not aliased. The 0.12.0 policy: a stale invocation must fail
// loudly, because a half-working grammar teaches the wrong shape without ever saying so.
// `lib/unknownVerb.ts` names each one — `schema`, `ensure`, `update-field`, `remove-field`,
// `commands` — and carries its replacement.
export async function fieldVerb(verb: string, args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ warnIfStale }, { targetCommand }, { Store }, { canonicalCollection }] = await Promise.all([
    import("../../compile/warnIfStale.ts"),
    import("../../targetCommand.ts"),
    import("../../store/Store.ts"),
    import("../../record/ref.ts"),
  ])
  warnIfStale(ws.root)
  const [target, ...flagArgs] = args
  if (!target || target.startsWith("--")) {
    throw new Error(`dt ${verb} needs a collection: dreamteamer ${verb} <collection> --name <field> …`)
  }
  // the singular is legal here too: `dt add-field task --name due …`
  return targetCommand(ws, canonicalCollection(new Store(ws).descriptors, target) ?? target, verb, flagArgs)
}
