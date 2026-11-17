import { DtError } from "../lib/DtError.ts"
import { asEnum } from "../lib/asEnum.ts"
import { asFlag } from "../lib/asFlag.ts"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { asStrings } from "../lib/asStrings.ts"
import { isObject } from "../lib/isObject.ts"
import { kindOf } from "../lib/kindOf.ts"
import { messageOf } from "../lib/messageOf.ts"
import type { Field } from "../types/Field.ts"

/** a bound is acted on when it is a number, and ignored otherwise */
function bound(v: unknown) {
  return typeof v === "number" ? v : undefined
}

/** a field nested in an object or a map, which must have a type; a DtError says where it is wrong */
function inner(raw: unknown, where: string): Field {
  let f
  try {
    f = readField(raw)
  } catch (e) {
    throw new DtError(`${where}.${messageOf(e)}`)
  }
  if (!f) throw new DtError(`${where}: field has no type`)
  return f
}

/** an object's `fields`, each read as a field */
function fieldsOf(v: unknown) {
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) throw new DtError(`fields: expected a map of fields, found ${kindOf(v)}`)
  const out: Record<string, Field> = {}
  for (const [k, t] of Object.entries(v)) out[k] = inner(t, `fields.${k}`)
  return out
}

/**
 * A field as its descriptor wrote it, or null when it has no type. Every key keeps its value and its place; the keys
 * this engine acts on are read by type, an object's fields and a map's values among them, and a type, list or
 * pattern of the wrong kind is a DtError.
 */
export function readField(raw: unknown): Field | null {
  if (!isObject(raw) || !raw.type) return null
  const e = asOptional(raw.enum, "enum", asEnum)
  const values = raw.values
  // the descriptor's keys are open-ended, so they are copied as a whole rather than by name
  const f: Field = Object.assign({}, raw, {
    type: typeof raw.type === "string" ? raw.type : asStrings(raw.type, "type"),
    many: asFlag(raw.many),
    required: asFlag(raw.required),
    enum: e?.values,
    choices: e?.choices,
    pattern: asOptional(raw.pattern, "pattern", asString),
    minimum: bound(raw.minimum),
    maximum: bound(raw.maximum),
    minLength: bound(raw.minLength),
    maxLength: bound(raw.maxLength),
    soft: asFlag(raw.soft),
    body: asFlag(raw.body),
    mirror_of: asOptional(raw.mirror_of, "mirror_of", asString),
    unique: asFlag(raw.unique),
    fields: fieldsOf(raw.fields),
    values: typeof values === "string" ? { type: values } : asOptional(values, "values", inner),
  })
  return f
}
