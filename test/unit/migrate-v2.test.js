// Tier 1 — the v1 → v2 descriptor converter's pure half (scripts/migrate-descriptors-v2.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { convertField, convertCollection, convertTemplate, addMirrorField, recordTitle, convertView, foldDisplay, convertBinding, convertPackage } from '../../scripts/migrate-descriptors-v2.mjs';

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
		['a soft reference into collections names a collection, so it is a plain string', { type: 'array', items: { type: 'string', 'x-reference': 'collections', 'x-reference-soft': true } }, { type: 'string', many: true }],
		['a soft reference', { type: 'string', 'x-reference': 'contacts', 'x-reference-soft': true }, { type: 'contacts', soft: true }],
		['a soft list of references', { type: 'array', items: { type: 'string', 'x-reference': 'contacts', 'x-reference-soft': true } }, { type: 'contacts', many: true, soft: true }],
		['a soft union', { type: 'string', 'x-reference': ['a', 'b'], 'x-reference-soft': true }, { type: ['a', 'b'], soft: true }],
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
		// `title_template: '{{ date }}'` opens with a date and names no string field, so it is dropped
		assert.deepEqual(Object.keys(d), ['name', 'storage', 'ids', 'mixins', 'fields', 'display']);
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

describe('recordTitle — the converter never writes a record_title v2 refuses', () => {
	const types = { date: 'date', title: 'string', company: 'companies' };
	test('a template opening with a non-string field is reordered to open with its string field', () => {
		assert.equal(recordTitle('{{ date }} — {{ title }}', types), '{{ title }} — {{ date }}');
		assert.equal(recordTitle('{{ date | date }} {{ company }} {{ title }}', types), '{{ title }} {{ date | date }} {{ company }}');
	});
	test('one already opening with a string field, a built-in, or a field it cannot see is left alone', () => {
		for (const t of ['{{ title }} · {{ date }}', '{{ id }} {{ date }}', '{{ subject }} {{ date }}']) assert.equal(recordTitle(t, types), t);
	});
	test('one naming no string field at all is dropped, with a warning naming the template', () => {
		assert.equal(recordTitle('{{ company }} · {{ date }}', types), null);
		const { text, warnings } = convertCollection('name: calls\ntitle_template: "{{ date }}"\nschema: { type: object, properties: { date: { type: string, format: date } } }\n');
		assert.equal(js(text).record_title, undefined);
		assert.match(warnings.join('\n'), /record_title "\{\{ date \}\}" names no string field to open with — dropped/);
	});
	test('a mixin\'s field counts — its type is passed in', () => {
		const { text } = convertCollection('name: calls\ntitle_template: "{{ date }} {{ subject }}"\nschema: { type: object, properties: { date: { type: string, format: date } } }\n', { mixinFields: { subject: 'string' } });
		assert.equal(js(text).record_title, '{{ subject }} {{ date }}');
	});
});

describe('convertView — every scope, every option key', () => {
	test('a collection view: route, scope, and the list block with columns and sort lifted out of options', () => {
		const { text } = convertView('# By status.\npath: /visits/board\ntarget: list\ncollection: collections/visits\n# one lane per status\nlayout: kanban\noptions: { group_columns_by_field: status, color_by_field: kind, template: "{{ reason }}", columns: [reason, last-modified], sort: -last-modified, page_size: 20 }\nnav: { label: Board, icon: layout, order: 3 }\nfilter: { status: { _eq: booked } }\n');
		assert.deepEqual(js(text), {
			route: '/visits/board', scope: 'collection', collection: 'collections/visits', filter: { status: { _eq: 'booked' } },
			display: {
				nav: { title: 'Board', icon: 'layout', order: 3 },
				list: { layout: 'kanban', columns: ['reason', 'last_modified'], sort: '-last_modified', options: { lanes_by: 'status', color_by: 'kind', card_title: '{{ reason }}', page_size: 20 } },
			},
		});
		assert.match(text, /^# By status\.\nroute:/);
		assert.match(text, /# one lane per status\n\s+layout: kanban/);
		assert.doesNotMatch(text, /\{ ?status:/, 'a flow mapping is never written');
	});
	test('every §3.5.1 option key is renamed, and `template` on a gantt labels its bar', () => {
		const { text } = convertView('path: /g\ntarget: list\ncollection: collections/visits\nlayout: gantt\noptions:\n  start_field: date\n  end_field: until\n  lat_field: lat\n  lng_field: lng\n  group_rows_by_field: doctor\n  group_template: "{{ doctor }}"\n  group_summary_template: "{{ reason }}"\n  template: "{{ reason }}"\n  bar_label_field: reason\n  link_by: doctor\n  node: card\n  show_ungrouped_rows: true\n');
		assert.deepEqual(js(text).display.list.options, { start: 'date', end: 'until', lat: 'lat', lng: 'lng', group_by: 'doctor', group_title: '{{ doctor }}', group_summary: '{{ reason }}', bar_title: '{{ reason }}', bar_label: 'reason', link_by: 'doctor', node: 'card', show_ungrouped_rows: true });
	});
	test('a record view lands in display.record; a page in display.list', () => {
		assert.deepEqual(js(convertView('path: /r\ntarget: item\ncollection: collections/visits\nlayout: data-model\noptions: { node: compact }\n').text), { route: '/r', scope: 'record', collection: 'collections/visits', display: { record: { layout: 'data-model', options: { node: 'compact' } } } });
		assert.deepEqual(js(convertView('path: /dash\ntarget: page\nlayout: dashboard\n').text), { route: '/dash', scope: 'page', display: { list: { layout: 'dashboard' } } });
	});
	test('a v2 view is left alone', () => {
		const once = convertView('path: /r\ntarget: list\ncollection: collections/visits\nlayout: table\n').text;
		assert.equal(convertView(once), null);
	});
	test('a default view comes back as a fold, its default layout dropped; one with a filter stays a view', () => {
		const { fold } = convertView('# The default list.\npath: /visits\ntarget: list\ncollection: collections/visits\nlayout: table\ndefault: true\noptions: { columns: [reason], page_size: 50 }\nnav: { label: Visits, icon: pulse }\n');
		assert.equal(fold.collection, 'visits');
		assert.equal(fold.block, 'list');
		assert.deepEqual(fold.node.toJSON(), { columns: ['reason'], options: { page_size: 50 } });
		assert.deepEqual(fold.nav, { icon: 'pulse' });
		assert.match(fold.comment, /The default list\./);
		const filtered = convertView('path: /t\ntarget: list\ncollection: collections/visits\nlayout: table\ndefault: true\nfilter: { status: { _eq: booked } }\n');
		assert.equal(filtered.fold, undefined);
		assert.equal(js(filtered.text).default, undefined);
		assert.match(filtered.warnings[0], /cannot be its collection's display/);
	});
});

describe('foldDisplay', () => {
	const COLLECTION = 'name: visits\nfields:\n  reason:\n    type: string\ndisplay:\n  nav:\n    icon: pulse\n  list:\n    layout: kanban\n    columns: [reason]\n';
	test('a record-scope default view folds into display.record and leaves list.layout untouched', () => {
		const { fold } = convertView('path: /visits/record\ntarget: item\ncollection: collections/visits\nlayout: data-model\ndefault: true\n');
		const d = js(foldDisplay(COLLECTION, fold));
		assert.deepEqual(d.display.record, { layout: 'data-model' });
		assert.deepEqual(d.display.list, { layout: 'kanban', columns: ['reason'] });
	});
	test('a collection-scope one folds into display.list, its keys winning, its header above the block', () => {
		const { fold } = convertView('# Newest first.\npath: /visits\ntarget: list\ncollection: collections/visits\nlayout: table\ndefault: true\noptions:\n  # what the list shows\n  columns: [reason, date]\n  sort: -date\nnav: { icon: other, order: 4 }\n');
		const text = foldDisplay(COLLECTION, fold);
		const d = js(text);
		assert.deepEqual(d.display.list, { layout: 'kanban', columns: ['reason', 'date'], sort: '-date' });
		assert.deepEqual(d.display.nav, { icon: 'pulse', order: 4 }, 'nav fills only what the collection lacks');
		assert.match(text, /# Newest first\.\n\s+list:/);
		assert.match(text, /# what the list shows\n\s+columns:/);
	});
});

describe('convertBinding', () => {
	test('target, can-enter and can-exit are renamed in place, comments kept', () => {
		const text = convertBinding('command: commands/prescribe\ncollection: collections/visits\n# once seen\ntarget: record\ncan-enter: { status: { _eq: seen } }\ncan-exit:\n  prescribed: { _eq: true }\n');
		assert.deepEqual(js(text), { command: 'commands/prescribe', collection: 'collections/visits', scope: 'record', available_when: { status: { _eq: 'seen' } }, done_when: { prescribed: { _eq: true } } });
		assert.match(text, /# once seen\nscope: record/);
		assert.equal(convertBinding(text), null, 'idempotent');
	});
});

describe('convertPackage', () => {
	const kindsOf = (mod, id) => (mod !== 'clinic' ? null : id === 'triage' ? ['skills'] : id === 'board' ? ['ui-views', 'commands'] : []);
	test('keys go snake_case, peers become peer_collections, entity disables become kind/id', () => {
		const { text, warnings } = convertPackage(JSON.stringify({ name: 'w', dreamteamer: { 'workspace-module': 'default', 'data-path': 'data', 'git-modules': {}, 'auto-commit': false, 'owns-data': true, peerDependencies: ['collections/billing/claims', 'people'], disable: ['clinic/triage', 'clinic/board', 'clinic/ghost', '@acme/views', 'solo', 'skills/already'] } }, null, 2) + '\n', kindsOf);
		const pkg = JSON.parse(text);
		assert.deepEqual(Object.keys(pkg.dreamteamer), ['workspace_module', 'data_path', 'git_modules', 'auto_commit', 'owns_data', 'peer_collections', 'disable']);
		assert.deepEqual(pkg.dreamteamer.peer_collections, ['billing/claims', 'people']);
		assert.deepEqual(pkg.dreamteamer.disable, ['skills/triage', 'ui-views/board', 'commands/board', 'clinic/ghost', '@acme/views', 'solo', 'skills/already']);
		assert.match(warnings.join('\n'), /disable "clinic\/ghost": module clinic ships no "ghost"/);
		assert.match(text, /^\{\n  "name"/, 'the indentation is kept');
		assert.equal(convertPackage(text, kindsOf).text, null, 'idempotent');
	});
});
