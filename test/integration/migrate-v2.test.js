// Tier 2 — the converter on a real v1 workspace: convert, compile, check, and the records it held
// before still pass. Invented names only — this engine is published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, writeCollection, compileQuietly, compileError, dt, ENGINE_ROOT, WS_MODULE } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';

const SCRIPT = path.join(ENGINE_ROOT, 'scripts', 'migrate-descriptors-v2.mjs');
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', timeout: 60_000 });

function v1Workspace() {
	const w = workspace({ compile: false });
	const tpl = path.join(w.root, 'modules', WS_MODULE, 'collection-templates');
	fs.mkdirSync(tpl, { recursive: true });
	fs.writeFileSync(path.join(tpl, 'kit-provenance.collection-template.yaml'), dump({ name: 'kit-provenance', description: 'who wrote it', template: { schema: { properties: { author: { type: 'string' } } } } }));
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
		id: { generate: '{{ when }}--{{ name | slug }}' },
		storage: { suffix: 'meeting', under: { field: 'company', path: 'meetings' } },
		schema: { type: 'object', required: ['name', 'when'], properties: { name: { type: 'string' }, when: { type: 'string', format: 'date' }, company: { type: 'string', 'x-reference': 'companies' }, notes: { type: 'string', format: 'markdown', 'x-body': true } } },
	});
	assert.equal(compileError(w.ws), null, 'the v1 fixture compiles');
	for (const a of [['add', 'companies', '--name', 'Northwind'], ['add', 'contacts', '--name', 'Ada', '--company', 'companies/northwind', '--stage', 'client'], ['add', 'meetings', '--name', 'Kickoff', '--when', '2026-10-01', '--company', 'companies/northwind']]) {
		const r = dt(w.root, ...a);
		assert.equal(r.code, 0, r.stderr);
	}
	assert.equal(dt(w.root, 'commit').code, 0);
	return w;
}

test('--dry-run prints the plan and writes nothing', () => {
	const w = v1Workspace();
	const before = fs.readFileSync(path.join(w.root, 'modules', WS_MODULE, 'collections', 'contacts.collection.yaml'), 'utf8');
	const r = run(w.root, '--dry-run');
	assert.equal(r.status, 0, r.stderr);
	// the init skeleton seeds collections of its own beside the three written here
	assert.match(r.stdout, /plan: descriptors \d+ · fields \d+ · relations folded 1 · enums merged 1 · mixins 1/);
	assert.equal(fs.readFileSync(path.join(w.root, 'modules', WS_MODULE, 'collections', 'contacts.collection.yaml'), 'utf8'), before);
});

test('a converted v1 workspace compiles, checks clean, and keeps its records and relations', () => {
	const w = v1Workspace();
	const dataBefore = fs.readdirSync(path.join(w.root, 'data'), { recursive: true }).sort();
	const r = run(w.root);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /migrated: descriptors \d+ · fields \d+ · relations folded 1/);
	for (const c of ['companies', 'contacts', 'meetings']) assert.ok('fields' in load(fs.readFileSync(path.join(w.root, 'modules', WS_MODULE, 'collections', `${c}.collection.yaml`), 'utf8')), `${c} is v2`);
	assert.deepEqual(fs.readdirSync(path.join(w.root, 'data'), { recursive: true }).sort(), dataBefore, 'no record moved, appeared or vanished');
	const src = load(fs.readFileSync(path.join(w.root, 'modules', WS_MODULE, 'collections', 'companies.collection.yaml'), 'utf8'));
	assert.deepEqual(src.fields.contacts, { type: 'contacts', many: true, mirror_of: 'company' }, 'spelling A folded onto the target');
	assert.ok(fs.existsSync(path.join(w.root, 'modules', WS_MODULE, 'mixins', 'kit-provenance.mixin.yaml')));
	assert.ok(!fs.existsSync(path.join(w.root, 'modules', WS_MODULE, 'collection-templates', 'kit-provenance.collection-template.yaml')));
	assert.equal(compileError(w.ws), null);
	const check = dt(w.root, 'check');
	assert.equal(check.code, 0, check.stdout + check.stderr);
	const company = JSON.parse(dt(w.root, 'get', 'companies/northwind', '--json').stdout);
	assert.deepEqual(company.contacts, ['contacts/ada'], 'the mirror the v1 records carried still reads');
	// and the converter is idempotent
	const again = run(w.root);
	assert.match(again.stdout, /migrated: descriptors 0 · fields 0 · relations folded 0/);
});
