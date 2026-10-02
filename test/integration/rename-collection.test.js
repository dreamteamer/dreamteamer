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
import { storageOf } from '../../src/descriptor.js';

const DOCTORS = simpleCollection({ storage: { suffix: 'doctor' } });
const VISITS = simpleCollection({
	storage: { suffix: 'visit' },
	fields: {
		name: { type: 'string', required: true },
		doctor: { type: 'doctors' },
		notes: { type: 'markdown', body: true },
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

		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		// descriptor: nested source, new name, new path
		assert.equal(descriptorAt(ws, 'modules/default/collections/doctors.collection.yaml'), null);
		const d = descriptorAt(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, undefined, 'a derived path stays unauthored, and follows the name by itself');
		assert.equal(storageOf(descriptorAt(ws, '.dreamteamer/collections/health/doctors.collection.yaml')).path, 'data/health/doctors');
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
		assert.equal(ws.dt('rename', 'collections/doctors', 'health/doctors').code, 0);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
		assert.match(check.stdout, /0 violations/);
		assert.match(ws.dt('list', 'health/doctors').stdout, /dana-levi/);
	});

	test('--namespace is sugar for the same thing', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/doctors', '--namespace', 'health');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(descriptorAt(ws, 'modules/default/collections/health/doctors.collection.yaml').name, 'health/doctors');
	});

	test('a nested id survives the move', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: {
				visits: simpleCollection({
					storage: { suffix: 'visit' },
					ids: { from: '{{ date }}/{{ name | slug }}' },
					fields: {
						name: { type: 'string', required: true },
						date: { type: 'string', required: true },
						notes: { type: 'markdown', body: true },
					},
				}),
			},
		});
		ws.store.add('visits', { name: 'Checkup', date: '2026/03' });
		assert.equal(ws.dt('rename', 'collections/visits', 'health/visits').code, 0);
		assert.ok(readFile(ws.root, 'data/health/visits/2026/03/checkup.visit.md'));
	});
});

describe('renaming the base name too', () => {
	test('re-suffixes the files when the suffix was DERIVED', () => {
		const ws = workspace({ collections: { doctors: DOCTORS } });
		ws.store.add('doctors', { name: 'Dana Levi' });
		const res = ws.dt('rename', 'collections/doctors', 'clinicians');
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
		assert.equal(ws.dt('rename', 'collections/doctors', 'clinicians').code, 0);
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
		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /storage\.path kept as "vault\/clinicians"/);
		assert.ok(readFile(ws.root, 'vault/clinicians/dana-levi.doctor.md'), 'records did NOT move');
		assert.equal(descriptorAt(ws, 'modules/default/collections/health/doctors.collection.yaml').storage.path, 'vault/clinicians');
	});
});

describe('references that are not record refs', () => {
	// `type: doctors` is a bare COLLECTION name, not a `<collection>/<id>` ref, so the per-record
	// rewrite cannot see it — and leaving it stale makes the next compile fail on an unknown type.
	test('a field type naming the collection in another descriptor is retargeted', () => {
		const ws = seeded();
		assert.equal(ws.dt('rename', 'collections/doctors', 'health/doctors').code, 0);
		const visits = descriptorAt(ws, 'modules/default/collections/visits.collection.yaml');
		assert.equal(visits.fields.doctor.type, 'health/doctors');
	});

	// The same bare name one level down: an object field's own `fields`, and a map's `values`. A
	// retarget that only looked at the top level left these naming a collection that no longer exists.
	test('a type inside an object field and a map value follows the rename', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: {
				doctors: DOCTORS,
				rotas: simpleCollection({
					storage: { suffix: 'rota' },
					fields: {
						name: { type: 'string', required: true },
						lead: { type: 'object', fields: { by: { type: 'doctors' }, since: { type: 'date' } } },
						per_room: { type: 'map', values: { type: 'doctors' } },
						notes: { type: 'markdown', body: true },
					},
				}),
			},
		});
		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const rotas = descriptorAt(ws, 'modules/default/collections/rotas.collection.yaml');
		assert.equal(rotas.fields.lead.fields.by.type, 'health/doctors');
		assert.equal(rotas.fields.lead.fields.since.type, 'date', 'a built-in type is not a collection name');
		assert.equal(rotas.fields.per_room.values.type, 'health/doctors');
		assert.equal(ws.dt('compile').code, 0);
	});

	// A mixin is shared by every collection that lists it, so a type it declares is retargeted in the
	// mixin source itself — not copied into each user.
	test('a type declared by a mixin is retargeted in the mixin', () => {
		const ws = workspace({ namespaces: ['health'], collections: { doctors: DOCTORS } });
		const mixins = path.join(ws.root, 'modules', WS_MODULE, 'mixins');
		fs.mkdirSync(mixins, { recursive: true });
		fs.writeFileSync(path.join(mixins, 'attended.mixin.yaml'),
			'name: attended\ndescription: Who attended.\nfields:\n  # the doctor on duty\n  attended_by: { type: doctors }\n');
		writeCollection(ws.root, 'visits', simpleCollection({ storage: { suffix: 'visit' }, mixins: ['attended'] }));
		const c = ws.dt('compile');
		assert.equal(c.code, 0, c.stdout + c.stderr);

		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const mixin = readFile(ws.root, `modules/${WS_MODULE}/mixins/attended.mixin.yaml`);
		assert.equal(load(mixin).fields.attended_by.type, 'health/doctors');
		assert.match(mixin, /^ {2}# the doctor on duty$/m, 'the mixin kept its comment');
		assert.equal(ws.dt('check').code, 0);
	});

	// ui-views and command-bindings point at `collections/<name>` — which IS a record ref, into the
	// `collections` collection, so it rides along on the same rewrite with no special case.
	test('a ui-view and a command-binding over the collection follow it', () => {
		const ws = seeded();
		const mod = path.join(ws.root, 'modules', WS_MODULE);
		for (const kind of ['ui-views', 'command-bindings', 'commands']) fs.mkdirSync(path.join(mod, kind), { recursive: true });
		fs.writeFileSync(path.join(mod, 'ui-views', 'docs.ui-view.yaml'),
			'route: /doctors\nscope: collection\ncollection: collections/doctors\n');
		fs.writeFileSync(path.join(mod, 'commands', 'refer.command.md'),
			'---\nname: refer\ndescription: Refer a patient on.\n---\nRefer them.\n');
		fs.writeFileSync(path.join(mod, 'command-bindings', 'refer--doctors.command-binding.yaml'),
			'command: commands/refer\ncollection: collections/doctors\nscope: record\navailable_when:\n  name:\n    _nempty: true\n');
		const c = ws.dt('compile');
		assert.equal(c.code, 0, c.stdout + c.stderr);

		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(load(readFile(ws.root, 'modules/default/ui-views/docs.ui-view.yaml')).collection, 'collections/health/doctors');
		assert.equal(load(readFile(ws.root, 'modules/default/command-bindings/refer--doctors.command-binding.yaml')).collection, 'collections/health/doctors');
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
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
		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"health" is not declared/);
		unchanged(ws);
	});

	test('a name that already exists', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/doctors', 'visits');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /already exists/);
		unchanged(ws);
	});

	test('an unknown collection', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/nope', 'health/nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown collection "nope"/);
	});

	test('a compiled-source collection', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/skills', 'health/skills');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /compiled source|not workspace-owned/);
	});

	// ⚠ A collection a MODULE ships is NOT refused any more — see `descriptorSourceDir`. The guard's
	// job is to stop a write that gets ERASED, and only `node_modules` does that. `repos` is the
	// engine's own, installed, and so still refused — but now for the accurate reason.
	test('a collection installed from node_modules, with the reason it cannot be written', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/repos', 'health/repos');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /ships from node_modules/);
		assert.match(res.stderr, /erased by the next `npm install`/, 'says WHY, not just no');
	});

	test('renaming to the same name is a no-op, not an error', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/doctors', 'doctors');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /already named that/);
	});
});

// An overlay names only the collection it adds to, so renaming the collection renames every overlay
// source with it — the file, in the module that ships it, and its `name:`. Renaming the base alone
// would leave each overlay naming a collection with no base, and compile would refuse the workspace.
describe('an OVERLAID collection', () => {
	/** `doctors` with an overlay from a second module; `pkg` is that module's `dreamteamer` block. */
	const overlaid = (pkg) => {
		const ws = seeded();
		const mod = path.join(ws.root, 'modules', 'extra');
		fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'),
			JSON.stringify({ name: 'extra', private: true, version: '0.0.1', dreamteamer: pkg }));
		fs.writeFileSync(path.join(mod, 'collections', 'doctors.collection.yaml'),
			'# the overlay\'s own header\nname: doctors\noverlay: true\nfields:\n  licence: { type: string }\n');
		const c = ws.dt('compile');
		assert.equal(c.code, 0, c.stdout + c.stderr);
		return ws;
	};
	const compiledDoctors = (ws) => descriptorAt(ws, '.dreamteamer/collections/health/doctors.collection.yaml');

	test('the overlay is renamed with its base, in its own module', () => {
		const ws = overlaid({ dependencies: ['default'] });
		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		assert.equal(readFile(ws.root, 'modules/extra/collections/doctors.collection.yaml'), null, 'the old overlay file is gone');
		const moved = readFile(ws.root, 'modules/extra/collections/health/doctors.collection.yaml');
		assert.ok(moved, 'the overlay moved within modules/extra');
		assert.equal(load(moved).name, 'health/doctors');
		assert.equal(load(moved).overlay, true);
		assert.match(moved, /^# the overlay's own header$/m, 'its comments survived');
		assert.equal(readFile(ws.root, 'modules/default/collections/health/doctors.collection.yaml') !== null, true);

		// the overlay still applies: its field is on the compiled collection
		assert.ok(compiledDoctors(ws).compiled.fields.licence, 'the overlay field survived the rename');
		assert.deepEqual(compiledDoctors(ws).compiled.overlaid_by, ['extra']);
		assert.equal(ws.store.read('visits', 'checkup').fields.doctor, 'health/doctors/dana-levi');
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
		assert.equal(ws.git(['status', '--porcelain', '--', 'modules/extra/collections', 'modules/default/collections']), '',
			'the overlay move is in the rename commit');
	});

	// An overlay of a PEER is gated on the module's `peer_collections`, which names the collection —
	// so that list follows the rename too, or compile refuses the overlay as unrelated to its base.
	test('an overlay of a peer carries its peer_collections entry', () => {
		const ws = overlaid({ peer_collections: ['doctors'] });
		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const pkg = JSON.parse(readFile(ws.root, 'modules/extra/package.json'));
		assert.deepEqual(pkg.dreamteamer.peer_collections, ['health/doctors']);
		assert.ok(compiledDoctors(ws).compiled.fields.licence);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});

	// An overlay's storage wins over the base's, and a rename re-derives storage from the base — so an
	// overlay that sets it is refused before anything moves, naming the file and the fix.
	test('an overlay that sets storage.suffix is refused, and nothing moves', () => {
		const ws = overlaid({ dependencies: ['default'] });
		const file = path.join(ws.root, 'modules', 'extra', 'collections', 'doctors.collection.yaml');
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'storage:\n  suffix: medic\n');
		assert.equal(ws.dt('compile').code, 0);

		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /modules\/extra\/collections\/doctors\.collection\.yaml overlays "doctors" and sets storage\.suffix — move it into the base descriptor/);
		assert.ok(readFile(ws.root, 'modules/extra/collections/doctors.collection.yaml'), 'the overlay did not move');
		assert.ok(readFile(ws.root, 'modules/default/collections/doctors.collection.yaml'), 'the base did not move');
		assert.equal(ws.store.read('visits', 'checkup').fields.doctor, 'doctors/dana-levi');
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
			+ 'storage: { path: data/billing-invoices, format: md, shape: file, suffix: invoice }\n'
			+ 'ids: { from: "{{ name | slug }}" }\n'
			+ 'fields:\n  name: { type: string, required: true }\n  notes: { type: markdown, body: true }\n');
		assert.equal(ws.dt('compile').code, 0);
		ws.store.reload?.();
		return ws;
	};

	test('moves into a namespace, and the descriptor stays in ITS module', () => {
		const ws = withModule();
		assert.equal(ws.dt('add', 'billing-invoices', '--name', 'March').code, 0);

		const res = ws.dt('rename', 'collections/billing-invoices', 'finance/invoices');
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
			fields: {
				name: { type: 'string', required: true },
				invoice: { type: 'billing-invoices' },
				notes: { type: 'markdown', body: true },
			},
		}));
		const c2 = ws.dt('compile');
		assert.equal(c2.code, 0, c2.stderr);
		assert.equal(ws.dt('add', 'billing-invoices', '--name', 'March').code, 0);
		assert.equal(ws.dt('add', 'payments', '--name', 'P1', '--invoice', 'billing-invoices/march').code, 0);

		assert.equal(ws.dt('rename', 'collections/billing-invoices', 'finance/invoices').code, 0);

		// the record ref AND the cross-module field type both follow.
		// ⚠ Read through the CLI, not `ws.store` — that Store was built when the fixture was, before
		// this test added a module and a collection to it, so its descriptor map does not know them.
		assert.match(ws.dt('get', 'payments/p1').stdout, /finance\/invoices\/march/);
		const payments = load(readFile(ws.root, 'modules/default/collections/payments.collection.yaml'));
		assert.equal(payments.fields.invoice.type, 'finance/invoices');
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
					fields: {
						name: { type: 'string', required: true },
						settled_by: { type: 'accounts' },
						notes: { type: 'markdown', body: true },
					},
				}),
			},
		});
		ws.store.add('accounts', { name: 'Current' });
		ws.store.add('accounts', { name: 'Card', settled_by: 'accounts/current' });

		assert.equal(ws.dt('rename', 'collections/accounts', 'finance/accounts').code, 0);

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

		assert.equal(ws.dt('rename', 'collections/docs', 'rnd/docs').code, 0);

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
// in TWO places (the descriptor write, and the type retarget), and took 194 lines across 24
// descriptors in one real migration — including 22-line headers stating what belongs in a collection.
// The record survived; the reasoning did not, and nothing said so.
describe('a rename preserves the descriptor verbatim apart from what it changes', () => {
	const RICH = [
		'# doctors — the header this test exists to protect.',
		'#',
		'# A doctor refers on to another doctor: a SELF-reference in the inline flow form, which is',
		'# where the retarget regex used to match nothing at all.',
		'name: doctors',
		'storage: { path: data/doctors, format: md, shape: file, suffix: doctor }',
		'ids: { from: "{{ name | slug }}" }',
		'fields:',
		'  name: { type: string, required: true }',
		'  # who they refer on to',
		'  refers_to: { type: doctors }',
		'  notes: { type: markdown, body: true }',
		'',
	].join('\n');

	test('comments survive, and the self-referencing type is retargeted', () => {
		const ws = workspace({ namespaces: ['health'] });
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'doctors.collection.yaml'), RICH);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('add', 'doctors', '--name', 'Dana').code, 0);
		assert.equal(ws.dt('add', 'doctors', '--name', 'Eli', '--refers_to', 'doctors/dana').code, 0);

		const res = ws.dt('rename', 'collections/doctors', 'health/doctors');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		const moved = readFile(ws.root, `modules/${WS_MODULE}/collections/health/doctors.collection.yaml`);
		assert.match(moved, /^# doctors — the header this test exists to protect\.$/m, 'the header block survived');
		assert.match(moved, /^ {2}# who they refer on to$/m, 'an inline field comment survived too');
		// the VALUE, not its spelling: the round-trip writer quotes only what YAML needs quoted, and
		// `health/doctors` is a plain scalar. Asserting the parse is what the retarget actually promises.
		assert.equal(load(moved).fields.refers_to.type, 'health/doctors', 'the self-referencing type was retargeted');
		assert.match(moved, /^ {2}refers_to: \{ ?type: health\/doctors ?\}$/m, 'the inline flow form was kept inline');
		assert.equal(load(moved).storage.path, 'data/health/doctors');

		// and the self-reference in the DATA followed
		assert.match(ws.dt('get', 'health/doctors/eli').stdout, /health\/doctors\/dana/);
		const check = ws.dt('check');
		assert.equal(check.code, 0, check.stdout);
	});
});

// ⚠ A union `type` may name SEVERAL collections, spelled as a flow list (`[a, old, b]`) or a
// block sequence (`- old` under a bare `type:` key). Step 4 used to be a scalar-only regex, so
// a descriptor carrying either list spelling made every rename of a listed collection REFUSE via the
// reparse-assert below — the very safety net meant to catch a botched rewrite instead caught a rewrite
// that never even tried.
describe('list-spelled union types survive a rename', () => {
	test('rename retargets union type entries — flow and block forms, comments kept', () => {
		const ws = workspace({
			collections: {
				meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
				clients: simpleCollection({ storage: { suffix: 'client' } }),
			},
		});
		// hand-author a descriptor carrying both list spellings and a comment, past the dump() round-trip
		const src = `name: notes
# the comment that must survive
storage: { suffix: note }
ids: { from: '{{ name | slug }}' }
fields:
  name: { type: string, required: true }
  about: { type: [meetings, clients] }
  sources:
    type:
      - meetings
      - clients
    many: true
  notes: { type: markdown, body: true }
`;
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'notes.collection.yaml'), src);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('rename', 'collections/meetings', 'sessions').code, 0);
		const after = readFile(ws.root, `modules/${WS_MODULE}/collections/notes.collection.yaml`);
		assert.match(after, /type: \[sessions, clients\]/);
		assert.match(after, /- sessions/);
		assert.doesNotMatch(after, /meetings/);
		assert.match(after, /the comment that must survive/);
		assert.equal(ws.dt('compile').code, 0);
	});

	test('a rename into a NAMESPACED name retargets both list forms, each keeping its spelling', () => {
		const ws = workspace({
			namespaces: ['health'],
			collections: {
				doctors: simpleCollection({ storage: { suffix: 'doctor' } }),
				clients: simpleCollection({ storage: { suffix: 'client' } }),
			},
		});
		// hand-author a descriptor carrying both list spellings, to be retargeted into a namespaced name
		const src = `name: notes
storage: { suffix: note }
ids: { from: '{{ name | slug }}' }
fields:
  name: { type: string, required: true }
  about: { type: [doctors, clients] }
  sources:
    type:
      - doctors
      - clients
    many: true
  notes: { type: markdown, body: true }
`;
		fs.writeFileSync(path.join(ws.root, 'modules', WS_MODULE, 'collections', 'notes.collection.yaml'), src);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('rename', 'collections/doctors', 'health/doctors').code, 0);
		const after = readFile(ws.root, `modules/${WS_MODULE}/collections/notes.collection.yaml`);
		// the VALUE in both list spellings — a namespaced name needs no quoting, so assert what it
		// PARSES to rather than how the writer chose to spell it
		const parsed = load(after);
		assert.deepEqual(parsed.fields.about.type, ['health/doctors', 'clients']);
		assert.deepEqual(parsed.fields.sources.type, ['health/doctors', 'clients']);
		// and each list kept the form its author wrote it in
		assert.match(after, /type: \[health\/doctors, clients\]/, 'the flow list stayed a flow list');
		assert.match(after, /^ {6}- health\/doctors$/m, 'the block sequence stayed a block sequence');
		// the unqualified old name should not appear as a bare reference
		assert.doesNotMatch(after, /- doctors\b/);
		assert.doesNotMatch(after, /type:\s+\[?doctors\b/);
		// and the workspace still compiles
		assert.equal(ws.dt('compile').code, 0);
	});
});
