// dreamteamer check — validate every record against the compiled descriptors.
// report-only: JSON Schema (ajv), id patterns, x-reference resolution, stray files.
// NEVER modifies a file. returns the number of violations.
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load } from './yaml.js';
import { parseRecord, patternRe, fmtAjvError, unknownFields } from './records.js';

const EXT = { md: '.md', yaml: '.yaml', json: '.json' };

export function check({ root }) {
	const RUNTIME = path.join(root, '.dreamteamer');
	const rel = (p) => path.relative(root, p);

	const ajv = new Ajv({ allErrors: true, strict: false });
	addFormats(ajv);
	ajv.addFormat('markdown', true); // rich-text marker, not a syntax to validate

	// ---- load compiled descriptors ------------------------------------------------
	const descDir = path.join(RUNTIME, 'system', 'collections');
	if (!fs.existsSync(descDir)) {
		console.error('✖ no compiled runtime — run `dreamteamer compile` first');
		return 2;
	}
	const descriptors = new Map();
	for (const f of fs.readdirSync(descDir).sort()) {
		if (!f.endsWith('.collection.yaml')) continue;
		const d = load(fs.readFileSync(path.join(descDir, f), 'utf8'));
		descriptors.set(d.name, d);
	}

	// ---- index all records: collection -> Map<id, filePath> ------------------------
	const index = new Map();
	const strays = [];
	for (const [name, d] of descriptors) {
		const ids = new Map();
		index.set(name, ids);
		// system-stored (knowhow/meta) collections are read from the COMPILED runtime —
		// their sources may live in any module; .dreamteamer is the merged read surface
		const dir = d.storage.path.startsWith('system/')
			? path.join(RUNTIME, d.storage.path)
			: path.join(root, d.storage.path);
		if (!fs.existsSync(dir)) continue;
		const shape = d.storage.shape ?? 'file';
		if (shape === 'folder') {
			for (const entry of fs.readdirSync(dir).sort()) {
				if (entry.startsWith('.')) continue;
				const p = path.join(dir, entry);
				if (!fs.statSync(p).isDirectory()) { strays.push({ collection: name, file: rel(p) }); continue; }
				const main = path.join(p, d.storage.entry ?? 'SKILL.md');
				if (fs.existsSync(main)) ids.set(entry, main);
				else strays.push({ collection: name, file: rel(p), note: `missing entry file ${d.storage.entry}` });
			}
		} else {
			const tail = `.${d.storage.suffix}${EXT[d.storage.codec ?? 'md']}`;
			for (const f of walk(dir)) {
				const r = path.relative(dir, f);
				if (r.endsWith(tail)) ids.set(r.slice(0, -tail.length), f);
				else strays.push({ collection: name, file: rel(f) });
			}
		}
	}

	// ---- validate each record -------------------------------------------------------
	const violations = [];
	const flag = (file, msg) => violations.push({ file: rel(file), msg });

	for (const [name, d] of descriptors) {
		const validate = ajv.compile(d.schema);
		const refFields = collectRefFields(d.schema);
		const bodyField = Object.entries(d.schema.properties ?? {}).find(([, s]) => s?.['x-body'])?.[0];

		for (const [id, file] of index.get(name)) {
			if (d.id?.pattern && !patternRe(d.id.pattern).test(id)) {
				flag(file, `id "${id}" does not match pattern ${d.id.pattern}`);
			}
			let fields;
			try {
				fields = parseRecord(file, d, bodyField);
			} catch (e) {
				flag(file, `parse error: ${e.message}`);
				continue;
			}
			if (!validate(fields)) {
				for (const err of validate.errors) flag(file, fmtAjvError(err, fields));
			}
			for (const k of unknownFields(d.schema, fields)) {
				flag(file, `unknown field "${k}" (not in the ${name} schema)`);
			}
			for (const [fieldPath, target] of refFields) {
				for (const value of valuesAt(fields, fieldPath)) {
					checkRef(file, fieldPath, value, target);
				}
			}
		}
	}

	function checkRef(file, fieldPath, value, target) {
		if (typeof value !== 'string') return;
		if (value.startsWith('@')) return; // runtime tokens (@me, @initiator) are legal
		const slash = value.indexOf('/');
		if (slash < 1) return flag(file, `${fieldPath.join('.')}: reference "${value}" is not <collection>/<id>`);
		const coll = value.slice(0, slash);
		const id = value.slice(slash + 1);
		if (target !== '*' && coll !== target) {
			return flag(file, `${fieldPath.join('.')}: reference "${value}" should target collection "${target}"`);
		}
		if (!descriptors.has(coll)) return flag(file, `${fieldPath.join('.')}: reference "${value}" targets unknown collection "${coll}"`);
		if (!index.get(coll).has(id)) return flag(file, `${fieldPath.join('.')}: dangling reference "${value}" — no such record`);
	}

	// ---- report ----------------------------------------------------------------------
	for (const s of strays) {
		console.log(`⚠ ${s.file} — unrecognized file in ${s.collection} folder${s.note ? ` (${s.note})` : ''}`);
	}
	if (violations.length === 0) {
		console.log(`✔ 0 violations (${[...index.values()].reduce((n, m) => n + m.size, 0)} records across ${descriptors.size} collections)`);
		return 0;
	}
	let last = null;
	for (const v of violations) {
		if (v.file !== last) console.log(`✖ ${v.file}`);
		console.log(`    ${v.msg}`);
		last = v.file;
	}
	console.log(`${violations.length} violation${violations.length === 1 ? '' : 's'}. files were NOT modified.`);
	return 1;
}


// collect [fieldPath, targetCollection] for every x-reference in the schema
function collectRefFields(schema, prefix = []) {
	const out = [];
	for (const [key, s] of Object.entries(schema.properties ?? {})) {
		if (!s || typeof s !== 'object') continue;
		const p = [...prefix, key];
		if (s['x-reference']) out.push([p, s['x-reference']]);
		if (s.items?.['x-reference']) out.push([p, s.items['x-reference']]);
		if (s.properties) out.push(...collectRefFields(s, p));
		if (s.items?.properties) out.push(...collectRefFields(s.items, p));
	}
	return out;
}

// yield all leaf values at a field path (flattening arrays)
function* valuesAt(obj, fieldPath) {
	let vals = [obj];
	for (const key of fieldPath) {
		vals = vals
			.flatMap((v) => (Array.isArray(v) ? v : [v]))
			.flatMap((v) => (v && typeof v === 'object' ? [v[key]] : []));
	}
	for (const v of vals.flat(Infinity)) if (v != null) yield v;
}

function* walk(dir) {
	for (const name of fs.readdirSync(dir).sort()) {
		if (name.startsWith('.')) continue;
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) yield* walk(p);
		else yield p;
	}
}
