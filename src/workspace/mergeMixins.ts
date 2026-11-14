import type { AuthoredDescriptor, Field } from "../types.ts"

/**
 * Merge mixins into a descriptor, in list order. Fields go before the body field; `storage`, `ids`
 * and `display` apply key by key where the descriptor is silent; constraints concatenate. A field
 * name two sources both declare is an error naming both.
 * @param {object} doc
 * @param {Map<string, object>} mixins   id → mixin doc
 * @returns {{ doc: object, errors: string[], used: string[] }}
 */
export function mergeMixins(
  doc: AuthoredDescriptor,
  mixins: Map<string, Partial<AuthoredDescriptor>>
): { doc: AuthoredDescriptor; errors: string[]; used: string[] } {
  const errors: string[] = []
  const used: string[] = []
  const out = structuredClone(doc)
  const ids = doc.mixins ?? []
  if (!Array.isArray(ids)) return { doc: out, errors: ["`mixins` is a list of mixin ids"], used }
  const owned = new Map(Object.keys(doc.fields ?? {}).map(f => [f, "the descriptor"]))
  const added: Record<string, Field> = {}
  const constraints = [...(doc.constraints ?? [])]
  for (const id of ids) {
    const m = mixins.get(id)
    if (!m) {
      errors.push(`mixin "${id}" does not exist (have: ${[...mixins.keys()].join(", ") || "none"})`)
      continue
    }
    used.push(id)
    for (const [f, v] of Object.entries(m.fields ?? {})) {
      if (owned.has(f)) {
        errors.push(`field "${f}" is declared by ${owned.get(f)} and by mixin "${id}" — one source per field`)
        continue
      }
      owned.set(f, `mixin "${id}"`)
      added[f] = structuredClone(v)
    }
    for (const k of ["storage", "ids"] as const) if (m[k]) out[k] = { ...structuredClone(m[k]), ...(out[k] ?? {}) }
    if (m.display) {
      out.display ??= {}
      for (const [b, v] of Object.entries<Record<string, unknown>>(m.display))
        out.display[b] = { ...structuredClone(v), ...(out.display[b] ?? {}) }
    }
    constraints.push(...(m.constraints ?? []))
  }
  // fields: the descriptor's own, with the mixins' inserted before the body
  const own = Object.entries<Field>(out.fields ?? {})
  const bodyAt = own.findIndex(([, f]) => f?.body)
  const merged =
    bodyAt < 0
      ? [...own, ...Object.entries(added)]
      : [...own.slice(0, bodyAt), ...Object.entries(added), ...own.slice(bodyAt)]
  out.fields = Object.fromEntries(merged)
  if (constraints.length) out.constraints = constraints
  delete out.mixins
  return { doc: out, errors, used }
}
