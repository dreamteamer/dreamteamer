import { SCALAR_TYPES } from "./SCALAR_TYPES.ts"
import { storageOf } from "./storageOf.ts"
import type { Descriptor, Field } from "../types.ts"

export const block = (d: Descriptor): Partial<Descriptor["compiled"]> => d?.compiled ?? {}

export const defaults = (d: Descriptor): Descriptor["compiled"]["defaults"] => block(d).defaults ?? {}

/** The resolved fields, injected ones included, in form order. */
export const fieldsOf = (d: Descriptor): Record<string, Field> => block(d).fields ?? {}

/** The fields a record STORES — everything but the virtual ones (`id`, `last_modified`). */
export const storedFieldsOf = (d: Descriptor): Record<string, Field> =>
  Object.fromEntries(Object.entries(fieldsOf(d)).filter(([, f]) => !f.virtual))

/** The JSON Schema the validator runs. Standard keywords only. */
export const jsonSchemaOf = (d: Descriptor): Record<string, unknown> =>
  block(d).json_schema ?? { type: "object", properties: {} }

/** The field a record's prose lands in — the text after the frontmatter — or undefined. */
export const bodyFieldOf = (d: Descriptor): string | undefined =>
  Object.entries(fieldsOf(d)).find(([, f]) => f.body)?.[0]

/** The one `type: position` field — what `dt reorder` writes — or undefined. */
export const positionFieldOf = (d: Descriptor): string | undefined =>
  Object.entries(fieldsOf(d)).find(([, f]) => f.type === "position")?.[0]

/** The names of the required fields. */
export const requiredOf = (d: Descriptor): string[] =>
  Object.entries(fieldsOf(d))
    .filter(([, f]) => f.required)
    .map(([k]) => k)

/**
 * What a field references: `null` (not a reference), `'*'` (any record — `type: reference`), or the
 * list of collections it may target (`type: <collection>` or a union `[a, b]`).
 */
export function targetsOf(field: Field | undefined): null | "*" | string[] {
  const t = field?.type
  if (Array.isArray(t)) return t
  if (t === "reference") return "*"
  if (typeof t === "string" && !SCALAR_TYPES.includes(t)) return [t]
  return null
}

/** A soft reference: the value must target a named collection, but a missing record is tolerated. */
export const isSoft = (field: Field | undefined): boolean => field?.soft === true

/** The field this one mirrors on the target collection, or undefined. */
export const mirrorOf = (field: Field | undefined): string | undefined => field?.mirror_of

export const titleOf = (d: Descriptor): string => d?.title ?? defaults(d).title ?? d?.name

export const singularOf = (d: Descriptor): string | undefined => d?.singular ?? defaults(d).singular

export const recordTitleOf = (d: Descriptor): string => d?.record_title ?? defaults(d).record_title ?? "{{ id }}"

/** How ids are made: `{ from, pattern }`. `from` is a template or an ordered list of them. */
export const idsOf = (d: Descriptor): { from?: string | string[]; pattern?: string } => ({
  ...(defaults(d).ids ?? {}),
  ...(d?.ids ?? {}),
})

/** Records are build output written by compile (a system kind), not workspace data. */
export const isRuntime = (d: Descriptor): boolean => block(d).runtime === true

/** Workspace plumbing hidden from the domain listing. */
export const isInternal = (d: Descriptor): boolean => d?.internal === true

export const isSensitive = (d: Descriptor): boolean => d?.sensitive === true

/** Records are opaque files (`format: binary`): no frontmatter, fields derived from the file. */
export const isBinary = (d: Descriptor): boolean => storageOf(d).format === "binary"

export const moduleOf = (d: Descriptor): string => block(d).module

export const overlaidByOf = (d: Descriptor): string[] => block(d).overlaid_by ?? []

export const unresolvedPeersOf = (d: Descriptor): string[] => block(d).unresolved_peers ?? []

/** The fields that are generated mirrors of another collection's reference. */
export const mirrorsOf = (d: Descriptor): string[] => block(d).mirrors ?? []
