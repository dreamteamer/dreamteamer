// Tier 2 — changing what an INSTALLED package draws, from the workspace, without copying it.
//
// Three capabilities, one shape: a package's ui-view or a package collection's default display is
// refined by a small source in the workspace module that compile merges onto the package's own, so a
// changed column list is a few lines and every later fix the package ships still arrives. And the
// fourth, which is what makes a view authored here travel: `dt set ui-views/<id> module=<m>` moves its
// source into another module (a linked clone's included), through the compile gate.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, compileQuietly, compileError, readFile, writeModule, dt } from '../helpers/ws.js';
import { saveUiView, moveUiView, setCollectionScalars } from '../../src/schema-ops.ts';
import { overlayView, viewOverlayOf } from '../../src/views.ts';
import { Store } from '../../src/store.ts';
import { load, dump } from '../../src/yaml.ts';

const DOCTORS = {
	ids: { from: '{{ name | slug }}' },
	fields: {
		name: { type: 'string', required: true },
		city: { type: 'string' },
		status: { type: 'string', enum: ['active', 'retired'] },
		notes: { type: 'markdown', body: true },
	},
	display: { list: { columns: ['name', 'city'], sort: 'name', options: { page_size: 25, density: 'compact' } } },
};
const PKG_VIEW = {
	route: '/clinic/doctors',
	scope: 'collection',
	collection: 'collections/doctors',
	filter: { status: { _eq: 'active' } },
	display: { nav: { title: 'Doctors' }, list: { layout: 'table', columns: ['name', 'city'], sort: 'name' } },
};
const OVERLAY_FILE = 'modules/default/ui-views/clinic-doctors.ui-view.yaml';
const PKG_VIEW_FILE = 'node_modules/@acme/clinic/ui-views/clinic-doctors.ui-view.yaml';

/** A workspace with `@acme/clinic` INSTALLED — it ships the `doctors` collection and a view of it. */
function withPackage({ view = PKG_VIEW, extra } = {}) {
	const ws = workspace({ compile: false });
	const mod = path.join(ws.root, 'node_modules', '@acme', 'clinic');
	fs.mkdirSync(path.join(mod, 'ui-views'), { recursive: true });
	fs.mkdirSync(path.join(mod, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: '@acme/clinic', dreamteamer: {} }, null, '\t'));
	fs.writeFileSync(path.join(mod, 'collections', 'doctors.collection.yaml'), dump({ name: 'doctors', ...DOCTORS }));
	fs.writeFileSync(path.join(mod, 'ui-views', 'clinic-doctors.ui-view.yaml'), dump(view));
	const pkgPath = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, '@acme/clinic': '*' };
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t'));
	ws.ws.pkg = pkg;
	extra?.(ws);
	ws.git(['add', '-A']);
	ws.git(['commit', '-qm', 'fixture: the clinic package']);
	const out = compileQuietly(ws.ws);
	assert.equal(out.code, 0, out.stdout);
	ws.store = new Store(ws.ws);
	ws.dt = (...a) => dt(ws.root, ...a);
	return ws;
}
const compiledView = (ws, id = 'clinic-doctors') => load(readFile(ws.root, `.dreamteamer/ui-views/${id}.ui-view.yaml`));
const writeOverlay = (ws, body) => {
	fs.mkdirSync(path.join(ws.root, 'modules/default/ui-views'), { recursive: true });
	fs.writeFileSync(path.join(ws.root, OVERLAY_FILE), dump(body));
};

describe('the overlay grammar', () => {
	test('deep, overlay wins at a leaf, a list is replaced whole, null removes', () => {
		const merged = overlayView(PKG_VIEW, { filter: null, display: { list: { columns: ['city'] } } });
		assert.equal(merged.filter, undefined);
		assert.deepEqual(merged.display.list, { layout: 'table', columns: ['city'], sort: 'name' });
		assert.deepEqual(merged.display.nav, { title: 'Doctors' });
	});

	test('viewOverlayOf is its inverse, and empty when nothing differs', () => {
		const view = { ...PKG_VIEW, filter: undefined, display: { ...PKG_VIEW.display, list: { ...PKG_VIEW.display.list, sort: '-city' } } };
		delete view.filter;
		const delta = viewOverlayOf(PKG_VIEW, view);
		assert.deepEqual(delta, { filter: null, display: { list: { sort: '-city' } } });
		assert.deepEqual(overlayView(PKG_VIEW, delta), view);
		assert.deepEqual(viewOverlayOf(PKG_VIEW, structuredClone(PKG_VIEW)), {});
	});
});

describe('compile merges a ui-view overlay onto the package view', () => {
	test('the merged view is what compiles, and it names where it came from and who overlaid it', () => {
		const ws = withPackage();
		writeOverlay(ws, { overlay: true, display: { list: { columns: ['name', 'status'] } } });
		assert.equal(compileQuietly(ws.ws).code, 0);
		const v = compiledView(ws);
		assert.deepEqual(v.display.list.columns, ['name', 'status']);
		assert.equal(v.display.list.sort, 'name', 'a key the overlay does not name is the package\'s');
		assert.equal(v.route, '/clinic/doctors');
		assert.equal(v.overlay, undefined, 'the flag is the source\'s, not the view\'s');
		assert.equal(v.compiled.module, 'clinic');
		assert.deepEqual(v.compiled.overlaid_by, ['default']);
		const entry = load(readFile(ws.root, '.dreamteamer/manifest.yaml')).entries['ui-views/clinic-doctors.ui-view.yaml'];
		assert.deepEqual(entry.sources.map((s) => s.path), [PKG_VIEW_FILE, OVERLAY_FILE], 'both sources are provenance, so either changing makes the runtime stale');
	});

	test('the flag line may carry a comment — the parsed flag decides, not the line\'s spelling', () => {
		const ws = withPackage();
		fs.mkdirSync(path.join(ws.root, 'modules/default/ui-views'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, OVERLAY_FILE), `overlay: true   # the clinic wants a status column\n${dump({ display: { list: { columns: ['name', 'status'] } } })}`);
		assert.equal(compileQuietly(ws.ws).code, 0);
		assert.deepEqual(compiledView(ws).display.list.columns, ['name', 'status']);
	});

	test('a view WITHOUT overlay: true and the same id is still the collision', () => {
		const ws = withPackage();
		writeOverlay(ws, { ...PKG_VIEW, route: '/mine' });
		assert.match(compileError(ws.ws), /name collision on ui-view "clinic-doctors"/);
	});

	test('an overlay with no view to refine is refused by name', () => {
		const ws = withPackage();
		fs.mkdirSync(path.join(ws.root, 'modules/default/ui-views'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/default/ui-views/nobody.ui-view.yaml'), dump({ overlay: true, display: { list: { sort: 'name' } } }));
		assert.match(compileError(ws.ws), /an overlay of ui-view "nobody".*no module ships a view "nobody"/s);
	});

	test('the merged view is validated: an overlay naming a field the collection lacks fails compile', () => {
		const ws = withPackage();
		writeOverlay(ws, { overlay: true, display: { list: { columns: ['name', 'shoe_size'] } } });
		assert.match(compileError(ws.ws), /shoe_size/);
	});
});

describe('Save over a package\'s view writes the overlay', () => {
	const edited = (patch) => overlayView(PKG_VIEW, patch);

	test('only the keys that differ land in the workspace module; the package source is untouched', () => {
		const ws = withPackage();
		const res = saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: edited({ display: { list: { sort: '-city' } } }) });
		assert.equal(res.overlay, true);
		assert.equal(path.relative(ws.root, res.file), OVERLAY_FILE);
		assert.deepEqual(load(readFile(ws.root, OVERLAY_FILE)), { overlay: true, display: { list: { sort: '-city' } } });
		assert.deepEqual(load(readFile(ws.root, PKG_VIEW_FILE)), PKG_VIEW);
		assert.equal(compiledView(ws).display.list.sort, '-city', 'the save is live: it takes precedence over the shipped view');
	});

	test('a second save REWRITES the overlay from the package source, never stacks on it', () => {
		const ws = withPackage();
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: edited({ display: { list: { sort: '-city' } } }) });
		const store = new Store(ws.ws);
		saveUiView(ws.ws, store, { id: 'clinic-doctors', view: edited({ filter: null }) });
		assert.deepEqual(load(readFile(ws.root, OVERLAY_FILE)), { overlay: true, filter: null }, 'the sort went back to the package\'s, and the filter is removed');
		assert.equal(compiledView(ws).filter, undefined);
	});

	test('saving the package view as it is removes the overlay', () => {
		const ws = withPackage();
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: edited({ display: { list: { sort: '-city' } } }) });
		const res = saveUiView(ws.ws, new Store(ws.ws), { id: 'clinic-doctors', view: structuredClone(PKG_VIEW) });
		assert.equal(res.removed, true);
		assert.equal(readFile(ws.root, OVERLAY_FILE), null);
		assert.equal(compiledView(ws).display.list.sort, 'name');
	});

	test('a save naming a node_modules module is refused before anything is written', () => {
		const ws = withPackage();
		assert.throws(() => saveUiView(ws.ws, ws.store, { id: 'mine', view: { ...PKG_VIEW, route: '/mine' }, moduleId: 'clinic' }), /ships from node_modules.*pick a module/s);
		assert.equal(fs.existsSync(path.join(ws.root, 'node_modules/@acme/clinic/ui-views/mine.ui-view.yaml')), false);
	});

	test('the CLI set on a package view writes the overlay too', () => {
		const ws = withPackage();
		const res = ws.dt('set', 'ui-views/clinic-doctors', 'display.list.columns=name,status');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(load(readFile(ws.root, OVERLAY_FILE)), { overlay: true, display: { list: { columns: ['name', 'status'] } } });
	});
});

describe('dt set ui-views/<id> module=<m> moves the view', () => {
	function withTwoModules() {
		const ws = withPackage({ extra: (w) => writeModule(w.root, 'reports') });
		const add = ws.dt('add', 'ui-views', '--route', '/by-status', '--scope', 'collection', '--collection', 'collections/doctors', 'display.list.layout=kanban', 'display.list.options.group_by=status');
		assert.equal(add.code, 0, add.stderr);
		return ws;
	}

	test('the source moves, bytes and all, and the old file is gone', () => {
		const ws = withTwoModules();
		const file = path.join(ws.root, 'modules/default/ui-views/by-status.ui-view.yaml');
		fs.writeFileSync(file, `# the board the clinic asked for\n${fs.readFileSync(file, 'utf8')}`);
		ws.git(['add', '--', 'modules/default/ui-views/by-status.ui-view.yaml']);
		ws.git(['commit', '-qm', 'note']);
		const before = fs.readFileSync(file, 'utf8');
		const res = ws.dt('set', 'ui-views/by-status', 'module=reports');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /default → reports/);
		assert.equal(readFile(ws.root, 'modules/default/ui-views/by-status.ui-view.yaml'), null);
		assert.equal(readFile(ws.root, 'modules/reports/ui-views/by-status.ui-view.yaml'), before);
		assert.equal(compileQuietly(ws.ws).code, 0);
		assert.match(ws.git(['log', '-1', '--format=%s']), /ui-views set by-status module=reports/);
		assert.equal(ws.git(['status', '--porcelain', '--', 'modules']), '', 'one commit holds both halves of the move');
	});

	test('--dry-run writes nothing', () => {
		const ws = withTwoModules();
		const res = ws.dt('set', 'ui-views/by-status', 'module=reports', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'modules/default/ui-views/by-status.ui-view.yaml'));
		assert.equal(readFile(ws.root, 'modules/reports/ui-views/by-status.ui-view.yaml'), null);
	});

	test('module= with other keys is refused — a move and an edit are two commands', () => {
		const ws = withTwoModules();
		const res = ws.dt('set', 'ui-views/by-status', 'module=reports', 'display.list.sort=name');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr, /two commands/);
	});

	test('a node_modules module is never a destination, and a package view never moves', () => {
		const ws = withTwoModules();
		assert.throws(() => moveUiView(ws.ws, new Store(ws.ws), 'by-status', 'clinic'), /ships from node_modules/);
		assert.throws(() => moveUiView(ws.ws, new Store(ws.ws), 'clinic-doctors', 'reports'), /shipped by an installed package/);
		assert.throws(() => moveUiView(ws.ws, new Store(ws.ws), 'nope', 'reports'), /does not exist/);
	});
});

describe('a package collection\'s DEFAULT display, changed from the workspace', () => {
	const OVERLAY = 'modules/default/collections/doctors.collection.yaml';

	test('a display write becomes a workspace overlay carrying only the keys that differ', () => {
		const ws = withPackage();
		const res = setCollectionScalars(ws.ws, ws.store, 'doctors', { 'display.list.columns': 'name,status', 'display.list.sort': 'name' });
		assert.equal(res.overlay, true);
		assert.deepEqual(res.peer, { collection: 'doctors', module: 'default' }, 'the result names the declaration it wrote');
		assert.equal(path.relative(ws.root, res.file), OVERLAY);
		const doc = load(readFile(ws.root, OVERLAY));
		assert.equal(doc.overlay, true);
		assert.deepEqual(doc.display, { list: { columns: ['name', 'status'] } }, 'the sort equals the package\'s, so it is not restated');
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/doctors.collection.yaml'));
		assert.deepEqual(compiled.display.list.columns, ['name', 'status']);
		assert.deepEqual(JSON.parse(readFile(ws.root, 'modules/default/package.json')).dreamteamer.peer_collections, ['doctors'],
			'the declaration compile requires of an overlay is written in the same save, not handed back as a remedy');
		assert.equal(load(readFile(ws.root, 'node_modules/@acme/clinic/collections/doctors.collection.yaml')).display.list.columns.includes('status'), false, 'the package source is untouched');
	});

	test('one changed option is written with the package\'s other options, so none is dropped', () => {
		const ws = withPackage();
		setCollectionScalars(ws.ws, ws.store, 'doctors', { 'display.list.options.page_size': '50' });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/doctors.collection.yaml'));
		assert.deepEqual(compiled.display.list.options, { page_size: 50, density: 'compact' });
	});

	test('setting it back to the package\'s value removes the overlay', () => {
		const ws = withPackage();
		setCollectionScalars(ws.ws, ws.store, 'doctors', { 'display.list.sort': '-city' });
		const res = setCollectionScalars(ws.ws, new Store(ws.ws), 'doctors', { 'display.list.sort': 'name' });
		assert.equal(res.removed, true);
		assert.equal(readFile(ws.root, OVERLAY), null);
	});

	test('a key that is not display is still the owner\'s, and says what CAN be changed', () => {
		const ws = withPackage();
		assert.throws(() => setCollectionScalars(ws.ws, ws.store, 'doctors', { description: 'mine' }), /display\.\* keys can be changed from here/);
	});

	test('the CLI spelling — and its result line says the peer declaration it wrote', () => {
		const ws = withPackage();
		const res = ws.dt('set', 'collections/doctors', 'display.list.columns=name,status');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, OVERLAY));
		assert.match(res.stdout, /display\.list\.columns, and declared doctors as a peer collection of default/);
		const again = ws.dt('set', 'collections/doctors', 'display.list.columns=name,city,status');
		assert.equal(again.code, 0, again.stderr);
		assert.doesNotMatch(again.stdout, /declared/, 'once declared, a later save writes no declaration and claims none');
	});
});
