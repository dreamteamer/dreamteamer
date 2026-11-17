import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parse } from "yaml"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { findFiles } from "../lib/findFiles.ts"
import { isObject } from "../lib/isObject.ts"
import type { Module } from "../types/Module.ts"
import type { Skill } from "../types/Skill.ts"

/** every module's skills, by the name and description in their frontmatter */
export function readSkills(modules: Module[]): Skill[] {
  const skills: Skill[] = []
  for (const module of modules)
    for (const file of findFiles(join(module.dir, "skills"), "SKILL.md")) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))
      let name: string | undefined
      let description: string | undefined
      try {
        const doc: unknown = fm ? parse(fm[1]) : null
        if (isObject(doc)) {
          name = asOptional(doc.name, "name", asString)
          description = asOptional(doc.description, "description", asString)
        }
      } catch {
        // a skill with unreadable frontmatter is listed by its path
        name = description = undefined
      }
      const skill: Skill = {
        name: name ?? relative(join(module.dir, "skills"), file),
        module: module.name,
        description: description ?? "",
        path: file,
      }
      skills.push(skill)
    }
  return skills
}
