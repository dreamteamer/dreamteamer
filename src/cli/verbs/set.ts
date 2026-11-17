import { DtError } from "../../lib/DtError.ts"
import { splitRef } from "../../model/splitRef.ts"
import { set as setRecord } from "../../store/set.ts"
import { fieldValues } from "../fieldValues.ts"
import type { Verb } from "../Verb.ts"

export const set: Verb = {
  usage: "set <ref> <field>=<value>…               an empty value clears a field",
  options: [],
  fields: true,
  run(a) {
    a.noExtra()
    const ref = a.wanted("a <collection>/<id> reference")
    const at = splitRef(a.model, ref, true)
    if (!at) throw new DtError(`${ref}: not a <collection>/<id> reference`)
    if (!a.fields.length) throw new DtError("nothing to set — give <field>=<value> pairs")
    a.done(setRecord(a.model, ref, fieldValues(a.model.collections[at.collection], a.fields)))
    return 0
  },
}
