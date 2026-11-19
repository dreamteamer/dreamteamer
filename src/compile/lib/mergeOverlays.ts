import type { AuthoredDescriptor, Field } from "../../types.ts"

/** A field refined by an overlay: the overlay's keys win, `display` merged key by key. */
function refineField(f: Field, by: Partial<Field>): Field {
  const out = { ...f, ...by }
  if (f?.display && by?.display) out.display = { ...f.display, ...by.display }
  return out
}

/**
 * A base and its overlays as ONE v2 descriptor: overlay fields inserted before the body,
 * constraints concatenated, every other key overlay-wins key by key (display per sub-block).
 */
export function mergeOverlays(base: AuthoredDescriptor, overlays: Partial<AuthoredDescriptor>[]): AuthoredDescriptor {
  const out = structuredClone(base)
  for (const o of overlays) {
    // a field already present — from the base OR an earlier overlay — is refined in place, key by key
    // (its `display` too); a new one goes in before the body field
    const own = Object.entries(out.fields ?? {}).map(([k, f]): [string, Field] => [
      k,
      k in (o.fields ?? {}) ? refineField(f, o.fields[k]) : f,
    ])
    const bodyAt = own.findIndex(([, f]) => f?.body)
    const add = Object.entries(o.fields ?? {}).filter(([k]) => !(k in (out.fields ?? {})))
    out.fields = Object.fromEntries(
      bodyAt < 0 ? [...own, ...add] : [...own.slice(0, bodyAt), ...add, ...own.slice(bodyAt)]
    )
    if (o.constraints) out.constraints = [...(out.constraints ?? []), ...o.constraints]
    if (o.display) {
      out.display ??= {}
      for (const [b, v] of Object.entries<Record<string, unknown>>(o.display))
        out.display[b] = { ...(out.display[b] ?? {}), ...v }
    }
    for (const [k, v] of Object.entries(o))
      if (!["name", "overlay", "fields", "constraints", "display", "mixins"].includes(k)) out[k] = structuredClone(v)
  }
  delete out.overlay
  return out
}
