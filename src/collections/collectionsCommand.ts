import type { Workspace, Flags } from "../types.ts"
import { Store } from "../store/Store.ts"
import { oneValue } from "../lib/oneValue.ts"
import { createCollection } from "./createCollection.ts"
import { rel } from "../lib/rel.ts"
import { reportCommits } from "../workspace/reportCommits.ts"
import { need } from "../lib/need.ts"
import { pairs } from "../lib/pairs.ts"
import { stripMeta } from "../lib/stripMeta.ts"
import type { Flat } from "../lib/types.ts"
import { moveCollection } from "./moveCollection.ts"
import { emit } from "../lib/emit.ts"
import { dryRunPlan } from "../lib/dryRunPlan.ts"
import { setCollectionScalars } from "./setCollectionScalars.ts"
import { alreadyThat } from "../lib/alreadyThat.ts"
import { collectionSourceFileFor } from "../lib/schema-ops.ts"
import { load, dump } from "../lib/yaml.ts"
import fs from "node:fs"
import { baseNameOf, defaultStoragePath } from "../record/namespace.ts"
import { storageOf } from "../record/storageOf.ts"
import { renameCollection } from "./renameCollection.ts"
import { removeCollection } from "./removeCollection.ts"
import { fieldFromFlags } from "../lib/fieldFromFlags.ts"
import { addField } from "./addField.ts"
import { reportMirror } from "./lib/reportMirror.ts"
import { updateField } from "./updateField.ts"
import { removeField } from "./removeField.ts"
import { positionLines } from "./lib/positionLines.ts"
import { renameField } from "./renameField.ts"
import { renameValue } from "./renameValue.ts"

/**
 * `dreamteamer add collections --name research-docs --mixins docs --id-from '{{ created | date }}--{{ title | slug }}'`
 */
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
 * `dt reorder collections/<c> …` — REFUSED since 0.49 (cr-dt-008). The nav is `nav.yaml` at the
 * workspace root, the one placement every surface draws from; a collection's `display.nav.order`
 * still compiles and moves no row. The verb used to write that key, compile, commit and print "the
 * nav order is live" while nothing on screen moved, so it now says where the order lives and writes
 * nothing. `module=` stays the move between modules (`dt set collections/<c> module=<m>`).
 */
function metaCollectionsMove(_ws: Workspace, store: Store, _flags: Flags, pos: string[]): never {
  const name = need(pos, 0, "collection name")
  store.descriptor(name)
  throw new Error(
    `dt reorder collections/${name} is refused: since 0.49 the nav's order is nav.yaml at the workspace root, and a collection's display.nav.order compiles but moves no row. Move the row in the sidebar (Move up · Move down · Move to top/bottom, or drag it), or edit nav.yaml by hand — nothing was written.`
  )
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

/**
 * `dreamteamer collections rename doctors health/doctors`, or `… doctors --namespace health`.
 * The whole point is that namespacing EXISTING data is one command instead of a six-step hand
 * migration whose last step (rewriting references) dangles everything when forgotten.
 */
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

/**
 * `dreamteamer collections rm widgets [--force]` — --force is required to drop a collection
 * that still has records (removeCollection refuses otherwise, and says so).
 */
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

/** `dreamteamer add-field health/visits --name kind --enum intake,follow-up --default-value follow-up` */
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

/**
 * `dreamteamer set-field tasks --name urgent --required false`
 * Same flag vocabulary as add-field (one `fieldFromFlags`), applied over the field as its source
 * declares it: a flag that is not passed leaves its key alone.
 */
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

/** `dreamteamer rm-field tasks --name urgent` */
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

/** `dreamteamer rename-field people --name employer --to company` */
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

/** `dreamteamer rename-value health/visits status seen done` */
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

/** `dt add|rm|rename|set|reorder collections/<c>`, `dt get collections/<c> --module <m>`, and the field
 *  verbs on any collection — or null when the verb is none of these. */
export function collectionsCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number | null {
  if (collection === "collections" && verb === "add") return metaCollectionsAdd(ws, store, flags)
  if (collection === "collections" && verb === "rm") return metaCollectionsRm(ws, store, flags, pos)
  if (collection === "collections" && verb === "rename") return metaCollectionsRename(ws, store, flags, pos)
  if (collection === "collections" && verb === "set") return metaCollectionsSet(ws, store, flags, pos)
  if (collection === "collections" && verb === "get" && flags.module !== undefined)
    return metaCollectionsGet(ws, store, flags, pos)
  if (collection === "collections" && verb === "reorder") return metaCollectionsMove(ws, store, flags, pos)
  if (verb === "add-field") return metaAddField(ws, store, collection, flags)
  if (verb === "set-field") return metaUpdateField(ws, store, collection, flags)
  if (verb === "rm-field") return metaRemoveField(ws, store, collection, flags)
  if (verb === "rename-field") return metaRenameField(ws, store, collection, flags)
  if (verb === "rename-value") return metaRenameValue(ws, store, collection, flags, pos)
  return null
}
