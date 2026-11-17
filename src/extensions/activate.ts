// Extensions: a module's `dreamteamer.extension` entry, imported and activated against the engine API (src/api.js)
// as the released engine activates it. This runs the module's code, and only for a module the workspace lists.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { DtError } from "../lib/DtError.ts"
import { mapOf } from "../lib/mapOf.ts"
import { messageOf } from "../lib/messageOf.ts"
import { moduleId } from "../model/moduleId.ts"
import type { Extension } from "../types/Extension.ts"
import type { Model } from "../types/Model.ts"
import type { Workspace } from "../types/Workspace.ts"

/** the released engine's own verbs, which no extension may claim */
const CORE = `init install update compile check exports doctor status setup changes commit help version list add values
  get set rm rename history diff revert reorder next add-field set-field rm-field rename-field rename-value relations
  resolve relocate fmt schema ensure update-field remove-field commands modules collections`.split(/\s+/)
/**
 * What an extension may contribute. `commands`, `check` and `next` are acted on; the rest are accepted and ignored.
 * Review: `setup`, `hooks`, `harnesses`, `doctor`, `analyze`, `sourceKinds` and `orientation` do nothing here yet.
 */
const KEYS = "commands check next setup hooks harnesses doctor analyze sourceKinds orientation".split(" ")

/** a function a module contributed, callable with its object as `this`; undefined for anything else */
function fn(v: unknown, self?: unknown) {
  return typeof v === "function" ? (...a: unknown[]): unknown => Reflect.apply(v, self, a) : undefined
}

/**
 * The workspace with the extensions its modules declare activated: its own modules first, then installed ones by
 * name, each given the engine API. One that does not load, contributes something malformed or claims a verb already
 * owned is left out with one line on stderr, in the released engine's words; the rest load. A module switched off by
 * `dreamteamer.disable` (`modules/<name or id>`) is not loaded.
 * Review: a module's engine floor (`dreamteamer.engine`) is not checked; this engine answers as 0.49.1.
 */
export async function activate(model: Model, warn = (m: string) => console.error(`✖ ${m}`)): Promise<Workspace> {
  const pkg = mapOf(JSON.parse(readFileSync(join(model.root, "package.json"), "utf8")))
  const off = [mapOf(pkg.dreamteamer).disable].flat()
  const ws: Workspace = { root: model.root, pkg, extensions: [] }
  const declared = model.modules.filter(
    (t) =>
      t.extension && t.origin !== "engine" && ![t.name, moduleId(t.name)].some((n) => off.includes(`modules/${n}`)),
  )
  declared.sort((x, y) => (x.origin === y.origin ? (x.name < y.name ? -1 : 1) : x.origin === "workspace" ? -1 : 1))
  if (!declared.length) return ws
  const api: unknown = await import("../api.js")
  const owner = new Map(CORE.map((t) => [t, "the engine"]))
  for (const m of declared) {
    const said = (t: string) => new DtError(`extension ${m.name}${t}`)
    try {
      let mod: Record<string, unknown>
      try {
        mod = mapOf(await import(pathToFileURL(join(m.dir, m.extension ?? "")).href))
      } catch (e) {
        throw said(`: its entry ${m.extension} did not load — ${messageOf(e).split("\n")[0]}`)
      }
      const start = fn(mod.default)
      if (!start) throw said(`: ${m.extension} must default-export activate(dt)`)
      if (mod.apiVersion !== undefined && mod.apiVersion !== 1) throw said(` targets an extension API other than 1`)
      const c = mapOf(await start(api))
      const odd = Object.keys(c).find((t) => !KEYS.includes(t))
      if (odd) throw said(` contributes an unknown key "${odd}" — known: ${KEYS.join(", ")}`)
      const commands: Extension["commands"] = {}
      for (const [verb, cmd] of Object.entries(mapOf(c.commands))) {
        const run = fn(mapOf(cmd).run, cmd)
        if (!run) throw said(`: command "${verb}" has no run(ws, argv)`)
        const prev = owner.get(verb)
        if (prev)
          throw said(
            ` contributes the command "${verb}", which ${prev} already owns — uninstall one, or switch it off: add "modules/${m.name}" to dreamteamer.disable in package.json`,
          )
        commands[verb] = run
      }
      const [check, next] = [fn(c.check), fn(c.next)]
      if ((c.check !== undefined && !check) || (c.next !== undefined && !next))
        throw said(`: check and next must be functions`)
      Object.keys(commands).forEach((t) => owner.set(t, m.name))
      ws.extensions.push({ name: m.name, version: m.version, dir: m.dir, commands, check, next })
    } catch (e) {
      warn(
        e instanceof DtError ? e.message : `extension ${m.name}: activate(dt) failed — ${messageOf(e).split("\n")[0]}`,
      )
    }
  }
  return ws
}
