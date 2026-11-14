import { isMap } from "../workspace/views.ts"

/** The smallest overlay turning `base` into `view` — `{}` when they agree. */
export function viewOverlayOf(
  base: Record<string, unknown> | null | undefined,
  view: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(view ?? {})) {
    const b = base?.[k]
    if (isMap(v) && isMap(b)) {
      const inner = viewOverlayOf(b, v)
      if (Object.keys(inner).length) out[k] = inner
    } else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = structuredClone(v)
  }
  for (const k of Object.keys(base ?? {})) if (!(k in (view ?? {}))) out[k] = null
  return out
}
