import path from "node:path"
import fs from "node:fs"
import { load } from "../record/yaml.ts"
import { readManifest } from "../runtime/runtime.ts"
import type { Workspace } from "../types.ts"
import type { SourceDoc } from "../workspace/types.ts"

/**
 * THE BASE DESCRIPTOR SOURCE, and the overlays beside it — asked of the manifest, decided by parsing.
 *
 * `descriptorSourceDir` above assumes `sources[0]` is the base, which is true in discovery order and
 * is not a fact anything checks. Every EDIT verb needs the base specifically — the rule is that
 * `set`, `rm`, `rename` and the field verbs act on the module that owns the entity and never teleport
 * it into the workspace module — so the base is identified the only way it is actually defined: it is
 * the contributing source that does not declare `overlay: true`.
 *
 * Returns workspace-relative paths. `base` is null when nothing in this workspace declares it (the
 * engine's own nine collections reach here that way), which is the signal to write an overlay.
 */
export function baseDescriptorSource(
  ws: Workspace,
  name: string
): { base: string | undefined; overlays: string[]; sources: string[] } {
  const suffix = `collections/${name}.collection.yaml`
  const sources = (readManifest(ws.root)?.entries?.[suffix]?.sources ?? [])
    // sources are `{path, hash}`; tolerate the pre-0.10 string form, as compile's staleness does
    .map(s => (typeof s === "string" ? s : s?.path))
    // ⚠ MATCHED ON THE KIND, not on the source path mirroring the collection's NAME. This used
    // to require `endsWith('collections/<name>.collection.yaml')`, which assumes a namespaced
    // descriptor is authored NESTED — true of what `dt add collections` writes, and NOT true of a
    // module that authors `collections/positions.collection.yaml` with `name: hr/positions`,
    // which is the ordinary shape for a module that OWNS its namespace (§8) and does not want to
    // repeat it in every path. Measured on a scratch workspace: that module's base was invisible
    // here, so `add-field hr/positions` created an overlay in the WORKSPACE module and failed
    // compile for a dependency nobody asked for — the exact defect this wave exists to remove,
    // surviving one layer down. `sources` is already scoped to THIS collection's manifest entry;
    // the only other thing in it is a merged MIXIN, whose suffix differs.
    .filter(p => typeof p === "string" && p.endsWith(".collection.yaml"))
  let base = null
  const overlays = []
  for (const rel of sources) {
    const file = path.join(ws.root, rel)
    if (!fs.existsSync(file)) continue
    let doc
    try {
      doc = load<SourceDoc | null>(fs.readFileSync(file, "utf8"))
    } catch {
      continue
    }
    if (doc?.overlay === true) overlays.push(rel)
    else base ??= rel
  }
  return { base, overlays, sources }
}
