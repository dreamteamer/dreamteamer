import path from "node:path"
import type { Under } from "../../record/types.ts"

/**
 * Where a FILE of a placed collection sits: `{ root, parentId }` — the fallback root, or the child
 * root inside one parent's folder — or null when the path is under neither. The inverse of
 * `placedRoot`, used to prune the right directories after a move and to compare observed placement
 * with the owner the record declares.
 */
export function placementOfFile(
  under: Under,
  file: string,
  fallbackDir: string,
  parentDir: string
): { root: string; parentId: string | null } | null {
  const inside = (dir: string): string | null => {
    const r = path.relative(dir, file)
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : null
  }
  if (inside(fallbackDir)) return { root: fallbackDir, parentId: null }
  const rel = inside(parentDir)
  if (!rel) return null
  const parentId = rel.split(path.sep)[0]
  return { root: path.join(parentDir, parentId, under.subfolder), parentId }
}
