import type { Model } from "../types/Model.ts"

/**
 * Split `<collection>/<id>` at the longest declared collection name (namespaces contain slashes).
 * Strict by default — a reference stored in a record names its collection in full. With `aliases`, the
 * singular is accepted too, which is what a command line may type.
 */
export function splitRef(model: Model, ref: string, aliases = false) {
  if (typeof ref !== "string") return null
  // a full name wins over another collection's singular of the same spelling: of the longest, the first listed
  const all = Object.values(model.collections)
  const names = [...all.map((t) => [t.name, t.name]), ...(aliases ? all.map((t) => [t.singular, t.name]) : [])]
  let hit: string[] | undefined
  for (const t of names) if (ref.startsWith(t[0] + "/") && (!hit || t[0].length > hit[0].length)) hit = t
  if (!hit) return null
  const res: { collection: string; id: string } = { collection: hit[1], id: ref.slice(hit[0].length + 1) }
  return res
}
