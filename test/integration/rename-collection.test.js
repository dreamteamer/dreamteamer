// Tier 2 — `collections rename`, the verb that makes namespacing EXISTING data one command.
//
// The reason it needs this much testing: it touches four things at once (descriptor source, record
// folder, record filenames, every inbound reference) and the failure mode of getting the last one
// wrong is SILENT — every link dangles and nothing says so until the next `check`. So the assertions
// here are mostly "and the references still resolve".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, tree, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const DOCTORS = simpleCollection({ storage: { suffix: 'doctor' } });
const VISITS = simpleCollection({
	storage: { suffix: 'visit' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' }, doctor: { type: 'string', 'x-reference': 'doctors' } },
	},
});

/** An UNnamespaced starting point with data and a cross-collection reference — the migration case. */
const seeded = (namespaces = ['health']) => {
	const ws = workspace({ namespaces, collections: { doctors: DOCTORS, visits: VISITS } });
	ws.store.add('doctors', { name: 'Dana Levi' });
	ws.store.add('visits', { name: 'Checkup', doctor: 'doctors/dana-levi' });
	return ws;
};

const descriptorAt = (ws, rel) => load(readFile(ws.root, rel) ?? 'null');

describe('moving an existing collection into a namespace', () => {
	test('moves the descriptor, the records and the references in one commit', () => {
		const ws = seeded();
		const before = ws.git(['rev-parse', 'HEAD']);

		const res = ws.dt('collections', 'rename', 'doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		// descriptor: nested source, new name, new path
		assert.equal(descriptorAt(ws, 'modules/ws/collections/doctors.collection.yaml'), null);
		const d = descriptorAt(ws, 'modules/ws/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
		assert.equal(d.storage.suffix, 'doctor', 'the base name did not change, so neither does the suffix');

		// records moved, old folder gone
		assert.ok(readFile(ws.root, 'data/health/doctors/dana-levi.doctor.md'));
		assert.deepEqual(tree(ws.root, 'data/doctors'), []);

		// THE point: the inbound reference was rewritten
		assert.equal(ws.store.read('visits', 'checkup').fields.doctor, 'health/doctors/dana-levi');

		// exactly one commit
		const commits = ws.git(['rev-list', '--count', `${before}..HEAD`]);
		assert.equal(commits, '1', 'a rename is ONE commit');
		assert.match(ws.git(['log', '-1', '--format=%s']), /collections rename doctors → health\/doctors/);
	});

	test('the workspace is clean afterwards — check passes and the CLI can address it', () => {
		const ws = seeded();
		assert.equal(ws.dt('collections', 'rename', 'doctors', 'health/doctors').code, 0);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
		assert.match(check.stdout, /0 violations/);
		assert.match(ws.dt('health/doctors', 'list').stdout, /dana-levi/);
	});

	test('--namespace is sugar for the same thing', () => {
		const ws = seeded();
		const res = ws.dt('collections', 'rename', 'doctors', '--namespace', 'health');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(descriptorAt(ws, 'modules/ws/collections/health/doctors.collection.yaml').name, 'health/doctors');
	});

	test('a nested id survives the move', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: {
				visits: simpleCollection({
					storage: { suffix: 'visit' },
					id: { generate: '{{ date }}/{{ name | slug }}' },
					schema: {
						type: 'object', required: ['name', 'date'],
						properties: { name: { type: 'string' }, date: { type: 'string' } },
					},
				}),
			},
		});
		ws.store.add('visits', { name: 'Checkup', date: '2026/03' });
		assert.equal(ws.dt('collections', 'rename', 'visits', 'health/visits').code, 0);
		assert.ok(readFile(ws.root, 'data/health/visits/2026/03/checkup.visit.md'));
	});
});

describe('renaming the base name too', () => {
	test('re-suffixes the files when the suffix was DERIVED', () => {
		const ws = workspace({ collections: { doctors: DOCTORS } });
		ws.store.add('doctors', { name: 'Dana Levi' });
		const res = ws.dt('collections', 'rename', 'doctors', 'clinicians');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'data/clinicians/dana-levi.clinician.md'), 'file re-suffixed');
		assert.equal(readFile(ws.root, 'data/clinicians/dana-levi.doctor.md'), null);
		assert.equal(descriptorAt(ws, 'modules/ws/collections/clinicians.collection.yaml').storage.suffix, 'clinician');
		assert.equal(ws.dt('check').code, 0);
	});

	// An authored suffix is a deliberate choice about the filename contract; a rename must not overrule
	// it, the same way it does not overrule an authored storage.path.
	test('leaves an AUTHORED suffix alone', () => {
		const ws = workspace({ collections: { doctors: simpleCollection({ storage: { suffix: 'medic' } }) } });
		ws.store.add('doctors', { name: 'Dana Levi' });
		assert.equal(ws.dt('collections', 'rename', 'doctors', 'clinicians').code, 0);
		assert.ok(readFile(ws.root, 'data/clinicians/dana-levi.medic.md'));
		assert.equal(descriptorAt(ws, 'modules/ws/collections/clinicians.collection.yaml').storage.suffix, 'medic');
	});
});

describe('authored storage.path is not overruled', () => {
	test('the records stay put and the CLI says so', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: { doctors: simpleCollection({ storage: { suffix: 'doctor', path: 'vault/clinicians' } }) },
		});
		ws.store.add('doctors', { name: 'Dana Levi' });
		const res = ws.dt('collections', 'rename', 'doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /storage\.path kept as "vault\/clinicians"/);
		assert.ok(readFile(ws.root, 'vault/clinicians/dana-levi.doctor.md'), 'records did NOT move');
		assert.equal(descriptorAt(ws, 'modules/ws/collections/health/doctors.collection.yaml').storage.path, 'vault/clinicians');
	});
});

describe('references that are not record refs', () => {
	// `x-reference: doctors` is a bare COLLECTION name, not a `<collection>/<id>` ref, so the per-record
	// rewrite cannot see it — and leaving it stale makes the next compile fail on an unknown target.
	test('x-reference targets in other descriptors are retargeted', () => {
		const ws = seeded();
		assert.equal(ws.dt('collections', 'rename', 'doctors', 'health/doctors').code, 0);
		const visits = descriptorAt(ws, 'modules/ws/collections/visits.collection.yaml');
		assert.equal(visits.schema.properties.doctor['x-reference'], 'health/doctors');
	});

	// ui-views point at `collections/<name>` — which IS a record ref, into the `collections` collection,
	// so it rides along on the same rewrite with no special case.
	test('a ui-view targeting the collection follows it', () => {
		const ws = seeded();
		const dir = path.join(ws.root, 'modules', 'ws', 'ui-views');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'docs.ui-view.yaml'),
			'path: /doctors\ntarget: list\ncollection: collections/doctors\nlayout: table\n');
		assert.equal(ws.dt('compile').code, 0);

		assert.equal(ws.dt('collections', 'rename', 'doctors', 'health/doctors').code, 0);
		assert.match(readFile(ws.root, 'modules/ws/ui-views/docs.ui-view.yaml'), /collections\/health\/doctors/);
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('refusals — nothing is half-renamed', () => {
	const unchanged = (ws) => {
		assert.ok(readFile(ws.root, 'modules/ws/collections/doctors.collection.yaml'), 'descriptor still there');
		assert.ok(readFile(ws.root, 'data/doctors/dana-levi.doctor.md'), 'records still there');
		assert.equal(ws.store.read('visits', 'checkup').fields.doctor, 'doctors/dana-levi');
	};

	test('an undeclared target namespace', () => {
		const ws = seeded([]);
		const res = ws.dt('collections', 'rename', 'doctors', 'health/doctors');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"health" is not declared/);
		unchanged(ws);
	});

	test('a name that already exists', () => {
		const ws = seeded();
		const res = ws.dt('collections', 'rename', 'doctors', 'visits');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /already exists/);
		unchanged(ws);
	});

	test('an unknown collection', () => {
		const ws = seeded();
		const res = ws.dt('collections', 'rename', 'nope', 'health/nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown collection "nope"/);
	});

	test('a compiled-source collection', () => {
		const ws = seeded();
		const res = ws.dt('collections', 'rename', 'skills', 'health/skills');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /compiled source|not workspace-owned/);
	});

	test('a collection a MODULE ships, not the workspace', () => {
		// the engine's own `users` collection: present in the runtime, no workspace-owned source
		const ws = seeded();
		const res = ws.dt('collections', 'rename', 'users', 'health/users');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /not workspace-owned/);
	});

	test('renaming to the same name is a no-op, not an error', () => {
		const ws = seeded();
		const res = ws.dt('collections', 'rename', 'doctors', 'doctors');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /already named that/);
	});
});
