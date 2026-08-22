// Tier 2 — namespaces through the REAL compiler, the REAL store and the REAL CLI binary.
//
// Tier 1 pins the semantics of a reference string. This file pins the things only a workspace can
// answer: where the files land, what the CLI can address, what `check` says about it, and which
// misconfigurations refuse to compile at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, simpleCollection, compileError, tree, readFile } from '../helpers/ws.js';

const DOCTORS = simpleCollection({ storage: { suffix: 'doctor' } });
const VISITS = simpleCollection({
	storage: { suffix: 'visit' },
	id: { generate: '{{ date }}--{{ name | slug }}' },
	schema: {
		type: 'object',
		required: ['name', 'date'],
		properties: {
			name: { type: 'string' },
			date: { type: 'string', format: 'date' },
			doctor: { type: 'string', 'x-reference': 'health/doctors' },
			notes: { type: 'string', 'x-body': true },
		},
	},
});

/** The standard two-namespace workspace these tests share. */
function nsWorkspace({ collections, ...extra } = {}) {
	return workspace({
		namespaces: ['health', 'finance'],
		...extra,
		collections: {
			'health/doctors': DOCTORS,
			'health/visits': VISITS,
			'finance/invoices': simpleCollection({ storage: { suffix: 'invoice' } }),
			...collections,
		},
	});
}

describe('a namespaced collection on disk', () => {
	test('records land in the namespace folder, not beside the default namespace', () => {
		// `tasks` stands in for what the operator said they would keep in the default namespace, so
		// this asserts the actual ask: health and finance data stop sitting beside the common entities.
		const ws = nsWorkspace({ collections: { tasks: simpleCollection({ storage: { suffix: 'task' } }) } });
		ws.store.add('health/doctors', { name: 'Dana Levi' });
		ws.store.add('finance/invoices', { name: 'March' });
		ws.store.add('tasks', { name: 'Ship it' });

		assert.deepEqual(tree(ws.root, 'data'), [
			'data/finance/invoices/march.invoice.md',
			'data/health/doctors/dana-levi.doctor.md',
			'data/tasks/ship-it.task.md',
		]);
	});

	test('storage.path is derived from the namespace without being authored', () => {
		const ws = nsWorkspace();
		const d = ws.store.descriptor('health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
		assert.equal(d.storage.base, 'workspace');
	});

	test('an authored storage.path still wins', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: {
				'health/doctors': simpleCollection({ storage: { suffix: 'doctor', path: 'vault/clinicians' } }),
			},
		});
		assert.equal(ws.store.descriptor('health/doctors').storage.path, 'vault/clinicians');
	});

	test('a data-path workspace nests the namespace under it', () => {
		const ws = workspace({
			namespaces: ['health'],
			pkg: { 'data-path': 'vault' },
			collections: { 'health/doctors': DOCTORS },
		});
		assert.equal(ws.store.descriptor('health/doctors').storage.path, 'vault/health/doctors');
	});
});

// The bug this feature was built on top of: compile used to write a nested descriptor and report ✔
// while the descriptor loader read one directory level, so the collection was absent from the runtime.
describe('the nested descriptor actually loads', () => {
	test('the runtime descriptor is written nested', () => {
		const ws = nsWorkspace();
		assert.ok(readFile(ws.root, '.dreamteamer/collections/health/doctors.collection.yaml'));
	});

	test('the store knows it', () => {
		const ws = nsWorkspace();
		assert.ok(ws.store.descriptors.has('health/doctors'));
	});

	test('the CLI can address it', () => {
		const ws = nsWorkspace();
		const add = ws.dt('add', 'health/doctors', '--name', 'Dana Levi');
		assert.equal(add.code, 0, add.stderr);
		const list = ws.dt('list', 'health/doctors');
		assert.equal(list.code, 0, list.stderr);
		assert.match(list.stdout, /dana-levi/);
	});
});

describe('references across namespaces', () => {
	test('a valid cross-namespace reference is accepted and round-trips', () => {
		const ws = nsWorkspace();
		ws.store.add('health/doctors', { name: 'Dana Levi' });
		const { id } = ws.store.add('health/visits', {
			name: 'Annual checkup', date: '2026-03-04', doctor: 'health/doctors/dana-levi',
		});
		assert.equal(ws.store.read('health/visits', id).fields.doctor, 'health/doctors/dana-levi');
	});

	test('a dangling namespaced reference is rejected before disk', () => {
		const ws = nsWorkspace();
		assert.throws(
			() => ws.store.add('health/visits', { name: 'x', date: '2026-03-04', doctor: 'health/doctors/nobody' }),
			/dangling reference "health\/doctors\/nobody"/,
		);
		assert.deepEqual(tree(ws.root, 'data/health'), []);
	});

	// The ambiguity the declared list resolves. With no namespace declared, `health/doctors/dana-levi`
	// is read as collection `health` + id `doctors/dana-levi` — so a workspace that forgot to declare
	// gets a loud "unknown collection" instead of a reference that quietly points somewhere else.
	test('without a declaration the same string names a different collection', () => {
		const ws = workspace({
			collections: {
				doctors: DOCTORS,
				linker: simpleCollection({
					storage: { suffix: 'link' },
					schema: {
						type: 'object', required: ['name'],
						properties: { name: { type: 'string' }, doctor: { type: 'string', 'x-reference': '*' } },
					},
				}),
			},
		});
		assert.equal(ws.store.namespaces.length, 0);
		assert.throws(
			() => ws.store.add('linker', { name: 'l', doctor: 'health/doctors/dana-levi' }),
			/targets unknown collection "health"/,
		);
	});

	test('check agrees with the store about where the namespace ends', () => {
		const ws = nsWorkspace();
		ws.store.add('health/doctors', { name: 'Dana Levi' });
		ws.store.add('health/visits', { name: 'Checkup', date: '2026-03-04', doctor: 'health/doctors/dana-levi' });
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /0 violations/);
	});

	test('check FLAGS a namespaced reference that dangles on disk', () => {
		const ws = nsWorkspace();
		// hand-written, so it bypasses the store's write-time refusal — exactly what `check` is for
		fs.mkdirSync(path.join(ws.root, 'data/health/visits'), { recursive: true });
		fs.writeFileSync(
			path.join(ws.root, 'data/health/visits/2026-03-04--x.visit.md'),
			'---\nname: x\ndate: \'2026-03-04\'\ndoctor: health/doctors/ghost\n---\n',
		);
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /dangling reference "health\/doctors\/ghost"/);
	});
});

describe('rename inside a namespace', () => {
	test('rewrites inbound references and moves only the record', () => {
		const ws = nsWorkspace();
		ws.store.add('health/doctors', { name: 'Dana Levi' });
		ws.store.add('health/visits', { name: 'Checkup', date: '2026-03-04', doctor: 'health/doctors/dana-levi' });

		const out = ws.store.rename('health/doctors', 'dana-levi', 'd-levi');
		assert.equal(out.rewrites, 1);
		assert.equal(
			ws.store.read('health/visits', '2026-03-04--checkup').fields.doctor,
			'health/doctors/d-levi',
		);
		assert.ok(readFile(ws.root, 'data/health/doctors/d-levi.doctor.md'));
		assert.equal(readFile(ws.root, 'data/health/doctors/dana-levi.doctor.md'), null);
	});
});

describe('the default namespace is transparent', () => {
	// The migration promise: declaring namespaces changes nothing about collections that do not use one.
	test('an unprefixed collection keeps its path and its reference shape', () => {
		const plain = workspace({ collections: { doctors: DOCTORS } });
		const withNs = workspace({ namespaces: ['health'], collections: { doctors: DOCTORS } });
		assert.equal(plain.store.descriptor('doctors').storage.path, 'data/doctors');
		assert.equal(withNs.store.descriptor('doctors').storage.path, 'data/doctors');
		withNs.store.add('doctors', { name: 'Dana Levi' });
		assert.ok(readFile(withNs.root, 'data/doctors/dana-levi.doctor.md'));
	});

	test('a multi-segment id in the default namespace still parses as one collection', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: {
				meetings: simpleCollection({
					storage: { suffix: 'meeting' },
					id: { generate: '{{ date }}/{{ name | slug }}' },
					schema: {
						type: 'object', required: ['name', 'date'],
						properties: { name: { type: 'string' }, date: { type: 'string' } },
					},
				}),
				notes2: simpleCollection({
					storage: { suffix: 'note' },
					schema: {
						type: 'object', required: ['name'],
						properties: { name: { type: 'string' }, about: { type: 'string', 'x-reference': 'meetings' } },
					},
				}),
			},
		});
		ws.store.add('meetings', { name: 'Kickoff', date: '2026/07' });
		assert.ok(readFile(ws.root, 'data/meetings/2026/07/kickoff.meeting.md'));
		// the reference carries a three-segment id and must still resolve
		ws.store.add('notes2', { name: 'n', about: 'meetings/2026/07/kickoff' });
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('misconfigurations refuse to compile', () => {
	const bad = (opts) => {
		const ws = workspace({ ...opts, compile: false });
		return compileError(ws.ws);
	};

	test('a slashed collection name with an undeclared namespace', () => {
		assert.match(
			bad({ collections: { 'health/doctors': DOCTORS } }),
			/"health" is not declared/,
		);
	});

	test('`default` is a reserved namespace', () => {
		assert.match(bad({ namespaces: ['default'] }), /reserved/);
	});

	test('a namespace colliding with a collection name', () => {
		assert.match(
			bad({ namespaces: ['health'], collections: { health: simpleCollection({ storage: { suffix: 'h' } }) } }),
			/collides with the collection/,
		);
	});

	test('an uppercase namespace segment', () => {
		assert.match(bad({ namespaces: ['Health'] }), /lowercase/);
	});

	// The measured data-loss bug: before this check the outer collection indexed the inner one's
	// records as its own and compile reported success.
	test('one collection nested inside another\'s folder', () => {
		const err = bad({
			collections: {
				outer: simpleCollection({ storage: { suffix: 'o', path: 'data/health' } }),
				inner: simpleCollection({ storage: { suffix: 'i', path: 'data/health/doctors' } }),
			},
		});
		assert.match(err, /"inner".*INSIDE "outer"/);
	});

	test('a namespace folder that is also a collection root', () => {
		const err = bad({
			namespaces: ['health'],
			collections: {
				'health/doctors': DOCTORS,
				everything: simpleCollection({ storage: { suffix: 'e', path: 'data/health' } }),
			},
		});
		assert.match(err, /INSIDE/);
	});

	test('a sibling folder sharing a string prefix is NOT refused', () => {
		const ws = workspace({
			collections: {
				a: simpleCollection({ storage: { suffix: 'a', path: 'data/health' } }),
				b: simpleCollection({ storage: { suffix: 'b', path: 'data/health-notes' } }),
			},
		});
		assert.ok(ws.store.descriptors.has('a'));
	});
});

describe('nested namespaces', () => {
	test('the longest declared namespace decides the collection', () => {
		const ws = workspace({
			namespaces: ['work/clients', 'work'],
			collections: {
				'work/clients/acme': simpleCollection({ storage: { suffix: 'doc' } }),
				'work/invoices': simpleCollection({ storage: { suffix: 'invoice' } }),
			},
		});
		assert.equal(ws.store.descriptor('work/clients/acme').storage.path, 'data/work/clients/acme');
		assert.equal(ws.store.descriptor('work/invoices').storage.path, 'data/work/invoices');
		ws.store.add('work/clients/acme', { name: 'Contract' });
		assert.ok(readFile(ws.root, 'data/work/clients/acme/contract.doc.md'));
	});
});

describe('dt changes sees namespaced records', () => {
	// `events.pathToRecord` maps a changed FILE back to (collection, id) by longest storage-path prefix.
	// Namespaces make deep paths and near-miss prefixes ordinary, so the mapping is worth asserting
	// rather than assuming — a miss here reports "nothing changed" for work that did.
	test('a namespaced record shows up as an item event with the right collection and id', () => {
		const ws = nsWorkspace();
		ws.store.add('health/doctors', { name: 'Dana Levi' });
		assert.equal(ws.dt('commit', '-m', 'add').code, 0);

		const out = JSON.parse(ws.dt('changes', '--json').stdout);
		const hit = out.events.find((e) => e.collection === 'health/doctors');
		assert.ok(hit, `expected a health/doctors event, got ${JSON.stringify(out.events)}`);
		assert.equal(hit.id, 'dana-levi');
		assert.equal(hit.type, 'item-added');
	});
});

describe('commit publishes namespaced records', () => {
	test('dt commit picks up a record written under a namespace folder', () => {
		const ws = nsWorkspace();
		ws.store.add('health/doctors', { name: 'Dana Levi' });
		const res = ws.dt('commit', '-m', 'add a doctor');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /health\/doctors\/dana-levi/);
		assert.equal(ws.git(['status', '--porcelain', 'data']), '');
	});
});
