import { INJECTED_FIELDS } from "../record/consts.ts"
import { SCALAR_TYPES } from "../record/consts.ts"
import { enumValues, fieldTitleOf, referenceTargets } from "../record/fields.ts"
import type { Field } from "../types.ts"

/** The closed set of keys a field may carry. Anything else is a compile error naming the key. */
const FIELD_KEYS = new Set([
  "type",
  "title",
  "required",
  "many",
  "default",
  "enum",
  "unique",
  "mirror_of",
  "on_delete",
  "soft",
  "sensitive",
  "body",
  "derived",
  "virtual",
  "deprecated",
  "passthrough",
  "fields",
  "values",
  "item_title",
  "examples",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "const",
  "display",
  "description",
])

/** The keys a field's `display` block may carry. */
const DISPLAY_KEYS = new Set([
  "editable",
  "hidden",
  "form_section",
  "placeholder",
  "unit",
  "unit_field",
  "direction",
  "width",
  "viewer",
  "editor",
  "options",
])

/**
 * Resolve one collection's authored fields.
 * @param {object} authored   the descriptor's `fields` (mixins and overlays already merged in by compile)
 * @param {object} ctx        { name, collections: Set<string>, peers?: Set<string> }
 * @returns {{ fields: object, errors: string[], warnings: string[], defaults: object }}
 *   fields   — resolved: injected fields first, authored fields in order, every field with its type and keys as authored
 *   defaults — per field, the keys compile supplied (title today; on_delete on references)
 *   errors   — each naming the field and the key
 */
export function resolveFields(
  authored: Record<string, Field> | null | undefined,
  ctx: { name?: string; collections: Iterable<string>; peers?: Iterable<string>; runtime?: boolean }
): { fields: Record<string, Field>; errors: string[]; warnings: string[]; defaults: Record<string, Partial<Field>> } {
  const errors: string[] = []
  const warnings: string[] = []
  const defaults: Record<string, Partial<Field>> = {}
  const known = new Set(Object.keys(authored ?? {}))
  const fields: Record<string, Field> = {}
  // `created` is STAMPED by the store, which a kind whose records compile writes never goes through
  for (const [k, v] of Object.entries(INJECTED_FIELDS)) {
    if (k === "created" && ctx.runtime) continue
    if (known.has(k)) errors.push(`field "${k}" is injected by the engine and cannot be authored`)
    fields[k] = { ...v }
  }
  // a type may name an installed collection or a declared peer nobody installed yet
  const types = new Set([...ctx.collections, ...(ctx.peers ?? [])])
  let bodies = 0
  let positions = 0
  for (const [name, prop] of Object.entries<Field>(authored ?? {})) {
    if (!prop || typeof prop !== "object" || Array.isArray(prop)) {
      errors.push(`field "${name}" must be a map`)
      continue
    }
    const targets = checkField(name, prop, { types, siblings: authored, errors, warnings, top: true })
    if (prop.body) bodies++
    if (prop.type === "position") positions++
    // defaults compile supplies, recorded apart so the resolved field never looks authored where it was not
    const out = { ...prop }
    const d: Partial<Field> = {}
    if (out.title === undefined) {
      out.title = fieldTitleOf(name)
      d.title = out.title
    }
    if (targets && out.on_delete === undefined && out.mirror_of === undefined) {
      out.on_delete = "restrict"
      d.on_delete = "restrict"
    }
    if (Object.keys(d).length) defaults[name] = d
    fields[name] = out
  }
  if (bodies > 1) errors.push(`${bodies} fields declare body: true — a record has one body`)
  if (positions > 1) errors.push(`${positions} fields are type position — a collection has one manual order`)
  return { fields, errors, warnings, defaults }
}

/** Keys that only a collection's own field may carry: they describe the RECORD, not a value inside one. */
const RECORD_KEYS = ["body", "mirror_of", "unique", "derived", "virtual"]

/**
 * Validate one field definition against the closed vocabulary, and every definition nested in it — an
 * object's `fields` and a map's `values` — under its full path (`details.code`). Pushes onto `errors`
 * and `warnings`; returns the field's reference targets (null when it references nothing).
 */
function checkField(
  path: string,
  prop: Field,
  {
    types,
    siblings,
    errors,
    warnings,
    top,
  }: { types: Set<string>; siblings: Record<string, Field>; errors: string[]; warnings: string[]; top: boolean }
): string[] | null {
  const at = `field "${path}"`
  const name = path.split(".").pop()
  const targets = referenceTargets(prop.type, types)
  if (!top)
    for (const k of RECORD_KEYS)
      if (k in prop)
        errors.push(`${at}: \`${k}\` belongs to a collection's own field, not one nested in an object or a map`)
  // a key copied verbatim into a harness keeps the harness's spelling, and says so
  // a WARNING: renaming a field is a record change (`dt rename-field`), which a compile must not force
  if (!/^[a-z][a-z0-9_]*$/.test(name) && !(prop.passthrough && /^[a-z][a-z0-9-]*$/.test(name)))
    warnings.push(
      `${at}: names are snake_case — \`dt rename-field\` renames it in every record (a key passed through to a harness in its own spelling is marked \`passthrough: true\`)`
    )
  for (const k of Object.keys(prop))
    if (!FIELD_KEYS.has(k))
      errors.push(`${at} has unknown key "${k}" — the closed list is: ${[...FIELD_KEYS].join(" ")}`)
  if (prop.type === undefined) errors.push(`${at} has no type`)
  else if (!targets && !(SCALAR_TYPES as readonly unknown[]).includes(prop.type)) {
    errors.push(
      Array.isArray(prop.type)
        ? `${at}: a union names collections, and ${JSON.stringify(prop.type)} is not all collections`
        : `${at}: unknown type "${prop.type}" — one of ${SCALAR_TYPES.join(" ")} or a collection name`
    )
  }
  if (Array.isArray(prop.type) && !prop.type.length)
    errors.push(`${at}: an empty union references nothing — a union names at least one collection`)
  if (Array.isArray(prop.type))
    for (const t of prop.type) if (!types.has(t)) errors.push(`${at}: union member "${t}" is not a collection`)
  if (prop.type === "object" && !prop.fields) errors.push(`${at}: type object needs \`fields\``)
  if (prop.fields && prop.type !== "object") errors.push(`${at}: \`fields\` belongs to type object`)
  if (prop.values && prop.type !== "map") errors.push(`${at}: \`values\` belongs to type map`)
  if (prop.item_title && !(prop.type === "object" && prop.many))
    errors.push(`${at}: \`item_title\` labels the rows of a \`many\` object`)
  if (prop.body && prop.type !== "markdown") errors.push(`${at}: the body is \`type: markdown\``)
  if (prop.type === "position" && prop.many) errors.push(`${at}: a position is scalar`)
  if (prop.enum !== undefined) {
    if (prop.type !== "string") errors.push(`${at}: \`enum\` belongs to type string (there is no type enum)`)
    const values = enumValues(prop.enum)
    if (!values)
      errors.push(
        `${at}: \`enum\` is a list of values or a map of value → { label, description, icon, color, background }`
      )
    // a WARNING: renaming a value is a record change (`dt rename-value`), which a compile must not force.
    // A passthrough field's values are spelled by something outside the workspace (a folder name).
    else if (!prop.passthrough)
      for (const v of values)
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(v)))
          warnings.push(
            `${at}: enum value "${v}" is not kebab-case — values are kebab-case, and the label belongs in the enum map (dt rename-value renames one)`
          )
  }
  if (prop.mirror_of !== undefined) {
    if (!targets || targets[0] === "*" || targets.length !== 1)
      errors.push(`${at}: \`mirror_of\` needs a type naming exactly one collection`)
    if (prop.required) errors.push(`${at}: a mirror cannot be required — the owner writes it`)
  }
  if (prop.on_delete !== undefined) {
    if (!targets) errors.push(`${at}: \`on_delete\` belongs to a reference`)
    if (!["restrict", "set-null"].includes(prop.on_delete)) errors.push(`${at}: on_delete is restrict or set-null`)
    if (prop.on_delete === "set-null" && prop.required)
      errors.push(`${at}: on_delete: set-null on a required reference would produce an invalid record`)
  }
  // a SOFT reference still names what it may point at, but a missing collection or record is
  // tolerated — for a value that is a declaration rather than a resolved link
  if (prop.soft !== undefined) {
    if (prop.soft !== true) errors.push(`${at}: \`soft\` is true or absent`)
    if (!targets) errors.push(`${at}: \`soft\` belongs to a reference`)
    if (prop.mirror_of !== undefined) errors.push(`${at}: a mirror is maintained by the engine, so it cannot be soft`)
  }
  if (prop.unique && prop.many) errors.push(`${at}: \`unique\` is a value constraint on a scalar field`)
  if (prop.derived && prop.virtual)
    errors.push(`${at}: derived (stored, engine-written) and virtual (never stored) exclude each other`)
  if (prop.display) {
    for (const k of Object.keys(prop.display))
      if (!DISPLAY_KEYS.has(k))
        errors.push(`${at}: display has unknown key "${k}" — one of ${[...DISPLAY_KEYS].join(" ")}`)
    const { editable, hidden, unit_field } = prop.display
    if (editable !== undefined && !([true, false, "create"] as unknown[]).includes(editable))
      errors.push(`${at}: display.editable is true, false or create`)
    if (hidden !== undefined && (!Array.isArray(hidden) || hidden.some(h => !["list", "form", "record"].includes(h))))
      errors.push(`${at}: display.hidden lists list, form, record`)
    if (
      prop.required &&
      prop.default === undefined &&
      (editable === false || (Array.isArray(hidden) && hidden.includes("form")))
    )
      errors.push(
        `${at}: required with no default, but hidden from the form or not editable — nothing could create a record`
      )
    if (unit_field !== undefined && (typeof unit_field !== "string" || siblings?.[unit_field]?.type !== "string"))
      errors.push(`${at}: display.unit_field "${unit_field}" is not a string field`)
  }
  for (const [k, child] of Object.entries(
    prop.type === "object" && prop.fields && typeof prop.fields === "object" ? prop.fields : {}
  )) {
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      errors.push(`field "${path}.${k}" must be a map`)
      continue
    }
    checkField(`${path}.${k}`, child, { types, siblings: prop.fields, errors, warnings, top: false })
  }
  if (prop.type === "map" && prop.values !== undefined) {
    if (typeof prop.values === "string") {
      if (!referenceTargets(prop.values, types) && !SCALAR_TYPES.includes(prop.values))
        errors.push(
          `${at}: \`values\` names unknown type "${prop.values}" — one of ${SCALAR_TYPES.join(" ")} or a collection name`
        )
    } else if (prop.values && typeof prop.values === "object" && !Array.isArray(prop.values)) {
      checkField(`${path}.values`, prop.values, { types, siblings: {}, errors, warnings, top: false })
    } else errors.push(`${at}: \`values\` is a type or a field definition`)
  }
  return targets
}
