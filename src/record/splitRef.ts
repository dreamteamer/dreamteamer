import { words } from "./ref.ts"
import type { Descriptors } from "../types.ts"

/**
 * split "<collection>/<id>" against the DECLARED collections and their singulars — longest prefix
 * at a "/" boundary, because both collection names and ids may contain slashes (namespaces;
 * path-shaped ids). The collection returned is always the declared NAME, whichever word was typed.
 */
export function splitRef(descriptors: Descriptors, ref: string): { collection: string; id: string } {
  let best = null
  let bestName = null
  for (const [w, name] of words(descriptors)) {
    if (ref === w || ref.startsWith(w + "/")) {
      if (!best || w.length > best.length) {
        best = w
        bestName = name
      }
    }
  }
  if (!best)
    throw new Error(`unknown collection in reference "${ref}" (known: ${[...descriptors.keys()].sort().join(", ")})`)
  if (ref === best) throw new Error(`reference "${ref}" names a collection but no record id`)
  return { collection: bestName, id: ref.slice(best.length + 1) }
}
