// The RECORD half of the public API — `import … from 'dreamteamer/records'`. Records over git and the
// read models a surface draws, and nothing that knows modules, harnesses, extensions or the CLI.
//
// It exists as its own entry for ONE consumer with a hard constraint: the mobile app runs the Store
// unmodified in a browser over a virtual filesystem, with shims for `node:fs`, `node:path` and
// `node:child_process` and nothing else. The full API pulls in the compiler, the extension loader
// and the CLI, which reach for `node:url`, `node:crypto` and `node:os` at import time. This file's
// import closure is pinned to those three builtins by test/integration/public-api.test.js.
//
// `dreamteamer` (src/api.js) re-exports everything here, so a node consumer never needs two imports.

/** Bumped on a breaking change to either public entry or to the extension contract. */
export const apiVersion = 1;
export { engineVersion, engineId } from './runtime.js';

// ---- records ------------------------------------------------------------------------------------
export { Store, bodyField, serialize, atomicWrite } from './store.js';
export { parseRecord, parseRecordText, idFromRecordPath } from './records.js';
export { check } from './check.js';
export { commitPending, composeSubject } from './commit.js';
export { history, historyDiff } from './history.js';
export { deriveEvents } from './events.js';
export { relationsOf } from './relations.js';

// ---- values, references and queries ---------------------------------------------------------------
export { matchesFilter, unknownOperators, looseEq, KNOWN_OPERATORS } from './filter.js';
export { sortRows, compareValues } from './temporal.js';
export { distinctValues } from './field-values.js';
export { keyBetween, placementKey } from './fractional-index.js';
export { parseRef, normalizeNamespaces } from './namespace.js';
export { splitRef, canonicalCollection, refTargetsOf } from './ref.js';
export { slug, slugOrHash } from './template.js';
export { load as loadYaml, dump as dumpYaml } from './yaml.js';

// ---- the compiled runtime (the boundary both halves read) -------------------------------------
export { RUNTIME_DIR, runtimeDir, readManifest, loadDescriptors, namespaces } from './runtime.js';

// ---- read models a surface draws -------------------------------------------------------------------
export { presentation } from './presentation.js';
export { commandsFor, recordResolver } from './record-commands.js';
