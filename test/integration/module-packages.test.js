// A PACKAGE OF MODULES: one npm dependency (or one git clone) whose root carries `modules/` delivers
// several modules at once, and a bare `dreamteamer.disable` entry drops whole ones — the
// cherry-pick. Before this, one dependency was exactly one module, so a family of related modules
// meant a repo (and an install) per module, or a root that tried to be all of them at once.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, compileQuietly, compileError, simpleCollection, writeModule } from '../helpers/ws.js';
import { discoverModules } from '../../src/compile.js';
import { dump } from '../../src/yaml.js';

/** A bundle at `dir`: a root package.json carrying the `dreamteamer` marker and `modules/<m>/` each
 *  shipping one collection named after the module. */
function bundle(dir, rootName, modules, { marker = {} } = {}) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: rootName, version: '0.0.1', dreamteamer: marker }, null, '\t'));
	for (const m of modules) {
		const mroot = path.join(dir, 'modules', m);
		fs.mkdirSync(path.join(mroot, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(mroot, 'package.json'), JSON.stringify({ name: m, version: '0.0.1', dreamteamer: { description: `the ${m} module` } }, null, '\t'));
		fs.writeFileSync(path.join(mroot, 'collections', `${m}.collection.yaml`), dump({ name: m, ...simpleCollection() }));
	}
}

/** The workspace with an npm dependency `@acme/pack` declared and installed as a bundle. */
function withNpmBundle(modules, disable) {
	const { root } = workspace({ compile: false });
	const pkgPath = path.join(root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, '@acme/pack': '0.0.1' };
	if (disable) pkg.dreamteamer.disable = disable;
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	bundle(path.join(root, 'node_modules', '@acme', 'pack'), '@acme/pack', modules);
	return { root, pkg };
}

const compiledCollections = (root) => fs.readdirSync(path.join(root, '.dreamteamer', 'collections')).filter((f) => f.endsWith('.collection.yaml')).map((f) => f.replace('.collection.yaml', ''));

describe('a dependency whose root carries modules/ is a package of modules', () => {
	test('each sub-module is discovered on the npm channel; the root itself is not a module', () => {
		const ws = withNpmBundle(['crates', 'lanes']);
		const { modules } = discoverModules(ws.root, ws.pkg);
		const byName = Object.fromEntries(modules.map((m) => [m.name, m]));
		assert.ok(byName.crates && byName.lanes, `sub-modules missing: ${Object.keys(byName).join(', ')}`);
		assert.equal(byName.crates.channel, 'npm');
		assert.ok(byName.crates.root.endsWith(path.join('@acme', 'pack', 'modules', 'crates')));
		assert.equal(byName['@acme/pack'], undefined, 'the bundle root must not be compiled as a module of its own');
		const { code } = compileQuietly(ws);
		assert.equal(code, 0);
		const compiled = compiledCollections(ws.root);
		assert.ok(compiled.includes('crates') && compiled.includes('lanes'), compiled.join(', '));
	});

	test('a git_modules clone with modules/ unpacks the same way, on the git channel', () => {
		const { root, ws } = workspace({ compile: false });
		bundle(path.join(root, 'git_modules', 'family'), 'family', ['crates']);
		const { modules } = discoverModules(root, ws.pkg);
		const crates = modules.find((m) => m.name === 'crates');
		assert.ok(crates, 'the clone\'s sub-module was not discovered');
		assert.equal(crates.channel, 'git');
		assert.equal(modules.find((m) => m.name === 'family'), undefined);
	});

	test('a dependency root WITHOUT modules/ is still exactly one module (the shape every existing consumer relies on)', () => {
		const { root } = workspace({ compile: false });
		const pkgPath = path.join(root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		pkg.dependencies = { ...pkg.dependencies, '@acme/solo': '0.0.1' };
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		const dir = path.join(root, 'node_modules', '@acme', 'solo');
		fs.mkdirSync(path.join(dir, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'solo', version: '0.0.1', dreamteamer: { description: 'one module' } }));
		fs.writeFileSync(path.join(dir, 'collections', 'solo.collection.yaml'), dump({ name: 'solo', ...simpleCollection() }));
		const { modules } = discoverModules(root, pkg);
		const solo = modules.find((m) => m.name === 'solo');
		assert.ok(solo && solo.channel === 'npm' && solo.root === dir);
	});

	test('an INLINE module never unpacks — a modules/ folder inside modules/<m> is still the unknown-folder error', () => {
		const { root, ws } = workspace({ compile: false });
		writeModule(root, 'inline', { collections: { inline: simpleCollection() } });
		fs.mkdirSync(path.join(root, 'modules', 'inline', 'modules', 'nested'), { recursive: true });
		fs.writeFileSync(path.join(root, 'modules', 'inline', 'modules', 'nested', 'package.json'), JSON.stringify({ name: 'nested', dreamteamer: {} }));
		const { modules } = discoverModules(root, ws.pkg);
		assert.equal(modules.find((m) => m.name === 'nested'), undefined, 'inline modules must not bundle');
		const err = compileError(ws);
		assert.ok(err && /modules/.test(err), `expected the unknown-folder refusal, got: ${err}`);
	});
});

describe('a bare dreamteamer.disable entry drops a whole module', () => {
	test('the disabled module is neither discovered nor compiled, and the entry counts as matched', () => {
		const ws = withNpmBundle(['crates', 'lanes'], ['lanes']);
		const { modules, disabledModules } = discoverModules(ws.root, ws.pkg);
		assert.deepEqual(modules.map((m) => m.name).filter((n) => n === 'lanes'), []);
		assert.deepEqual(disabledModules, ['lanes']);
		const { code, warnings } = compileQuietly(ws);
		assert.equal(code, 0);
		const compiled = compiledCollections(ws.root);
		assert.ok(compiled.includes('crates') && !compiled.includes('lanes'), compiled.join(', '));
		assert.ok(!warnings.some((w) => w.includes('"lanes" matched nothing')), warnings.join('\n'));
	});

	test('a bare entry that names no module still warns, exactly like an entity entry that matches nothing', () => {
		const ws = withNpmBundle(['crates'], ['ghost']);
		const { warnings } = compileQuietly(ws);
		assert.ok(warnings.some((w) => w.includes('dreamteamer.disable entry "ghost" matched nothing')), warnings.join('\n'));
	});

	test('disabling a module another one depends on fails loudly, naming what is present', () => {
		const ws = withNpmBundle(['crates', 'lanes'], ['crates']);
		const lanesPkg = path.join(ws.root, 'node_modules', '@acme', 'pack', 'modules', 'lanes', 'package.json');
		const p = JSON.parse(fs.readFileSync(lanesPkg, 'utf8'));
		p.dreamteamer.dependencies = ['crates'];
		fs.writeFileSync(lanesPkg, JSON.stringify(p));
		const err = compileError(ws);
		assert.ok(err && /depends on "crates", which is not installed/.test(err), err);
	});
});
