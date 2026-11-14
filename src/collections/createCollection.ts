import path from "node:path"
import fs from "node:fs"
import { editWorkspacePkg } from "./editWorkspacePkg.ts"
import { qualify } from "./qualify.ts"
import { editModulePkg, moduleRecord, nameList, workspaceSystemDir } from "./schema-ops.ts"
import { IN_NODE_MODULES } from "./consts.ts"
import type { Store } from "../record/Store.ts"
import { moduleOf } from "../record/descriptor.ts"
import { baseNameOf, namespaceOf } from "../record/namespace.ts"
import { normalizeNamespaces } from "../record/normalizeNamespaces.ts"
import { singular } from "../record/singular.ts"
import { dump } from "../record/yaml.ts"
import type { AuthoredDescriptor, Workspace } from "../types.ts"
import { kindDir } from "../workspace/compile.ts"
import { writeGated } from "../workspace/writeGated.ts"

// ---- ops ------------------------------------------------------------------------

export function createCollection(
  ws: Workspace,
  store: Store,
  {
    name,
    mixins,
    idFrom,
    namespace,
    moduleId,
    description,
    suffix,
  }: {
    name?: string
    mixins?: string | string[]
    idFrom?: string
    /** the CLI refuses a bare `--namespace` before calling; `''` is the explicit "no namespace" */
    namespace?: string
    moduleId?: string | null
    description?: string
    suffix?: string
  }
) {
  if (!name) throw new Error("missing collection name")
  // §8. `--namespace health --name doctors` and `--name health/doctors` are the SAME collection,
  // because the qualified name IS the identity everywhere else in the engine — and a module that
  // declares exactly one namespace makes even that redundant. The resolved name is ALWAYS echoed,
  // because an inferred identity the operator did not type is one they must be able to read back.
  //
  // ⚠ THE COMPILED SET, not `ws.pkg.dreamteamer.namespaces`. Since §8 the declaration may live in
  // any module's package.json, and the union is resolved by compile and stamped into the manifest —
  // so a verb reading the workspace's own key alone would refuse a namespace a module declares.
  const declared = store.namespaces
  const modNs = moduleId ? normalizeNamespaces(moduleRecord(store, moduleId).fields.namespaces) : []
  let inferred = false
  let ns0 = namespace
  if (ns0 === undefined && modNs.length === 1 && !namespaceOf(name, [modNs[0]])) {
    ns0 = modNs[0]
    inferred = true
  } else if (ns0 === undefined && modNs.length > 1 && !namespaceOf(name, modNs)) {
    throw new Error(`module ${moduleId} declares ${modNs.join(", ")} — say which: --namespace ${modNs[0]}`)
  }
  // `--namespace ''` is the explicit "no namespace", the same convention `dt set` has for clearing
  // a field. It arrives as the empty string and must not be confused with "not given".
  // ⚠ `qualify(ns, baseNameOf(name, [ns]))` is what stops the prefix DOUBLING: `--name hr/grades
  // --module hr` resolves the base name to `grades` and re-qualifies it once.
  const qualified = ns0 ? qualify(ns0, baseNameOf(name, [ns0])) : name
  // The set INCLUDING a namespace this call is about to declare — `defaultStoragePath` and the
  // suffix derivation both split on it, and a name whose prefix is not yet in the set derives
  // `suffix: ops/plan` from `ops/plans`.
  const declaredAll = [...new Set([...declared, ...(ns0 ? [ns0] : [])])]
  const ns = namespaceOf(qualified, declaredAll)
  if (qualified.includes("/") && !ns) {
    throw new Error(
      `namespace "${qualified.slice(0, qualified.lastIndexOf("/"))}" is not declared — pass --namespace <ns> (which declares it where the collection will live), or declare it first: dt set modules/<m> namespaces=<ns>.`
    )
  }
  // ⚠ THE NAME AS TYPED, TOO, not only the qualified one. Namespace inference (§8) turns
  // `--name people --module hr` into `hr/people`, which is a DIFFERENT collection — so with the
  // qualified check alone, asking to create a collection that already exists silently created a
  // second one in the module's namespace. §13 requires the refusal, and it has to fire on the name
  // the operator actually typed.
  for (const clash of new Set([qualified, name])) {
    if (!store.descriptors.has(clash)) continue
    // §13: name both remedies, because the operator asking for this wants ONE of them and the
    // generic "already exists" tells them which neither.
    const owner = moduleOf(store.descriptors.get(clash))
    const target = moduleId ?? ws.pkg.dreamteamer?.workspace_module ?? "default"
    throw new Error(
      `collection "${clash}" already exists, owned by ${owner}. Fields from ${target}: dreamteamer add-field ${clash} --module ${target} --name <f> --type <t> · move it: dreamteamer set collections/${clash} module=${target}`
    )
  }
  // NESTED, mirroring where compile puts it in the runtime: `collections/health/doctors.collection.yaml`.
  // compile enumerates this kind recursively for exactly this reason — and `upsertField` derives the
  // same path from the same name, which is what keeps a later `add-field` editing the base descriptor
  // instead of quietly creating an overlay beside it.
  // …and in the module the caller NAMED — the workspace module only by default. `--module` is what
  // makes a module-first modeling session one verb per step instead of six manual ones.
  const intoRoot = moduleId ? path.join(ws.root, moduleRecord(store, moduleId).fields.path) : null
  if (intoRoot && IN_NODE_MODULES(path.relative(ws.root, intoRoot))) {
    throw new Error(
      `module "${moduleId}" ships from node_modules — a write there is erased by the next \`npm install\`. Vendor it into modules/ first.`
    )
  }
  const dest = path.join(
    intoRoot ? kindDir(intoRoot, "collections") : workspaceSystemDir(ws, "collections"),
    `${qualified}.collection.yaml`
  )
  if (fs.existsSync(dest)) throw new Error(`${path.relative(ws.root, dest)} already exists`)

  // THE MINIMAL v2 DESCRIPTOR, in canonical key order: `name`, a `description` when one is given,
  // the mixins, the id rule, and `fields`. Storage, title and singular are compile's to default —
  // a default written into the source is a value nobody chose, and it stops following the name.
  // Without a mixin the collection gets the one field its records are named by; with one, the mixin
  // supplies the fields and `add-field` grows the rest.
  const mixinList = mixins === undefined || mixins === "" ? [] : nameList(mixins)
  const descriptor: AuthoredDescriptor = { name: qualified }
  // ⚠ A DESCRIPTION IS NOT DECORATION. compile WARNS about a collection without one, because it
  // renders as a bare NAME in the orientation block every session loads — an agent learns the noun
  // exists and nothing about when it is the right one.
  if (typeof description === "string" && description) descriptor.description = description
  if (mixinList.length) descriptor.mixins = mixinList
  if (typeof idFrom === "string" && idFrom) descriptor.ids = { from: idFrom }
  // An explicit suffix WINS over the derivation, and the derivation is echoed by the caller either
  // way: every record filename carries it (`<id>.<suffix>.md`).
  if (typeof suffix === "string" && suffix) descriptor.storage = { suffix }
  descriptor.fields = mixinList.length ? {} : { name: { type: "string", required: true } }
  // the SUFFIX comes off the bare name — `health/doctors` records are `<id>.doctor.md`, not
  // `<id>.health/doctor.md` — exactly as compile derives it
  const effectiveSuffix = descriptor.storage?.suffix ?? singular(baseNameOf(qualified, declaredAll))
  // `--namespace x` where nobody declares `x` DECLARES it, in the module the collection is landing
  // in — else the workspace. Writing a source that cannot compile and then telling the operator to
  // go declare it is the shape §8 exists to remove; and the module is the right home, because that
  // is what travels when the module is copied (decision 130's gate).
  const needsDeclaration = !!ns && !declared.includes(ns)
  const declFile = needsDeclaration
    ? moduleId
      ? path.join(ws.root, moduleRecord(store, moduleId).fields.path, "package.json")
      : path.join(ws.root, "package.json")
    : null
  const gate = writeGated(
    ws,
    store,
    declFile ? [dest, declFile] : [dest],
    `dreamteamer: collections add ${qualified}`,
    () => {
      if (declFile && moduleId) {
        editModulePkg(declFile, dt => {
          dt.namespaces = normalizeNamespaces([...(dt.namespaces ?? []), ns])
        })
      } else if (declFile) {
        editWorkspacePkg(ws, dt => {
          dt.namespaces = normalizeNamespaces([...(dt.namespaces ?? []), ns])
        })
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, dump(descriptor))
    },
    undefined,
    { commentsMayDecrease: true }
  )
  return {
    file: dest,
    descriptor,
    name: qualified,
    inferred,
    declaredNamespace: needsDeclaration ? ns : null,
    suffix: effectiveSuffix,
    suffixDerived: suffix === undefined || suffix === "",
    commits: gate.commits,
  }
}
