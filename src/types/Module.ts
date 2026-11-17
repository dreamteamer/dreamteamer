/** One installed package (or local folder) that carries a `dreamteamer` key in its package.json. Read-only input. */
export interface Module {
  name: string
  version: string
  dir: string
  origin: "npm" | "workspace" | "engine"
  title?: string
  namespaces: string[]
  dependencies: string[]
  /** collections this module may reference without requiring them (`peer_collections`) */
  peers: string[]
  /** its extension's entry, relative to its folder (`dreamteamer.extension`) */
  extension?: string
  /** contract elements this engine saw but does not implement (extension, nav, setup, …) */
  unsupported: string[]
}
