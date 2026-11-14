import type { Workspace, Flags } from "../types.ts"
import { Store } from "../record/Store.ts"
import { createModule } from "./createModule.ts"
import { oneValue } from "../lib/oneValue.ts"
import { emit } from "../lib/emit.ts"
import { KIND_COUNT } from "./lib/consts.ts"
import { reportCommits } from "../workspace/reportCommits.ts"
import { need } from "../lib/need.ts"
import type { Flat } from "../lib/types.ts"
import { removeModule } from "./removeModule.ts"
import { dryRunPlan } from "../lib/dryRunPlan.ts"
import { renameModule } from "./renameModule.ts"
import { pairs } from "../lib/pairs.ts"
import { stripMeta } from "../lib/stripMeta.ts"
import { setModule } from "./setModule.ts"
import { alreadyThat } from "../lib/alreadyThat.ts"
import { rel } from "../lib/rel.ts"

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

/** `dt add|rm|rename|set modules/<id>` — or null for any other verb. */
export function modulesCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number | null {
  if (collection === "modules" && verb === "add") return metaModulesAdd(ws, store, flags)
  if (collection === "modules" && verb === "rm") return metaModulesRm(ws, store, flags, pos)
  if (collection === "modules" && verb === "rename") return metaModulesRename(ws, store, flags, pos)
  if (collection === "modules" && verb === "set") return metaModulesSet(ws, store, flags, pos)
  return null
}
