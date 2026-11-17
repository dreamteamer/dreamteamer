import type { Collection } from "./Collection.ts"
import type { Issue } from "./Issue.ts"
import type { Module } from "./Module.ts"
import type { Skill } from "./Skill.ts"

/** The resolved workspace: what every adapter (CLI, harness instructions, UI) reads. Derived, reproducible. */
export interface Model {
  root: string
  modules: Module[]
  collections: Record<string, Collection>
  skills: Skill[]
  /** collections some module declares as optional peers */
  peers: string[]
  /** the records of the source kinds (collections, modules, skills …): kind → id → the file each is read from */
  sources: Record<string, Record<string, string>>
  /** ids another repo vouches for: collection → ids */
  exports: Record<string, string[]>
  issues: Issue[]
}
