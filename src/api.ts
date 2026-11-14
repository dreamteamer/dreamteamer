// The PUBLIC API — `import … from 'dreamteamer'`. Everything a surface (the VS Code extension, the
// mobile app) or an extension (http, workflows, notebooklm) may call, and nothing else: package.json
// `exports` hides `src/*`, so an internal file can be split, renamed or deleted without a cross-repo
// break. That break used to be the rule — the extension imported fifteen internal files by path, and
// deleting one took `activate()` down before the tree view existed.
//
// Grouped by task. Each name is the ONE implementation of its operation; nothing here wraps or
// re-implements. Its declarations are GENERATED (dist/api.d.ts) from these signatures and src/types.ts;
// test/types/consumer.ts is the contract they are held to.
//
// Importing this module prints nothing, writes nothing, binds no port and touches no network.
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as self from "./api.ts"
import { findWorkspace } from "./workspace.ts"
import { loadExtensions, manifestViolations } from "./extensions.ts"
import fs from "node:fs"
import { KINDS, discoverModules } from "./compile.ts"
import { DERIVED_KINDS } from "./runtime.ts"
import { KNOWN_HARNESSES } from "./harnesses.ts"
import { CORE_VERBS } from "./cli.ts"
import { installCommand as installCheckout } from "./checkout.ts"
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
export { EXTENSION_API, declaredExtensions, contributedNotes } from "./extensions.ts"
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
export { envContext, renderTemplate, parseEnvValues } from "./env-vars.ts"
// the one template grammar (`{{ field | filter:arg }}`): what a surface renders `record_title`,
// `display.record.subtitle`, `card_title` and `item_title` with, so no surface keeps a second parser
export { parseTemplate, validateTemplate, renderDisplay } from "./template.ts"
export { satisfies } from "./semver.ts"

// ---- the compiler, schema and module operations ---------------------------------------------------
export { compile, staleness, warnIfStale, discoverModules, CompileError, KINDS } from "./compile.ts"
export { MANAGED_BLOCKS } from "./harnesses.ts"
export {
  createCollection,
  removeCollection,
  renameCollection,
  moveCollection,
  setCollectionScalars,
  addField,
  updateField,
  removeField,
  removeFieldPlan,
  renameField,
  renameFieldPlan,
  renameValue,
  renameValuePlan,
  fieldFromFlags,
  saveUiView,
  removeUiView,
  moveUiView,
  createModule,
  setModule,
  renameModule,
  removeModule,
  createSkill,
  refuseHandAuthored,
  removeEntity,
  renameEntity,
  setEntityFrontmatter,
} from "./schema-ops.ts"
export { init, ensureRepo, ensureAllRepos, listRepos, installClone } from "./init.ts"

// ---- the checkout: which one this is, and how it becomes ready ---------------------------------
export { describeCheckout, resolveNpm, childEnv, readHookInput, readStdin } from "./checkout.ts"

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
export { emit, parseArgs } from "./collections-cli.ts"
