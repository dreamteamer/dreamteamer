// Tier 1 — the v1 → v2 descriptor converter's pure half (scripts/migrate-descriptors-v2.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { convertField, convertCollection, convertTemplate, addMirrorField } from '../../scripts/migrate-descriptors-v2.mjs';

const js = (text) => parseDocument(text).toJSON();

describe('convertField', () => {
	const cases = [
		['a plain string', { type: 'string' }, { type: 'string' }],
		['markdown', { type: 'string', format: 'markdown' }, { type: 'markdown' }],
		['a date-time', { type: 'string', format: 'date-time' }, { type: 'datetime' }],
		['a uri', { type: 'string', format: 'uri' }, { type: 'url' }],
		['a reference', { type: 'string', 'x-reference': 'companies' }, { type: 'companies' }],
		['a list of references', { type: 'array', items: { type: 'string', 'x-reference': 'contacts' } }, { type: 'contacts', many: true }],
		['a union', { type: 'string', 'x-reference': ['a', 'b'] }, { type: ['a', 'b'] }],
		['the open reference', { type: 'string', 'x-reference': '*' }, { type: 'reference' }],
		['tags', { type: 'array', items: { type: 'string' } }, { type: 'string', many: true }],
		['an open object', { type: 'object' }, { type: 'map' }],
		['a typed map', { type: 'object', additionalProperties: { type: 'string' } }, { type: 'map', values: 'string' }],
		['the body', { type: 'string', format: 'markdown', 'x-body': true }, { type: 'markdown', body: true }],
		['a bare-string body', { type: 'string', 'x-body': true }, { type: 'markdown', body: true }],
		['a soft reference is a plain string', { type: 'array', items: { type: 'string', 'x-reference': 'collections', 'x-reference-soft': true } }, { type: 'string', many: true }],
		['an untyped list', { type: 'array' }, { type: 'string', many: true }],
	];
	for (const [what, v1, v2] of cases) test(what, () => assert.deepEqual(convertField(v1).field, v2));

	test('required, title, description and default are kept, in canonical order', () => {
		assert.deepEqual(convertField({ type: 'string', description: 'd', default: 'x', title: 'T' }, { required: true }).field, { type: 'string', title: 'T', required: true, default: 'x', description: 'd' });
	});

	test('an enum with x-choices becomes the enum map', () => {
		assert.deepEqual(convertField({ type: 'string', enum: ['a', 'b'], 'x-choices': { a: { label: 'A' } } }).field, { type: 'string', enum: { a: { label: 'A' }, b: {} } });
	});

	test('spelling B becomes mirror_of; spelling A is reported for folding', () => {
		assert.deepEqual(convertField({ type: 'array', items: { type: 'string', 'x-reference': 'visits', 'x-inverse-of': 'visits.doctor' }, readOnly: true }).field, { type: 'visits', many: true, mirror_of: 'doctor' });
		const a = convertField({ type: 'string', 'x-reference': 'doctors', 'x-inverse': 'visits', 'x-unique': true });
		assert.deepEqual(a.field, { type: 'doctors', unique: true });
		assert.deepEqual(a.fold, { name: 'visits', description: undefined, unique: true });
		const o = convertField({ type: 'string', 'x-reference': 'meetings', 'x-unique': true, 'x-inverse': { field: 'prep', description: 'What was read first.' } });
		assert.deepEqual(o.fold, { name: 'prep', description: 'What was read first.', unique: true });
	});

	test('a list of objects with a row label', () => {
		assert.deepEqual(convertField({ type: 'array', items: { type: 'object', 'x-title-template': '{{ verb }}', required: ['verb'], properties: { verb: { type: 'string' } } } }).field, { type: 'object', many: true, fields: { verb: { type: 'string', required: true } }, item_title: '{{ verb }}' });
	});
});

describe('convertCollection', () => {
	const V1 = `# Visits — the event, never the person.
name: health/visits
storage: { path: data/health/visits, codec: md, shape: file, suffix: visit, under: { field: patient, path: visits } }
id:
  generate: "{{ date }}--{{ patient | basename }}"
  pattern: "^\\\\d{4}-.*$"
templates: [collection-templates/clinic-provenance]
schema:
  type: object
  required: [patient, date]
  properties:
    # who was seen — and where the record is stored
    patient:
      type: string
      x-reference: health/patients
      description: Who was seen.
    date: { type: string, format: date }
    position: { type: string }
    lane:
      type: string
      enum: [intake, urgent]
      x-choices:
        urgent: { label: Urgent, color: charts.red }
    notes:
      type: string
      format: markdown
      x-body: true
order: 20
list_fields: [patient, date, last-modified]
sort_field: position
icon: pulse
group: care
title_template: '{{ date }}'
`;
	test('every v1 key lands on its v2 key, in canonical order', () => {
		const { text } = convertCollection(V1, { bareName: 'visits' });
		const d = js(text);
		assert.deepEqual(Object.keys(d), ['name', 'record_title', 'storage', 'ids', 'mixins', 'fields', 'display']);
		assert.deepEqual(d.storage, { path: 'data/health/visits', format: 'md', under: { parent: 'patient', subfolder: 'visits' } });
		assert.deepEqual(d.ids, { from: '{{ date }}--{{ patient | basename }}', pattern: '^\\d{4}-.*$' });
		assert.deepEqual(d.mixins, ['clinic-provenance']);
		assert.deepEqual(d.fields.patient, { type: 'health/patients', required: true, description: 'Who was seen.' });
		assert.deepEqual(d.fields.position, { type: 'position' });
		assert.deepEqual(d.fields.lane.enum, { intake: {}, urgent: { label: 'Urgent', color: 'charts.red' } });
		assert.deepEqual(d.display, { nav: { icon: 'pulse', order: 20, section: 'care' }, list: { columns: ['patient', 'date', 'last_modified'] } });
	});
	test('comments survive: the file header and the comment above a field', () => {
		const { text } = convertCollection(V1, { bareName: 'visits' });
		assert.match(text, /^# Visits — the event, never the person\./);
		assert.match(text, /# who was seen — and where the record is stored\n\s+patient:/);
	});
	test('an authored suffix that differs from the singular is kept', () => {
		const d = js(convertCollection('name: meeting-analyses\nstorage: { suffix: analysis }\nschema: { type: object, properties: { name: { type: string } } }\n', { bareName: 'meeting-analyses' }).text);
		assert.equal(d.storage.suffix, 'analysis');
	});
	test('group: system becomes internal; extends becomes overlay', () => {
		assert.equal(js(convertCollection('name: repos\ngroup: system\nschema: { type: object, properties: {} }\n').text).internal, true);
		assert.equal(js(convertCollection('name: tasks\nextends: core/tasks\nschema: { properties: { urgent: { type: boolean } } }\n').text).overlay, true);
	});
	test('a v2 source is left alone — the converter is idempotent', () => {
		const once = convertCollection(V1, { bareName: 'visits' }).text;
		assert.equal(convertCollection(once).text, null);
	});
	test('a numeric sort_field becomes the default sort, not a position', () => {
		const d = js(convertCollection('name: steps\nschema: { type: object, properties: { index: { type: integer } } }\nsort_field: index\n').text);
		assert.equal(d.fields.index.type, 'integer');
		assert.equal(d.display.list.sort, 'index');
	});
});

describe('convertTemplate and addMirrorField', () => {
	test('a collection-template becomes a mixin', () => {
		const m = js(convertTemplate('name: docs\ndescription: a dated document\ntemplate:\n  id: { generate: "{{ created | date }}--{{ title | slug }}" }\n  schema: { required: [title], properties: { title: { type: string }, content: { type: string, format: markdown, x-body: true } } }\n  list_fields: [title, last-modified]\n', 'docs'));
		assert.deepEqual(m, { name: 'docs', description: 'a dated document', ids: { from: '{{ created | date }}--{{ title | slug }}' }, fields: { title: { type: 'string', required: true }, content: { type: 'markdown', body: true } }, display: { list: { columns: ['title', 'last_modified'] } } });
	});
	test('a mirror is inserted before the body, once', () => {
		const t = 'name: doctors\nfields:\n  name: { type: string }\n  notes: { type: markdown, body: true }\n';
		const { text, added } = addMirrorField(t, 'visits', { type: 'visits', many: true, mirror_of: 'doctor' });
		assert.equal(added, true);
		assert.deepEqual(Object.keys(js(text).fields), ['name', 'visits', 'notes']);
		assert.equal(addMirrorField(text, 'visits', {}).added, false);
	});
});
