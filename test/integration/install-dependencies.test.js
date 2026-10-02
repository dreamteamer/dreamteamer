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
import { dump, load } from '../../src/yaml.js';
import { isRuntime } from '../../src/descriptor.js';

/** A compiled descriptor's text, read as a runtime kind — its records are build output compile writes. */
const compiledAsRuntime = (text) => isRuntime(load(text ?? '') ?? {});

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

const writeProbe = (root) => {
	const probe = path.join(root, 'modules', WS_MODULE, 'probes', 'first.probe.yaml');
	fs.mkdirSync(path.dirname(probe), { recursive: true });
	fs.writeFileSync(probe, dump({ name: 'first' }));
};

/** The PUBLIC installer, called the way an API consumer calls it — `installCommand(await
 *  openWorkspace(root), argv)` and no options — in a child process, so its board stays out of the
 *  test runner's stdout. */
const apiInstall = (cwd, ...argv) => {
	const script = `import { openWorkspace, installCommand } from ${JSON.stringify(path.join(ENGINE_ROOT, 'src', 'api.js'))};
process.exitCode = await installCommand(await openWorkspace(process.cwd()), ${JSON.stringify(argv)});`;
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** A workspace whose node_modules holds ONLY the dev-linked engine, and which declares an extension
 *  (`probe-kit`, a local file: package) that is not installed yet — a fresh checkout. */
function freshCheckout({ missing = 'probe-kit', withProbe = true } = {}) {
	const ws = workspace({ compile: false });
	const vendor = path.join(ws.root, 'vendor', 'probe-kit');
	fs.mkdirSync(path.join(vendor, 'collections'), { recursive: true });
	fs.writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'probe-kit', version: '1.0.0', description: 'A test extension.', dreamteamer: { extension: './ext.js' } }));
	fs.writeFileSync(path.join(vendor, 'ext.js'), ENTRY);
	fs.writeFileSync(path.join(vendor, 'collections', 'probes.collection.yaml'), dump({
		name: 'probes', description: 'A claim.', storage: { path: 'probes', format: 'yaml', shape: 'file', suffix: 'probe' },
		ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true } },
	}));
	if (withProbe) writeProbe(ws.root);
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
		assert.ok(compiledAsRuntime(descriptor), 'the contributed kind compiled as an ordinary collection');
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

describe('the PUBLIC installer compiles with the activated extensions by default (review R1)', () => {
	test('the checkout layer refuses to run without an opener, rather than defaulting to one that loads no extension', async () => {
		const { installCommand } = await import('../../src/checkout.js');
		await assert.rejects(installCommand({ root: '/nowhere', pkg: {} }, []), /opts\.open .* is required/);
	});

	test('an extension installed BEFORE the call: its kind compiles, and the manifest names it', () => {
		const ws = freshCheckout();
		// already in node_modules — no npm run at all, only the compile step's reopen
		fs.cpSync(path.join(ws.root, 'vendor', 'probe-kit'), path.join(ws.root, 'node_modules', 'probe-kit'), { recursive: true });
		const r = apiInstall(ws.root);
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.match(readFile(ws.root, '.dreamteamer/manifest.yaml') ?? '', /extensions:\n {2}- name: probe-kit/);
		assert.ok(compiledAsRuntime(readFile(ws.root, '.dreamteamer/collections/probes.collection.yaml')));
		assert.match(r.stdout + r.stderr, /probe-kit judged 1 probe/);
	});

	test('an extension npm installs DURING the call is activated before the compile', () => {
		const ws = freshCheckout();
		const r = apiInstall(ws.root, '--json');
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.match(readFile(ws.root, '.dreamteamer/manifest.yaml') ?? '', /extensions:\n {2}- name: probe-kit/);
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'probes', 'first.probe.yaml')));
	});
});

describe('installing a dependency into an ALREADY COMPILED workspace compiles it in (review R2)', () => {
	test('one install: the provider and its collection reach the runtime, and a second compile changes nothing', () => {
		const ws = freshCheckout({ withProbe: false });
		assert.equal(run(ws.root, 'compile').code, 0);
		// compile's output (.dreamteamer/ and the root harness files) is gitignored, so the compiled
		// workspace has nothing left to commit
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
		const r = run(ws.root, 'install', '--json');
		assert.equal(r.code, 0, r.stderr);
		const steps = JSON.parse(r.stdout).steps;
		assert.equal(steps.find((s) => s.id === 'dependencies').state, 'todo');
		assert.equal(steps.find((s) => s.id === 'compile').state, 'todo', 'the compile step was decided before npm installed anything');
		const manifest = readFile(ws.root, '.dreamteamer/manifest.yaml');
		assert.match(manifest, /extensions:\n {2}- name: probe-kit/, 'the provider npm installed never reached the runtime');
		const descriptor = readFile(ws.root, '.dreamteamer/collections/probes.collection.yaml');
		assert.ok(compiledAsRuntime(descriptor), 'the installed module\'s collection was not compiled');
		const semantic = (m) => m.replace(/^compiled: .*\n/m, '');
		assert.equal(run(ws.root, 'compile').code, 0);
		assert.equal(semantic(readFile(ws.root, '.dreamteamer/manifest.yaml')), semantic(manifest));
	});
});

describe('a DANGLING link in node_modules is npm\'s to repair, never a development link to restore (review R3)', () => {
	test('npm replaces the broken link, the working engine link is kept, and a repeat install is clean', () => {
		const ws = freshCheckout();
		const broken = path.join(ws.root, 'node_modules', 'probe-kit');
		fs.symlinkSync('../old-moved-probe', broken);
		const engine = path.join(ws.root, 'node_modules', 'dreamteamer');
		const engineTarget = fs.readlinkSync(engine);
		const r = run(ws.root, 'install');
		assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
		assert.doesNotMatch(r.stderr, /kept the development link node_modules\/probe-kit/);
		assert.equal(fs.realpathSync(broken), fs.realpathSync(path.join(ws.root, 'vendor', 'probe-kit')), 'the repaired dependency was replaced by the dangling link again');
		assert.equal(fs.readlinkSync(engine), engineTarget, 'the working development engine link was not kept');
		const again = run(ws.root, 'install', '--json');
		assert.equal(again.code, 0, again.stderr);
		assert.equal(JSON.parse(again.stdout).steps.find((s) => s.id === 'dependencies').state, 'already');
	});
});
