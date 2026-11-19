import type { Descriptor } from "../../types.ts"
import { storageOf } from "../../record/storageOf.ts"
import { sourceHint } from "../../runtime/runtime.ts"
import type { Store } from "../Store.ts"

export function writableDescriptor(store: Store, collection: string): Descriptor {
  const d = store.descriptor(collection)
  if (storageOf(d).runtime) {
    // Two different runtime shapes, and pointing at the wrong one is worse than saying
    // nothing: a STAGED kind (skills, commands, ui-views…) really does have a source file
    // under `modules/<module>/<kind>/`, while a PROJECTED one (modules) has no such folder
    // and never should — its source is the module's package.json. `x-source` says which,
    // stated as data on the descriptor so the store never has to know what a module is.
    const from = sourceHint(d)
    throw new Error(`"${collection}" records are compiled sources — edit ${from} and run \`dreamteamer compile\``)
  }
  return d
}
