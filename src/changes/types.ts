export type EventType = "item-added" | "item-updated" | "item-removed"

/** One pending record file `git status` reported, mapped back to its record. */
export interface Row {
  verb: string
  collection: string
  id: string
  repoRel: string
  fromRel: string | null
}

export type ChangeKind = "created" | "updated" | "deleted"

/** One record's change, keyed by `ref` per `repo` — the shape `foldChanges` folds and `groupChanges` groups. */
export interface RecordChange {
  collection: string
  id: string
  ref: string
  repo: string
  change: ChangeKind
  path?: string
}

export interface ChangeGroup<T extends RecordChange = RecordChange> {
  collection: string
  created: number
  updated: number
  deleted: number
  records: T[]
}
