// The PUBLIC API — `import … from 'dreamteamer'`. Everything a surface (the VS Code extension, the
// mobile app) or an extension (http, workflows, notebooklm) may call, and nothing else: package.json
// `exports` hides `src/*`, so an internal file can be split, renamed or deleted without a cross-repo
// break. That break used to be the rule — the extension imported fifteen internal files by path, and
// deleting one took `activate()` down before the tree view existed.
//
// Grouped by task. Each name is the ONE implementation of its operation; nothing here wraps or
// re-implements. `api.d.ts` beside this file is the typed contract, and a test pins the two together.
//
// Importing this module prints nothing, writes nothing, binds no port and touches no network.
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as self from "./api.ts"
import { findWorkspace } from "./lib/workspace.ts"
import { loadExtensions, manifestViolations } from "./lib/extensions.ts"
import fs from "node:fs"
import { KINDS, discoverModules } from "./commands/compile.ts"
import { unreadDataWarnings } from "./lib/unread-data.ts"
import { DERIVED_KINDS } from "./lib/runtime.ts"
import { KNOWN_HARNESSES } from "./lib/harnesses.ts"
import { CORE_VERBS } from "./cli.ts"
import { installCommand as installCheckout } from "./commands/checkout.ts"

// Everything the record half exports (the browser-safe entry, `dreamteamer/records`), then the rest.
export * from "./records-api.ts"

// ---- the workspace ------------------------------------------------------------------------------

/**
 * The workspace at (or above) `start`, with its declared extensions ACTIVATED against this engine.
 * The handle every other call takes: `{ root, pkg, extensions }`. Performs no compile, install,
 * network call or write, and never changes the process cwd.
 */
export async function openWorkspace(start = process.cwd()): Promise<Workspace & { extensions: LoadedExtension[] }> {
  const ws: Workspace = findWorkspace(start)
  ws.extensions = await loadExtensions(ws, self, {
    verbs: CORE_VERBS,
    kinds: [...KINDS, ...DERIVED_KINDS],
    harnesses: KNOWN_HARNESSES,
  })
  return ws as Workspace & { extensions: LoadedExtension[] }
}
export { findWorkspace }
export { EXTENSION_API, declaredExtensions, contributedNotes } from "./lib/extensions.ts"
/** An extension's `check` may return `{ file, message, warning: true }`: printed as a warning, never a
 *  violation. A module reads this flag to know the engine it runs on has the channel — on one without
 *  it, a warning item would be counted as a violation. */
export const CHECK_WARNINGS = true as const

/** What every extension's `check` reports on `ws`, as `check(ws, { extra })` takes it — attributed to
 *  the extension, a throw being a violation. `dt check` and an in-process caller get one verdict. An
 *  item the extension marked `warning: true` keeps the mark: `check` prints it and does not count it. */
export async function contributedViolations(ws: Workspace): Promise<CheckExtra[]> {
  const out: CheckExtra[] = []
  // every discovered module's manifest, held to the dependency rule — the workspace's own root and the
  // engine are not modules anybody installs
  try {
    for (const m of discoverModules(ws.root, ws.pkg).modules) {
      if (path.resolve(m.root) === path.resolve(ws.root)) continue
      let pkg
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8"))
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
      for (const v of (await e.check({ root: ws.root, ws, dt: self })) ?? [])
        out.push({
          file: v.file ?? e.name,
          msg: `${v.message} (${e.name})`,
          ...(v.warning === true ? { warning: true as const } : {}),
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
export { envContext, renderTemplate, parseEnvValues } from "./lib/env-vars.ts"
// the one template grammar (`{{ field | filter:arg }}`): what a surface renders `record_title`,
// `display.record.subtitle`, `card_title` and `item_title` with, so no surface keeps a second parser
export { parseTemplate, validateTemplate, renderDisplay } from "./lib/template.ts"
export { satisfies } from "./lib/semver.ts"
// the nav document (cr-dt-008): nav.yaml read, checked and written, and the shipped fragments merged into it —
// what every host (the editor, dt web) uses, so there is one grammar and one writer
export { readNavDoc, validateNavDoc, writeNavDoc } from "./lib/nav.ts"
export { applyNavFragments } from "./lib/nav-fragments.ts"

// ---- the compiler, schema and module operations ---------------------------------------------------
export { compile, staleness, warnIfStale, discoverModules, CompileError, KINDS } from "./commands/compile.ts"
export { MANAGED_BLOCKS } from "./lib/harnesses.ts"
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
} from "./commands/schema-ops.ts"
import type { CheckExtra } from "./lib/record-types.ts"
import type { LoadedExtension, Workspace } from "./lib/workspace-types.ts"
export { init, ensureRepo, ensureAllRepos, listRepos, installClone } from "./commands/init.ts"

// ---- the checkout: which one this is, and how it becomes ready ---------------------------------
export { describeCheckout, resolveNpm, childEnv, readHookInput, readStdin } from "./commands/checkout.ts"

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
export { emit, parseArgs } from "./commands/collections-cli.ts"
