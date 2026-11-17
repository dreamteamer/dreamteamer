/**
 * One field of a collection as its descriptor wrote it: the keys this engine acts on are read by type, and every
 * other key is carried as written.
 */
export interface Field {
  /** a scalar name, a collection name, or a list of collection names (a reference to any of them) */
  type: string | string[]
  many?: boolean
  required?: boolean
  default?: unknown
  /** the allowed values; a descriptor may write them as a list or as a map */
  enum?: unknown[]
  /** how each value is shown, when the enum was written as a map: value → `label`, `color`, `icon` … */
  choices?: Record<string, unknown>
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  /** a reference that need not resolve */
  soft?: boolean
  /** the field that is the text below a Markdown record's frontmatter */
  body?: boolean
  /** the generated reverse side of another field; neither produced nor validated here */
  mirror_of?: string
  /** no two records of the collection hold one value of it; a list field is never unique */
  unique?: boolean
  /** an object's own fields */
  fields?: Record<string, Field>
  /** what every value of a map is; a type written alone is read as `{ type }` */
  values?: Field
  [key: string]: unknown
}
