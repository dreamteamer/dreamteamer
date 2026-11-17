import { asArray } from "../lib/asArray.ts"
import { asFlag } from "../lib/asFlag.ts"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { asStrings } from "../lib/asStrings.ts"
import { isObject } from "../lib/isObject.ts"
import type { Field } from "../types/Field.ts"

/** a bound is acted on when it is a number, and ignored otherwise */
function bound(v: unknown) {
  return typeof v === "number" ? v : undefined
}

/**
 * A field as its descriptor wrote it, or null when it has no type. Every key keeps its value and its place; the keys
 * this engine acts on are read by type, and a type, list or pattern of the wrong kind is a DtError.
 */
export function readField(raw: unknown): Field | null {
  if (!isObject(raw) || !raw.type) return null
  // the descriptor's keys are open-ended, so they are copied as a whole rather than by name
  const f: Field = Object.assign({}, raw, {
    type: typeof raw.type === "string" ? raw.type : asStrings(raw.type, "type"),
    many: asFlag(raw.many),
    required: asFlag(raw.required),
    enum: asOptional(raw.enum, "enum", (v, where) => asArray(v, where, (t) => t)),
    pattern: asOptional(raw.pattern, "pattern", asString),
    minimum: bound(raw.minimum),
    maximum: bound(raw.maximum),
    minLength: bound(raw.minLength),
    maxLength: bound(raw.maxLength),
    soft: asFlag(raw.soft),
    body: asFlag(raw.body),
    mirror_of: asOptional(raw.mirror_of, "mirror_of", asString),
  })
  return f
}
