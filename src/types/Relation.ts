/** A reverse field: `mirror` on records of `target` lists (or, when `unique`, names) the `owner` records whose `field` points at them. */
export interface Relation {
  owner: string
  field: string
  target: string
  mirror: string
  /** the owner field holds a list */
  list: boolean
  /** the owner field is one-to-one, so the mirror is a single reference */
  unique: boolean
}
