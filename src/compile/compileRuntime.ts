import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { stringify } from "yaml"
import { asObject } from "../lib/asObject.ts"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { DtError } from "../lib/DtError.ts"
import { listFiles } from "../lib/listFiles.ts"
import { SOURCE_KINDS } from "../model/SOURCE_KINDS.ts"
import { getSource } from "../store/getSource.ts"
import { tail } from "../store/tail.ts"
import type { Model } from "../types/Model.ts"

/** how each module arrived, in the released manifest's words */
const CHANNELS = { npm: "npm", workspace: "inline", engine: "engine" } as const

/**
 * YAML as the released engine writes it: block style, single quotes, long lines whole, and every string that YAML 1.1
 * would read as something else (a timestamp, `yes`, `on`) quoted, because some readers parse it as YAML 1.1
 */
function yaml(v: unknown) {
  return stringify(v, { lineWidth: 0, singleQuote: true, version: "1.1" })
}

/**
 * Write the released engine's compiled layout into `<root>/.dreamteamer/`, for the readers that open it directly (the
 * protocol host, module scripts): a compiled descriptor per collection (`collections/<name>.collection.yaml`), a
 * projected record per module (`modules/<id>.module.yaml`), every other source kind's files copied as they are (a
 * skill's whole folder), and `manifest.yaml` with the keys those readers use — `compiled`, `host`, `engine`,
 * `namespaces`, `package`, `data_path`, `layers`, `modules`, `ui` and `entries` (each runtime file's source path).
 * The kind folders are replaced; nothing else under `.dreamteamer/` is touched. Returns how many files it wrote.
 * Review: no source hashes, `json_schema`, harness files or `.gitignore` are written; whether readers need them is open.
 */
export function compileRuntime(model: Model, version: string): number {
  const out = join(model.root, ".dreamteamer")
  const entries: Record<string, unknown> = {}
  function put(rel: string, body: string | Buffer, from: string) {
    const p = join(out, rel)
    if (!resolve(p).startsWith(resolve(out) + sep))
      throw new DtError(`${rel}: its path leaves .dreamteamer — nothing more compiled`)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
    entries[rel.split(sep).join("/")] = { sources: [{ path: relative(model.root, from) }] }
  }
  for (const kind of SOURCE_KINDS) rmSync(join(out, kind), { recursive: true, force: true })
  for (const [kind, ids] of Object.entries(model.sources)) {
    const c = model.collections[kind]
    for (const [id, file] of Object.entries(ids))
      if (kind === "collections" || kind === "modules")
        put(`${kind}/${id}${tail(c)}`, yaml(getSource(model, kind, id).data), file)
      else if (c.storage.shape !== "folder") put(`${kind}/${id}${tail(c)}`, readFileSync(file), file)
      else for (const f of listFiles(dirname(file))) put(join(kind, id, relative(dirname(file), f)), readFileSync(f), f)
  }
  const pkg = asObject(JSON.parse(readFileSync(join(model.root, "package.json"), "utf8")), "package.json")
  const manifest = {
    compiled: new Date().toISOString(),
    host: `dreamteamer-first-principles@${version}`,
    engine: version,
    namespaces: [...new Set(model.modules.flatMap((t) => t.namespaces))].sort(),
    package: asOptional(pkg.name, "package.json name", asString) ?? null,
    data_path: "data",
    layers: [],
    modules: model.modules.map((t) => ({
      name: t.name,
      location: t.origin === "workspace" ? "modules" : "node_modules",
      channel: CHANNELS[t.origin],
      root: relative(model.root, t.dir),
    })),
    ui: [],
    entries,
  }
  writeFileSync(join(out, "manifest.yaml"), yaml(manifest))
  return Object.keys(entries).length + 1
}
