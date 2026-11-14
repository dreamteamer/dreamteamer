import path from "node:path"
import fs from "node:fs"
import { readExports } from "../record/readExports.ts"
import type { GitModuleEntry, PackageJson } from "../types.ts"

/** One git module as `declaredGitModules` resolved it: who declared it (`null` is the workspace root). */
type ResolvedGitModule = {
  url: string | undefined
  ref: string
  records: string[] | null | undefined
  open: boolean
  module: boolean
  declarers: (string | null)[]
}

/** Every git module this workspace installs, by name — THE NPM MODEL. Its own declarations first, all of
 *  them (a root installs its devDependencies too). Then, with `root`, what each clone on disk NEEDS: the
 *  entries of the clone's own `git_modules` that provide a package its committed `dreamteamer-exports.json`
 *  names as holding ids its records reference. A clone with no manifest needs nothing — the rest of its list
 *  is its devDependencies, never installed here, which is what keeps a transitive install from dragging in
 *  everything a nested workspace happens to read. A need is matched to an entry by package name, scoped or
 *  not (`@northwind/org` → `org`); one no entry provides is returned in `unmet`.
 *
 *  Resolution, as npm's: a need the root declares is the root's (`overrides` — a differing ref or url is
 *  returned in `mismatches`, never acted on); a need another clone already hoisted at the same url and ref
 *  is shared; a need nobody has is hoisted to the top-level `git_modules/<name>`, once; a need that disagrees
 *  with what the top holds is `nested` — a second clone under its declarer, as npm nests a second version.
 *  `install` lays a symlink under each declarer of a top-level clone. Nothing here refuses; every
 *  disagreement is returned to be said. `records` is the union of the lists, `open` when some declarer
 *  named none; a nested `module: true` is not hoisted. */
export function declaredGitModules(
  pkg: PackageJson,
  root: string | null = null
): {
  map: Map<string, ResolvedGitModule>
  nested: {
    by: string
    name: string
    url: string | undefined
    ref: string
    top: { url: string | undefined; ref: string }
  }[]
  mismatches: { name: string; by: string; what: "url" | "ref"; theirs: string | undefined }[]
  unmet: { by: string; holder: string }[]
} {
  const map = new Map<string, ResolvedGitModule>(),
    nested: ReturnType<typeof declaredGitModules>["nested"] = [],
    mismatches: ReturnType<typeof declaredGitModules>["mismatches"] = [],
    unmet: ReturnType<typeof declaredGitModules>["unmet"] = []
  const validate = (at: string, entry: GitModuleEntry | undefined) => {
    if (entry?.module !== undefined && typeof entry.module !== "boolean")
      throw new Error(`${at}.module must be true or false (got ${JSON.stringify(entry.module)})`)
    const r = entry?.records
    if (r !== undefined && (!Array.isArray(r) || !r.length || r.some(c => typeof c !== "string" || !c.trim()))) {
      throw new Error(`${at}.records must be a non-empty list of collection names (got ${JSON.stringify(r)})`)
    }
    const { url, ref = "main" } = entry ?? {}
    return { url, ref, records: r, open: r === undefined }
  }
  for (const [name, entry] of Object.entries(pkg?.dreamteamer?.git_modules ?? {})) {
    map.set(name, { ...validate(`git_modules.${name}`, entry), module: entry?.module === true, declarers: [null] })
  }
  if (!root) return { map, nested, mismatches, unmet }
  const widen = (have: ResolvedGitModule, e: ReturnType<typeof validate>): void => {
    if (e.open) have.open = true
    else have.records = [...new Set([...(have.records ?? []), ...e.records])]
  }
  // clones to read, by workspace-relative path; a Map visits entries appended while it is walked
  const clones = new Map([...map.keys()].map(n => [`git_modules/${n}`, n]))
  for (const by of clones.keys()) {
    const dir = path.join(root, by)
    let own: Record<string, GitModuleEntry>
    try {
      own = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dreamteamer?.git_modules ?? {}
    } catch {
      continue
    }
    const holders = new Set(
      Object.values(readExports(dir) ?? {})
        .flatMap(ids => Object.values(ids).map(e => e.from))
        .filter(Boolean)
    )
    for (const holder of holders) {
      const found = Object.entries(own).find(([n]) => n === holder || n === holder.split("/").pop())
      if (!found) {
        unmet.push({ by, holder })
        continue
      }
      const [need, entry] = found
      const e = validate(`${by}: git_modules.${need}`, entry)
      const have = map.get(need)
      if (!have) {
        map.set(need, { ...e, module: false, declarers: [by] })
        clones.set(`git_modules/${need}`, need)
        continue
      }
      if (have.declarers[0] === null) {
        // the root's — it overrides
        if (have.url !== e.url) mismatches.push({ name: need, by, what: "url", theirs: e.url })
        else if (have.ref !== e.ref) mismatches.push({ name: need, by, what: "ref", theirs: e.ref })
      } else if (have.url !== e.url || have.ref !== e.ref) {
        nested.push({ by, name: need, ...e, top: { url: have.url, ref: have.ref } })
        clones.set(`${by}/git_modules/${need}`, need)
        continue
      }
      have.declarers.push(by)
      widen(have, e)
    }
  }
  return { map, nested, mismatches, unmet }
}
