// shared record primitives — parsing, id patterns, error formatting — used by
// both the validating store (hard, write-time) and check (soft, report-only).
import fs from 'node:fs';
import path from 'node:path';
import { load } from './yaml.js';

export function parseRecord(file, d, bodyField) {
	return parseRecordText(fs.readFileSync(file, 'utf8'), d, bodyField);
}

export function parseRecordText(text, d, bodyField) {
	const codec = d.storage.codec ?? 'md';
	if (codec === 'yaml') return load(text) ?? {};
	if (codec === 'json') return JSON.parse(text);
	let fields = {};
	let body = text;
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (m) {
		fields = load(m[1]) ?? {};
		body = text.slice(m[0].length);
	}
	if (bodyField && body.trim()) fields[bodyField] = body;
	return fields;
}

// id patterns may use unicode property escapes — compile with the u flag
export function patternRe(pattern) {
	try { return new RegExp(pattern, 'u'); } catch { return new RegExp(pattern); }
}

// ajv errors, humanized: echo the offending value (the one datum the reader needs)
export function fmtAjvError(e, fields) {
	const fieldPath = e.instancePath.slice(1).replace(/\//g, '.');
	const value = fieldPath ? fieldPath.split('.').reduce((v, k) => v?.[k], fields) : undefined;
	if (e.keyword === 'enum') return `field ${fieldPath}: "${value}" not in enum [${e.params.allowedValues.join(', ')}]`;
	return `field ${fieldPath || '(root)'}: ${JSON.stringify(value) ?? ''} ${e.message}`.trim();
}

// unknown keys relative to a schema that declares properties (typo detector)
export function unknownFields(schema, fields) {
	const props = schema?.properties ?? {};
	if (!Object.keys(props).length) return [];
	return Object.keys(fields).filter((k) => !(k in props));
}

// ---- shared reader primitives (review finding 11: walk/EXT existed 2-4×, diverging) ----

export const EXT = { md: '.md', yaml: '.yaml', json: '.json' };

/** The id a record file carries, or null when this path is not a record of `d`.
 *  `relPath` is relative to the collection's data directory.
 *
 *  THE ONLY PLACE a filename becomes an id. store, check and events each carried their own copy of
 *  `endsWith('.' + suffix + EXT[codec])`, which is three places to update and two to forget.
 *
 *  `codec: file` records are opaque bytes whose extension is whatever was imported, so their tail is
 *  `.<suffix>.<ONE extension segment>` — one, because `x.asset.tar.gz` in the folder is an archive
 *  someone dropped there, and calling it a record would hide it from `check`'s stray report. */
export function idFromRecordPath(d, relPath) {
	const suffix = d.storage.suffix;
	if ((d.storage.codec ?? 'md') === 'file') {
		const lit = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const m = new RegExp(`^(.+)\\.${lit}\\.[A-Za-z0-9]+$`).exec(relPath);
		return m ? m[1] : null;
	}
	const tail = `.${suffix}${EXT[d.storage.codec ?? 'md']}`;
	return relPath.endsWith(tail) ? relPath.slice(0, -tail.length) : null;
}

const JUNK_DIRS = new Set(['__pycache__', 'node_modules']);
const JUNK_FILE = /\.(pyc|pyo)$|^\.DS_Store$/;

// THE collection walk — junk-excluding everywhere (store/check used to see .pyc files
// compile deliberately skipped; one walk, one verdict).
export function* walk(dir) {
	for (const name of fs.readdirSync(dir).sort()) {
		if (name.startsWith('.') || JUNK_DIRS.has(name)) continue;
		if (JUNK_FILE.test(name)) continue;
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) yield* walk(p);
		else yield p;
	}
}

// ids are PATHS — but only downward ones. traversal segments, absolute paths and
// backslashes are rejected before any fs join (review finding 1: an escaping --id
// wrote a record outside the repo and orphaned others inside it).
export function assertSafeId(id) {
	if (typeof id !== 'string' || id === '') throw new Error(`invalid id "${id}" — nothing was written.`);
	if (id.startsWith('/') || id.includes('\\') || id.split('/').some((s) => s === '' || s === '.' || s === '..')) {
		throw new Error(`invalid id "${id}" — ids are relative paths, no "."/".." segments, no leading slash. nothing was written.`);
	}
}
