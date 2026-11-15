import type { Store } from "../Store.ts"

export function refuseMirrorWrites(
  store: Store,
  collection: string,
  id: string | null | undefined,
  changed: Iterable<string>
): void {
  const relations = store.relations()
  for (const key of changed) {
    const r = relations.find(rel => rel.target === collection && rel.mirror === key)
    if (r)
      throw new Error(
        `${key} is generated from ${r.owner}.${r.field} — set that instead: dreamteamer set ${r.owner}/<id> ${r.field}=${collection}/${id ?? "<id>"} — nothing was written.`
      )
  }
}
