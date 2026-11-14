import { SKELETON_KINDS } from "./consts.ts"
import type { DreamteamerBlock, Flags } from "../types.ts"

/** Every path `init` writes or creates for this effective block, root-relative. ⚠ The data folder is
 *  the FLAG's (or `data`), not the block's — what init has always created, so both are listed. */
export function initFootprint(block: DreamteamerBlock, flags: Flags = {}) {
  const wm = block.workspace_module,
    base = wm ? `modules/${wm}` : "."
  return [
    "package.json",
    ".gitignore",
    ".env.example",
    ".vscode/extensions.json",
    flags.data_path ?? "data",
    block.data_path,
    ...SKELETON_KINDS.map(k => `${base}/${k}`),
    ...(wm ? [`${base}/package.json`] : []),
    `${base}/collections/notes.collection.yaml`,
  ]
}
