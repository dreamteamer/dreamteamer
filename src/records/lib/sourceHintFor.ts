import { Store } from "../../record/Store.ts"
import { storageOf } from "../../record/storageOf.ts"

/** The path `revert`'s refusal names — where a human edits this compiled entity. */
export function sourceHintFor(store: Store, collection: string) {
  // ⚠ `modules` is the one system collection that is PROJECTED rather than stored as a kind folder:
  // its source is each module's package.json. Deriving the hint from `storage.path` gave
  // `modules/*/modules/`, which `git ls-files` matches nothing at all — a correct refusal handing
  // over an unusable remedy.
  if (collection === "modules") return "modules/*/package.json"
  return `modules/*/${storageOf(store.descriptors.get(collection)).path ?? collection}/`
}
