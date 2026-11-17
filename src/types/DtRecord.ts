export interface DtRecord {
  /** `<collection>/<id>` */
  ref: string
  collection: string
  id: string
  /** the absolute path of the file */
  path: string
  /** the frontmatter fields, and the body field */
  data: Record<string, unknown>
  mtimeMs: number
  /** things the writer should be told (an id that is a hash, not a name) */
  warnings?: string[]
}
