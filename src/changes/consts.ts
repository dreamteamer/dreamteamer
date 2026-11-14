import { type EventType } from "./types.ts"
import { type ChangeKind } from "../record/types.ts"

// ── the record-change report (0.42.0) ────────────────────────────────────────────────────────────
// What `dt changes` and `dt commit` print, and what a session appends to its reply after a write.
// A change is `{ collection, id, ref, path, repo, layer, change }` with `change` one of the three
// words the report uses; `deriveEvents`' `item-*` types are the same three facts, older spelling.
export const CHANGE_OF: Record<EventType, ChangeKind> = {
  "item-added": "created",
  "item-updated": "updated",
  "item-removed": "deleted",
}

export const TYPE_OF: Record<ChangeKind, EventType> = {
  created: "item-added",
  updated: "item-updated",
  deleted: "item-removed",
}
