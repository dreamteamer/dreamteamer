import type { Extension } from "./Extension.ts"

/** The released engine's workspace handle, which an extension's verbs and contributions are given */
export interface Workspace {
  root: string
  pkg: Record<string, unknown>
  extensions: Extension[]
}
