// The released engine's API, version 1, over this engine: what the protocol host, the web module and extensions load
// as `<engine>/src/api.js`. A plain JavaScript entry, because a host imports this exact file; Node strips the types
// of the files it imports only outside node_modules, so the engine is installed as a link or a git_modules clone.
// Adapter exception to the house style: this file only re-exports, by the released API's names.
import { accessors } from "./api/accessors.ts"
import { extensionShims } from "./api/extensionShims.ts"
import { shims } from "./api/shims.ts"

export const apiVersion = 1
export { Store } from "./api/Store.ts"
export { CompileError } from "./api/CompileError.ts"
export { findWorkspace, openWorkspace } from "./api/openWorkspace.ts"
export { parseRef } from "./api/parseRef.ts"
export { presentation } from "./api/presentation.ts"
export { matchesFilter, unknownOperators, looseEq, KNOWN_OPERATORS } from "./store/matchesFilter.ts"
export { compareValues } from "./lib/compareValues.ts"
export { sortRows } from "./api/sortRows.ts"
export { recordResolver, commandsFor } from "./api/commandsFor.ts"
export { distinctValues } from "./api/distinctValues.ts"
export { envContext, renderTemplate, parseEnvValues } from "./api/renderTemplate.ts"
export { readManifest, staleness } from "./api/readManifest.ts"
export { history, historyDiff } from "./api/history.ts"
export { placementKey } from "./api/placementKey.ts"
export { commitPending } from "./api/commitPending.ts"
export { slug } from "./lib/slug.ts"
export { slugOrHash } from "./lib/slugOrHash.ts"
export const { engineVersion, namespaces, loadDescriptors, bodyField, parseRecordText, warnIfStale, emit } = shims
export const { engineBin, parseArgs, splitRef, check, compile, CHECK_WARNINGS } = extensionShims
export const {
  fieldsOf,
  storedFieldsOf,
  bodyFieldOf,
  positionFieldOf,
  requiredOf,
  targetsOf,
  mirrorOf,
  titleOf,
  recordTitleOf,
  idsOf,
  storageOf,
  isRuntime,
  isInternal,
  isSensitive,
  isBinary,
  displayOf,
  moduleOf,
  overlaidByOf,
  unresolvedPeersOf,
  jsonSchemaOf,
} = accessors
