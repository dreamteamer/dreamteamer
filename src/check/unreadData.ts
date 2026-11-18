// Record files under the workspace's own data/ that no compiled collection reads (cr-dt-008 test stage).
//
// A collection that leaves a module — notebooks and wikis composed out of rnd — leaves its records on disk
// with nothing reading them, and `dt check` said "0 violations". Compile has warned about the same thing for
// a record layer's clone since cr-dt-004 ("no collection here reads it"); this is the workspace's own data/,
// read at check time against the compiled descriptors. A warning, never a violation: the files are not
// wrong, they are unread — and the remedy is usually one install.
import fs from "node:fs"
import path from "node:path"
import type { PackageJson, Workspace } from "../types.ts"
import { load } from "../lib/yaml.ts"
import { walk } from "../lib/walk.ts"
import { loadDescriptors } from "../runtime/loadDescriptors.ts"
import { exportsFacts } from "../runtime/exportsFacts.ts"
import { storageOf } from "../record/storageOf.ts"
import { defaultStoragePath } from "../record/namespace.ts"
import { discoverModules } from "../workspace/discoverModules.ts"
import { kindDir } from "../compile/kindDir.ts"

/** `<id>.<suffix>.<ext>` — the shape every text record file has (a dotfile never is one). */
const RECORD_FILE = /^[^.][^/]*\.[A-Za-z][\w-]*\.(md|ya?ml|json)$/
const subdirs = (abs: string): string[] => {
  try {
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * `[folder, files]` per folder under `dataDir` no claimed path accounts for and holding record files:
 * a claimed folder is skipped, a prefix of one (a namespace folder) is descended into. `/`-joined.
 */
function unreadRecordFolders(root: string, dataDir: string, claimed: Set<string>): [string, string[]][] {
  const out: [string, string[]][] = []
  const visit = (rel: string) => {
    for (const name of subdirs(path.join(root, rel))) {
      const p = `${rel}/${name}`
      if (claimed.has(p)) continue
      if ([...claimed].some(c => c.startsWith(`${p}/`))) {
        visit(p)
        continue
      }
      const files = [...walk(path.join(root, p))]
        .map(f => path.relative(path.join(root, p), f).split(path.sep).join("/"))
        .filter(f => RECORD_FILE.test(path.posix.basename(f)))
        .sort()
      if (files.length) out.push([p, files])
    }
  }
  visit(dataDir)
  return out
}

/**
 * The folder each collection of a package in node_modules that this workspace does not compile would
 * store its records in, as `folder → "<package> defines <collection>"` — where an unread folder's reader is.
 */
function definedFolders(ws: Workspace, dataDir: string): Map<string, string> {
  const nm = path.join(ws.root, "node_modules")
  const compiled = new Set(discoverModules(ws.root, ws.pkg).modules.map(m => m.name))
  const at = new Map<string, string>()
  for (const top of subdirs(nm)) {
    const dirs = top.startsWith("@")
      ? subdirs(path.join(nm, top)).map(s => path.join(nm, top, s))
      : [path.join(nm, top)]
    for (const dir of dirs) {
      let m: PackageJson
      try {
        m = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
      } catch {
        continue
      }
      if (!m.dreamteamer || compiled.has(m.name!) || !fs.existsSync(kindDir(dir, "collections"))) continue
      for (const f of [...walk(kindDir(dir, "collections"))].filter(x => x.endsWith(".collection.yaml"))) {
        let d: { name?: unknown; storage?: { path?: unknown } } | null
        try {
          d = load(fs.readFileSync(f, "utf8"))
        } catch {
          continue
        }
        const storagePath = d?.storage?.path
        const literal = typeof storagePath === "string" && !storagePath.includes("${")
        if (typeof d?.name === "string")
          at.set(
            literal
              ? (storagePath as string).replace(/\/+$/, "")
              : defaultStoragePath(d.name, m.dreamteamer.namespaces ?? [], dataDir),
            `${m.name} defines ${d.name}: dt install ${m.name}`
          )
      }
    }
  }
  return at
}

/** The ⚠ lines `dt check` prints, as `{ file, msg, warning: true }` items (src/api.ts contributedViolations). */
export function unreadDataWarnings(ws: Workspace): { file: string; msg: string; warning: true }[] {
  const descriptors = loadDescriptors(ws.root) ?? new Map()
  const dataDir = exportsFacts(ws.root).data
  const roots = [...descriptors.values()]
    .map(storageOf)
    .filter(s => !s.runtime && !s.external && !s.unavailable && !path.isAbsolute(s.path))
  const unread = unreadRecordFolders(ws.root, dataDir, new Set(roots.map(s => s.path.replace(/\/+$/, ""))))
  const known = unread.length ? definedFolders(ws, dataDir) : new Map<string, string>()
  return unread.map(([folder, files]) => {
    const shown = files.length > 3 ? [...files.slice(0, 3), `+${files.length - 3} more`] : files
    const msg = `${files.length} record file${files.length === 1 ? "" : "s"} no collection here reads (${shown.join(", ")}) — ${known.get(folder) ?? "install the module that defines it to read them"}`
    return { file: `${folder}/`, msg, warning: true as const }
  })
}
