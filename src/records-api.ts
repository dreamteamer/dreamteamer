// The RECORD half of the public API — `import … from 'dreamteamer/records'`. Records over git and the
// read models a surface draws, and nothing that knows modules, harnesses, extensions or the CLI.
//
// It exists as its own entry for ONE consumer with a hard constraint: the mobile app runs the Store
// unmodified in a browser over a virtual filesystem, with shims for `node:fs`, `node:path` and
// `node:child_process` and nothing else. The full API pulls in the compiler, the extension loader
// and the CLI, which reach for `node:url`, `node:crypto` and `node:os` at import time. This file's
// import closure is pinned to those three builtins by test/integration/public-api.test.js.
//
// `dreamteamer` (src/api.ts) re-exports everything here, so a node consumer never needs two imports.

/** Bumped on a breaking change to either public entry or to the extension contract. */
export const apiVersion = 1;
export { engineVersion, engineId } from './runtime.ts';

// ---- records ------------------------------------------------------------------------------------
export { Store, bodyField, serialize, atomicWrite } from './store.ts';
export { parseRecord, parseRecordText, idFromRecordPath } from './records.ts';
export { check } from './check.ts';
export { commitPending, composeSubject } from './commit.ts';
export { history, historyDiff } from './history.ts';
export { deriveEvents } from './events.ts';
export { relationsOf } from './relations.ts';

// ---- values, references and queries ---------------------------------------------------------------
export { matchesFilter, unknownOperators, looseEq, KNOWN_OPERATORS } from './filter.ts';
export { sortRows, compareValues } from './temporal.ts';
export { distinctValues } from './field-values.ts';
export { keyBetween, placementKey } from './fractional-index.ts';
export { parseRef, normalizeNamespaces } from './namespace.ts';
export { splitRef, canonicalCollection } from './ref.ts';
export * from './descriptor.ts';
export { slug, slugOrHash } from './template.ts';
export { load as loadYaml, dump as dumpYaml } from './yaml.ts';

// ---- the compiled runtime (the boundary both halves read) -------------------------------------
export { RUNTIME_DIR, runtimeDir, readManifest, loadDescriptors, namespaces } from './runtime.ts';

// ---- read models a surface draws -------------------------------------------------------------------
export { presentation } from './presentation.ts';
export { commandsFor, recordResolver } from './record-commands.ts';
