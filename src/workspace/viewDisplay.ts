import { VIEW_DISPLAY, isMap } from "./views.ts"

/**
 * A view's display, resolved: the collection's display with the view's merged over it sub-block by
 * sub-block — a sub-block the view omits is the collection's, and a key the view sets wins. `nav` is
 * the exception: a view with no `nav` has no nav entry, so the collection's is not inherited.
 */
export function viewDisplay(collectionDisplay: unknown, view: unknown): Record<string, Record<string, unknown>> {
  const display = isMap(view) ? view.display : undefined
  const own = isMap(display) ? display : {}
  const base = isMap(collectionDisplay) ? collectionDisplay : {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const b of Object.keys(VIEW_DISPLAY)) {
    if (b === "nav" && !own.nav) continue
    const v = { ...((base[b] ?? {}) as Record<string, unknown>), ...((own[b] ?? {}) as Record<string, unknown>) }
    if (Object.keys(v).length) out[b] = structuredClone(v)
  }
  return out
}
