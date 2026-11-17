import { asFlag } from "../lib/asFlag.ts"
import { asObject } from "../lib/asObject.ts"
import { asOptional } from "../lib/asOptional.ts"
import { asString } from "../lib/asString.ts"
import { asStrings } from "../lib/asStrings.ts"
import { isObject } from "../lib/isObject.ts"
import { readOr } from "../lib/readOr.ts"
import type { Descriptor } from "../types/Descriptor.ts"
import type { Issue } from "../types/Issue.ts"
import type { Module } from "../types/Module.ts"

/**
 * The parts of a descriptor the model is built from. A YAML document that is not a map reads as an empty
 * descriptor; a key of the wrong type is an error, and reads as absent.
 */
export function readDescriptor(doc: unknown, module: Module, file: string, issues: Issue[]): Descriptor {
  const d = isObject(doc) ? doc : {}
  function map(key: "storage" | "ids") {
    const v = d[key]
    return v === null ? null : readOr(issues, file, () => asOptional(v, key, asObject), undefined)
  }
  const res: Descriptor = {
    module,
    file,
    keys: Object.keys(d),
    name: readOr(issues, file, () => asOptional(d.name, "name", asString), undefined),
    overlay: asFlag(d.overlay) ?? false,
    singular: readOr(issues, file, () => asOptional(d.singular, "singular", asString), undefined),
    description: readOr(issues, file, () => asOptional(d.description, "description", asString), undefined),
    use_when: readOr(issues, file, () => asOptional(d.use_when, "use_when", asString), undefined),
    mixins: readOr(issues, file, () => asOptional(d.mixins, "mixins", asStrings) ?? [], []),
    storage: map("storage"),
    ids: map("ids"),
    fields: readOr(issues, file, () => asOptional(d.fields, "fields", asObject) ?? {}, {}),
  }
  return res
}
