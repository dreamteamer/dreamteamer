import { renameValueInSubschema } from "./renameValueInSubschema.ts"
import { asTree } from "./schema-ops.ts"
import type { At } from "./types.ts"

/** A constraint, at its root-level positions, for the subschemas that constrain `field`. */
export function renameValueInConstraint(
  c: unknown,
  field: string,
  from: string,
  to: string,
  at: At,
  label: string
): void {
  const node = asTree(c)
  if (!node) return
  const prop = asTree(node.properties)?.[field]
  if (prop) renameValueInSubschema(prop, from, to, at, `${label}.properties.${field}`)
  for (const k of ["if", "then", "else", "not"]) renameValueInConstraint(node[k], field, from, to, at, `${label}.${k}`)
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    const subs = node[k]
    ;(Array.isArray(subs) ? subs : []).forEach((sub: unknown, i: number) =>
      renameValueInConstraint(sub, field, from, to, at, `${label}.${k}[${i}]`)
    )
  }
  for (const [k, sub] of Object.entries(asTree(node.dependentSchemas) ?? {}))
    renameValueInConstraint(sub, field, from, to, at, `${label}.dependentSchemas.${k}`)
}
