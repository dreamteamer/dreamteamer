import type { Descriptor } from "../../types.ts"
import { storageOf } from "../../record/storageOf.ts"
import { EXT } from "../../record/consts.ts"

/** `<id>.<suffix>.<ext>` — the filename of a text record, wherever its root is. */
export function recordFileName(d: Descriptor, id: string): string {
  return `${id}.${storageOf(d).suffix}${EXT[storageOf(d).format]}`
}
