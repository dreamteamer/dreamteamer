import path from "node:path"
import fs from "node:fs"
import { declaredSkillsDir } from "../../compile/stagedKindDir.ts"

/**
 * Refuse a write to a skill compiled from a module's BUILD folder (`dreamteamer.skills`). The manifest
 * names that folder as the skill's source, so `set`/`rm`/`rename` would edit a build output the next
 * build overwrites — and a git that ignores `dist/` would commit nothing while the verb said ✔.
 * `shipped` is the manifest source, workspace-relative; the owning module is the nearest package above it.
 */
export function refuseBuiltSkill(wsRoot: string, kind: string, id: string, shipped: string | null): void {
  if (kind !== "skills" || !shipped) return
  for (let dir = path.dirname(path.join(wsRoot, shipped)); dir.startsWith(wsRoot); dir = path.dirname(dir)) {
    if (!fs.existsSync(path.join(dir, "package.json"))) continue
    const built = declaredSkillsDir(dir)
    if (!built || !path.join(wsRoot, shipped).startsWith(path.join(dir, built) + path.sep)) return
    throw new Error(builtSkillLine(path.relative(wsRoot, dir) || ".", built, id))
  }
}

/** The refusal for a skill write into a module whose skills stage from its build. */
export const builtSkillLine = (moduleRoot: string, built: string, id: string): string =>
  `skill "${id}" is staged from ${moduleRoot}'s build (dreamteamer.skills: "${built}"), and a write there is overwritten by the next build.\n  write its source instead — ${path.join(moduleRoot, "skills", id)}/ by convention — run the module's build, then \`dt compile\`.`
