// Tier 2 — the setup convention adds NO engine contract (CR-dt-005 Stage A): a module's setup
// instructions are a `SETUP.md` at the module root compile already discovered, found through the
// manifest's `modules[].root` — and a module without one is doctor-only, on the API 1 board unchanged.
// What is pinned here is what the reference (`references/setup.md`) tells an agent to rely on.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspace, dt, compileQuietly, ENGINE_ROOT } from '../helpers/ws.js';
import { readManifest } from '../../src/runtime.js';

const SETUP = '# setup\n\nCommands: `dt fixture-kit verify` (synthetic).\n';
const json = (o) => JSON.stringify(o, null, '\t') + '\n';

function put(dir, files) {
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
}
/** Every workspace file (hash + mtime), node_modules/ and .git/ PRUNED BEFORE DESCENT and no link
 *  followed — the engine is linked into node_modules, and a recursive readdir through it never ends. */
function files(root, dir = '', out = {}) {
	for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = path.join(dir, e.name), p = path.join(root, rel);
		if (e.isDirectory()) { if (!(dir === '' && ['node_modules', '.git'].includes(e.name))) files(root, rel, out); }
		else if (e.isFile()) out[rel] = `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.lstatSync(p).mtimeMs}`;
	}
	return out;
}
const skill = (name) => ({ [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: "use when testing ${name}"\n---\n\nA fixture.\n` });

/** Every channel and every policy the convention leans on, in one workspace:
 *  inline `alpha` (SETUP.md) · direct dependency `beta-kit`, an extension with doctor rows (SETUP.md) ·
 *  direct dependency `gamma-kit`, an extension whose doctor returns NO rows and ships no SETUP.md ·
 *  bundle `kit-bundle` whose sub-module `delta` carries SETUP.md · `hidden-kit`, in node_modules but
 *  never declared (transitive) · inline `off`, disabled. The last two carry a SETUP.md nobody may follow. */
function fixture() {
	const ws = workspace({ compile: false, pkg: { disable: ['modules/off'] } });
	const nm = (name) => path.join(ws.root, 'node_modules', name);
	put(path.join(ws.root, 'modules', 'alpha'), { 'package.json': json({ name: 'alpha', description: 'Inline fixture.', dreamteamer: {} }), 'SETUP.md': SETUP, ...skill('alpha-guide') });
	put(path.join(ws.root, 'modules', 'off'), { 'package.json': json({ name: 'off', description: 'Disabled fixture.', dreamteamer: {} }), 'SETUP.md': SETUP, ...skill('off-guide') });
	put(nm('beta-kit'), {
		'package.json': json({ name: 'beta-kit', version: '1.0.0', description: 'Extension fixture.', files: ['ext.js', 'SETUP.md', 'skills'], dreamteamer: { extension: './ext.js' } }),
		'ext.js': `export default () => ({ doctor: () => [{ label: 'config', state: 'ok', detail: 'present' }, { label: 'sign-in', state: 'warn', detail: 'not verified', fix: 'see SETUP.md' }] });\n`,
		'SETUP.md': SETUP, ...skill('beta-guide'),
	});
	put(nm('gamma-kit'), {
		'package.json': json({ name: 'gamma-kit', version: '1.0.0', description: 'Doctor-only fixture.', dreamteamer: { extension: './ext.js' } }),
		'ext.js': 'export default () => ({ doctor: () => [] });\n', ...skill('gamma-guide'),
	});
	put(nm('kit-bundle'), { 'package.json': json({ name: 'kit-bundle', version: '1.0.0', dreamteamer: {} }) });
	put(path.join(nm('kit-bundle'), 'modules', 'delta'), { 'package.json': json({ name: 'delta', description: 'Bundled fixture.', dreamteamer: {} }), 'SETUP.md': SETUP, ...skill('delta-guide') });
	put(nm('hidden-kit'), { 'package.json': json({ name: 'hidden-kit', version: '1.0.0', dreamteamer: { extension: './ext.js' } }), 'ext.js': 'export default () => { throw new Error("a transitive package must never load"); };\n', 'SETUP.md': SETUP });
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, 'beta-kit': '1.0.0', 'gamma-kit': '1.0.0', 'kit-bundle': '1.0.0' };
	fs.writeFileSync(pkgFile, json(pkg));
	return ws;
}

describe('a module\'s SETUP.md is found through the manifest compile writes — no new contract', () => {
	test('inline, direct and bundled modules resolve <root>/SETUP.md; a transitive package, a disabled module and the bundle root itself do not appear; compile says nothing about the file', () => {
		const ws = fixture();
		const out = compileQuietly({ root: ws.root, pkg: JSON.parse(fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8')) });
		assert.equal(out.code, 0);
		assert.ok(!out.warnings.concat(out.stdout).some((l) => /SETUP/.test(l)), [...out.warnings, ...out.stdout].join('\n'));
		const modules = readManifest(ws.root).modules;
		const withSetup = modules.filter((m) => fs.existsSync(path.join(ws.root, m.root, 'SETUP.md'))).map((m) => m.name).sort();
		assert.deepEqual(withSetup, ['alpha', 'beta-kit', 'delta']);
		assert.ok(modules.some((m) => m.name === 'gamma-kit'), 'a module without SETUP.md is still a module');
		assert.ok(!modules.some((m) => ['hidden-kit', 'off', 'kit-bundle'].includes(m.name)), modules.map((m) => m.name).join(', '));
		assert.equal(modules.find((m) => m.name === 'delta').root, 'node_modules/kit-bundle/modules/delta');
	});

	test('dt doctor is the API 1 board unchanged: rows as the extension gave them, and NO rows still reads READY — and it writes nothing', () => {
		const ws = fixture();
		assert.equal(dt(ws.root, 'compile').code, 0);
		const before = files(ws.root);
		const r = dt(ws.root, 'doctor', '--json');
		assert.equal(r.code, 0, r.stderr);
		const caps = JSON.parse(r.stdout).capabilities;
		assert.deepEqual(caps.map((c) => [c.name, c.verdict]), [['engine', 'READY'], ['beta-kit', 'DEGRADED'], ['gamma-kit', 'READY']]);
		assert.deepEqual(caps[1].checks, [{ label: 'config', state: 'ok', detail: 'present' }, { label: 'sign-in', state: 'warn', detail: 'not verified', fix: 'see SETUP.md' }]);
		assert.deepEqual(caps[2].checks, [], 'an empty check list is the legacy READY — the reference, not the board, calls it no evidence');
		assert.equal(dt(ws.root, 'doctor', '--strict').code, 0);
		assert.deepEqual(files(ws.root), before, 'doctor wrote to the workspace');
	});
});

describe('the reference an agent follows', () => {
	const skillDir = path.join(ENGINE_ROOT, 'skills', 'using-dreamteamer');
	test('the digest routes setup to references/setup.md, and that page teaches the four verbs, the status words, consent and the no-catalog rule', () => {
		assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /\| "help me set this up".*\| `references\/setup\.md` \|/);
		const ref = fs.readFileSync(path.join(skillDir, 'references', 'setup.md'), 'utf8');
		for (const must of ['npx dreamteamer init', 'dt install <package>', 'dt setup <unit> --authorize', '**ready**', '**configured**', '**skipped**', '**blocked**', '**no setup**', '**no evidence**', 'never a file the engine ships', 'Never scan', 'one yes', 'exit 3']) {
			assert.ok(ref.includes(must), must);
		}
	});
});
