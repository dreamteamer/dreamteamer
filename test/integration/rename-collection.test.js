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
import { workspace, simpleCollection, tree, readFile, writeCollection, WS_MODULE } from '../helpers/ws.js';
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

		const res = ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		// descriptor: nested source, new name, new path
		assert.equal(descriptorAt(ws, 'modules/default/collections/doctors.collection.yaml'), null);
		const d = descriptorAt(ws, 'modules/default/collections/health/doctors.collection.yaml');
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
		assert.equal(ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors').code, 0);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
		assert.match(check.stdout, /0 violations/);
		assert.match(ws.dt('list', 'health/doctors').stdout, /dana-levi/);
	});

	test('--namespace is sugar for the same thing', () => {
		const ws = seeded();
		const res = ws.dt('schema', 'rename-collection', 'doctors', '--namespace', 'health');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(descriptorAt(ws, 'modules/default/collections/health/doctors.collection.yaml').name, 'health/doctors');
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
		assert.equal(ws.dt('schema', 'rename-collection', 'visits', 'health/visits').code, 0);
		assert.ok(readFile(ws.root, 'data/health/visits/2026/03/checkup.visit.md'));
	});
});

describe('renaming the base name too', () => {
	test('re-suffixes the files when the suffix was DERIVED', () => {
		const ws = workspace({ collections: { doctors: DOCTORS } });
		ws.store.add('doctors', { name: 'Dana Levi' });
		const res = ws.dt('schema', 'rename-collection', 'doctors', 'clinicians');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'data/clinicians/dana-levi.clinician.md'), 'file re-suffixed');
		assert.equal(readFile(ws.root, 'data/clinicians/dana-levi.doctor.md'), null);
		assert.equal(descriptorAt(ws, 'modules/default/collections/clinicians.collection.yaml').storage.suffix, 'clinician');
		assert.equal(ws.dt('check').code, 0);
	});

	// An authored suffix is a deliberate choice about the filename contract; a rename must not overrule
	// it, the same way it does not overrule an authored storage.path.
	test('leaves an AUTHORED suffix alone', () => {
		const ws = workspace({ collections: { doctors: simpleCollection({ storage: { suffix: 'medic' } }) } });
		ws.store.add('doctors', { name: 'Dana Levi' });
		assert.equal(ws.dt('schema', 'rename-collection', 'doctors', 'clinicians').code, 0);
		assert.ok(readFile(ws.root, 'data/clinicians/dana-levi.medic.md'));
		assert.equal(descriptorAt(ws, 'modules/default/collections/clinicians.collection.yaml').storage.suffix, 'medic');
	});
});

describe('authored storage.path is not overruled', () => {
	test('the records stay put and the CLI says so', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: { doctors: simpleCollection({ storage: { suffix: 'doctor', path: 'vault/clinicians' } }) },
		});
		ws.store.add('doctors', { name: 'Dana Levi' });
		const res = ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /storage\.path kept as "vault\/clinicians"/);
		assert.ok(readFile(ws.root, 'vault/clinicians/dana-levi.doctor.md'), 'records did NOT move');
		assert.equal(descriptorAt(ws, 'modules/default/collections/health/doctors.collection.yaml').storage.path, 'vault/clinicians');
	});
});

describe('references that are not record refs', () => {
	// `x-reference: doctors` is a bare COLLECTION name, not a `<collection>/<id>` ref, so the per-record
	// rewrite cannot see it — and leaving it stale makes the next compile fail on an unknown target.
	test('x-reference targets in other descriptors are retargeted', () => {
		const ws = seeded();
		assert.equal(ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors').code, 0);
		const visits = descriptorAt(ws, 'modules/default/collections/visits.collection.yaml');
		assert.equal(visits.schema.properties.doctor['x-reference'], 'health/doctors');
	});

	// ui-views point at `collections/<name>` — which IS a record ref, into the `collections` collection,
	// so it rides along on the same rewrite with no special case.
	test('a ui-view targeting the collection follows it', () => {
		const ws = seeded();
		const dir = path.join(ws.root, 'modules', WS_MODULE, 'ui-views');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'docs.ui-view.yaml'),
			'path: /doctors\ntarget: list\ncollection: collections/doctors\nlayout: table\n');
		assert.equal(ws.dt('compile').code, 0);

		assert.equal(ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors').code, 0);
		assert.match(readFile(ws.root, 'modules/default/ui-views/docs.ui-view.yaml'), /collections\/health\/doctors/);
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('refusals — nothing is half-renamed', () => {
	const unchanged = (ws) => {
		assert.ok(readFile(ws.root, 'modules/default/collections/doctors.collection.yaml'), 'descriptor still there');
		assert.ok(readFile(ws.root, 'data/doctors/dana-levi.doctor.md'), 'records still there');
		assert.equal(ws.store.read('visits', 'checkup').fields.doctor, 'doctors/dana-levi');
	};

	test('an undeclared target namespace', () => {
		const ws = seeded([]);
		const res = ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"health" is not declared/);
		unchanged(ws);
	});

	test('a name that already exists', () => {
		const ws = seeded();
		const res = ws.dt('schema', 'rename-collection', 'doctors', 'visits');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /already exists/);
		unchanged(ws);
	});

	test('an unknown collection', () => {
		const ws = seeded();
		const res = ws.dt('schema', 'rename-collection', 'nope', 'health/nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown collection "nope"/);
	});

	test('a compiled-source collection', () => {
		const ws = seeded();
		const res = ws.dt('schema', 'rename-collection', 'skills', 'health/skills');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /compiled source|not workspace-owned/);
	});

	// ⚠ A collection a MODULE ships is NOT refused any more — see `descriptorSourceDir`. The guard's
	// job is to stop a write that gets ERASED, and only `node_modules` does that. `repos` is the
	// engine's own, installed, and so still refused — but now for the accurate reason.
	test('a collection installed from node_modules, with the reason it cannot be written', () => {
		const ws = seeded();
		const res = ws.dt('schema', 'rename-collection', 'repos', 'health/repos');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /ships from node_modules/);
		assert.match(res.stderr, /erased by the next `npm install`/, 'says WHY, not just no');
	});

	test('an OVERLAID collection is refused, naming both contributors', () => {
		// two modules contributing a descriptor for one name: the overlay's `extends` points at the
		// base's current id, so moving the base alone would leave a broken reference behind.
		const ws = seeded();
		const overlay = path.join(ws.root, 'modules', 'extra');
		fs.mkdirSync(path.join(overlay, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(overlay, 'package.json'),
			JSON.stringify({ name: 'extra', private: true, version: '0.0.1', dreamteamer: { dependencies: ['default'] } }));
		fs.writeFileSync(path.join(overlay, 'collections', 'doctors.collection.yaml'),
			'name: doctors\nextends: default/doctors\nschema:\n  properties:\n    extra: { type: string }\n');
		const c = ws.dt('compile');
		assert.equal(c.code, 0, c.stderr);

		const res = ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /is overlaid/);
		assert.match(res.stderr, /modules\/extra/, 'names the overlay so it can be found');
	});

	test('renaming to the same name is a no-op, not an error', () => {
		const ws = seeded();
		const res = ws.dt('schema', 'rename-collection', 'doctors', 'doctors');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /already named that/);
	});
});

// ⚠ THE CASE THIS CHANGE EXISTS FOR. A workspace's domain collections live in MODULES — that is what
// modules are for — so a guard that refused every module-shipped collection refused the migration
// `collections rename` was built to perform. A real vault hit it on 26 of 26 collections it wanted to
// namespace. The descriptor is rewritten in the module that ships it, not moved to the workspace one.
describe('a collection shipped by an INLINE module', () => {
	/** A fixture with a second module under `modules/billing`, the shape every real workspace has. */
	const withModule = () => {
		const ws = workspace({ namespaces: ['finance'] });
		const mod = path.join(ws.root, 'modules', 'billing');
		fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'),
			JSON.stringify({ name: 'billing', private: true, version: '0.0.1', dreamteamer: {} }));
		fs.writeFileSync(path.join(mod, 'collections', 'billing-invoices.collection.yaml'),
			'name: billing-invoices\n'
			+ 'storage: { path: data/billing-invoices, codec: md, shape: file, suffix: invoice }\n'
			+ 'id: { generate: "{{ name | slug }}" }\n'
			+ 'schema:\n  type: object\n  required: [name]\n  properties:\n    name: { type: string }\n');
		assert.equal(ws.dt('compile').code, 0);
		ws.store.reload?.();
		return ws;
	};

	test('moves into a namespace, and the descriptor stays in ITS module', () => {
		const ws = withModule();
		assert.equal(ws.dt('add', 'billing-invoices', '--name', 'March').code, 0);

		const res = ws.dt('schema', 'rename-collection', 'billing-invoices', 'finance/invoices');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		// the descriptor moved WITHIN modules/billing — not into modules/default
		const moved = readFile(ws.root, 'modules/billing/collections/finance/invoices.collection.yaml');
		assert.ok(moved, 'descriptor is in the module that shipped it');
		assert.equal(load(moved).name, 'finance/invoices');
		assert.equal(readFile(ws.root, 'modules/billing/collections/billing-invoices.collection.yaml'), null);
		assert.equal(readFile(ws.root, 'modules/default/collections/finance/invoices.collection.yaml'), null,
			'a rename must not teleport a collection into the workspace module');

		// records moved, suffix re-derived, and the CLI can address it
		assert.ok(readFile(ws.root, 'data/finance/invoices/march.invoice.md'));
		assert.match(ws.dt('list', 'finance/invoices').stdout, /march/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('and inbound references from ANOTHER module are rewritten', () => {
		const ws = withModule();
		// the workspace module points at the billing module's collection — which the engine requires it
		// to DECLARE, so the fixture does what a real workspace does.
		const wsPkgPath = path.join(ws.root, 'modules', WS_MODULE, 'package.json');
		const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8'));
		wsPkg.dreamteamer = { ...wsPkg.dreamteamer, dependencies: ['billing'] };
		fs.writeFileSync(wsPkgPath, JSON.stringify(wsPkg, null, '\t'));
		writeCollection(ws.root, 'payments', simpleCollection({
			storage: { suffix: 'payment' },
			schema: {
				type: 'object', required: ['name'],
				properties: { name: { type: 'string' }, invoice: { type: 'string', 'x-reference': 'billing-invoices' } },
			},
		}));
		const c2 = ws.dt('compile');
		assert.equal(c2.code, 0, c2.stderr);
		assert.equal(ws.dt('add', 'billing-invoices', '--name', 'March').code, 0);
		assert.equal(ws.dt('add', 'payments', '--name', 'P1', '--invoice', 'billing-invoices/march').code, 0);

		assert.equal(ws.dt('schema', 'rename-collection', 'billing-invoices', 'finance/invoices').code, 0);

		// the record ref AND the cross-module x-reference target both follow.
		// ⚠ Read through the CLI, not `ws.store` — that Store was built when the fixture was, before
		// this test added a module and a collection to it, so its descriptor map does not know them.
		assert.match(ws.dt('get', 'payments/p1').stdout, /finance\/invoices\/march/);
		const payments = load(readFile(ws.root, 'modules/default/collections/payments.collection.yaml'));
		assert.equal(payments.schema.properties.invoice['x-reference'], 'finance/invoices');
		assert.equal(ws.dt('check').code, 0);
	});
});

// ⚠ THE THREE BUGS A REAL MIGRATION FOUND (0.9.1). Each of these passed the whole suite before it
// was written, because each fails only in a shape the suite did not have: a record pointing at its
// OWN collection, a ref written into a module source, and a module that stops existing.
describe('regressions from a real namespace migration', () => {
	test('a SELF-reference inside the renamed collection is rewritten', () => {
		// `finance/accounts`: every card and loan carries `settled_by: <the account that settles it>`.
		// The rewrite used to run AFTER the record folder moved, so `recordFiles()` walked the old
		// (now empty) path and never saw these — 5 of 11 records dangled, silently.
		const ws = workspace({
			namespaces: ['finance'],
			collections: {
				accounts: simpleCollection({
					storage: { suffix: 'account' },
					schema: {
						type: 'object', required: ['name'],
						properties: { name: { type: 'string' }, settled_by: { type: 'string', 'x-reference': 'accounts' } },
					},
				}),
			},
		});
		ws.store.add('accounts', { name: 'Current' });
		ws.store.add('accounts', { name: 'Card', settled_by: 'accounts/current' });

		assert.equal(ws.dt('schema', 'rename-collection', 'accounts', 'finance/accounts').code, 0);

		assert.match(ws.dt('get', 'finance/accounts/card').stdout, /finance\/accounts\/current/,
			'the self-reference followed the collection');
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	test('a ref in a MODULE SOURCE is rewritten once, not twice', () => {
		// `recordFiles()` yielded every module source TWICE (the `modules` collection's storage.path is
		// `modules`, and sourceRoots() includes the workspace root). Harmless while rewrites were
		// idempotent — and namespacing is not: `rnd/docs/x` still contains `docs/x`, so the second
		// pass produced `rnd/rnd/docs/x`.
		const ws = workspace({ namespaces: ['rnd'], collections: { docs: simpleCollection({ storage: { suffix: 'doc' } }) } });
		ws.store.add('docs', { name: 'Spec' });
		const descriptor = path.join(ws.root, 'modules', WS_MODULE, 'collections', 'docs.collection.yaml');
		fs.writeFileSync(descriptor, '# design: data/docs/spec.doc.md\n' + fs.readFileSync(descriptor, 'utf8'));
		assert.equal(ws.dt('compile').code, 0);

		assert.equal(ws.dt('schema', 'rename-collection', 'docs', 'rnd/docs').code, 0);

		const moved = readFile(ws.root, `modules/${WS_MODULE}/collections/rnd/docs.collection.yaml`);
		assert.match(moved, /^# design:/m, 'the comment SURVIVED the rename — dump() used to eat it');
		assert.match(moved, /data\/rnd\/docs\/spec\.doc\.md/, 'and its path was rewritten');
		assert.doesNotMatch(moved, /rnd\/rnd/, 'exactly once');
	});

	test('recordFiles yields each file exactly once', () => {
		const ws = workspace({ collections: { docs: simpleCollection({ storage: { suffix: 'doc' } }) } });
		ws.store.add('docs', { name: 'Spec' });
		const seen = new Map();
		for (const f of ws.store.recordFiles()) seen.set(path.resolve(f), (seen.get(path.resolve(f)) ?? 0) + 1);
		const dupes = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
		assert.deepEqual(dupes, [], 'no file may be walked twice — rewrites are not all idempotent');
	});
});

// ⚠ COMMENTS ARE THE POINT OF A MODULE SOURCE. `load` → mutate → `dump` dropped every one of them,
// in TWO places (the descriptor write, and the x-reference retarget), and took 194 lines across 24
// descriptors in one real migration — including 22-line headers stating what belongs in a collection.
// The record survived; the reasoning did not, and nothing said so.
describe('a rename preserves the descriptor verbatim apart from what it changes', () => {
	const RICH = [
		'# doctors — the header this test exists to protect.',
		'#',
		'# A doctor refers on to another doctor: a SELF-reference in the inline flow form, which is',
		'# where the retarget regex used to match nothing at all.',
		'name: doctors',
		'storage: { path: data/doctors, codec: md, shape: file, suffix: doctor }',
		'id: { generate: "{{ name | slug }}" }',
		'schema:',
		'  type: object',
		'  required: [name]',
		'  properties:',
		'    name: { type: string }',
		'    # who they refer on to',
		'    refers_to: { type: string, x-reference: doctors }',
		'',
	].join('\n');

	test('comments survive, and the self-referencing x-reference is retargeted', () => {
		const ws = workspace({ namespaces: ['health'] });
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'doctors.collection.yaml'), RICH);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('add', 'doctors', '--name', 'Dana').code, 0);
		assert.equal(ws.dt('add', 'doctors', '--name', 'Eli', '--refers_to', 'doctors/dana').code, 0);

		const res = ws.dt('schema', 'rename-collection', 'doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		const moved = readFile(ws.root, `modules/${WS_MODULE}/collections/health/doctors.collection.yaml`);
		assert.match(moved, /^# doctors — the header this test exists to protect\.$/m, 'the header block survived');
		assert.match(moved, /^    # who they refer on to$/m, 'an inline property comment survived too');
		assert.match(moved, /x-reference: 'health\/doctors'/, 'the self-referencing target was retargeted');
		assert.equal(load(moved).storage.path, 'data/health/doctors');

		// and the self-reference in the DATA followed
		assert.match(ws.dt('get', 'health/doctors/eli').stdout, /health\/doctors\/dana/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});
});
