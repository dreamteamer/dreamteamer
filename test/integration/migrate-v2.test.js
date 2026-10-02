// Tier 2 — the converter on a real v1 workspace: convert, compile, check, and the records it held
// before still pass. The engine reads v2 only, so the v1 sources and their records are written as
// files, exactly as a workspace on the previous release holds them. Invented names only — this engine
// is published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, writeCollection, dt, ENGINE_ROOT, WS_MODULE } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';

const SCRIPT = path.join(ENGINE_ROOT, 'scripts', 'migrate-descriptors-v2.mjs');
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', timeout: 60_000 });
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const MOD = `modules/${WS_MODULE}`;

function v1Workspace() {
	const w = workspace({ compile: false });
	write(w.root, `${MOD}/collection-templates/kit-provenance.collection-template.yaml`, dump({ name: 'kit-provenance', description: 'who wrote it', template: { schema: { properties: { author: { type: 'string' } } } } }));
	writeCollection(w.root, 'companies', {
		description: 'An organisation.',
		storage: { shape: 'folder', entry: 'company.md', suffix: 'company' },
		id: { generate: '{{ name | slug }}' },
		schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, notes: { type: 'string', format: 'markdown', 'x-body': true } } },
	});
	writeCollection(w.root, 'contacts', {
		description: 'A person.',
		id: { generate: '{{ name | slug }}' },
		templates: ['collection-templates/kit-provenance'],
		schema: {
			type: 'object', required: ['name'],
			properties: {
				name: { type: 'string' },
				// spelling A: the owner declares the inverse; the converter folds it onto companies
				company: { type: 'string', 'x-reference': 'companies', 'x-inverse': 'contacts' },
				stage: { type: 'string', enum: ['lead', 'client'], 'x-choices': { client: { label: 'Client' } } },
				tags: { type: 'array', items: { type: 'string' } },
				notes: { type: 'string', format: 'markdown', 'x-body': true },
			},
		},
		list_fields: ['name', 'company', 'last-modified'],
		icon: 'person',
		group: 'crm',
	});
	writeCollection(w.root, 'meetings', {
		description: 'A call with a company.',
		// opens with a date: v2 needs a string first, so the converter reorders it
		title_template: '{{ when }} — {{ name }}',
		id: { generate: '{{ when }}--{{ name | slug }}' },
		storage: { suffix: 'meeting', under: { field: 'company', path: 'meetings' } },
		schema: { type: 'object', required: ['name', 'when'], properties: { name: { type: 'string' }, when: { type: 'string', format: 'date' }, status: { type: 'string', enum: ['planned', 'held'] }, summarised: { type: 'boolean' }, company: { type: 'string', 'x-reference': 'companies' }, notes: { type: 'string', format: 'markdown', 'x-body': true } } },
	});
	// a view of every scope, a default view of each foldable scope, and a binding
	write(w.root, `${MOD}/ui-views/contacts.ui-view.yaml`, '# The default contacts list — newest first.\npath: /contacts\ntarget: list\ncollection: collections/contacts\nlayout: table\ndefault: true\noptions:\n  # what the list shows\n  columns: [name, stage, last-modified]\n  sort: -last-modified\n  page_size: 50\n');
	write(w.root, `${MOD}/ui-views/contacts-record.ui-view.yaml`, 'path: /contacts/record\ntarget: item\ncollection: collections/contacts\nlayout: data-model\ndefault: true\n');
	write(w.root, `${MOD}/ui-views/meetings-board.ui-view.yaml`, '# Meetings by status.\npath: /meetings/board\ntarget: list\ncollection: collections/meetings\n# one lane per status\nlayout: kanban\noptions:\n  group_columns_by_field: status\n  color_by_field: status\n  template: "{{ name }}"\nnav:\n  label: Board\n  icon: layout\nfilter:\n  status: { _eq: planned }\n');
	write(w.root, `${MOD}/ui-views/meetings-gantt.ui-view.yaml`, 'path: /meetings/gantt\ntarget: list\ncollection: collections/meetings\nlayout: gantt\noptions:\n  start_field: when\n  end_field: when\n  template: "{{ name }}"\n  group_rows_by_field: company\n  group_template: "{{ company }}"\n');
	write(w.root, `${MOD}/ui-views/meeting-page.ui-view.yaml`, 'path: /meetings/page\ntarget: item\ncollection: collections/meetings\nlayout: data-model\n');
	write(w.root, `${MOD}/ui-views/dash.ui-view.yaml`, 'path: /dash\ntarget: page\nlayout: dashboard\n');
	write(w.root, `${MOD}/commands/summarize.command.md`, '---\nname: summarize\ndescription: Summarize a call.\n---\nSummarize it.\n');
	write(w.root, `${MOD}/command-bindings/summarize--meetings.command-binding.yaml`, 'command: commands/summarize\ncollection: collections/meetings\n# once held\ntarget: record\ncan-enter:\n  status: { _eq: held }\ncan-exit:\n  summarised: { _eq: true }\n');
	// the records, as the previous release wrote them — the mirror included
	write(w.root, 'data/companies/northwind/company.md', '---\nname: Northwind\ncontacts:\n  - contacts/ada\n---\n');
	write(w.root, 'data/contacts/ada.contact.md', '---\nname: Ada\ncompany: companies/northwind\nstage: client\n---\n');
	write(w.root, 'data/companies/northwind/meetings/2026-10-01--kickoff.meeting.md', '---\nname: Kickoff\nwhen: 2026-10-01\nstatus: held\ncompany: companies/northwind\n---\n');
	// the manifest as the previous release wrote it: hyphenated keys, a disable naming its module
	const pkg = JSON.parse(read(w.root, 'package.json'));
	pkg.dreamteamer = Object.fromEntries(Object.entries(pkg.dreamteamer).map(([k, v]) => [k.replace(/_/g, '-'), v]));
	pkg.dreamteamer.disable = ['default/meeting-page'];
	write(w.root, 'package.json', JSON.stringify(pkg, null, '\t') + '\n');
	w.git(['add', '-A']);
	w.git(['commit', '-qm', 'fixture: a v1 workspace']);
	return w;
}
/** Compile from disk, as a person would — the fixture handle carries the package.json it was made with. */
const compiles = (w) => { const r = dt(w.root, 'compile'); return r.code === 0 ? null : r.stdout + r.stderr; };
const dataBytes = (root) => fs.readdirSync(path.join(root, 'data'), { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(root, 'data', f)).isFile() ? read(root, path.join('data', f)) : null]);

test('--dry-run prints the plan and writes nothing', () => {
	const w = v1Workspace();
	const r = run(w.root, '--dry-run');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /plan: descriptors \d+ · fields \d+ · relations folded 1 · enums merged 1 · mixins 1 · views folded 2 · views converted 4 · bindings converted 1 · packages 1/);
	assert.equal(w.git(['status', '--porcelain']), '', 'nothing was written');
});

test('a converted v1 workspace compiles, checks clean, and keeps its records and relations', () => {
	const w = v1Workspace();
	const dataBefore = dataBytes(w.root);
	const r = run(w.root);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /migrated: descriptors \d+ · fields \d+ · relations folded 1 · enums merged 1 · mixins 1 · views folded 2 · views converted 4 · bindings converted 1 · packages 1/);
	for (const c of ['companies', 'contacts', 'meetings']) assert.ok('fields' in load(read(w.root, `${MOD}/collections/${c}.collection.yaml`)), `${c} is v2`);
	assert.deepEqual(dataBytes(w.root), dataBefore, 'no record changed, moved, appeared or vanished');
	const companies = load(read(w.root, `${MOD}/collections/companies.collection.yaml`));
	assert.deepEqual(companies.fields.contacts, { type: 'contacts', many: true, mirror_of: 'company' }, 'spelling A folded onto the target');
	assert.ok(exists(w.root, `${MOD}/mixins/kit-provenance.mixin.yaml`));
	assert.ok(!exists(w.root, `${MOD}/collection-templates/kit-provenance.collection-template.yaml`));
	assert.equal(load(read(w.root, `${MOD}/collections/meetings.collection.yaml`)).record_title, '{{ name }} — {{ when }}');
	assert.equal(compiles(w), null);
	const check = dt(w.root, 'check');
	assert.equal(check.code, 0, check.stdout + check.stderr);
	const company = JSON.parse(dt(w.root, 'get', 'companies/northwind', '--json').stdout);
	assert.deepEqual(company.contacts, ['contacts/ada'], 'the mirror the v1 records carried still reads');
	// and the converter is idempotent
	const again = run(w.root);
	assert.match(again.stdout, /migrated: descriptors 0 · fields 0 · relations folded 0 · enums merged 0 · mixins 0 · views folded 0 · views converted 0 · bindings converted 0 · packages 0/);
});

test('every default view folds by scope, and every option key is rewritten', () => {
	const w = v1Workspace();
	assert.equal(run(w.root).status, 0);
	// the two default views are gone, folded into the descriptor they described
	assert.ok(!exists(w.root, `${MOD}/ui-views/contacts.ui-view.yaml`));
	assert.ok(!exists(w.root, `${MOD}/ui-views/contacts-record.ui-view.yaml`));
	const text = read(w.root, `${MOD}/collections/contacts.collection.yaml`);
	const { display } = load(text);
	assert.deepEqual(display.list, { columns: ['name', 'stage', 'last_modified'], sort: '-last_modified', options: { page_size: 50 } }, 'the list view wins over list_fields; table is the default and is not written');
	assert.deepEqual(display.record, { layout: 'data-model' }, 'the record-scope default lands in display.record');
	assert.match(text, /# The default contacts list — newest first\.\n\s+list:/, 'the view\'s header travels with it');
	assert.match(text, /# what the list shows\n\s+columns:/);
	// a named view: v2 keys, option keys renamed, comments kept
	const board = read(w.root, `${MOD}/ui-views/meetings-board.ui-view.yaml`);
	assert.deepEqual(load(board).display, { nav: { title: 'Board', icon: 'layout' }, list: { layout: 'kanban', options: { lanes_by: 'status', color_by: 'status', card_title: '{{ name }}' } } });
	assert.match(board, /^# Meetings by status\.\nroute: \/meetings\/board/);
	assert.match(board, /# one lane per status\n\s+layout: kanban/);
	assert.deepEqual(load(read(w.root, `${MOD}/ui-views/meetings-gantt.ui-view.yaml`)).display.list.options, { start: 'when', end: 'when', bar_title: '{{ name }}', group_by: 'company', group_title: '{{ company }}' });
	assert.deepEqual(load(read(w.root, `${MOD}/ui-views/meeting-page.ui-view.yaml`)), { route: '/meetings/page', scope: 'record', collection: 'collections/meetings', display: { record: { layout: 'data-model' } } });
	assert.deepEqual(load(read(w.root, `${MOD}/ui-views/dash.ui-view.yaml`)), { route: '/dash', scope: 'page', display: { list: { layout: 'dashboard' } } });
	const binding = read(w.root, `${MOD}/command-bindings/summarize--meetings.command-binding.yaml`);
	assert.deepEqual(load(binding), { command: 'commands/summarize', collection: 'collections/meetings', scope: 'record', available_when: { status: { _eq: 'held' } }, done_when: { summarised: { _eq: true } } });
	assert.match(binding, /# once held\nscope: record/);
	// the compiled views are what a surface draws
	assert.equal(compiles(w), null);
	assert.equal(load(read(w.root, '.dreamteamer/ui-views/meetings-board.ui-view.yaml')).compiled.display.list.layout, 'kanban');
});

test('the package.json block goes snake_case', () => {
	const w = v1Workspace();
	assert.equal(run(w.root).status, 0);
	const block = JSON.parse(read(w.root, 'package.json')).dreamteamer;
	assert.ok(Object.keys(block).every((k) => !k.includes('-')), Object.keys(block).join(', '));
	assert.equal(block.workspace_module, 'default');
	assert.deepEqual(block.disable, ['ui-views/meeting-page'], 'a <module>/<entity> disable is <kind>/<entity>, the kind found from the source file');
	assert.equal(compiles(w), null, 'compile accepts the converted manifest');
	assert.ok(!exists(w.root, '.dreamteamer/ui-views/meeting-page.ui-view.yaml'), 'and the disable still disables');
});

test('run through a symlinked engine folder, it still converts', () => {
	const w = v1Workspace();
	const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-link-')), 'dreamteamer');
	fs.symlinkSync(ENGINE_ROOT, link);
	try {
		const r = spawnSync(process.execPath, [path.join(link, 'scripts', 'migrate-descriptors-v2.mjs'), '--root', w.root], { encoding: 'utf8', timeout: 60_000 });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /migrated: descriptors [1-9]/);
		assert.ok('fields' in load(read(w.root, `${MOD}/collections/companies.collection.yaml`)));
	} finally {
		fs.rmSync(path.dirname(link), { recursive: true, force: true });
	}
});

test('dreamteamer.md becomes DREAMTEAMER.md, and the generated harness files are ignored', () => {
	const w = v1Workspace();
	write(w.root, 'dreamteamer.md', '# House rules\n\nEvery visit names its doctor.\n');
	write(w.root, 'CLAUDE.md', '<!-- dreamteamer:begin -->\ngenerated\n<!-- dreamteamer:end -->\n');
	write(w.root, 'AGENTS.md', '# House rules for another tool, written by hand\n');
	// rules written by hand ABOVE a generated block are the operator's too: ignoring the file loses them
	write(w.root, 'GEMINI.md', 'Always measure.\n\n<!-- dreamteamer:begin (generated) -->\nx\n<!-- dreamteamer:end -->\n');
	const ignore = read(w.root, '.gitignore').split('\n').filter((l) => !['/CLAUDE.md', '/AGENTS.md', '/GEMINI.md', '/NOTEBOOKLM.md'].includes(l.trim())).join('\n');
	write(w.root, '.gitignore', ignore);
	w.git(['add', '-f', 'dreamteamer.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.gitignore']);
	w.git(['commit', '-qm', 'fixture: instructions and a tracked harness file']);

	const plan = run(w.root, '--dry-run');
	assert.match(plan.stdout, /instructions renamed 1 · harness files ignored 2/);
	assert.ok(fs.readdirSync(w.root).includes('dreamteamer.md'), 'a dry run renames nothing');

	const r = run(w.root);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /instructions renamed 1 · harness files ignored 2/);
	assert.match(r.stdout, /GEMINI\.md carries text outside the generated block/);
	assert.match(r.stdout, /git rm --cached CLAUDE\.md$/m, 'only the generated file is untracked');
	assert.match(r.stdout, /AGENTS\.md carries text outside the generated block, so it stays tracked/);
	const names = fs.readdirSync(w.root);
	assert.ok(names.includes('DREAMTEAMER.md') && !names.includes('dreamteamer.md'), names.join(' '));
	assert.equal(read(w.root, 'DREAMTEAMER.md'), '# House rules\n\nEvery visit names its doctor.\n');
	const lines = read(w.root, '.gitignore').split('\n');
	for (const f of ['/CLAUDE.md', '/NOTEBOOKLM.md']) assert.ok(lines.includes(f), `${f} is ignored`);
	for (const f of ['/AGENTS.md', '/GEMINI.md']) assert.ok(!lines.includes(f), `${f}: a harness file with text of its own is never ignored`);
	assert.equal(compiles(w), null, 'compile reads DREAMTEAMER.md and accepts the converted manifest');
	assert.match(run(w.root).stdout, /instructions renamed 0 · harness files ignored 0/, 'idempotent');
});
