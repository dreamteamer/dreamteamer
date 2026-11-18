import path from "node:path"
import fs from "node:fs"
import { entitySource } from "./lib/entitySource.ts"
import { gatedTreeOp } from "../lib/gatedTreeOp.ts"
import { entityShape, refuseNpmEntity } from "../lib/schema-ops.ts"
import { refuseBuiltSkill } from "./lib/refuseBuiltSkill.ts"
import { ENTITY_ID } from "./lib/consts.ts"
import { setFrontmatterKey } from "./lib/setFrontmatterKey.ts"
import type { Store } from "../store/Store.ts"
import type { Workspace } from "../types.ts"

export function renameEntity(
  ws: Workspace,
  store: Store,
  kind: string,
  oldId: string,
  newId: string | true | undefined
) {
  if (!newId || newId === true) throw new Error(`missing new id — dreamteamer rename ${kind}/${oldId} <new-id>`)
  if (oldId === newId) return { renamed: false, id: newId }
  if (!ENTITY_ID.test(newId))
    throw new Error(`invalid ${kind.replace(/s$/, "")} id "${newId}" — lowercase alphanumeric with single hyphens.`)
  const shape = entityShape(ws, kind)
  const { dir, file, shipped } = entitySource(ws, kind, oldId)
  if (!shipped) throw new Error(`${kind.replace(/s$/, "")} "${oldId}" does not exist — dt list ${kind}`)
  refuseNpmEntity(kind, oldId, shipped)
  refuseBuiltSkill(ws.root, kind, oldId, shipped)
  const newDir = shape.folder
    ? path.join(path.dirname(dir), newId)
    : path.join(path.dirname(file), `${newId}${shape.suffix}`)
  if (fs.existsSync(newDir)) throw new Error(`${path.relative(ws.root, newDir)} already exists`)
  const entityFile = shape.folder ? path.join(newDir, "SKILL.md") : newDir
  const isYaml = shape.suffix.endsWith(".yaml")
  let before: Buffer | string | null = null
  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: ${kind} rename ${oldId} → ${newId}`,
    paths: [path.relative(ws.root, shape.folder ? dir : file), path.relative(ws.root, newDir)],
    mutate: () => {
      fs.renameSync(shape.folder ? dir : file, newDir)
      // ⚠ THE FRONTMATTER `name` IS PART OF THE ID. compile reads the FILENAME for the entity id
      // and the frontmatter for what the harness shows, and letting them disagree is how a skill
      // answers to one name in the tree and another in the session that loads it. A YAML entity
      // (a binding, a template) carries no `name` key, so there is nothing to move.
      before = fs.readFileSync(entityFile, "utf8")
      if (!isYaml) fs.writeFileSync(entityFile, setFrontmatterKey(before, "name", newId))
    },
    undo: () => {
      if (before !== null && fs.existsSync(entityFile)) fs.writeFileSync(entityFile, before)
      if (fs.existsSync(newDir)) fs.renameSync(newDir, shape.folder ? dir : file)
    },
  })
  return { renamed: true, id: newId, commits: out.commits }
}
