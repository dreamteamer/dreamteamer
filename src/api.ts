import path from "node:path"
import { fileURLToPath } from "node:url"
import { unreadDataWarnings } from "./check/unreadData.ts"
import * as self from "./api.ts"
import { findWorkspace } from "./workspace/findWorkspace.ts"
import { manifestViolations } from "./extensions/manifestViolations.ts"
import fs from "node:fs"
import { discoverModules } from "./workspace/discoverModules.ts"
import { installCheckout } from "./install/installCheckout.ts"
import type { Workspace, CheckItem, PackageJson } from "./types.ts"

// Everything the record half exports (the browser-safe entry, `dreamteamer/records`), then the rest.
export * from "./records-api.ts"
export type {
  Workspace,
  PackageJson,
  DreamteamerBlock,
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
  NavDoc,
  NavEntry,
  NavWarning,
  ModuleFields,
  ModuleRecordRow,
  UpdateCheckRow,
  InstallDriftRow,
} from "./types.ts"

import { openWorkspace } from "./openWorkspace.ts"
export { openWorkspace }
export { findWorkspace }
export { EXTENSION_API } from "./extensions/consts.ts"
export { declaredExtensions } from "./extensions/declaredExtensions.ts"
export { contributedNotes } from "./records/lib/contributedNotes.ts"
/**
 * An extension's `check` may return `{ file, message, warning: true }`: printed as a warning, never a
 * violation. A module reads this flag to know the engine it runs on has the channel — on one without
 * it, a warning item would be counted as a violation.
 */
export const CHECK_WARNINGS = true

/**
 * What every extension's `check` reports on `ws`, as `check(ws, { extra })` takes it — attributed to
 * the extension, a throw being a violation. `dt check` and an in-process caller get one verdict. An
 * item the extension marked `warning: true` keeps the mark: `check` prints it and does not count it.
 */
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
  // record files under data/ no compiled collection reads — a collection that left with a module
  try {
    out.push(...unreadDataWarnings(ws))
  } catch {
    /* a warning pass never breaks check */
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

export { envContext } from "./workspace/envContext.ts"
export { renderTemplate } from "./workspace/renderTemplate.ts"
export { parseEnvValues } from "./workspace/parseEnvValues.ts"
// the one template grammar (`{{ field | filter:arg }}`): what a surface renders `record_title`,
// `display.record.subtitle`, `card_title` and `item_title` with, so no surface keeps a second parser
export { parseTemplate } from "./record/parseTemplate.ts"
export { validateTemplate } from "./record/validateTemplate.ts"
export { renderDisplay } from "./record/renderDisplay.ts"
export { satisfies } from "./lib/npm/satisfies.ts"
// the nav document (cr-dt-008): nav.yaml read, checked and written, and the shipped fragments merged into it —
// what every host (the desktop app, the editor) uses, so there is one grammar and one writer
export { readNavDoc, validateNavDoc, writeNavDoc } from "./record/nav.ts"
export { applyNavFragments } from "./workspace/navFragments.ts"

export { compile, warnIfStale, CompileError } from "./compile/compile.ts"
export { staleness } from "./compile/staleness.ts"
export { discoverModules } from "./workspace/discoverModules.ts"
// the compiled module records: what the app lists and scopes by instead of parsing .dreamteamer/modules/*.yaml
export { moduleRows } from "./workspace/moduleRows.ts"
// commits a repo has that its upstream does not — the count `dt commit` reports after a write; the
// pending half of the same picture is `commitPending(store, { dryRun: true })`
export { aheadCount } from "./workspace/lib/aheadCount.ts"
// what `dt update --all` would move: the engine and each npm module, installed → latest (`dt update --check`)
export { updateCheck } from "./update/updateCheck.ts"
// declared packages installed at another version than the checkout pins (a pulled upgrade) — `dt install` fixes them
export { installDrift } from "./install/installDrift.ts"
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

export { describeCheckout } from "./lib/git/describeCheckout.ts"
export { resolveNpm } from "./lib/npm/resolveNpm.ts"
export { childEnv } from "./lib/childEnv.ts"
export { readHookInput } from "./install/readHookInput.ts"
export { readStdin } from "./install/readStdin.ts"

/**
 * `dt install` on the checkout `ws`, as the CLI runs it. The compile step reopens the workspace with
 * `opts.open` — `openWorkspace` unless a caller injects another — so the extensions npm just
 * installed take part in that compile. The one name here that supplies a default rather than
 * re-exporting: the checkout layer cannot import the opener that activates extensions.
 */
export const installCommand = (
  ws: Workspace,
  argv: string[],
  opts: { open?: (at: string) => Promise<Workspace> } = {}
): Promise<number> => installCheckout(ws, argv, { open: openWorkspace, ...opts })

export { emit } from "./lib/emit.ts"
export { parseArgs } from "./lib/parseArgs.ts"
