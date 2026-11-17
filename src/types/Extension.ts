import type { Workspace } from "./Workspace.ts"

/** A module's extension, activated: the contributions this engine acts on */
export interface Extension {
  name: string
  version: string
  dir: string
  /** the verbs it adds: `<verb> …` runs the function with the workspace and the arguments after the verb */
  commands: Record<string, (ws: Workspace, argv: string[]) => unknown>
  /** more issues for `check`: given `{ root, ws, dt }`, it returns (or resolves to) `[{ file, message, warning? }]` */
  check?: (ctx: object) => unknown
  /** lines about records for `next`: given `{ root, ws, collection, ids }`, it returns `[{ id, text }]` */
  next?: (ctx: object) => unknown
}
