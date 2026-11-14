import fs from "node:fs"
import path from "node:path"
import { extensionText } from "./extensionText.ts"
import { gatedTreeOp } from "./gatedTreeOp.ts"
import { readmeText } from "./readmeText.ts"
import { scaffoldKey } from "./scaffoldKey.ts"
import { MODULE_ID } from "./consts.ts"
import { testText } from "./testText.ts"
import type { Store } from "../record/Store.ts"
import { normalizeNamespaces } from "../record/normalizeNamespaces.ts"
import type { DreamteamerBlock, Workspace } from "../types.ts"
import { KINDS } from "../workspace/consts.ts"
import { discoverModules } from "../workspace/discoverModules.ts"
import { moduleRows } from "../workspace/moduleRows.ts"

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

const ENGINE_VERSION = (
  JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version

export function createModule(
  ws: Workspace,
  store: Store,
  {
    name,
    description,
    namespace,
    extension = false,
    pkg: pkgName = null,
  }: {
    name?: string | true
    description?: string | true
    namespace?: string | true
    extension?: boolean
    pkg?: string | true | null
  }
) {
  if (!name || name === true) throw new Error("missing module name — dreamteamer add modules --name <id>")
  if (pkgName === true)
    throw new Error("--package takes the npm name: dreamteamer add modules --name <id> --package @scope/<id>")
  if (pkgName && (pkgName.length > 214 || !NPM_NAME.test(pkgName)))
    throw new Error(`"${pkgName}" is not an npm package name — lowercase, URL-safe, optionally @scope/name`)
  if (extension && !/^[a-z]/.test(name))
    throw new Error(
      `--extension needs a module id that starts with a letter — "${name}" becomes the setup unit's id and its env key (${scaffoldKey(name)}), and both must start with one`
    )
  if (pkgName) {
    const holder = discoverModules(ws.root, ws.pkg).modules.find(m => {
      try {
        return (
          (JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8")) as { name?: string }).name === pkgName
        )
      } catch {
        return false
      }
    })
    if (holder)
      throw new Error(
        `${pkgName} is already the package name of ${path.relative(ws.root, holder.root) || holder.root} — two modules under one name would shadow each other; pick another --package`
      )
  }
  if (!MODULE_ID.test(name)) {
    throw new Error(
      `invalid module id "${name}" — lowercase alphanumeric with single hyphens. It becomes a folder name, a package name and a record id at once, so there is only one spelling.`
    )
  }
  const rows = moduleRows(store)
  const clash = rows.find(r => r.id === name)
  if (clash) throw new Error(`module "${name}" already exists (${clash.fields.path}) — dt list modules`)
  const root = path.join(ws.root, "modules", name)
  if (fs.existsSync(root)) throw new Error(`modules/${name} already exists on disk — remove it or pick another id`)

  const dt: DreamteamerBlock = {}
  if (typeof description === "string" && description) dt.description = description
  // §6.2: `--namespace hr` DECLARES THE NAMESPACE IN THE MODULE, which is the whole point of §8 —
  // the workspace's effective set is the union of what its modules declare, so a module that owns a
  // namespace can be copied alone into a bare workspace and still compile.
  //
  // ⚠ It used to be dropped on the floor. `dt add modules --name hr --namespace hr` reported ✔,
  // shipped `"dreamteamer": {}`, left the manifest's `namespaces: []`, and the next
  // `add collections --module hr` then created an UNPREFIXED collection — four steps of silence
  // behind one accepted-and-ignored flag. Normalized here rather than trusted: a leading or
  // trailing slash in a declaration re-splits every reference under it.
  const ns = typeof namespace === "string" ? namespace.replace(/^\/+|\/+$/g, "") : ""
  if (ns) {
    const owner = moduleRows(store).find(r => normalizeNamespaces(r.fields.namespaces).includes(ns))
    // compile refuses two declarations of one namespace, and refusing it HERE names the verb that
    // fixes it instead of rolling a created module back over a compile error.
    if (owner)
      throw new Error(
        `namespace "${ns}" is already declared by ${owner.id} — one owner. Remove it there first (dt set modules/${owner.id} namespaces=…), or pick another namespace.`
      )
    dt.namespaces = [ns]
  }
  // `files` is the npm publish surface: every kind a module CAN ship, so a kind added to the engine
  // does not silently stop being packaged.
  // `engine` is the floor the module is written against: the engine that scaffolded it (cr-dt-007)
  dt.engine = `>=${ENGINE_VERSION}`
  if (extension) {
    dt.extension = "./src/extension.js"
    dt.env = [scaffoldKey(name)]
  }
  const files = [...KINDS, ...(extension ? ["src"] : []), "README.md"]
  // `--package` makes it publishable: its npm name (the module id stays the folder), a first version,
  // and the engine as a devDependency for its own tests — never `dependencies`, which would nest a second engine (D66)
  const mpkg = pkgName
    ? {
        name: pkgName,
        version: "0.1.0",
        type: "module",
        files,
        scripts: { test: "node --test" },
        devDependencies: { dreamteamer: ENGINE_VERSION },
        dreamteamer: dt,
      }
    : {
        name,
        private: true,
        version: "0.0.1",
        type: "module",
        files,
        scripts: { test: "node --test" },
        dreamteamer: dt,
      }
  const pkgFile = path.join(root, "package.json")
  const written = {
    "README.md": readmeText({ id: name, pkgName: mpkg.name, description, extension }),
    "test/module.test.mjs": testText({ id: name }),
    ...(extension ? { "src/extension.js": extensionText({ id: name }) } : {}),
  }

  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: modules add ${name}`,
    // compile regenerates .env.example from the declared keys, so a module that declares one (--extension)
    // changes it — it rides in the same commit rather than being left modified outside it
    paths: [
      path.relative(ws.root, pkgFile),
      ...Object.keys(written).map(f => path.relative(ws.root, path.join(root, f))),
      ...(extension && fs.existsSync(path.join(ws.root, ".env.example")) ? [".env.example"] : []),
    ],
    mutate: () => {
      // ⚠ SCAFFOLD EVERY KIND FOLDER. Not decoration: it is what makes the module's shape
      // self-documenting the moment it exists, and compile's "contributed no recognised sources"
      // warning is taught to read a scaffolded folder as a module being authored (see compile.js)
      // rather than as a mistake — a verb whose own output triggers a warning reads as broken.
      // git cannot track an empty directory, so only package.json is in the pathspec.
      for (const kind of KINDS) fs.mkdirSync(path.join(root, kind), { recursive: true })
      fs.writeFileSync(pkgFile, JSON.stringify(mpkg, null, "\t") + "\n")
      for (const [f, text] of Object.entries(written)) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
        fs.writeFileSync(path.join(root, f), text)
      }
    },
    undo: () => fs.rmSync(root, { recursive: true, force: true }),
  })
  return {
    id: name,
    root: path.relative(ws.root, root),
    file: pkgFile,
    files: ["package.json", ...Object.keys(written)],
    namespace: ns || null,
    commits: out.commits,
  }
}
