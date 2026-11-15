import type { Descriptor, Fields } from "../../types.ts"
import { unknownFields, fmtAjvError } from "../../record/records.ts"
import { normalizeRecord } from "./normalizeRecord.ts"
import { jsonSchemaOf } from "../../record/descriptor.ts"
import type { Store } from "../Store.ts"
import { mirrorRemedy } from "./mirrorRemedy.ts"

export function validate(
  store: Store,
  d: Descriptor,
  fields: Fields,
  { skipRefs = false }: { skipRefs?: boolean } = {}
): Fields {
  // hard at the tools includes UNKNOWN fields: a typo'd key must never land on disk
  const unknown = unknownFields(d, fields)
  if (unknown.length)
    throw new Error(`unknown field(s) for this collection: ${unknown.join(", ")} — nothing was written.`)
  // BEFORE ajv, and deliberately inside validate() rather than in each verb: this is the one
  // choke point add/set/revert all pass through, so `--starts "2026-07-28 12:00"` from a CLI
  // session and a `datetime-local` widget's `2026-07-28T12:00` reach disk as the same
  // canonical, offset-carrying value. ajv's `date-time` accepts exactly one spelling; without
  // this every human-shaped input is a validation error (see src/temporal.ts).
  normalizeRecord(jsonSchemaOf(d), fields)
  // qualifyBareRefs must ALSO run before the validator below, for the same "one choke
  // point" reason but a different consequence: `validate(fields)` is what triggers useDefaults,
  // materializing any schema `default:` onto `fields` for the first time — a bare value sitting
  // in a single-target ref field's `default:` is never seen by qualifyBareRefs and would reach
  // checkRefs unqualified, failing as malformed rather than as the dangling reference it should
  // read as. In practice no shipped descriptor defaults a ref field, so this is latent, not hit.
  store.qualifyBareRefs(d, fields)
  const validate = store.ajv.compile(jsonSchemaOf(d)) // useDefaults mutates: defaults materialize
  if (!validate(fields)) {
    const msgs = validate.errors.map(e => "  " + fmtAjvError(e, fields))
    // The remedy line, when the cause is a generated mirror — see mirrorRemedy below.
    const remedy = mirrorRemedy(
      d,
      validate.errors.map(e => e.instancePath.split("/")[1])
    )
    throw new Error(`validation failed:\n${msgs.join("\n")}${remedy}\nnothing was written.`)
  }
  if (!skipRefs) store.checkRefs(d, fields)
  return fields
}
