/** A record layer: a workspace cloned under `git_modules/<name>` whose records this one reads. */
export interface Layer {
  name: string
  /** the collections it lends; absent, every collection both workspaces have */
  records?: string[]
  /** its records' folder, its own `data_path` */
  data: string
}
