import { isMap } from "../views.ts"

// A ui-view source with `overlay: true` and the id of a view another module ships is MERGED onto it at
// compile (compile.js). These two are the whole grammar, and inverse: `overlayView(base, viewOverlayOf(
// base, view))` is `view` again, which is what lets a save over a package's view write only what differs.

/** `base` refined by `overlay`: deep, overlay wins at a leaf, a list is replaced whole, `null` removes. */
export function overlayView(
  base: Record<string, unknown> | null | undefined,
  overlay: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(base ?? {})
  for (const [k, v] of Object.entries(overlay ?? {})) {
    if (v === null) delete out[k]
    else if (isMap(v) && isMap(out[k])) out[k] = overlayView(out[k], v)
    else out[k] = structuredClone(v)
  }
  return out
}
