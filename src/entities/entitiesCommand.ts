import type { Workspace, Flags } from "../types.ts"
import { Store } from "../record/Store.ts"
import { oneValue } from "../lib/oneValue.ts"
import { SCAFFOLDABLE } from "./lib/consts.ts"
import { refuseHandAuthored } from "./lib/refuseHandAuthored.ts"
import { createSkill } from "./createSkill.ts"
import { emit } from "../lib/emit.ts"
import { rel } from "../lib/rel.ts"
import { reportCommits } from "../workspace/reportCommits.ts"
import { need } from "../lib/need.ts"
import { dryRunPlan } from "../lib/dryRunPlan.ts"
import { removeEntity } from "./removeEntity.ts"
import { renameEntity } from "./renameEntity.ts"
import { pairs } from "../lib/pairs.ts"
import { stripMeta } from "../lib/stripMeta.ts"
import { setEntityFrontmatter } from "./setEntityFrontmatter.ts"
import { alreadyThat } from "../lib/alreadyThat.ts"
import { isEntityKind } from "../lib/isEntityKind.ts"

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

/** `dt add|set|rm|rename <kind>/<id>` for skills, agents, commands and the other frontmatter kinds — or
 *  null for any other target or verb. */
export function entitiesCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number | null {
  // ---- the identity entities. §3.1's last row: `add` scaffolds a skill and is refused WITH THE
  // PATH for the five hand-authored kinds; `set` edits frontmatter; `rm` and `rename` work on all
  // six. Keyed on the collection NAME rather than on `storage.base` because these six are the
  // ones with a source-file shape — `modules` is projected and `collections` has its own verbs.
  if (isEntityKind(store, collection) && ["add", "set", "rm", "rename"].includes(verb)) {
    return metaEntityVerb(ws, store, collection, verb, flags, pos)
  }
  return null
}
