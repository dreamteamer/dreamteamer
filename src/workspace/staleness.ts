import path from "node:path"
import fs from "node:fs"
import { walk } from "../record/walk.ts"
import { readManifest } from "../runtime/runtime.ts"
import type { Manifest, PackageJson } from "../types.ts"
import { KINDS } from "./KINDS.ts"
import { INSTRUCTIONS_SOURCE, kindDir, sha256, toPosix } from "./compile.ts"
import { discoverModules } from "./discoverModules.ts"
import { excludedFromKind, isPackageEntry } from "./extensions.ts"

// staleness: does any manifest entry's SOURCE differ from what was compiled, or is a
// source file missing/new? used by `status` and warned about at every tool entry.
export function staleness(root: string): { compiled: boolean; stale: string[]; manifest?: Manifest; message?: string } {
  const manifest = readManifest(root)
  if (!manifest) return { compiled: false, stale: [], message: "no compiled runtime — run `dreamteamer compile`" }
  const stale = []
  for (const e of Object.values(manifest.entries ?? {})) {
    for (const src of e.sources) {
      // sources are {path, hash}; tolerate the pre-merge string form
      const srcPath = typeof src === "string" ? src : src.path
      const srcHash = typeof src === "string" ? e.hash : src.hash
      const p = path.join(root, srcPath)
      if (!fs.existsSync(p)) stale.push(`${srcPath} (removed)`)
      else if (sha256(fs.readFileSync(p)) !== srcHash) stale.push(`${srcPath} (changed)`)
    }
  }
  // new source files not present in the manifest — scan winning module roots across
  // ALL channels (shadowed copies were not compiled, so their files are not "new")
  const known = new Set([
    ...Object.values(manifest.entries ?? {}).flatMap(e => e.sources.map(s => (typeof s === "string" ? s : s.path))),
    ...(manifest.inert ?? []).map(s => s.path),
  ])
  for (const src of manifest.inert ?? []) {
    const p = path.join(root, src.path)
    if (!fs.existsSync(p)) stale.push(`${src.path} (removed)`)
    else if (sha256(fs.readFileSync(p)) !== src.hash) stale.push(`${src.path} (changed)`)
  }
  let pkg: PackageJson = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  } catch {
    /* no pkg */
  }
  const wm = pkg.dreamteamer?.workspace_module
  const found = discoverModules(root, pkg)
  // ⚠ A DISABLED ENTITY IS NOT A NEW ONE, AND THIS IS THE DIFFERENCE BETWEEN A WARNING AND A LIE.
  // `compile` skips every source named by an ENTITY-LEVEL `dreamteamer.disable` entry
  // (`<module>/<entity>`) before `addEntry`, so that file's path never becomes a manifest source.
  // This scan used to have no knowledge of that filter, so it found the file on disk, found it
  // absent from `known`, and reported it `(new, uncompiled)` — permanently, because every future
  // compile skips it exactly the same way. The workspace was told to run a compile that could not
  // possibly clear the warning, at every tool entry, for as long as the disable stood.
  //
  // Two consuming workspaces were sitting in that state when this was found, one of them with a
  // clean compile seconds earlier. The MODULE-level form (a bare name) needs no handling here:
  // `discoverModules` drops the whole module, so its files are never walked at all.
  //
  // The root itself, when a workspace declares no `workspace-module`, is not a named module, so no
  // `<module>/<entity>` entry can address its sources — it is walked unfiltered, as before.
  const disabledEntities = new Set<string>(
    (pkg.dreamteamer?.disable ?? []).filter((d): d is string => typeof d === "string" && !isPackageEntry(d))
  )
  const refused = new Set((manifest.refused ?? []).map(r => r.name))
  const roots = [
    ...(wm ? [] : [{ name: null, root }]),
    ...found.modules.filter(m => !refused.has(m.name)).map(m => ({ name: m.name, root: m.root })),
  ]
  // the kinds the last compile STAGED, read off its manifest — staleness loads no extension code
  const contributedKinds = (manifest["source-kinds"] ?? []).map(k => ({ kind: k.kind, exclude: k.exclude ?? [] }))
  for (const { name: moduleName, root: r } of roots) {
    for (const kind of [...KINDS, ...contributedKinds.map(k => k.kind)]) {
      const dir = kindDir(r, kind)
      if (!fs.existsSync(dir)) continue
      for (const f of walk(dir)) {
        const rel = path.relative(dir, f).split(path.sep).join("/")
        if (excludedFromKind(contributedKinds, kind, rel)) continue
        // The SAME id derivation `compile` uses, so the two can never disagree about which
        // file a disable entry names.
        //
        // ⚠ AND THE TWO KINDS DERIVE IT DIFFERENTLY. `compile` walks collections recursively,
        // so a collection's id is its whole relative path (it may carry a namespace segment,
        // `<ns>/<name>`); every other kind it reads with a flat `readdirSync`, so the entity
        // is the TOP-LEVEL entry and a folder-shaped one — a skill is a directory holding
        // `SKILL.md` — is named by the folder alone. Matching the full path for those meant a
        // disabled SKILL still counted as stale, because `working-with-tasks/SKILL.md` is not
        // `working-with-tasks`. Caught against a real workspace whose disable list held one
        // of each: the ui-view cleared and the skill did not.
        if (moduleName) {
          const relEntity = kind === "collections" ? rel : rel.split("/")[0]
          const entityId = relEntity.replace(/\.[^.]+\.(yaml|md|json)$/, "")
          if (disabledEntities.has(`${kind}/${entityId}`)) continue
        }
        const relPath = toPosix(path.relative(root, f))
        if (!known.has(relPath)) stale.push(`${relPath} (new, uncompiled)`)
      }
    }
  }
  // ⚠ `dreamteamer.md` is a compile source that is NOT under a KIND directory, so the walk above
  // cannot reach it — and its CREATION is the one moment that matters most: day one in an adopting
  // workspace, when no harness file carries an instructions block yet. Every later EDIT was already
  // caught by the manifest-source walk at the top of this function; only the first write was silent,
  // and it reported `.dreamteamer is fresh` while the rules reached no agent at all.
  if (fs.existsSync(path.join(root, INSTRUCTIONS_SOURCE)) && !known.has(INSTRUCTIONS_SOURCE)) {
    stale.push(`${INSTRUCTIONS_SOURCE} (new, uncompiled)`)
  }
  return { compiled: true, stale, manifest }
}
