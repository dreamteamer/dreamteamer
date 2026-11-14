import path from "node:path"
import fs from "node:fs"
import { declaredGitModules } from "./declaredGitModules.ts"
import type { PackageJson } from "../types.ts"

/** The declared record layers, validated: `{ name, records, module, via }` per entry — `via` the nested
 *  declarers a hoisted layer was asked for by (`declaredGitModules`). WHAT THE CLONE IS decides it, not the
 *  reader's key (0.41.0): a clone whose own manifest names `workspace_module` is a workspace, so its data is
 *  a layer for every collection both have (`records: null`); a clone that names none is a bundle and is not
 *  listed here; a clone not on disk is listed (not installed). `records:` still makes an entry a layer and
 *  NARROWS it to the listed collections; `module: true` declares one too (and is refused downstream when the
 *  clone has no workspace module to contribute). `root` absent reads only the declarations. */
export function layerEntries(
  pkg: PackageJson,
  root: string | null = null
): { name: string; records: string[] | null; module: boolean; via: string[] }[] {
  const out: ReturnType<typeof layerEntries> = []
  for (const [name, e] of declaredGitModules(pkg, root).map) {
    const clone = root ? path.join(root, "git_modules", name) : null
    // a declaration naming no records reads every shared collection of a WORKSPACE clone — or of one not on
    // disk, which cannot say what it is, and is read as a layer that is not installed (announced by compile,
    // check and status) rather than vanishing: silence is how an absent layer passed for an empty one. Of a
    // bundle it reads nothing, so another declarer's list stands
    const wide = e.open && (clone ? !fs.existsSync(clone) || !!cloneWorkspaceModule(clone) : e.module)
    if (!wide && !e.records && !(clone && e.module)) continue
    out.push({ name, records: wide ? null : (e.records ?? null), module: e.module, via: e.declarers.filter(Boolean) })
  }
  return out
}

/** The `workspace_module` a directory's own manifest names, or null — what makes a clone a workspace. */
function cloneWorkspaceModule(dir: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dreamteamer?.workspace_module || null
  } catch {
    return null
  }
}
