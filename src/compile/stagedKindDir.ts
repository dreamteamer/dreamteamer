import path from "node:path"
import fs from "node:fs"
import { kindDir } from "./kindDir.ts"

/**
 * The folder compile STAGES one kind from in the module at `root`: `kindDir`, except for `skills` in a
 * module that declares `dreamteamer.skills` — a folder of its build (`dist/skills`), where a skill's
 * TypeScript scripts arrive compiled beside its copied `SKILL.md`. Node will not strip types under
 * `node_modules`, so a module whose skills run code ships them built, and its `skills/` is then the
 * build's SOURCE, never read here.
 *
 * ⚠ EVERY READER OF A MODULE'S SKILLS ASKS THIS, not `kindDir`: staging, the source-free warning,
 * staleness and `check --alone`'s shipped-files gate. One that asked `kindDir` would read the unbuilt
 * source and disagree with what compile staged. A WRITER still asks `kindDir` — or refuses, as the
 * entity verbs do — because a build output is never where a source is authored.
 *
 * The workspace root never declares it (compile refuses the key there), and a value that is not a
 * string falls back to `kindDir`: compile refuses that shape with its own message before staging.
 */
export function stagedKindDir(root: string, kind: string): string {
  const declared = kind === "skills" ? declaredSkillsDir(root) : null
  return declared ? path.join(root, declared) : kindDir(root, kind)
}

/** `dreamteamer.skills` of the package at `root` when it is a string, else null. */
export function declaredSkillsDir(root: string): string | null {
  try {
    const skills = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dreamteamer?.skills
    return typeof skills === "string" && skills ? skills : null
  } catch {
    return null
  }
}
