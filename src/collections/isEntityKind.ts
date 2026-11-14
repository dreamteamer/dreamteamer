import { OWN_VERBS } from "./OWN_VERBS.ts"
import type { Store } from "../record/Store.ts"
import { storageOf } from "../record/storageOf.ts"

export const isEntityKind = (store: Store, collection: string): boolean =>
  storageOf(store?.descriptors.get(collection)).runtime && !OWN_VERBS.has(collection)
