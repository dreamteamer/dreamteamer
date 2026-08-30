// dreamteamer check — validate every record against the compiled descriptors.
// report-only: JSON Schema (ajv), id patterns, x-reference resolution, stray files.
// NEVER modifies a file. returns the number of violations.
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parseRecord, patternRe, fmtAjvError, unknownFields, walk, idFromRecordPath, MAX_RECORD_BYTES } from './records.js';
import { NO_RUNTIME, loadDescriptors, runtimeDir, namespaces as compiledNamespaces } from './runtime.js';
import { parseRef } from './namespace.js';
import { refTargetsOf } from './ref.js';
import { relationsOf, expectedMirrors } from './relations.js';

export function check({ root }) {
	const RUNTIME = runtimeDir(root);
	const rel = (p) => path.relative(root, p);

	// useDefaults matches the STORE's validator (review finding 11: the two paths could
	// reach different verdicts on identical bytes). check never writes — the defaults
	// materialize into the in-memory copy only.
	const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: 'array' });
	addFormats(ajv);
	ajv.addFormat('markdown', true); // rich-text marker, not a syntax to validate

	// ---- load compiled descriptors ------------------------------------------------
	const descriptors = loadDescriptors(root);
	if (!descriptors) {
		console.error(`✖ ${NO_RUNTIME}`);
		return 2;
	}
	// Off the manifest, like the descriptors themselves — `check` is in the record layer and must not
	// learn what a workspace package.json is (see the split in CLAUDE.md).
	const namespaces = compiledNamespaces(root);

	// ---- index all records: collection -> Map<id, filePath> ------------------------
	const index = new Map();
	const strays = [];
	// declared here rather than beside the validation pass: indexing can itself produce a
	// finding (an unreachable data root, below) before a single record is read.
	const violations = [];
	for (const [name, d] of descriptors) {
		const ids = new Map();
		index.set(name, ids);
		// runtime-based (knowhow/meta) collections are read from the COMPILED runtime —
		// their sources may live in any module; .dreamteamer is the merged read surface
		const dir = path.join(d.storage.base === 'runtime' ? RUNTIME : root, d.storage.path);
		// An unreachable data ROOT is a finding, not a skip: a collection whose module clone is
		// missing otherwise reports zero records and a clean check — a silent success. An EMPTY
		// directory stays fine (a module with no records yet is normal); only a missing owning
		// repo counts.
		const repoRoot = path.resolve(root, d.storage.repo ?? '.');
		if (!fs.existsSync(dir) && (d.storage.repo ?? '.') !== '.' && !fs.existsSync(repoRoot)) {
			violations.push({ file: d.storage.path, msg: `collection "${name}" is owned by ${d.storage.repo}, which is not present — every record in it is unreadable` });
			continue;
		}
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
			const opaque = (d.storage.codec ?? 'md') === 'file';
			const allowed = d.storage.extensions;                  // undefined = any
			const max = d.storage.max_bytes ?? MAX_RECORD_BYTES;
			for (const f of walk(dir)) {
				const id = idFromRecordPath(d, path.relative(dir, f));
				if (id === null) { strays.push({ collection: name, file: rel(f) }); continue; }
				// One id is one file. Under a fixed-extension codec this cannot happen; under `file` it
				// can, and picking one silently is how a replaced logo keeps rendering as its predecessor.
				if (ids.has(id)) {
					violations.push({ file: rel(f), msg: `collection "${name}" holds the id "${id}" twice — ${rel(ids.get(id))} and ${rel(f)}. Remove one.` });
					continue;
				}
				ids.set(id, f);
				if (!opaque) continue;
				const ext = path.extname(f).slice(1).toLowerCase();
				if (allowed && !allowed.includes(ext)) {
					violations.push({ file: rel(f), msg: `collection "${name}" does not accept .${ext} — its declared extensions are ${allowed.join(', ')}` });
				}
				const size = fs.statSync(f).size;
				if (size > max) {
					violations.push({ file: rel(f), msg: `is ${size} bytes, over collection "${name}"'s max_bytes of ${max} — a record is a small file; a big one belongs outside the vault` });
				}
			}
		}
	}

	// ---- validate each record -------------------------------------------------------
	const flag = (file, msg) => violations.push({ file: rel(file), msg });

	// parsed fields, kept for the relations pass below (parse each record exactly once)
	const parsed = new Map();
	const softRefs = new Map(); // absent-but-declared peer collection -> how many refs point at it

	for (const [name, d] of descriptors) {
		const validate = ajv.compile(d.schema);
		const refFields = collectRefFields(d.schema);
		const softTargets = d.unresolved_peers ? new Set(d.unresolved_peers) : null;
		const bodyField = Object.entries(d.schema.properties ?? {}).find(([, s]) => s?.['x-body'])?.[0];
		parsed.set(name, new Map());

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
					checkRef(file, fieldPath, value, target, softTargets);
				}
			}
			parsed.get(name).set(id, fields);
		}
	}

	// ---- relations: mirrors are DERIVED state ------------------------------------------
	// The owning side's foreign key is the truth; the mirror on the target is a cache of it, kept by
	// the store. So this is not a "do both sides agree" test between two equal authorities — check
	// recomputes what the owners imply and reports any mirror that has fallen behind. The fix is
	// therefore mechanical (`relations rebuild`), which is what the message says, rather than a
	// judgement call about which side is right.
	for (const rel of relationsOf(descriptors)) {
		const owners = [...(parsed.get(rel.owner) ?? [])].map(([id, fields]) => ({ id, fields }));
		const exp = expectedMirrors(rel, owners);

		// x-unique: the FK is one-to-one, so two owners naming one target is a conflict the mirror
		// physically cannot represent (it is a scalar) — reported on the SECOND claimant, where the
		// edit that has to change is.
		if (rel.unique) {
			const seen = new Map();
			for (const { id, fields } of owners) {
				const v = fields?.[rel.field];
				// a union FK yields one relation row per target collection; without this filter each
				// row would re-flag the same duplicate once per member.
				if (typeof v !== 'string' || !v.startsWith(`${rel.target}/`)) continue;
				if (seen.has(v)) flag(index.get(rel.owner).get(id), `${rel.field}: "${v}" is already taken by ${rel.owner}/${seen.get(v)} (x-unique)`);
				else seen.set(v, id);
			}
		}

		for (const [id, fields] of parsed.get(rel.target) ?? []) {
			const actual = fields?.[rel.mirror];
			const expected = exp.get(id);
			// a unique relation mirrors to a scalar, everything else to a sorted array — compare in
			// the shape the mirror is actually written in (absent and empty are the same reading).
			const same = rel.unique
				? (actual ?? null) === (expected ?? null)
				: JSON.stringify([...(actual ?? [])].sort()) === JSON.stringify(expected ?? []);
			if (!same) flag(index.get(rel.target).get(id), `${rel.mirror}: stale — run: dreamteamer relations rebuild ${rel.target}`);
		}
	}

	function checkRef(file, fieldPath, value, targets, softTargets) {
		if (typeof value !== 'string') return;
		if (value.startsWith('@')) return; // runtime tokens (@me, @initiator) are legal
		// The SAME parser the store writes through (src/namespace.js) — `check` disagreeing with the
		// write path about where a namespace ends would flag valid records and pass invalid ones.
		const ref = parseRef(value, namespaces);
		if (!ref) return flag(file, `${fieldPath.join('.')}: reference "${value}" is not <collection>/<id>`);
		const { collection: coll, id } = ref;
		if (targets !== '*' && !targets.includes(coll)) {
			const want = targets.length === 1 ? `collection "${targets[0]}"` : `one of: ${targets.join(', ')}`;
			return flag(file, `${fieldPath.join('.')}: reference "${value}" should target ${want}`);
		}
		if (!descriptors.has(coll)) {
			// A collection the owning module DECLARED as a peer and nothing installed provides is the
			// normal state of a module opened on its own — the reference is unresolvable, not wrong.
			// `unresolved_peers` is stamped by compile so this layer never has to know what a module
			// is (see the record/workspace split in CLAUDE.md).
			if (softTargets?.has(coll)) {
				softRefs.set(coll, (softRefs.get(coll) ?? 0) + 1);
				return;
			}
			return flag(file, `${fieldPath.join('.')}: reference "${value}" targets unknown collection "${coll}"`);
		}
		if (!index.get(coll).has(id)) return flag(file, `${fieldPath.join('.')}: dangling reference "${value}" — no such record`);
	}

	// ---- report ----------------------------------------------------------------------
	for (const s of strays) {
		console.log(`⚠ ${s.file} — unrecognized file in ${s.collection} folder${s.note ? ` (${s.note})` : ''}`);
	}
	// Warned, never silent: the references are real and currently resolve to nothing. This is the
	// expected reading when a module is opened without the workspace that provides the concept.
	for (const [coll, n] of [...softRefs].sort()) {
		console.log(`⚠ peer collection "${coll}" is declared but not installed — ${n} reference${n === 1 ? '' : 's'} unresolvable`);
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


// collect [fieldPath, targets] for every x-reference in the schema, where `targets` is '*' or the
// normalized array of declared collections (see refTargetsOf). Relations are NOT read here — they
// are decoded once, from the compiled descriptors, by src/relations.js.
function collectRefFields(schema, prefix = []) {
	const out = [];
	for (const [key, s] of Object.entries(schema.properties ?? {})) {
		if (!s || typeof s !== 'object') continue;
		const p = [...prefix, key];
		const targets = refTargetsOf(s);
		if (targets) out.push([p, targets]);
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

