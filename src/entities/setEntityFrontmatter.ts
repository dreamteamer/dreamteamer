import path from "node:path"
import fs from "node:fs"
import { entitySource } from "./lib/entitySource.ts"
import { entityShape, refuseNpmEntity } from "../lib/schema-ops.ts"
import { setFrontmatterKey } from "./lib/setFrontmatterKey.ts"
import type { Store } from "../record/Store.ts"
import { fieldsOf } from "../record/descriptor.ts"
import { writeSource } from "../record/writeSource.ts"
import { load } from "../record/yaml.ts"
import type { Workspace } from "../types.ts"
import type { SourceDoc } from "../workspace/types.ts"
import { writeGated } from "../workspace/writeGated.ts"

export function setEntityFrontmatter(
  ws: Workspace,
  store: Store,
  kind: string,
  id: string,
  changes: Record<string, unknown>
) {
  const shape = entityShape(ws, kind)
  const { dir, file, shipped } = entitySource(ws, kind, id)
  if (!shipped) throw new Error(`${kind.replace(/s$/, "")} "${id}" does not exist — dt list ${kind}`)
  refuseNpmEntity(kind, id, shipped)
  // ⚠ THE DESCRIPTOR IS THE AUTHORITY, and the engine was disagreeing with itself: `dt set
  // skills/<id> descripton="oops"` wrote the typo, compiled, SELF-COMMITTED — and then `dt check`
  // failed on the very workspace the self-commit exists to keep valid, because the `skills`
  // descriptor declares a closed set of properties and check validates against it. "Frontmatter is
  // an open document" was the wrong half to believe: if a key is not in the descriptor, `check`
  // will reject it, so `set` refuses it first. Its two siblings already read this way
  // (`setCollectionScalars`, `setModule`), and a body field is not settable from the CLI at all.
  const props = fieldsOf(store.descriptors.get(kind))
  const settable = (k: string): boolean => props[k] && !props[k].body && !props[k].derived && !props[k].virtual
  const unknown = Object.keys(changes).find(k => !settable(k))
  if (unknown)
    throw new Error(
      `"${unknown}" is not a settable key of ${kind} — declared: ${Object.keys(props).filter(settable).join(", ")}. \`dreamteamer check\` rejects anything else, so this is refused before it is committed.`
    )
  const target = shape.folder ? path.join(dir, "SKILL.md") : file
  // A YAML source (a binding, a template) is a whole document; a markdown one has frontmatter and
  // prose. `writeSource` round-trips both — the difference is only which text it is handed.
  const isYaml = shape.suffix.endsWith(".yaml")
  const previousText = fs.readFileSync(target, "utf8")
  const changed: string[] = []
  const gate = writeGated(
    ws,
    store,
    [target],
    `dreamteamer: ${kind} set ${id} ${Object.keys(changes).join(" ")}`,
    () => {
      if (isYaml) {
        const doc = load<SourceDoc | null>(previousText) ?? {}
        for (const [k, v] of Object.entries(changes)) {
          if (v === "" || v === null) delete doc[k]
          else doc[k] = v
          changed.push(k)
        }
        fs.writeFileSync(target, writeSource(previousText, doc))
      } else {
        let text = previousText
        for (const [k, v] of Object.entries(changes)) {
          text = setFrontmatterKey(text, k, v === "" ? null : v)
          changed.push(k)
        }
        fs.writeFileSync(target, text)
      }
    },
    undefined,
    { commentsMayDecrease: true }
  )
  return { id, file: target, changed, commits: gate.commits, unchanged: gate.unchanged }
}
