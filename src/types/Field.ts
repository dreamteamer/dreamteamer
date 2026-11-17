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
  enum?: unknown[]
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
  [key: string]: unknown
}
