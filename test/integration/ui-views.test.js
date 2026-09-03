// Tier 2 — saving a ui-view, which is a SOURCE write and therefore a compile-gated schema op.
//
// The bug these exist for: `saveUiView` wrote every view into the WORKSPACE MODULE's `ui-views/`,
// whoever shipped it. For a view another inline module ships that produced a second file with the
// same id, compile refuses a name collision, and `writeGated` rolled the whole thing back — so the
// surface reported a collision error and the operator's edit vanished. Every module-shipped view in
// a multi-module workspace was unsaveable, and nothing said so.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, compileQuietly, readFile } from '../helpers/ws.js';
import { saveUiView, removeUiView } from '../../src/schema-ops.js';
import { load, dump } from '../../src/yaml.js';

const HEADER = '# Every doctor worth calling twice — the triage list.\n#\n# The whole file, explained.\n';
// A comment above a TOP-LEVEL key, which is where this vault keeps its ⚠ warnings — the reason
// `health-labs-abnormal.ui-view.yaml` says `filter:` is top-level and not `options.filter`.
const KEY_NOTE = '# ⚠ top-level, not nested — read by nothing if you move it.';

/** A workspace whose SECOND inline module ships a ui-view — the shape that could not be saved. */
function withModuleView(viewBody = {}) {
	const ws = workspace({ collections: { doctors: simpleCollection() } });
	const mod = path.join(ws.root, 'modules', 'clinic');
	fs.mkdirSync(path.join(mod, 'ui-views'), { recursive: true });
	fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'clinic', dreamteamer: {} }, null, '\t'));
	const body = dump({ path: '/clinic/doctors', target: 'list', collection: 'collections/doctors', layout: 'table', ...viewBody })
		.replace(/^layout:/m, `${KEY_NOTE}\nlayout:`);
	fs.writeFileSync(path.join(mod, 'ui-views', 'clinic-doctors.ui-view.yaml'), HEADER + body);
	// Committed, because that is the state a real module source is in — and `git add -- <path>` on a
	// DELETED file only works if the file was tracked, which is what the remove test needs.
	ws.git(['add', '-A']);
	ws.git(['commit', '-qm', 'fixture: the clinic module']);
	compileQuietly(ws.ws);
	return ws;
}

const VIEW = { path: '/clinic/doctors', target: 'list', collection: 'collections/doctors', layout: 'cards' };

describe('saveUiView writes the view where it already lives', () => {
	test("a view shipped by ANOTHER inline module is updated in place, not copied into the workspace module", () => {
		const ws = withModuleView();

		const res = saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });

		assert.equal(res.updated, true, 'it is an update, not a create');
		assert.equal(path.relative(ws.root, res.file), path.join('modules', 'clinic', 'ui-views', 'clinic-doctors.ui-view.yaml'));
		assert.equal(load(readFile(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml')).layout, 'cards');
		assert.equal(
			readFile(ws.root, 'modules/default/ui-views/clinic-doctors.ui-view.yaml'),
			null,
			'no second copy — a second copy is the collision',
		);
	});

	test('and the workspace still compiles afterwards — the collision is what used to roll the save back', () => {
		const ws = withModuleView();
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });
		const out = compileQuietly(ws.ws);
		assert.equal(out.code, 0);
	});

	test('the file\'s header comments survive the round-trip — a module source is where the WHY is written', () => {
		const ws = withModuleView();
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });
		const text = readFile(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml');
		assert.ok(text.startsWith(HEADER), `header lost:\n${text}`);
		assert.match(text, /layout: cards/);
	});

	test('a comment above a TOP-LEVEL key comes back above that same key', () => {
		const ws = withModuleView();
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });
		const text = readFile(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml');
		assert.match(text, new RegExp(`${KEY_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nlayout: cards`), text);
	});

	test('a comment whose key did NOT survive is dropped, never re-attached to something else', () => {
		const ws = withModuleView({ filter: { name: { _eq: 'Dana' } } });
		// annotate `filter:`, then save a view that has no filter at all
		const file = path.join(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml');
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^filter:/m, '# about the filter\nfilter:'));
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });
		assert.doesNotMatch(readFile(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml'), /about the filter/);
	});

	test('a key the caller omits is GONE — the write replaces, so clearing a filter clears it', () => {
		const ws = withModuleView({ filter: { name: { _eq: 'Dana' } } });
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });
		const doc = load(readFile(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml'));
		assert.equal(doc.filter, undefined);
	});

	test('a BRAND NEW view still lands in the workspace module', () => {
		const ws = workspace({ collections: { doctors: simpleCollection() } });
		const res = saveUiView(ws.ws, ws.store, { id: 'my-doctors', view: { ...VIEW, path: '/my/doctors' } });
		assert.equal(res.updated, false);
		assert.equal(path.relative(ws.root, res.file), path.join('modules', 'default', 'ui-views', 'my-doctors.ui-view.yaml'));
	});

	test('the save is ONE commit, naming the view', () => {
		const ws = withModuleView();
		const before = ws.git(['rev-parse', 'HEAD']);
		saveUiView(ws.ws, ws.store, { id: 'clinic-doctors', view: VIEW });
		assert.equal(ws.git(['rev-list', '--count', `${before}..HEAD`]), '1');
		assert.match(ws.git(['log', '-1', '--format=%s']), /ui-views update clinic-doctors/);
	});
});

describe('a view shipped by an INSTALLED package', () => {
	/** A module in `node_modules/` — the one place a source write is erased without warning. */
	function withInstalledView() {
		const ws = workspace({ collections: { doctors: simpleCollection() } });
		const mod = path.join(ws.root, 'node_modules', '@acme', 'views');
		fs.mkdirSync(path.join(mod, 'ui-views'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: '@acme/views', dreamteamer: {} }, null, '\t'));
		fs.writeFileSync(path.join(mod, 'ui-views', 'acme-doctors.ui-view.yaml'), dump({ ...VIEW, path: '/acme/doctors', layout: 'table' }));
		const pkgPath = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		pkg.dependencies = { ...pkg.dependencies, '@acme/views': '*' };
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t'));
		ws.ws.pkg = pkg; // the handle carries the package.json compile reads
		compileQuietly(ws.ws);
		return ws;
	}

	test('is refused with a message that names npm install', () => {
		const ws = withInstalledView();
		assert.throws(
			() => saveUiView(ws.ws, ws.store, { id: 'acme-doctors', view: VIEW }),
			/erased by the next npm install/,
		);
		// and the package source is untouched — a refusal that half-wrote would be worse than none
		assert.equal(load(readFile(ws.root, 'node_modules/@acme/views/ui-views/acme-doctors.ui-view.yaml')).layout, 'table');
	});

	test('and cannot be removed either — disable is the route', () => {
		const ws = withInstalledView();
		assert.throws(() => removeUiView(ws.ws, ws.store, 'acme-doctors'), /dreamteamer\.disable/);
		assert.ok(readFile(ws.root, 'node_modules/@acme/views/ui-views/acme-doctors.ui-view.yaml'));
	});
});

describe('removeUiView', () => {
	test('deletes an inline module\'s view, since a save may already write there', () => {
		const ws = withModuleView();
		removeUiView(ws.ws, ws.store, 'clinic-doctors');
		assert.equal(readFile(ws.root, 'modules/clinic/ui-views/clinic-doctors.ui-view.yaml'), null);
		assert.equal(compileQuietly(ws.ws).code, 0);
	});

	test('refuses one that does not exist', () => {
		const ws = workspace({ collections: { doctors: simpleCollection() } });
		assert.throws(() => removeUiView(ws.ws, ws.store, 'nope'), /does not exist/);
	});
});

// ---- the DOTTED value grammar `set-view` takes -------------------------------------------------
// Not about where a view is saved (above) but about what a `key=value` on the command line MEANS.
// Two of these used to have no spelling at all: a list option could only be written as JSON, and
// the one setting whose meaningful value is the empty string could not be written by any spelling.

describe('dt set ui-views/<id> — dotted values', () => {
	const viewed = () => {
		const ws = workspace({ collections: { doctors: simpleCollection() } });
		const add = ws.dt('add', 'ui-views', '--path', '/recent', '--target', 'list',
			'--collection', 'collections/doctors', '--layout', 'table');
		assert.equal(add.code, 0, add.stderr);
		return ws;
	};
	const saved = (ws) => load(readFile(ws.root, 'modules/default/ui-views/recent.ui-view.yaml'));

	test('options.columns=a,b is a LIST — the comma spelling every other verb takes', () => {
		const ws = viewed();
		const res = ws.dt('set', 'ui-views/recent', 'options.columns=name,notes');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(saved(ws).options.columns, ['name', 'notes'], 'a literal "name,notes" is read by nobody');
	});

	test('one column is still a list of one, and spaces around the commas are trimmed', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.columns=name').code, 0);
		assert.deepEqual(saved(ws).options.columns, ['name']);
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.columns=name, notes').code, 0);
		assert.deepEqual(saved(ws).options.columns, ['name', 'notes']);
	});

	test('the JSON form still works, and is the only spelling for a list of objects', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.columns=["name","notes"]').code, 0);
		assert.deepEqual(saved(ws).options.columns, ['name', 'notes']);
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.arrangement=[{"node":"a","x":1,"y":2}]').code, 0);
		assert.deepEqual(saved(ws).options.arrangement, [{ node: 'a', x: 1, y: 2 }]);
	});

	test('a comma in a SCALAR option stays one string — the key decides, not the comma', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.template=a, b').code, 0);
		assert.equal(saved(ws).options.template, 'a, b');
	});

	test('the flag form takes the same value grammar as the positional one', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', '--options.columns', 'name,notes').code, 0);
		assert.deepEqual(saved(ws).options.columns, ['name', 'notes']);
	});

	test('an EMPTY list option still removes the key, rather than showing no columns', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.columns=name,notes').code, 0);
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.columns=').code, 0);
		assert.equal(saved(ws).options?.columns, undefined);
	});
});

describe('dt set ui-views/<id> — the empty string that MEANS something', () => {
	const viewed = () => {
		const ws = workspace({ collections: { doctors: simpleCollection() } });
		const add = ws.dt('add', 'ui-views', '--path', '/recent', '--target', 'list',
			'--collection', 'collections/doctors', '--layout', 'table', 'options.sort=-name');
		assert.equal(add.code, 0, add.stderr);
		return ws;
	};
	const saved = (ws) => load(readFile(ws.root, 'modules/default/ui-views/recent.ui-view.yaml'));

	test("a QUOTED empty value writes sort: '' — what the surface needs to mean unsorted", () => {
		const ws = viewed();
		const res = ws.dt('set', 'ui-views/recent', 'options.sort=""');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(saved(ws).options.sort, '', 'the key must be PRESENT and empty, not absent');
		assert.ok('sort' in saved(ws).options);
	});

	test('and it survives a compile, so the record round-trips', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.sort=""').code, 0);
		assert.equal(compileQuietly(ws.ws).code, 0);
		assert.equal(ws.store.read('ui-views', 'recent').fields.options.sort, '');
	});

	test('a BARE empty value still removes the key — the convention is untouched', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.sort=').code, 0);
		assert.equal(saved(ws).options?.sort, undefined);
	});

	test('a quoted NON-empty value is that literal string', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', 'nav.label="Recent"', 'options.sort="-name"').code, 0);
		assert.equal(saved(ws).nav.label, 'Recent');
		assert.equal(saved(ws).options.sort, '-name');
	});

	test('the flag form takes it too', () => {
		const ws = viewed();
		assert.equal(ws.dt('set', 'ui-views/recent', '--options.sort', '""').code, 0);
		assert.equal(saved(ws).options.sort, '');
	});

	test('an unbalanced quote is named, not written', () => {
		const ws = viewed();
		const res = ws.dt('set', 'ui-views/recent', 'options.sort="-name');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /not a quoted string/);
		assert.equal(saved(ws).options.sort, '-name', 'the view is untouched');
	});
});
