// dreamteamer check — validate every record against the compiled descriptors.
// report-only: JSON Schema (ajv), id patterns, x-reference resolution, stray files.
// NEVER modifies a file. returns the number of violations.
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load } from './yaml.js';
import { parseRecord, patternRe, fmtAjvError, unknownFields, walk, EXT } from './records.js';

export function check({ root }) {
	const RUNTIME = path.join(root, '.dreamteamer');
	const rel = (p) => path.relative(root, p);

	// useDefaults matches the STORE's validator (review finding 11: the two paths could
	// reach different verdicts on identical bytes). check never writes — the defaults
	// materialize into the in-memory copy only.
	const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: 'array' });
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

	// parsed fields, kept for the symmetric-ref pass below (parse each record exactly once)
	const parsed = new Map();
	const inverseRules = [];   // [collection, fieldPath, targetCollection, inverseField]

	for (const [name, d] of descriptors) {
		const validate = ajv.compile(d.schema);
		const refFields = collectRefFields(d.schema);
		const bodyField = Object.entries(d.schema.properties ?? {}).find(([, s]) => s?.['x-body'])?.[0];
		parsed.set(name, new Map());
		for (const [fieldPath, target, inverse] of refFields) {
			if (inverse) inverseRules.push([name, fieldPath, target, inverse]);
		}

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
			parsed.get(name).set(id, fields);
		}
	}

	// ---- symmetric references (x-inverse) --------------------------------------------
	// A two-way link is redundant state, and redundant state drifts. Filters resolve OUTBOUND refs
	// only, so some predicates are only expressible from one side and both directions have to exist
	// — which makes an invariant mandatory, not optional. `x-inverse` on a ref field names the field
	// on the target that must point back; a one-sided link is a violation on the side that is missing.
	for (const [name, fieldPath, target, inverse] of inverseRules) {
		for (const [id, fields] of parsed.get(name)) {
			const self = `${name}/${id}`;
			for (const value of valuesAt(fields, fieldPath)) {
				if (typeof value !== 'string' || value.startsWith('@')) continue;
				const targetId = value.slice(value.indexOf('/') + 1);
				const targetFields = parsed.get(target)?.get(targetId);
				if (!targetFields) continue;                       // already flagged as dangling
				const back = [...valuesAt(targetFields, [inverse])];
				if (!back.includes(self)) {
					flag(index.get(target).get(targetId),
						`${inverse}: must point back to "${self}" (${self} declares ${fieldPath.join('.')}: ${value})`);
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


// collect [fieldPath, targetCollection, inverseField] for every x-reference in the schema.
// `x-inverse` names the field on the TARGET collection that must point back — see checkSymmetry.
function collectRefFields(schema, prefix = []) {
	const out = [];
	for (const [key, s] of Object.entries(schema.properties ?? {})) {
		if (!s || typeof s !== 'object') continue;
		const p = [...prefix, key];
		if (s['x-reference']) out.push([p, s['x-reference'], s['x-inverse']]);
		if (s.items?.['x-reference']) out.push([p, s.items['x-reference'], s['x-inverse'] ?? s.items['x-inverse']]);
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

