import { pathToFileURL } from "node:url"
import path from "node:path"
import type { Api, Contribution, LoadedExtension, Workspace } from "../types.ts"
import { declaredExtensions } from "./declaredExtensions.ts"
import { EXTENSION_API } from "./consts.ts"
import { v1ManifestRefusal } from "../compile/v1ManifestRefusal.ts"
import { validateSetup } from "./lib/validateSetup.ts"

const CONTRIBUTION_KEYS = new Set([
  "commands",
  "sourceKinds",
  "analyze",
  "harnesses",
  "orientation",
  "hooks",
  "check",
  "doctor",
  "next",
  "setup",
])

/**
 * Import and activate every declared extension against `api`, and check the contributions cannot
 * collide with core or with each other. `reserved` is what core already owns: its verbs, kinds and
 * harness ids.
 */
export async function loadExtensions(
  ws: Workspace,
  api: Api,
  reserved: { verbs?: string[]; kinds?: string[]; harnesses?: string[] } = {}
): Promise<LoadedExtension[]> {
  const v1 = v1ManifestRefusal(ws.pkg?.dreamteamer, "package.json")
  if (v1) throw new Error(v1)
  const loaded: LoadedExtension[] = []
  type Owned = "command" | "kind" | "harness" | "unit"
  const owner: Record<Owned, Map<string, string>> = {
    command: new Map(),
    kind: new Map(),
    harness: new Map(),
    unit: new Map(),
  }
  for (const r of reserved.verbs ?? []) owner.command.set(r, "the engine")
  for (const r of reserved.kinds ?? []) owner.kind.set(r, "the engine")
  for (const r of reserved.harnesses ?? []) owner.harness.set(r, "the engine")
  const claim = (what: Owned, key: string, by: string): void => {
    const prev = owner[what].get(key)
    if (prev)
      throw new Error(
        what === "unit"
          ? `setup unit "${key}" is contributed by ${by} and ${prev} — uninstall one, or switch it off: add "modules/${by}" to dreamteamer.disable in package.json`
          : `extension ${by} contributes the ${what} "${key}", which ${prev} already owns — uninstall one, or switch it off: add "modules/${by}" to dreamteamer.disable in package.json`
      )
    owner[what].set(key, by)
  }
  for (const ext of declaredExtensions(ws)) {
    let mod
    try {
      mod = await import(pathToFileURL(ext.entry).href)
    } catch (e) {
      throw new Error(
        `extension ${ext.name}: its entry ${path.relative(ws.root, ext.entry)} did not load — ${e.message.split("\n")[0]} (npm install?)`,
        { cause: e }
      )
    }
    if (typeof mod.default !== "function")
      throw new Error(`extension ${ext.name}: ${path.relative(ws.root, ext.entry)} must default-export activate(dt)`)
    if (mod.apiVersion !== undefined && mod.apiVersion !== EXTENSION_API) {
      throw new Error(
        `extension ${ext.name} targets extension API ${mod.apiVersion}; this engine (${api.engineVersion?.() ?? "?"}) speaks ${EXTENSION_API}`
      )
    }
    const c: Contribution = (await mod.default(api)) ?? {}
    for (const k of Object.keys(c))
      if (!CONTRIBUTION_KEYS.has(k))
        throw new Error(
          `extension ${ext.name} contributes an unknown key "${k}" — known: ${[...CONTRIBUTION_KEYS].join(", ")}`
        )
    const commands = c.commands ?? {}
    for (const [verb, cmd] of Object.entries(commands)) {
      if (typeof cmd?.run !== "function")
        throw new Error(`extension ${ext.name}: command "${verb}" has no run(ws, argv)`)
      claim("command", verb, ext.name)
    }
    const sourceKinds = (c.sourceKinds ?? []).map(k => normalizeKind(ext.name, k))
    for (const k of sourceKinds) claim("kind", k.kind, ext.name)
    for (const id of Object.keys(c.harnesses ?? {})) claim("harness", id, ext.name)
    for (const fn of ["analyze", "check", "doctor", "next"] as const)
      if (c[fn] !== undefined && typeof c[fn] !== "function")
        throw new Error(`extension ${ext.name}: ${fn} must be a function`)
    // setup units: validated here so an uncompilable declaration never reaches `dt install`; a unit id is
    // claimed like a verb, because two packages answering `dt setup <id>` is the same silent loser
    const setup = validateSetup(ext.name, c.setup, { env: ext.env, vars: ext.vars })
    if (setup.errors.length) throw new Error(setup.errors.join("\n"))
    for (const u of setup.units) claim("unit", u.id, ext.name)
    loaded.push({
      name: ext.name,
      version: ext.version,
      dir: ext.dir,
      env: ext.env,
      vars: ext.vars,
      commands,
      sourceKinds,
      analyze: c.analyze ?? null,
      harnesses: c.harnesses ?? {},
      orientation: c.orientation ?? null,
      hooks: c.hooks ?? {},
      check: c.check ?? null,
      doctor: c.doctor ?? null,
      next: c.next ?? null,
      setup: setup.units,
    })
  }
  // one env key, one kind (D39): two inputs — in one package or across packages — that name the same
  // key with different kinds are refused here, naming the pair, before any setup runs on them
  const keyKinds = new Map()
  for (const ext of loaded)
    for (const u of ext.setup ?? [])
      for (const i of u.inputs ?? []) {
        if (!i.env) continue
        const prev = keyKinds.get(i.env)
        if (prev && prev.kind !== i.kind)
          throw new Error(
            `${i.env} is declared as ${prev.kind} by ${prev.by} (unit ${prev.unit}, input ${prev.input}) and as ${i.kind} by ${ext.name} (unit ${u.id}, input ${i.id}) — one key, one kind`
          )
        if (!prev) keyKinds.set(i.env, { kind: i.kind, by: ext.name, unit: u.id, input: i.id })
      }
  return loaded
}

/** A contributed source kind: a plain folder name, and excluded subtrees that stay RELATIVE to it. */
function normalizeKind(by: string, k: unknown): { kind: string; exclude: string[]; extension: string } {
  const kind = typeof k === "string" ? k : (k as { kind?: unknown } | null)?.kind
  if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind))
    throw new Error(`extension ${by}: a source kind is a lowercase folder name (got ${JSON.stringify(kind)})`)
  const exclude = ((typeof k === "object" ? ((k as { exclude?: unknown[] }).exclude ?? []) : []) as unknown[]).map(
    e => {
      const rel = path.posix.normalize(String(e)).replace(/\/+$/, "")
      if (!rel || rel === "." || rel.startsWith("..") || path.posix.isAbsolute(rel))
        throw new Error(`extension ${by}: kind "${kind}" excludes "${e}", which is not a subtree of it`)
      return rel
    }
  )
  return { kind, exclude, extension: by }
}
