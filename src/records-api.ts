// The RECORD half of the public API — `import … from 'dreamteamer/records'`. Records over git and the
// read models a surface draws, and nothing that knows modules, harnesses, extensions or the CLI.
//
// It exists as its own entry for ONE consumer with a hard constraint: the mobile app runs the Store
// unmodified in a browser over a virtual filesystem, with shims for `node:fs`, `node:path` and
// `node:child_process` and nothing else. The full API pulls in the compiler, the extension loader
// and the CLI, which reach for `node:url`, `node:crypto` and `node:os` at import time. This file's
// import closure is pinned to those three builtins by test/integration/public-api.test.ts.
//
// `dreamteamer` (src/api.js) re-exports everything here, so a node consumer never needs two imports.

/** Bumped on a breaking change to either public entry or to the extension contract. */
export const apiVersion = 1 as const
export { engineVersion, engineId } from "./lib/runtime.ts"

// ---- records ------------------------------------------------------------------------------------
export { Store, bodyField, serialize, atomicWrite } from "./lib/store.ts"
export { parseRecord, parseRecordText, idFromRecordPath } from "./lib/records.ts"
export { check } from "./commands/check.ts"
export { commitPending, composeSubject } from "./commands/commit.ts"
export { history, historyDiff } from "./commands/history.ts"
export { deriveEvents } from "./commands/events.ts"
export { relationsOf } from "./lib/relations.ts"

// ---- values, references and queries ---------------------------------------------------------------
export { matchesFilter, unknownOperators, looseEq, KNOWN_OPERATORS } from "./lib/filter.ts"
export { sortRows, compareValues } from "./lib/temporal.ts"
export { distinctValues } from "./commands/field-values.ts"
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
