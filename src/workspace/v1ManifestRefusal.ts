import type { DreamteamerBlock } from "../types.ts"
import { MANIFEST_KEYS } from "./MANIFEST_KEYS.ts"
import { CONVERTER } from "./extensions.ts"

/**
 * The refusal for a `dreamteamer` block in the v1 spelling — a kebab-case spelling of a key this
 * engine reads, or a bare `disable` entry — or null. Asked BEFORE any extension code loads, because
 * a v1 `disable` names its module in a spelling this engine does not honour, and the module it meant
 * to switch off would otherwise load and fail first.
 */
export function v1ManifestRefusal(block: DreamteamerBlock | null | undefined, where: string): string | null {
  const keys = Object.keys(block ?? {}).filter(
    k => k === "peerDependencies" || (k.includes("-") && MANIFEST_KEYS.includes(k.replace(/-/g, "_")))
  )
  const bare = (Array.isArray(block?.disable) ? block.disable : []).filter(
    (d: unknown) => typeof d === "string" && !d.includes("/")
  )
  if (!keys.length && !bare.length) return null
  const what = [...keys, ...bare.map(d => `disable "${d}"`)].join(", ")
  return `${where}: the dreamteamer block is in the v1 spelling (${what}).\n  convert the workspace once: ${CONVERTER}\n  then dt compile and dt check — UPDATING.md has the walk.`
}
