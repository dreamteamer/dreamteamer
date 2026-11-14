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
} from "./lib/types.ts"

/** Bumped on a breaking change to either public entry or to the extension contract. */
export const apiVersion = 1
export { engineVersion, engineId } from "./lib/runtime.ts"

// ---- records ------------------------------------------------------------------------------------
export { Store, bodyField, serialize, atomicWrite } from "./lib/store.ts"
export { parseRecord, parseRecordText, idFromRecordPath } from "./lib/records.ts"
export { check } from "./check.ts"
export { commitPending, composeSubject } from "./commit.ts"
export { history, historyDiff } from "./lib/history.ts"
export { deriveEvents } from "./lib/events.ts"
export { relationsOf } from "./lib/relations.ts"

// ---- values, references and queries ---------------------------------------------------------------
export { matchesFilter, unknownOperators, looseEq, KNOWN_OPERATORS } from "./lib/filter.ts"
export { sortRows, compareValues } from "./lib/temporal.ts"
export { distinctValues } from "./lib/field-values.ts"
export { keyBetween, placementKey } from "./lib/fractional-index.ts"
export { parseRef, normalizeNamespaces } from "./lib/namespace.ts"
export { splitRef, canonicalCollection } from "./lib/ref.ts"
export * from "./lib/descriptor.ts"
export { slug, slugOrHash } from "./lib/template.ts"
export { load as loadYaml, dump as dumpYaml } from "./lib/yaml.ts"

// ---- the compiled runtime (the boundary both halves read) -------------------------------------
export { RUNTIME_DIR, runtimeDir, readManifest, loadDescriptors, namespaces } from "./lib/runtime.ts"

// ---- read models a surface draws -------------------------------------------------------------------
export { presentation } from "./lib/presentation.ts"
export { commandsFor, recordResolver } from "./lib/record-commands.ts"
