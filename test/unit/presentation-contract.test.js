// Tier 1 — the display contract carries exactly the names of the design's display-contract table
// (descriptor format v2, §4.3), one word per meaning, and every one of them.
//
// Two directions, both on the clinic fixture, which exercises every key:
//   1. NOTHING UNLISTED. Every key presentation emits, at every depth, is a name in the table below. A
//      new key fails here until the table — and the design — name it.
//   2. NOTHING MISSING. Every name in the table is emitted somewhere, so a key the design promises
//      cannot quietly stop being produced.
//
// The table is copied from §4.3. Beside it: the row identifiers (`collection`, `field`, `type`) the
// table's rows are keyed by, and `many`, which the table omits but a surface cannot draw a list
// without (the wire type is the ITEM's type).
import { test, describe } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { presentation } from '../../src/presentation.js';
import { clinic } from '../helpers/clinic-compiled.js';

const CONTRACT = {
	top: ['collections', 'fields', 'relations'],
	collection: ['collection', 'title', 'nav', 'list', 'record', 'form', 'position_field', 'record_title', 'record_type', 'runtime', 'internal'],
	nav: ['icon', 'order', 'section'],
	list: ['layout', 'columns', 'sort', 'options'],
	record: ['layout', 'subtitle', 'badge', 'color_by', 'options'],
	form: ['sections'],
	section: ['title', 'fields'],
	field: [
		'collection', 'field', 'type', 'many',
		'title', 'description', 'required', 'kind', 'editable', 'hidden', 'role',
		'editor', 'editor_options', 'viewer', 'viewer_options', 'mirror_of', 'on_delete', 'unique', 'nullable', 'default',
		'unit', 'unit_field', 'direction', 'width', 'placeholder', 'form_section', 'deprecated', 'sensitive',
	],
	choice: ['label', 'value', 'description', 'icon', 'color', 'background'],
	relation: ['collection', 'field', 'related_collection', 'list', 'kind', 'mirror'],
};
const WIRE_TYPES = ['string', 'markdown', 'integer', 'number', 'boolean', 'date', 'datetime', 'url', 'email', 'object', 'map', 'position'];
const VALUES = {
	kind: ['derived', 'virtual', 'mirror'],
	editable: [true, false, 'create'],
	role: ['body', 'reference', 'reference_many', 'mirror'],
	hidden: ['list', 'form', 'record'],
	relationKind: ['m2o', 'o2o', 'm2m'],
};

/** Every key emitted, grouped by the table row it belongs to. */
function emitted(p) {
	const seen = Object.fromEntries(Object.keys(CONTRACT).map((k) => [k, new Set()]));
	const add = (group, obj) => { for (const k of Object.keys(obj)) seen[group].add(k); };
	add('top', p);
	for (const c of p.collections) {
		add('collection', c);
		add('nav', c.nav); add('list', c.list); add('record', c.record); add('form', c.form);
		for (const s of c.form.sections) add('section', s);
	}
	const fieldRows = (rows) => {
		for (const f of rows) {
			add('field', f);
			for (const opts of [f.editor_options, f.viewer_options]) {
				for (const ch of opts?.choices ?? []) add('choice', ch);
				if (opts?.fields) fieldRows(opts.fields);
			}
		}
	};
	for (const rows of Object.values(p.fields)) fieldRows(rows);
	for (const r of p.relations) add('relation', r);
	return seen;
}

describe('the display contract carries only the §4.3 names', () => {
	const p = presentation(clinic());
	const seen = emitted(p);

	for (const [group, names] of Object.entries(CONTRACT)) {
		test(`${group}: no key outside the table`, () => {
			assert.deepEqual([...seen[group]].filter((k) => !names.includes(k)).sort(), [], `unlisted ${group} key`);
		});
		test(`${group}: every key in the table is emitted`, () => {
			assert.deepEqual(names.filter((k) => !seen[group].has(k)), [], `${group} key never emitted`);
		});
	}

	test('wire types are the authored names, and every one of them is reachable', () => {
		const types = new Set(Object.values(p.fields).flat().flatMap((f) => [f.type, ...(f.editor_options?.fields ?? []).map((s) => s.type)]));
		assert.deepEqual([...types].filter((t) => !WIRE_TYPES.includes(t)), []);
		// `object` and `map` and `position` are in the fixture; the rest are scalars every clinic has
		for (const t of ['string', 'markdown', 'integer', 'number', 'boolean', 'date', 'datetime', 'url', 'email', 'object', 'map', 'position']) assert.ok(types.has(t), `type ${t} not emitted`);
	});

	test('closed values stay closed', () => {
		const rows = Object.values(p.fields).flat();
		for (const f of rows) {
			if (f.kind !== undefined) assert.ok(VALUES.kind.includes(f.kind), `kind ${f.kind}`);
			assert.ok(VALUES.editable.includes(f.editable), `editable ${f.editable}`);
			if (f.role !== undefined) assert.ok(VALUES.role.includes(f.role), `role ${f.role}`);
			for (const h of f.hidden ?? []) assert.ok(VALUES.hidden.includes(h), `hidden ${h}`);
		}
		for (const r of p.relations) if (r.kind !== undefined) assert.ok(VALUES.relationKind.includes(r.kind));
		assert.deepEqual(new Set(rows.map((f) => f.kind).filter(Boolean)), new Set(VALUES.kind));
		assert.deepEqual(new Set(rows.map((f) => f.role).filter(Boolean)), new Set(VALUES.role));
		assert.deepEqual(new Set(rows.map((f) => f.editable)), new Set(VALUES.editable));
		assert.deepEqual(new Set(p.relations.map((r) => r.kind).filter(Boolean)), new Set(VALUES.relationKind));
	});

	test('no v1 word survives anywhere in the projection', () => {
		const text = JSON.stringify(p);
		for (const word of ['"meta"', '"schema"', '"special"', '"readonly"', '"readonly_hint"', '"formHidden"', '"list_fields"', '"sort_field"', '"title_template"', '"group"', '"system"', '"inverse"', '"inverse_of"', '"is_nullable"', '"default_value"', '"text"', '"edit"', '"view"', '"last-modified"', '"timestamp"', '"float"', '"json"', '"x-']) {
			assert.ok(!text.includes(word), `${word} in the projection`);
		}
	});
});

describe('the template grammar is public', () => {
	test('api.js exports the one parser, validator and renderer', async () => {
		const api = await import('../../src/api.js');
		const template = await import('../../src/template.js');
		for (const name of ['parseTemplate', 'validateTemplate', 'renderDisplay']) assert.equal(api[name], template[name], name);
	});

	test('a surface renders the contract\'s record_title and subtitle with it', async () => {
		const { renderDisplay } = await import('../../src/api.js');
		const p = presentation(clinic());
		const visits = p.collections.find((c) => c.collection === 'health/visits');
		const record = { id: 'v1', reason: 'Headache', date: '2026-03-04', patient: 'health/patients/dana-oren', kind: 'intake' };
		assert.equal(renderDisplay(visits.record_title, record), 'Headache · 2026-03-04');
		const patients = p.collections.find((c) => c.collection === 'health/patients');
		const resolve = (ref) => renderDisplay(patients.record_title, { name: ref === 'health/patients/dana-oren' ? 'Dana Oren' : '?' });
		const isReference = (f) => p.fields['health/visits'].find((r) => r.field === f)?.role === 'reference';
		assert.equal(renderDisplay(visits.record.subtitle, record, { resolve, isReference }), 'Dana Oren · intake');
	});
});

// The typings a TypeScript consumer compiles against name exactly the contract's keys. A key added to
// the contract and not to records-api.d.ts would type-check as absent in every surface.
describe('records-api.d.ts types the same contract', () => {
	const dts = fs.readFileSync(new URL('../../src/records-api.d.ts', import.meta.url), 'utf8');
	/** The top-level member names of one exported interface (nested object types are not descended). */
	const keysOf = (iface) => {
		const start = dts.indexOf(`export interface ${iface} {`);
		assert.notEqual(start, -1, `records-api.d.ts declares no ${iface}`);
		let depth = 0, i = dts.indexOf('{', start), body = '';
		for (; i < dts.length; i++) {
			const ch = dts[i];
			if (ch === '{') { depth++; if (depth === 1) continue; }
			if (ch === '}') { depth--; if (depth === 0) break; }
			body += depth === 1 ? ch : ' ';
		}
		return [...body.matchAll(/(?:^|[;\s])([a-z_]+)\??:/g)].map((m) => m[1]);
	};
	for (const [iface, group] of [['PresentationCollection', 'collection'], ['PresentationField', 'field'], ['PresentationChoice', 'choice'], ['PresentationRelation', 'relation']]) {
		test(`${iface} declares exactly the ${group} keys`, () => {
			assert.deepEqual([...new Set(keysOf(iface))].sort(), [...CONTRACT[group]].sort());
		});
	}
});
