// `dt status` gains a setup section and `dt doctor` renders a unit's checks as rows — both read-only,
// both from the unit's own inspect, never from a stored flag. The probe reaches every state.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, withProbeSetup, ENGINE_ROOT, git, treeHash } from '../helpers/ws.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const run = (root, args, env = {}) => {
	const home = path.join(root, '.home');
	fs.mkdirSync(home, { recursive: true });
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const probed = () => {
	const ws = workspace({ compile: false });
	withProbeSetup(ws.root);
	git(ws.root, ['add', '-A']); git(ws.root, ['commit', '-qm', 'fixture: probe']);
	const c = run(ws.root, ['compile']);
	assert.equal(c.code, 0, c.stderr);
	return ws;
};
/** The unit's line in the SETUP section (the modules section above it lists the same names). */
const line = (out, unit) => (out.split('setup:\n')[1] ?? '').split('\n').find((l) => new RegExp(`^  ${unit}\\s`).test(l)) ?? '';

describe('dt status — the setup section', () => {
	test('every state the probe can reach renders as the design\'s line, with the next command', () => {
		const ws = probed();
		const tok = path.join(ws.root, 'tok'); fs.writeFileSync(tok, 'x');
		const home = path.join(ws.root, 'phome');
		// nothing done yet: configured, with what is missing, pointing at dt setup
		let s = run(ws.root, ['status']);
		assert.equal(s.code, 0, s.stderr);
		assert.match(line(s.stdout, 'probe'), /^  probe\s+configured\s+probe home missing · token file missing · weights missing · tuned missing · live check unverified\s+→ dt setup probe/);
		// no evidence is never ready
		assert.match(line(run(ws.root, ['status'], { PROBE_EMPTY: '1' }).stdout, 'probe'), /no evidence/);
		// after the safe part and the consequential effects: still configured until verified
		assert.equal(run(ws.root, ['setup', 'probe', '--input', 'label=d', '--input', `home=${home}`, '--allow', 'download', '--allow', 'machine'], { PROBE_TOKEN_PATH: tok }).code, 0);
		s = run(ws.root, ['status'], { PROBE_TOKEN_PATH: tok });
		assert.match(line(s.stdout, 'probe'), /^  probe\s+configured\s+live check unverified\s+→ dt setup probe --verify --allow machine/);
		// verified: ready with the receipt's date
		assert.equal(run(ws.root, ['setup', 'probe', '--input', 'label=d', '--input', `home=${home}`, '--verify', '--allow', 'machine'], { PROBE_TOKEN_PATH: tok }).code, 0);
		s = run(ws.root, ['status'], { PROBE_TOKEN_PATH: tok });
		assert.match(line(s.stdout, 'probe'), /^  probe\s+ready · verified \d{4}-\d{2}-\d{2}\s*$/);
		// skipped, with how to come back
		assert.equal(run(ws.root, ['setup', 'probe', '--skip']).code, 0);
		s = run(ws.root, ['status'], { PROBE_TOKEN_PATH: tok });
		assert.match(line(s.stdout, 'probe'), /^  probe\s+skipped\s+dt setup <unit> to resume\s+→ dt setup probe/);
		// --json carries the same lines as data
		const j = JSON.parse(run(ws.root, ['status', '--json'], { PROBE_TOKEN_PATH: tok }).stdout);
		assert.equal(j.setup.find((l) => l.unit === 'probe').state, 'skipped');
		assert.equal(j.workspace.root, fs.realpathSync(ws.root), 'every JSON result names workspace.root');
		assert.equal(JSON.parse(run(ws.root, ['doctor', '--json'], { PROBE_TOKEN_PATH: tok }).stdout).workspace.root, fs.realpathSync(ws.root));
	});

	test('a package with no unit reads no setup — and names its unset declared vars', () => {
		const ws = workspace({ compile: false });
		// a plain extension (no setup key) that declares an env key and a var
		const dir = path.join(ws.root, 'node_modules', 'plain-kit');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'plain-kit', version: '1.0.0', files: ['ext.js'], dreamteamer: { extension: './ext.js', env: ['KIT_TOKEN'], vars: ['KIT_HOME'] } }));
		fs.writeFileSync(path.join(dir, 'ext.js'), 'export default () => ({ doctor: () => [{ label: "kit", state: "ok" }] });');
		const pkgFile = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dependencies = { ...pkg.dependencies, 'plain-kit': '1.0.0' };
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		assert.equal(run(ws.root, ['compile']).code, 0);
		const s = run(ws.root, ['status']);
		assert.match(line(s.stdout, 'plain-kit'), /^  plain-kit\s+no setup\s+needs: KIT_TOKEN, KIT_HOME\s+→ set KIT_TOKEN, KIT_HOME in \.env/);
		fs.writeFileSync(path.join(ws.root, '.env'), 'KIT_TOKEN=x\nKIT_HOME=/k\n');
		assert.match(line(run(ws.root, ['status']).stdout, 'plain-kit'), /^  plain-kit\s+no setup\s*$/);
		// its own doctor rows still render
		assert.match(run(ws.root, ['doctor']).stdout, /plain-kit — READY\n {2}✔ kit/);
		// a plain module — collections only, no code — reads no setup too; the workspace's own module and the engine do not appear
		const plain = path.join(ws.root, 'node_modules', 'plain-data');
		fs.mkdirSync(path.join(plain, 'collections'), { recursive: true });
		fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'plain-data', version: '1.0.0', files: ['collections'], dreamteamer: { vars: ['DATA_ROOT'] } }));
		fs.writeFileSync(path.join(plain, 'collections', 'things.collection.yaml'), 'name: things\ndescription: x\nstorage:\n  path: things\n  format: md\n  shape: file\n  suffix: thing\nids:\n  from: \'{{ title | slug }}\'\nfields:\n  title:\n    type: string\n');
		const pkg2 = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg2.dependencies = { ...pkg2.dependencies, 'plain-data': '1.0.0' };
		fs.writeFileSync(pkgFile, JSON.stringify(pkg2, null, '\t') + '\n');
		assert.equal(run(ws.root, ['compile']).code, 0);
		const out = run(ws.root, ['status']).stdout;
		assert.match(line(out, 'plain-data'), /^  plain-data\s+no setup\s+needs: DATA_ROOT/);
		assert.equal(line(out, 'default'), '', 'the workspace module has no setup line');
		assert.equal(line(out, 'dreamteamer'), '', 'the engine has no setup line');
	});
});

describe('dt doctor — a unit\'s checks as rows, blocked is bad', () => {
	test('statuses map to ok / warn / bad and --strict fails on blocked', () => {
		const ws = probed();
		const d = run(ws.root, ['doctor']);
		assert.equal(d.code, 0, d.stderr);
		assert.match(d.stdout, /probe — DEGRADED\n(?:.*\n)*? {2}⚠ probe home {2}no folder yet — fix: dt setup probe/);
		assert.match(d.stdout, / {2}⚠ live check {2}never verified — fix: dt setup probe --verify --allow machine/);
		// a blocked check: the probe's inspect throws → one bad row, and --strict exits 1
		const b = run(ws.root, ['doctor', '--strict'], { PROBE_THROW: 'inspect' });
		assert.equal(b.code, 1);
		assert.match(b.stdout, /probe — UNAVAILABLE\n {2}✖ inspect/);
	});
});

describe('status and doctor are read-only and offline', () => {
	test('the tree hash is unchanged by either, in every state, and neither path imports a network module', () => {
		const ws = probed();
		for (const env of [{}, { PROBE_EMPTY: '1' }, { PROBE_THROW: 'inspect' }]) {
			const before = treeHash(ws.root);
			run(ws.root, ['status'], env); run(ws.root, ['doctor'], env); run(ws.root, ['status', '--json'], env); run(ws.root, ['doctor', '--json'], env);
			assert.equal(treeHash(ws.root), before, JSON.stringify(env));
		}
		for (const f of ['src/setup.js', 'src/doctor.js']) {
			const text = fs.readFileSync(path.join(ENGINE_ROOT, f), 'utf8');
			assert.doesNotMatch(text, /from 'node:(http|https|dns|net)'/, f);
		}
	});
});
