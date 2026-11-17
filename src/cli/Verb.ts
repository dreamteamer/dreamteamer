import type { Collection } from "../types/Collection.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Model } from "../types/Model.ts"
import type { Workspace } from "../types/Workspace.ts"

/** One verb of the command line: how it is typed, what it takes, and what it does. */
export interface Verb {
  /** its line in the verb list, without the indent */
  usage: string
  /** the options it takes; `json` and `force` take no value */
  options: readonly string[]
  /** it takes `<field>=<value>` pairs and unknown `--<field>` options as fields */
  fields?: boolean
  run(a: Args): number | Promise<number>
}

/** A parsed command line, the workspace's model, and the helpers every verb shares. */
export interface Args {
  verb: string
  model: Model
  pos: string[]
  target: string | undefined
  extra: string[]
  opts: Record<string, string[]>
  fields: [string, string | undefined][]
  out: (v: unknown) => void
  /** the workspace with its extensions activated, loaded on first use: only the verbs that ask run module code */
  ws(): Promise<Workspace>
  /** the target, or a refusal naming what was wanted */
  wanted(what: string): string
  /** refuse positional arguments past the target and the first `n` after it */
  noExtra(n?: number): void
  /** refuse any positional argument */
  none(): void
  /** the collection a name or singular names, or a refusal that lists them */
  collectionOf(name: string): Collection
  /** print a written record and what its writer should be told */
  done(r: DtRecord): void
}
