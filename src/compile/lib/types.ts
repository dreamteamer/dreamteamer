import type { HarnessContext } from "../../types.ts"

/** What an extension's harness renderer returns: managed blocks by file (null removes one), and its summary. */
export interface HarnessOut {
  blocks?: Record<string, string | null>
  summary?: string
}

export type CollectionRow = HarnessContext["collections"][number] & { useWhen: string; write: string }

export type ModuleRow = HarnessContext["modules"][number] & {
  namespaces: string[]
  bin: string[]
  scripts: string[]
  skills: string[]
  commands: string[]
}

export interface Contributions {
  rendered: [id: string, out: HarnessOut][]
  paragraphs: string[]
}

/**
 * A compiled entry's YAML — a module record, a mixin, a command-binding, a skill's frontmatter — as far as
 * the harness surface reads it. Sources were validated by compile; this only names the keys used here.
 */
export interface EntryDoc {
  name?: string
  title?: string
  description?: string
  path?: string
  namespaces?: string[]
  bin?: string[]
  scripts?: string[]
  skills?: string[]
  collection?: string
  command?: string
  available_when?: unknown
  done_when?: unknown
  [k: string]: unknown
}

/** What a ui-view or command-binding check finds: `v1` when it is the old spelling (compile's own refusal). */
export interface ViewCheck {
  v1?: true
  errors: string[]
  warnings: string[]
}
