// The PUBLIC API — `import … from 'dreamteamer'`. Everything a surface (the VS Code extension, the
// mobile app) or an extension (http, workflows, notebooklm) may call, and nothing else: package.json
// `exports` hides `src/*`, so an internal file can be split, renamed or deleted without a cross-repo
// break. That break used to be the rule — the extension imported fifteen internal files by path, and
// deleting one took `activate()` down before the tree view existed.
//
// Grouped by task. Each name is the ONE implementation of its operation; nothing here wraps or
// re-implements. `api.d.ts` beside this file is the typed contract, and a test pins the two together.
//
// Importing this module prints nothing, writes nothing, binds no port and touches no network.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as self from './api.js';
import { findWorkspace } from './workspace.js';
import { loadExtensions } from './extensions.js';
import { KINDS } from './compile.js';
import { DERIVED_KINDS } from './runtime.js';
import { KNOWN_HARNESSES } from './harnesses.js';
import { CORE_VERBS } from './cli.js';

// Everything the record half exports (the browser-safe entry, `dreamteamer/records`), then the rest.
export * from './records-api.js';

// ---- the workspace ------------------------------------------------------------------------------

/**
 * The workspace at (or above) `start`, with its declared extensions ACTIVATED against this engine.
 * The handle every other call takes: `{ root, pkg, extensions }`. Performs no compile, install,
 * network call or write, and never changes the process cwd.
 */
export async function openWorkspace(start = process.cwd()) {
	const ws = findWorkspace(start);
	ws.extensions = await loadExtensions(ws, self, { verbs: CORE_VERBS, kinds: [...KINDS, ...DERIVED_KINDS], harnesses: KNOWN_HARNESSES });
	return ws;
}
export { findWorkspace };
export { EXTENSION_API, declaredExtensions } from './extensions.js';

/** The engine's own CLI entry — what a tool spawns to run `dt` in another checkout. */
export const engineBin = fileURLToPath(new URL('../bin/dreamteamer.js', import.meta.url));
export const engineRoot = path.dirname(path.dirname(engineBin));

// ---- values the workspace half adds ---------------------------------------------------------------
export { envContext, renderTemplate, parseEnvValues } from './env-vars.js';
export { satisfies } from './semver.js';

// ---- the compiler, schema and module operations ---------------------------------------------------
export { compile, staleness, warnIfStale, discoverModules, CompileError, KINDS } from './compile.js';
export { MANAGED_BLOCKS } from './harnesses.js';
export {
	createCollection, removeCollection, renameCollection, moveCollection, setCollectionScalars,
	addField, updateField, removeField, removeFieldPlan, renameField, renameFieldPlan, fieldDef, statedKeywords,
	saveUiView, removeUiView,
	createModule, setModule, renameModule, removeModule,
	createSkill, refuseHandAuthored, removeEntity, renameEntity, setEntityFrontmatter,
} from './schema-ops.js';
export { init, ensureRepo, ensureAllRepos, listRepos, installClone } from './init.js';

// ---- the checkout: which one this is, and how it becomes ready ---------------------------------
export { describeCheckout, installCommand, resolveNpm, childEnv, readHookInput, readStdin } from './checkout.js';

// ---- CLI helpers an extension command reuses -----------------------------------------------------
export { emit, parseArgs } from './collections-cli.js';
