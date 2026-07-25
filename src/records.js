// shared record primitives — parsing, id patterns, error formatting — used by
// both the validating store (hard, write-time) and check (soft, report-only).
import fs from 'node:fs';
import { load } from './yaml.js';

export function parseRecord(file, d, bodyField) {
	const text = fs.readFileSync(file, 'utf8');
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
