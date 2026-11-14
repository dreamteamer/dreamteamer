import type { AuthoredDescriptor, Descriptor, Field } from "../types.ts"

/** One collection source as compile grouped it: the file, its parsed doc, and the module that ships it. */
export type DescriptorSource = { src: SourceRef; doc: AuthoredDescriptor; moduleName: string }

/** A record layer as compile reads it: the clone, its data folder, and the collections it narrows to (null: all). */
export type CompileLayer = {
  name: string
  root: string
  dataPath: string
  records: string[] | null
  /** set by compile: some collection here skips one of the layer's, so it is never read completely */
  skipsSome?: boolean
}

/** One collection compile resolved: the doc it writes, its resolved fields, its sources and storage facts. */
export type CompiledCollection = {
  doc: AuthoredDescriptor & { compiled?: Descriptor["compiled"] }
  resolved: Record<string, Field>
  sources: SourceRef[]
  compiled: Descriptor["compiled"]
  storage: {
    path: string
    format: string
    shape: string
    entry?: string
    under?: NonNullable<AuthoredDescriptor["storage"]>["under"]
    repo: string
    runtime: boolean
  }
}

/** A source file compile read: workspace-relative path and content hash (what staleness compares). */
export type SourceRef = { path: string; hash: string }
