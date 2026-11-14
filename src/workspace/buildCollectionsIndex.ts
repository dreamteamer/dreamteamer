import { fieldsOf, isInternal, moduleOf } from "../record/descriptor.ts"
import { storageOf } from "../record/storageOf.ts"
import { load } from "../record/yaml.ts"
import type { Descriptor, Entry } from "../types.ts"
import { flat } from "./harnessMarkers.ts"
import type { CollectionRow } from "./types.ts"
import { writeLine } from "./writeLine.ts"

/** collection name -> description / use_when / whether it is a schema-ops collection, read from the
 *  compiled descriptor BYTES compile already holds. Same pattern as buildSkillsIndex: no filesystem
 *  read, and deliberately nothing that touches `data/` — see collectionsSection for why. */
export function buildCollectionsIndex(entries: Map<string, Entry>): CollectionRow[] {
  const index: CollectionRow[] = []
  for (const [rt, e] of entries) {
    const m = /^collections\/(.+)\.collection\.yaml$/.exec(rt)
    if (!m) continue
    let d = {} as Descriptor
    try {
      d = load<Descriptor | null>(e.bytes.toString("utf8")) ?? ({} as Descriptor)
    } catch {
      /* unparseable descriptor */
    }
    index.push({
      name: d.name ?? m[1],
      // ⚠ TWO QUESTIONS, KEPT SEPARATE. `systemGroup` answers "is this machinery, group it out
      // of the domain listing"; `generated` answers "is this build output the hand-edit warning
      // is about" — they agreed until `repos`, machinery whose records are still real files
      // under `data/`. The partition is AUTHORED (`group: system` on the descriptor, ten core
      // collections carry it), never derived from storage: a workspace collection may be its
      // own apparatus, and a runtime-stored one may not be. An unparseable descriptor (`d = {}`
      // from the catch above) carries neither key and answers false to both, which leaves it in
      // the domain listing — the visible failure rather than the silent one.
      systemGroup: isInternal(d),
      generated: storageOf(d).runtime,
      description: flat(d.description),
      useWhen: flat(d.use_when),
      module: moduleOf(d) ?? "",
      // the sensitivity marks, so a generated persona can NAME what it was not given —
      // "withheld" is a better answer than "I don't know"
      sensitive: d.sensitive === true,
      sensitiveFields: Object.entries(fieldsOf(d))
        .filter(([, f]) => f.sensitive === true)
        .map(([k]) => k),
      write: writeLine(d),
    })
  }
  return index.sort((a, b) => a.name.localeCompare(b.name))
}
