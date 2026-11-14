import { SCALAR_TYPES } from "../record/SCALAR_TYPES.ts"
import type { Store } from "../record/Store.ts"
import { fieldsOf, targetsOf } from "../record/descriptor.ts"
import type { Field } from "../types.ts"

// ---- the field verbs ----------------------------------------------------------------------------
// A field is one entry of a descriptor's `fields` map, in the vocabulary a person writes (`type:
// date`, `many: true`, `mirror_of: patient`). The verbs build that entry from flags, place it in the
// source that declares it, and write it through the YAML document, so every comment and every
// untouched byte stays where its author put it.

/** The order a field's keys are written in (§3.4.1): facts about the data, `display`, then what it means. */
const FIELD_KEY_ORDER = [
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
]

/** `--type`: a built-in type, a collection, `a,b` for a union of collections, or `reference`. A
 *  collection may not be named after a built-in type (compile refuses it), so the two never collide. */
function parseType(store: Store, raw: unknown): Field["type"] {
  const known = `one of ${SCALAR_TYPES.join(" ")}, a collection name, or a,b for a union of collections`
  if (raw === true || raw === "") throw new Error(`--type takes a value — ${known}`)
  const parts = String(raw)
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
  if (parts.length > 1) {
    const bad = parts.filter(t => !store.descriptors.has(t))
    if (bad.length)
      throw new Error(
        `--type ${raw}: a union names collections, and ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not one — ${known}`
      )
    return parts
  }
  if (SCALAR_TYPES.includes(parts[0]) || store.descriptors.has(parts[0])) return parts[0]
  throw new Error(`unknown type "${parts[0]}" — ${known}`)
}

/** A boolean flag: bare or `true` turns it on; `false` or the empty value clears it. */
function flagOn(flags: Record<string, unknown>, key: string): boolean {
  const v = flags[key]
  if (v === true || v === "true") return true
  if (v === false || v === "false" || v === "") return false
  throw new Error(`--${key} takes true or false — got "${v}"`)
}

/** A flag that takes a value; the empty value (`--x=`) clears what it names. */
function flagText(flags: Record<string, unknown>, key: string): string {
  const v = flags[key]
  if (v === true) throw new Error(`--${key} takes a value (--${key}= clears it)`)
  return String(v)
}

/** A CLI default arrives as a string; which JSON value it becomes depends on the field's type. */
const coerceDefault = (type: Field["type"], def: unknown): unknown =>
  type === "boolean" ? def === "true" || def === true : type === "number" || type === "integer" ? Number(def) : def

/** `a,b,c` → the values, trimmed. */
const optionList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v).split(",")).map(x => String(x).trim()).filter(Boolean)

/**
 * One field, built from the flag vocabulary over `previous` — the field as its source declares it
 * (`{}` for a new one). Each flag owns the key it names and nothing else, so a flag that is not
 * passed leaves its key exactly as authored: `set-field --description "…"` changes the description
 * and only the description. The empty value clears a key (`--enum=`), and `false` clears a boolean.
 *
 *   --type string|markdown|…|<collection>|a,b|reference   --many   --required   --unique
 *   --enum a,b   --default-value v   --mirror-of <field>   --on-delete restrict|set-null   --soft
 *   --sensitive   --body   --description "…"
 */
export function fieldFromFlags(
  store: Store,
  flags: Record<string, unknown>,
  previous: Record<string, unknown> = {}
): Field {
  const f = structuredClone(previous ?? {}) as Field
  const has = (k: string): boolean => flags[k] !== undefined
  if (has("type")) f.type = parseType(store, flags.type)
  f.type ??= "string"
  for (const k of ["required", "many", "unique", "soft", "sensitive", "body"]) {
    if (!has(k)) continue
    if (flagOn(flags, k)) f[k] = true
    else delete f[k]
  }
  if (has("enum")) {
    const v = flagText(flags, "enum")
    if (v === "") delete f.enum
    else {
      const values = optionList(v)
      // a decorated enum keeps each surviving value's label, icon and colour
      f.enum =
        f.enum && typeof f.enum === "object" && !Array.isArray(f.enum)
          ? Object.fromEntries(values.map(x => [x, (f.enum as Record<string, Record<string, string>>)[x] ?? {}]))
          : values
    }
  }
  if (has("mirror-of")) {
    const v = flagText(flags, "mirror-of")
    if (v === "") delete f.mirror_of
    else {
      const t = targetsOf(f)
      if (!Array.isArray(t) || t.length !== 1)
        throw new Error(`--mirror-of ${v} needs --type <collection>: the one collection whose "${v}" field points here`)
      const fk = fieldsOf(store.descriptor(t[0]))[v]
      if (!fk) throw new Error(`--mirror-of ${v}: ${t[0]} has no field "${v}"`)
      f.mirror_of = v
      // the far side's key decides the cardinality: a unique scalar key is claimed by one record,
      // so its mirror holds one; any other key can be claimed by many
      if (!has("many")) {
        if (fk.unique && !fk.many) delete f.many
        else f.many = true
      }
    }
  }
  if (has("on-delete")) {
    const v = flags["on-delete"]
    if (v === "") delete f.on_delete
    else if (v === "restrict" || v === "set-null") f.on_delete = v
    else throw new Error("--on-delete takes restrict or set-null")
  }
  const def = flags["default-value"] ?? flags.default
  if (def !== undefined) {
    if (def === true) throw new Error("--default-value takes a value (--default-value= clears it)")
    if (def === "") delete f.default
    else f.default = f.many ? optionList(def).map(x => coerceDefault(f.type, x)) : coerceDefault(f.type, def)
  }
  if (has("description")) {
    const v = flagText(flags, "description")
    if (v === "") delete f.description
    else f.description = v
  }
  // what a flag can be held to before the gate compile, so the refusal names the flag
  if (f.body && f.type !== "markdown")
    throw new Error(`--body marks the field a record's prose lands in, so it is --type markdown (got ${f.type})`)
  if (has("enum") && f.enum !== undefined && f.type !== "string")
    throw new Error(`--enum belongs to --type string (got ${Array.isArray(f.type) ? f.type.join(",") : f.type})`)
  if (has("on-delete") && f.on_delete !== undefined && !targetsOf(f))
    throw new Error(`--on-delete belongs to a reference — give --type <collection>`)
  if (has("soft") && f.soft && !targetsOf(f))
    throw new Error(`--soft belongs to a reference — give --type <collection>`)
  return orderField((previous ?? {}) as Field, f)
}

/**
 * The field's keys in writing order: the keys the source already had stay where its author put
 * them, and a new key goes in at its canonical place among them — so `set-field --unique` adds one
 * line and moves none.
 */
function orderField(previous: Field, next: Field): Field {
  const rank = (k: string): number => {
    const i = FIELD_KEY_ORDER.indexOf(k)
    return i < 0 ? FIELD_KEY_ORDER.length : i
  }
  const keys = Object.keys(previous).filter(k => k in next)
  for (const k of Object.keys(next)
    .filter(x => !keys.includes(x))
    .sort((a, b) => rank(a) - rank(b))) {
    const at = keys.findIndex(x => rank(x) > rank(k))
    keys.splice(at < 0 ? keys.length : at, 0, k)
  }
  return Object.fromEntries(keys.map(k => [k, next[k]])) as Field
}
