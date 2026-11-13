// Shared synthetic fixtures for the held-out tests of cr-dt-004 (written by the test stage from the
// tests' recorded steps). Each workspace is its own git repo with its own package.json name; a shapes
// clone `org` carries the collections a workspace installs.
import fs from "node:fs"
import path from "node:path"
import { workspace, compileQuietly, git, dt } from "../helpers/ws.js"

export const MANIFEST = "dreamteamer-exports.json"
export const write = (dir, files) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
}
export const rec = (fields, body = "") =>
  `---\n${Object.entries(fields)
    .map(([k, v]) =>
      Array.isArray(v)
        ? `${k}:\n${v.map(x => `  - ${x}`).join("\n")}`
        : typeof v === "object"
          ? `${k}:\n${Object.entries(v)
              .map(([a, b]) => `  ${a}: ${b}`)
              .join("\n")}`
          : `${k}: ${v}`
    )
    .join("\n")}\n---\n${body}`
export const coll = (name, fields, storage = {}) =>
  `name: ${name}\nstorage:\n${Object.entries({
    suffix: { people: "person" }[name] ?? name.split("/").pop().replace(/s$/, ""),
    ...storage,
  })
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n")}\nfields:\n${Object.entries(fields)
    .map(
      ([k, v]) =>
        `  ${k}:\n${Object.entries(v)
          .map(([a, b]) => `    ${a}: ${typeof b === "object" ? JSON.stringify(b) : b}`)
          .join("\n")}`
    )
    .join("\n")}\n`
export const NAME = { name: { type: "string", required: true } }

export function commitAll(dir, msg) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.email", "test@example.invalid"])
    git(dir, ["config", "user.name", "dreamteamer test"])
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", msg, "--allow-empty"])
}

export function clone(root, key, { pkg = key, files = {} } = {}) {
  const dir = path.join(root, "git_modules", key)
  write(dir, {
    "package.json": JSON.stringify(
      { name: pkg, private: true, dreamteamer: { workspace_module: "default", data_path: "data", git_modules: {} } },
      null,
      "\t"
    ),
    "modules/default/package.json": JSON.stringify({ name: "default", dreamteamer: {} }),
    ...files,
  })
  commitAll(dir, key)
  return dir
}

/** A workspace named `pkg` installing `colls` (name -> descriptor yaml) from a shapes clone, holding
 *  `files`, reading `layers` ({ key: { pkg, files, records } }). */
export function mkws({ pkg = "w-ws", colls, namespaces = [], files = {}, layers = {}, vars, env } = {}) {
  const w = workspace({ compile: false })
  const org = path.join(w.root, "git_modules", "org")
  write(org, {
    "package.json": JSON.stringify({
      name: "org",
      version: "1.0.0",
      dreamteamer: namespaces.length ? { namespaces } : {},
    }),
  })
  for (const [n, y] of Object.entries(colls)) write(org, { [`collections/${n}.collection.yaml`]: y })
  commitAll(org, "org")
  const entries = { org: { url: "x", ref: "main" } }
  for (const [key, l] of Object.entries(layers)) {
    clone(w.root, key, l)
    entries[key] = { url: "x", ref: "main", ...(l.records ? { records: l.records } : {}) }
  }
  const pkgPath = path.join(w.root, "package.json")
  const m = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  m.name = pkg
  m.dreamteamer.git_modules = entries
  if (vars) m.dreamteamer.vars = vars
  fs.writeFileSync(pkgPath, JSON.stringify(m, null, "\t") + "\n")
  if (env) fs.writeFileSync(path.join(w.root, ".env"), env)
  write(w.root, files)
  commitAll(w.root, "ws")
  w.ws.pkg = m
  compileQuietly(w.ws)
  return w
}

/** Copy `src`'s committed-shape workspace (package.json, data, manifest) into r/git_modules/<key>. */
export function copyInto(r, src, { key = "w", records } = {}) {
  const dir = path.join(r.root, "git_modules", key)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(path.join(src, "package.json"), path.join(dir, "package.json"))
  if (fs.existsSync(path.join(src, "data")))
    fs.cpSync(path.join(src, "data"), path.join(dir, "data"), { recursive: true })
  if (fs.existsSync(path.join(src, MANIFEST))) fs.cpSync(path.join(src, MANIFEST), path.join(dir, MANIFEST))
  write(dir, { "modules/default/package.json": JSON.stringify({ name: "default", dreamteamer: {} }) })
  commitAll(dir, key)
  addLayer(r, key, records)
  return dir
}

export function addLayer(r, key, records) {
  const pkgPath = path.join(r.root, "package.json")
  const m = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  m.dreamteamer.git_modules[key] = { url: "x", ref: "main", ...(records ? { records } : {}) }
  fs.writeFileSync(pkgPath, JSON.stringify(m, null, "\t") + "\n")
  r.ws.pkg = m
  compileQuietly(r.ws)
}

export const manifest = dir => JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")).references
export const head = dir => git(dir, ["rev-parse", "HEAD"]).trim()
export const count = dir => git(dir, ["rev-list", "--count", "HEAD"]).trim()
export { dt, git, compileQuietly }
