import path from "node:path"
import fs from "node:fs"
import { gatedTreeOp } from "./gatedTreeOp.ts"
import { ENTITY_ID, IN_NODE_MODULES, moduleRecord, workspaceSystemDir } from "./schema-ops.ts"
import type { Store } from "../record/Store.ts"
import type { Workspace } from "../types.ts"
import { kindDir } from "../workspace/compile.ts"

export function createSkill(
  ws: Workspace,
  store: Store,
  { name, description, moduleId }: { name?: string | true; description?: string | true; moduleId?: string | null }
) {
  if (!name || name === true)
    throw new Error('missing skill name — dreamteamer add skills --name <id> --description "…"')
  if (!ENTITY_ID.test(name))
    throw new Error(
      `invalid skill id "${name}" — lowercase alphanumeric with single hyphens (it is a folder name and the frontmatter \`name\` at once).`
    )
  if (typeof description !== "string" || !description.trim()) {
    // ⚠ REQUIRED, not defaulted. claude-code discovers skills natively and shows the description
    // as the trigger; the orientation block indexes it for every other harness. A skill with no
    // description is loadable by nobody and shows up as a bare id in the one place an agent looks.
    throw new Error(
      "--description is required: it is the sentence that says WHEN to load this skill, and it is all any harness shows. An undescribed skill is undiscoverable."
    )
  }
  if (store.descriptors.has("skills") && store.ids("skills").has(name)) {
    throw new Error(`skill "${name}" already exists — dt get skills/${name}`)
  }
  const root = moduleId ? path.join(ws.root, moduleRecord(store, moduleId).fields.path) : null
  if (root && IN_NODE_MODULES(path.relative(ws.root, root))) {
    throw new Error(
      `module "${moduleId}" ships from node_modules — a write there is erased by the next \`npm install\`.`
    )
  }
  // ⚠ THE MODULE ROOT IS RETURNED, not left to the caller to slice back out of `file`. The caller
  // prints a path under it (the `no proof yet` nudge), and deriving that by cutting at `/skills/`
  // is wrong in both layouts this function already handles: the ROOT layout writes
  // `skills/<id>/SKILL.md` with no module segment at all, and the pre-flatten one writes
  // `system/skills/…`. Here the answer is known exactly, in one line.
  const wm = ws.pkg.dreamteamer?.workspace_module
  const modRoot = root ?? (wm ? path.join(ws.root, "modules", wm) : ws.root)
  const dir = path.join(root ? kindDir(root, "skills") : workspaceSystemDir(ws, "skills"), name)
  const file = path.join(dir, "SKILL.md")
  if (fs.existsSync(file)) throw new Error(`${path.relative(ws.root, file)} already exists`)
  // THE MINIMUM THAT COMPILES, and nothing more: two frontmatter keys and an empty body. A
  // scaffold that guesses at sections is a file whose only content is that a verb made it.
  const text = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`
  const out = gatedTreeOp(ws, store, {
    subject: `dreamteamer: skills add ${name}`,
    paths: [path.relative(ws.root, file)],
    mutate: () => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, text)
    },
    undo: () => fs.rmSync(dir, { recursive: true, force: true }),
  })
  return { id: name, file, moduleRoot: path.relative(ws.root, modRoot) || ".", commits: out.commits }
}
