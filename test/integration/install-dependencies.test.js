// `dt install` and the packages it installs — two defects from the 0.31.0 review, both about the
// moment npm puts NEW code into node_modules:
//
//   F1 — the handle was opened BEFORE npm ran, so the first install compiled without the extension it
//        had just installed (its collection compiled as an ordinary one, the manifest had no provider)
//        and only a second, manual compile repaired it.
//   F3 — readiness was "node_modules/dreamteamer resolves", so a checkout whose engine is a dev LINK
//        read as ready while a declared extension was missing: npm never ran.
//
// npm runs for real here, OFFLINE: every dependency is a `file:` path, including the engine itself.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, readFile, git, ENGINE_ROOT, WS_MODULE } from '../helpers/ws.js';
import { dump } from '../../src/yaml.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const run = (cwd, ...args) => {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const ENTRY = `export const apiVersion = 1;
export default () => ({
	sourceKinds: [{ kind: 'probes' }],
	analyze(draft) {
		const n = [...draft.entries.keys()].filter((k) => k.startsWith('probes/')).length;
		return { notes: ['probe-kit judged ' + n + ' probe(s)'] };
	},
});
`;

/** A workspace whose node_modules holds ONLY the dev-linked engine, and which declares an extension
 *  (`probe-kit`, a local file: package) that is not installed yet — a fresh checkout. */
function freshCheckout({ missing = 'probe-kit' } = {}) {
	const ws = workspace({ compile: false });
	const vendor = path.join(ws.root, 'vendor', 'probe-kit');
	fs.mkdirSync(path.join(vendor, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'probe-kit', version: '1.0.0', description: 'A test extension.', dreamteamer: { extension: './ext.js' } }));
	fs.writeFileSync(path.join(vendor, 'ext.js'), ENTRY);
	fs.writeFileSync(path.join(vendor, 'collections', 'probes.collection.yaml'), dump({
		name: 'probes', description: 'A claim.', storage: { path: 'probes', codec: 'yaml', shape: 'file', suffix: 'probe' },
		id: { generate: '{{ name | slug }}' }, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
	}));
	const probe = path.join(ws.root, 'modules', WS_MODULE, 'probes', 'first.probe.yaml');
	fs.mkdirSync(path.dirname(probe), { recursive: true });
	fs.writeFileSync(probe, dump({ name: 'first' }));
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	// every dependency is a local path, so npm needs no registry; the engine stays the dev LINK the
	// fixture already made (node_modules/dreamteamer → this checkout)
	pkg.dependencies = { dreamteamer: `file:${ENGINE_ROOT}`, [missing]: missing === 'probe-kit' ? 'file:./vendor/probe-kit' : `file:./vendor/${missing}` };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixture: declares probe-kit']);
	return ws;
}

describe('dt install brings in what the workspace declares, and compiles WITH it', () => {
	test('one install: the extension is loaded, its kind is a runtime collection, and a second compile changes nothing', () => {
		const ws = freshCheckout();
		assert.ok(!fs.existsSync(path.join(ws.root, 'node_modules', 'probe-kit')), 'the fixture must start without the extension');
		const r = run(ws.root, 'install', '--json');
		assert.equal(r.code, 0, r.stderr);
		const board = JSON.parse(r.stdout);
		assert.equal(board.steps.find((s) => s.id === 'dependencies').state, 'todo', 'the missing extension did not make npm run');
		assert.ok(fs.existsSync(path.join(ws.root, 'node_modules', 'probe-kit', 'package.json')), 'npm did not install the declared extension');
		const manifest = readFile(ws.root, '.dreamteamer/manifest.yaml');
		assert.match(manifest, /extensions:\n {2}- name: probe-kit/, 'the first compile ran without the extension npm had just installed');
		const descriptor = readFile(ws.root, '.dreamteamer/collections/probes.collection.yaml');
		assert.match(descriptor, /base: runtime/, 'the contributed kind compiled as an ordinary collection');
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes', 'first.probe.yaml')), 'the probe was not staged on the first install');
		assert.match(r.stderr, /probe-kit judged 1 probe/, 'the extension\'s analysis did not take part in the first install');
		// no semantic repair left for a second compile to make
		assert.equal(run(ws.root, 'compile').code, 0);
		assert.equal(readFile(ws.root, '.dreamteamer/collections/probes.collection.yaml'), descriptor);
	});

	test('the dev-linked engine survives npm, and a second install has nothing to do', () => {
		const ws = freshCheckout();
		const link = path.join(ws.root, 'node_modules', 'dreamteamer');
		const before = fs.readlinkSync(link);
		assert.equal(run(ws.root, 'install').code, 0);
		assert.ok(fs.lstatSync(link).isSymbolicLink(), 'npm replaced the development engine link with a copy');
		assert.equal(fs.readlinkSync(link), before, 'the development engine link now points somewhere else');
		const again = run(ws.root, 'install', '--json');
		assert.equal(again.code, 0, again.stderr);
		assert.equal(JSON.parse(again.stdout).steps.find((s) => s.id === 'dependencies').state, 'already');
	});

	test('a dependency npm cannot install fails the install — never a green board over a missing package', () => {
		const ws = freshCheckout({ missing: 'no-such-package' });
		const r = run(ws.root, 'install', '--json');
		assert.equal(r.code, 1, 'an npm failure reported success');
		assert.match(JSON.parse(r.stdout).log.join('\n'), /dependencies failed/);
	});
});
