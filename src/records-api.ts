// The contract's shapes (src/types.ts) — the record half's. `dreamteamer` adds the workspace half's.
export type {
  Fields,
  Field,
  AuthoredDescriptor,
  Descriptor,
  DisplayBlock,
  Storage,
  Descriptors,
  Manifest,
  CommandRow,
  Presentation,
  PresentationChoice,
  PresentationComponentOptions,
  PresentationField,
  PresentationCollection,
  PresentationRelation,
} from "./types.ts"

/** Bumped on a breaking change to either public entry or to the extension contract. */
export const apiVersion = 1
export { engineVersion, engineId } from "./runtime.ts"

// ---- records ------------------------------------------------------------------------------------
export { Store, bodyField, serialize, atomicWrite } from "./store.ts"
export { parseRecord, parseRecordText, idFromRecordPath } from "./records.ts"
export { check } from "./check.ts"
export { commitPending, composeSubject } from "./commit.ts"
export { history, historyDiff } from "./history.ts"
export { deriveEvents } from "./events.ts"
export { relationsOf } from "./relations.ts"

// ---- values, references and queries ---------------------------------------------------------------
export { matchesFilter, unknownOperators, looseEq, KNOWN_OPERATORS } from "./filter.ts"
export { sortRows, compareValues } from "./temporal.ts"
export { distinctValues } from "./field-values.ts"
export { keyBetween, placementKey } from "./fractional-index.ts"
export { parseRef, normalizeNamespaces } from "./namespace.ts"
export { splitRef, canonicalCollection } from "./ref.ts"
export * from "./descriptor.ts"
export { slug, slugOrHash } from "./template.ts"
export { load as loadYaml, dump as dumpYaml } from "./yaml.ts"

// ---- the compiled runtime (the boundary both halves read) -------------------------------------
export { RUNTIME_DIR, runtimeDir, readManifest, loadDescriptors, namespaces } from "./runtime.ts"

// ---- read models a surface draws -------------------------------------------------------------------
export { presentation } from "./presentation.ts"
export { commandsFor, recordResolver } from "./record-commands.ts"
