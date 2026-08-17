// Tier 2 — the meta verbs, through the CLI, including the namespace flag.
//
// These write SOURCES behind a real compile gate, which is the property worth testing: a schema op
// that produced an uncompilable descriptor used to be discoverable only on the next command.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const descriptorOf = (ws, file) => load(readFile(ws.root, file));

describe('collections add', () => {
	test('creates a compilable collection in the default namespace', () => {
		const ws = workspace();
		const res = ws.dt('collections', 'add', '--name', 'widgets');
		assert.equal(res.code, 0, res.stderr);

		const d = descriptorOf(ws, 'modules/ws/collections/widgets.collection.yaml');
		assert.equal(d.name, 'widgets');
		assert.equal(d.storage.path, 'data/widgets');
		assert.equal(d.storage.suffix, 'widget');
		assert.equal(ws.dt('widgets', 'add', '--name', 'A').code, 0);
		assert.ok(readFile(ws.root, 'data/widgets/a.widget.md'));
	});

	test('--namespace puts it in the namespace folder with a bare suffix', () => {
		const ws = workspace({ namespaces: ['health'] });
		const res = ws.dt('collections', 'add', '--namespace', 'health', '--name', 'doctors');
		assert.equal(res.code, 0, res.stderr);

		const d = descriptorOf(ws, 'modules/ws/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
		// the suffix comes off the BARE name — `<id>.doctor.md`, never `<id>.health/doctor.md`
		assert.equal(d.storage.suffix, 'doctor');
	});

	test('a qualified --name is the same thing as --namespace', () => {
		const ws = workspace({ namespaces: ['health'] });
		assert.equal(ws.dt('collections', 'add', '--name', 'health/doctors').code, 0);
		const d = descriptorOf(ws, 'modules/ws/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
	});

	test('an undeclared namespace is refused BEFORE a file is written', () => {
		const ws = workspace();
		const res = ws.dt('collections', 'add', '--name', 'health/doctors');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"health" is not declared/);
		assert.equal(readFile(ws.root, 'modules/ws/collections/health/doctors.collection.yaml'), null);
	});

	test('a duplicate name is refused', () => {
		const ws = workspace({ namespaces: ['health'] });
		assert.equal(ws.dt('collections', 'add', '--name', 'health/doctors').code, 0);
		const again = ws.dt('collections', 'add', '--name', 'health/doctors');
		assert.equal(again.code, 1);
		assert.match(again.stderr, /already exists/);
	});
});

describe('collections rm', () => {
	test('removes a namespaced collection', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('collections', 'add', '--name', 'health/doctors');
		const res = ws.dt('collections', 'rm', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(readFile(ws.root, 'modules/ws/collections/health/doctors.collection.yaml'), null);
	});

	test('refuses while records exist, and --force overrides', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('collections', 'add', '--name', 'health/doctors');
		ws.dt('health/doctors', 'add', '--name', 'Dana');
		const refused = ws.dt('collections', 'rm', 'health/doctors');
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /still has records/);
		assert.equal(ws.dt('collections', 'rm', 'health/doctors', '--force').code, 0);
	});
});

describe('field verbs on a namespaced collection', () => {
	test('add-field, update-field and remove-field all address it by qualified name', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('collections', 'add', '--name', 'health/doctors');

		assert.equal(ws.dt('health/doctors', 'add-field', '--name', 'speciality', '--type', 'string').code, 0);
		let d = descriptorOf(ws, 'modules/ws/collections/health/doctors.collection.yaml');
		assert.equal(d.schema.properties.speciality.type, 'string');

		assert.equal(
			ws.dt('health/doctors', 'update-field', '--name', 'speciality', '--type', 'enum', '--options', 'gp,ent').code,
			0,
		);
		d = descriptorOf(ws, 'modules/ws/collections/health/doctors.collection.yaml');
		assert.deepEqual(d.schema.properties.speciality.enum, ['gp', 'ent']);

		assert.equal(ws.dt('health/doctors', 'remove-field', '--name', 'speciality').code, 0);
		d = descriptorOf(ws, 'modules/ws/collections/health/doctors.collection.yaml');
		assert.equal(d.schema.properties.speciality, undefined);
	});

	test('a reference field can target a namespaced collection', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('collections', 'add', '--name', 'health/doctors');
		ws.dt('collections', 'add', '--name', 'health/visits');
		const res = ws.dt('health/visits', 'add-field', '--name', 'doctor', '--type', 'reference', '--target', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);

		ws.dt('health/doctors', 'add', '--name', 'Dana Levi');
		assert.equal(ws.dt('health/visits', 'add', '--name', 'v1', '--doctor', 'health/doctors/dana-levi').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});
});
