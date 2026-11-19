import type { Descriptor } from "../../types.ts"
import { displayOf } from "../../record/displayOf.ts"

/** `id` first, then the descriptor's own columns — the shape every text listing prints. */
export const listColumns = (d: Descriptor): string[] => [
  "id",
  ...(displayOf(d).list?.columns ?? []).map(c => (c === "last_modified" ? "last-modified" : c)).filter(c => c !== "id"),
]
