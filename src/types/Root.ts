/** A folder a collection's records are read from, each file's path there being its id. */
export interface Root {
  dir: string
  /** the record whose folder lends it, for a collection stored under its owners */
  parent?: string
  /** the record layer that lends it */
  layer?: string
}

/** A record's file, and the folder it was found in. */
export interface RecordFile {
  path: string
  root: Root
}
