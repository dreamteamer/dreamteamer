import { enumValues, referenceTargets } from "../record/fields.ts"
import type { Field } from "../types.ts"

/** JSON Schema keywords copied onto the emitted property unchanged. */
const PASS_THROUGH = [
  "default",
  "examples",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "const",
]

/**
 * The validator's schema. Standard JSON Schema, standard keywords only, no descriptions, no titles:
 * those live once, in `compiled.fields`. Properties are exactly the non-virtual fields.
 */
export function toJsonSchema(
  fields: Record<string, Field>,
  { constraints = [], collections }: { constraints?: unknown[]; collections?: Set<string> } = {}
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, f] of Object.entries(fields)) {
    if (f.virtual) continue
    properties[name] = propertySchema(f, collections)
    if (f.required) required.push(name)
  }
  const schema: Record<string, unknown> = { type: "object", properties }
  if (required.length) schema.required = required
  if (constraints.length) schema.allOf = constraints.map(c => structuredClone(c))
  return schema
}

function propertySchema(f: Field, collections: Set<string> | undefined): Record<string, unknown> {
  let s: Record<string, unknown> = scalarSchema(f, collections)
  for (const k of PASS_THROUGH) if (f[k] !== undefined && !(f.many && ["minItems", "maxItems"].includes(k))) s[k] = f[k]
  if (f.many) {
    const arr: Record<string, unknown> = { type: "array", items: s }
    for (const k of ["minItems", "maxItems", "default", "examples"]) if (f[k] !== undefined) arr[k] = f[k]
    delete s.default
    delete s.examples
    if (f.mirror_of !== undefined) arr.uniqueItems = true
    s = arr
  }
  if (f.mirror_of !== undefined) s.readOnly = true
  return s
}

function scalarSchema(f: Field, collections: Set<string> | undefined): Record<string, unknown> {
  const t = f.type
  if (referenceTargets(t, collections ?? new Set(Array.isArray(t) ? t : [t]))) return { type: "string" }
  switch (t) {
    case "string":
      return f.enum !== undefined ? { type: "string", enum: enumValues(f.enum) } : { type: "string" }
    case "markdown":
      return { type: "string", format: "markdown" }
    case "boolean":
      return { type: "boolean" }
    case "integer":
      return { type: "integer" }
    case "number":
      return { type: "number" }
    case "date":
      return { type: "string", format: "date" }
    case "datetime":
      return { type: "string", format: "date-time" }
    case "url":
      return { type: "string", format: "uri" }
    case "email":
      return { type: "string", format: "email" }
    case "position":
      return { type: "string", pattern: "^[a-z]+$" }
    // `values` absent: any value under any key — the open object a free-form block needs
    case "map":
      return f.values === undefined
        ? { type: "object" }
        : { type: "object", additionalProperties: valueSchema(f.values, collections) }
    case "object": {
      const inner = toJsonSchema(
        Object.fromEntries(
          Object.entries<Field>(f.fields ?? {}).map(([k, v]) => [k, { ...v, title: undefined as string | undefined }])
        ),
        { collections }
      )
      return inner
    }
    default:
      return { type: "string" }
  }
}

function valueSchema(
  values: string | Field | undefined,
  collections: Set<string> | undefined
): Record<string, unknown> {
  if (typeof values === "string") return scalarSchema({ type: values }, collections)
  if (values && typeof values === "object") return propertySchema(values, collections)
  return {}
}
