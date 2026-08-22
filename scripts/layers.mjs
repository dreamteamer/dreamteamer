#!/usr/bin/env node
// The engine has two halves, and the edge between them only goes one way.
//
//   node scripts/layers.mjs     report the graph; exit 1 on a violation
//
// RECORD is schema-validated records over git: parse, validate, CRUD, refs, history, filters.
// WORKSPACE is the compiler and the agent-harness surface: modules, `extends`, skills, adapters.
// The seam is BOUNDARY (`runtime.js`) — the compiled `.dreamteamer/` artifact that one half writes
// and the other reads.
//
// WHY THIS IS A SCRIPT AND NOT A COMMENT: the edge was already almost absent — two imports, both
// reaching compile.js for a manifest read — and neither was there on purpose. An invariant nobody
// can violate by accident is worth having; one held up by good intentions gets re-added by the next
// person who needs a manifest in the store. This is deliberately NOT a package split: two packages
// would buy a distribution nobody has asked for and charge it to the extension's engine loader
// (decision 139). One repo, one enforced direction.
//
// An unclassified file under src/ is a FAILURE, not a default — adding one should cost the same
// sentence of thought that adding a core collection does.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const LAYERS = {
	// records over git — must not know that modules, channels or `extends` exist
	record: ['store', 'records', 'temporal', 'fractional-index', 'filter', 'field-values', 'commit', 'events', 'history', 'template', 'yaml', 'workspace', 'check', 'namespace', 'ref', 'env-vars'],
	// the compiled artifact both halves share
	boundary: ['runtime'],
	// the workspace compiler and the harness surface
	workspace: ['compile', 'harnesses', 'schema-ops', 'init', 'record-commands', 'semver'],
	// entry points; span both halves by definition (cli, http, descriptor→UI read model)
	surface: ['cli', 'collections-cli', 'server', 'presentation'],
};

// who may import whom. `record` and `boundary` are the constrained half; surfaces are free.
const ALLOWED = {
	record: new Set(['record', 'boundary']),
	boundary: new Set(['record', 'boundary']),
	workspace: new Set(['record', 'boundary', 'workspace']),
	surface: new Set(['record', 'boundary', 'workspace', 'surface']),
};

const layerOf = new Map();
for (const [layer, mods] of Object.entries(LAYERS)) for (const m of mods) layerOf.set(m, layer);

const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
const problems = [];

for (const f of files) {
	const mod = basename(f, '.js');
	const layer = layerOf.get(mod);
	if (!layer) {
		problems.push(`src/${f} is not assigned to a layer — add it to LAYERS in ${basename(fileURLToPath(import.meta.url))} and say which half it belongs to`);
		continue;
	}
	const body = readFileSync(join(SRC, f), 'utf8');
	// static `import … from './x.js'` and `export … from './x.js'` — the only cross-module
	// mechanism this codebase uses (no dynamic import inside src/).
	for (const m of body.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'\.\/([\w.-]+)\.js'/g)) {
		const target = m[1];
		const targetLayer = layerOf.get(target);
		if (!targetLayer) continue; // the missing-assignment failure is already reported on that file
		if (!ALLOWED[layer].has(targetLayer)) {
			problems.push(`src/${f} (${layer}) imports src/${target}.js (${targetLayer}) — ${layer} may only import ${[...ALLOWED[layer]].join(', ')}`);
		}
	}
}

for (const [layer, mods] of Object.entries(LAYERS)) {
	const missing = mods.filter((m) => !files.includes(`${m}.js`));
	if (missing.length) problems.push(`LAYERS.${layer} names ${missing.map((m) => `${m}.js`).join(', ')}, which no longer exist under src/ — drop them`);
	console.log(`${layer.padEnd(9)} ${mods.filter((m) => files.includes(`${m}.js`)).sort().join(' ')}`);
}

if (problems.length) {
	console.error(`\n✖ ${problems.length} layering problem${problems.length === 1 ? '' : 's'}:`);
	for (const p of problems) console.error(`    ${p}`);
	process.exit(1);
}
console.log(`\n✔ ${files.length} modules, no record → workspace imports`);
