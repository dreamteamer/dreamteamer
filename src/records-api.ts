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
export { engineVersion, engineId } from "./runtime/runtime.ts"

// ---- records ------------------------------------------------------------------------------------
export { Store } from "./record/Store.ts"
export { bodyField } from "./record/bodyField.ts"
export { serialize } from "./record/serialize.ts"
export { atomicWrite } from "./lib/atomicWrite.ts"
export { parseRecord } from "./record/records.ts"
export { parseRecordText } from "./record/parseRecordText.ts"
export { idFromRecordPath } from "./record/idFromRecordPath.ts"
export { check } from "./check/check.ts"
export { commitPending } from "./changes/commitPending.ts"
export { composeSubject } from "./changes/composeSubject.ts"
export { history } from "./records/history.ts"
export { historyDiff } from "./records/historyDiff.ts"
export { deriveEvents } from "./changes/deriveEvents.ts"
export { relationsOf } from "./record/relationsOf.ts"

// ---- values, references and queries ---------------------------------------------------------------
export { matchesFilter } from "./records/lib/matchesFilter.ts"
export { unknownOperators } from "./record/unknownOperators.ts"
export { looseEq } from "./records/lib/looseEq.ts"
export { KNOWN_OPERATORS } from "./record/consts.ts"
export { sortRows } from "./records/lib/sortRows.ts"
export { compareValues } from "./records/lib/compareValues.ts"
export { distinctValues } from "./records/distinctValues.ts"
export { keyBetween } from "./records/lib/keyBetween.ts"
export { placementKey } from "./records/lib/placementKey.ts"
export { parseRef } from "./record/parseRef.ts"
export { normalizeNamespaces } from "./record/normalizeNamespaces.ts"
export { splitRef } from "./record/splitRef.ts"
export { canonicalCollection } from "./record/ref.ts"
export {
  fieldsOf,
  storedFieldsOf,
  jsonSchemaOf,
  bodyFieldOf,
  positionFieldOf,
  requiredOf,
  targetsOf,
  isSoft,
  mirrorOf,
  titleOf,
  singularOf,
  recordTitleOf,
  idsOf,
  isRuntime,
  isInternal,
  isSensitive,
  isBinary,
  moduleOf,
  overlaidByOf,
  unresolvedPeersOf,
  mirrorsOf,
} from "./record/descriptor.ts"
export { storageOf } from "./record/storageOf.ts"
export { displayOf } from "./record/displayOf.ts"
export { slug, slugOrHash } from "./record/template.ts"
export { load as loadYaml, dump as dumpYaml } from "./lib/yaml.ts"

// ---- the compiled runtime (the boundary both halves read) -------------------------------------
export { runtimeDir, readManifest, namespaces } from "./runtime/runtime.ts"
export { RUNTIME_DIR } from "./runtime/consts.ts"
export { loadDescriptors } from "./runtime/loadDescriptors.ts"

// ---- read models a surface draws -------------------------------------------------------------------
export { presentation } from "./record/presentation.ts"
export { commandsFor } from "./records/commandsFor.ts"
export { recordResolver } from "./records/lib/recordResolver.ts"
