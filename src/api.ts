import path from "node:path"
import { fileURLToPath } from "node:url"
import * as self from "./api.ts"
import { findWorkspace } from "./workspace/findWorkspace.ts"
import { loadExtensions } from "./extensions/loadExtensions.ts"
import { manifestViolations } from "./extensions/manifestViolations.ts"
import fs from "node:fs"
import { KINDS } from "./compile/consts.ts"
import { discoverModules } from "./workspace/discoverModules.ts"
import { DERIVED_KINDS } from "./runtime/consts.ts"
import { KNOWN_HARNESSES } from "./compile/consts.ts"
import { CORE_VERBS } from "./cli.ts"
import { installCheckout } from "./install/installCheckout.ts"
import type { Workspace, LoadedExtension, CheckItem, PackageJson } from "./types.ts"

// Everything the record half exports (the browser-safe entry, `dreamteamer/records`), then the rest.
export * from "./records-api.ts"
export type {
  Workspace,
  PackageJson,
  DreamteamerBlock,
  GitModuleEntry,
  Flags,
  Contribution,
  CheckItem,
  DoctorRow,
  ExtensionContext,
  Activate,
  LoadedExtension,
  Entry,
  CompileDraft,
  HarnessContext,
  TemplatePart,
  SchemaOp,
} from "./types.ts"

// ---- the workspace ------------------------------------------------------------------------------

/**
 * The workspace at (or above) `start`, with its declared extensions ACTIVATED against this engine.
 * The handle every other call takes: `{ root, pkg, extensions }`. Performs no compile, install,
 * network call or write, and never changes the process cwd.
 */
export async function openWorkspace(
  start: string = process.cwd()
): Promise<Workspace & { extensions: LoadedExtension[] }> {
  const ws = findWorkspace(start) as Workspace & { extensions: LoadedExtension[] }
  ws.extensions = await loadExtensions(ws, self, {
    verbs: CORE_VERBS,
    kinds: [...KINDS, ...DERIVED_KINDS],
    harnesses: KNOWN_HARNESSES,
  })
  return ws
}
export { findWorkspace }
export { EXTENSION_API } from "./extensions/consts.ts"
export { declaredExtensions } from "./extensions/declaredExtensions.ts"
export { contributedNotes } from "./records/lib/contributedNotes.ts"
/** An extension's `check` may return `{ file, message, warning: true }`: printed as a warning, never a
 *  violation. A module reads this flag to know the engine it runs on has the channel — on one without
 *  it, a warning item would be counted as a violation. */
export const CHECK_WARNINGS = true

/** What every extension's `check` reports on `ws`, as `check(ws, { extra })` takes it — attributed to
 *  the extension, a throw being a violation. `dt check` and an in-process caller get one verdict. An
 *  item the extension marked `warning: true` keeps the mark: `check` prints it and does not count it. */
export async function contributedViolations(ws: Workspace): Promise<{ file: string; msg: string; warning?: true }[]> {
  const out: { file: string; msg: string; warning?: true }[] = []
  // every discovered module's manifest, held to the dependency rule — the workspace's own root and the
  // engine are not modules anybody installs
  try {
    for (const m of discoverModules(ws.root, ws.pkg).modules) {
      if (path.resolve(m.root) === path.resolve(ws.root)) continue
      let pkg: PackageJson
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8")) as PackageJson
      } catch {
        continue
      }
      if (pkg.name === "dreamteamer") continue
      for (const v of manifestViolations(pkg, path.relative(ws.root, path.join(m.root, "package.json"))))
        out.push({ file: v.file, msg: v.message })
    }
  } catch {
    /* discovery failing is compile's to report */
  }
  for (const e of (ws.extensions ?? []).filter(x => x.check)) {
    try {
      for (const v of ((await e.check({ root: ws.root, ws, dt: self })) ?? []) as CheckItem[])
        out.push({
          file: v.file ?? e.name,
          msg: `${v.message} (${e.name})`,
          ...(v.warning === true ? { warning: true } : {}),
        })
    } catch (err) {
      out.push({ file: e.name, msg: `check failed — ${err.message}` })
    }
  }
  return out
}

/** The engine's own CLI entry — what a tool spawns to run `dt` in another checkout. */
export const engineBin = fileURLToPath(new URL("../bin/dreamteamer.js", import.meta.url))
export const engineRoot = path.dirname(path.dirname(engineBin))

// ---- values the workspace half adds ---------------------------------------------------------------
export { envContext } from "./workspace/envContext.ts"
export { renderTemplate } from "./workspace/renderTemplate.ts"
export { parseEnvValues } from "./workspace/parseEnvValues.ts"
// the one template grammar (`{{ field | filter:arg }}`): what a surface renders `record_title`,
// `display.record.subtitle`, `card_title` and `item_title` with, so no surface keeps a second parser
export { parseTemplate } from "./record/parseTemplate.ts"
export { validateTemplate } from "./record/validateTemplate.ts"
export { renderDisplay } from "./record/renderDisplay.ts"
export { satisfies } from "./lib/npm/satisfies.ts"

// ---- the compiler, schema and module operations ---------------------------------------------------
export { compile, warnIfStale, CompileError } from "./compile/compile.ts"
export { staleness } from "./compile/staleness.ts"
export { discoverModules } from "./workspace/discoverModules.ts"
export { KINDS } from "./compile/consts.ts"
export { MANAGED_BLOCKS } from "./doctor/consts.ts"
export { createCollection } from "./collections/createCollection.ts"
export { removeCollection } from "./collections/removeCollection.ts"
export { renameCollection } from "./collections/renameCollection.ts"
export { moveCollection } from "./collections/moveCollection.ts"
export { setCollectionScalars } from "./collections/setCollectionScalars.ts"
export { addField } from "./collections/addField.ts"
export { updateField } from "./collections/updateField.ts"
export { removeField } from "./collections/removeField.ts"
export { removeFieldPlan } from "./collections/lib/removeFieldPlan.ts"
export { renameField } from "./collections/renameField.ts"
export { renameFieldPlan } from "./collections/lib/renameFieldPlan.ts"
export { renameValue } from "./collections/renameValue.ts"
export { renameValuePlan } from "./collections/lib/renameValuePlan.ts"
export { fieldFromFlags } from "./lib/fieldFromFlags.ts"
export { saveUiView } from "./ui-views/saveUiView.ts"
export { removeUiView } from "./ui-views/removeUiView.ts"
export { moveUiView } from "./ui-views/moveUiView.ts"
export { createModule } from "./modules/createModule.ts"
export { setModule } from "./modules/setModule.ts"
export { renameModule } from "./modules/renameModule.ts"
export { removeModule } from "./modules/removeModule.ts"
export { createSkill } from "./entities/createSkill.ts"
export { refuseHandAuthored } from "./entities/lib/refuseHandAuthored.ts"
export { removeEntity } from "./entities/removeEntity.ts"
export { renameEntity } from "./entities/renameEntity.ts"
export { setEntityFrontmatter } from "./entities/setEntityFrontmatter.ts"
export { init } from "./init/init.ts"
export { ensureRepo, ensureAllRepos } from "./repos/repos.ts"
export { listRepos } from "./repos/listRepos.ts"
export { installClone } from "./install/installClone.ts"

// ---- the checkout: which one this is, and how it becomes ready ---------------------------------
export { describeCheckout } from "./lib/git/describeCheckout.ts"
export { resolveNpm } from "./lib/npm/resolveNpm.ts"
export { childEnv } from "./lib/childEnv.ts"
export { readHookInput } from "./install/readHookInput.ts"
export { readStdin } from "./install/readStdin.ts"

/** `dt install` on the checkout `ws`, as the CLI runs it. The compile step reopens the workspace with
 *  `opts.open` — `openWorkspace` unless a caller injects another — so the extensions npm just
 *  installed take part in that compile. The one name here that supplies a default rather than
 *  re-exporting: the checkout layer cannot import the opener that activates extensions. */
export const installCommand = (
  ws: Workspace,
  argv: string[],
  opts: { open?: (at: string) => Promise<Workspace> } = {}
): Promise<number> => installCheckout(ws, argv, { open: openWorkspace, ...opts })

// ---- CLI helpers an extension command reuses -----------------------------------------------------
export { emit } from "./lib/emit.ts"
export { parseArgs } from "./lib/parseArgs.ts"
