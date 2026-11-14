import path from "node:path"
import { storageOf } from "./storageOf.ts"
import type { Under } from "./types.ts"
import type { Descriptor } from "../types.ts"

/** A descriptor's resolved `storage.under` — `{ parent, subfolder, collection, id }` — or null. */
export function placementOf(d: Descriptor | null | undefined): Under | null {
  return d ? (storageOf(d).under ?? null) : null
}

/** `storage.under.id: nested` — the id BEGINS with the parent's id, and the file drops that segment
 *  because the parent's folder already carries it. Changing the parent is a rename. */
export const isNested = (under: Under | null | undefined): boolean => under?.id === "nested"

/** The parent id a NESTED id begins with. */
export const parentOfNestedId = (id: string): string => String(id).split("/")[0]

/** A nested id without its leading parent segment — the path inside the parent's subfolder. */
export const localOfNestedId = (id: string): string => String(id).slice(String(id).indexOf("/") + 1)

/** The folder a placed record of `d` lives in when its owner is `parentId` — or the fallback root. */
export function placedRoot(under: Under, fallbackDir: string, parentDir: string, parentId: string | null): string {
  return parentId ? path.join(parentDir, parentId, under.subfolder) : fallbackDir
}
