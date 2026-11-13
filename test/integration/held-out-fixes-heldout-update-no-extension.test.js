// HELD-OUT (rnd/tests/dreamteamer/heldout-update-no-extension) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-update-runs-the-new-version-s-setup-unit.
// dt update of a package with no extension: the output is what 0.48.0 printed — the one ✔ line, no unit line, no dt setup hint — and the commit is the same.
//
// SELF-CONTAINED FIXTURES: this file does not depend on the @fix/unit fixture the plan adds. It packs its own
// `@ho/*` packages (below) into the same offline folder buildRegistry() builds, so `--from` reads both.
//   @ho/unit 1.0.0   extension, unit `hounit`: one REQUIRED string input `calendar` (env HO_CALENDAR) — with
//                    it unset the unit needs input (exit 3); inspect names itself "hounit 1.0.0"; its env action
//                    `write-version` has no value until `calendar` is given.
//   @ho/unit 1.1.0   extension, unit `hounit`: no inputs; inspect names itself "hounit 1.1.0" (unverified, so
//                    the line reads `— hounit: configured — hounit 1.1.0 unverified`); plan: one ready env
//                    action `write-version` → HO_UNIT_VERSION=1.1.0 (declared in dreamteamer.env). Its entry
//                    THROWS AT IMPORT when HO_UNIT_CRASH=1 — the parent, holding 1.0.0 in its ESM cache, never
//                    runs that line; a fresh process does.
//   @ho/host 1.0.0   extension, unit `hohost` with a REQUIRED input `calendar` (env HO_HOST_CAL).
//   @ho/host 1.1.0   extension, unit `hohost` with no inputs ("hohost 1.1.0"), and dreamteamer.dependencies
//                    ['@ho/newdep'] — the update's closure brings a new package.
//   @ho/newdep 1.0.0 extension, unit `honewdep` ("honewdep 1.0.0", unverified, no actions).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, ENGINE_ROOT, git, treeHash } from '../helpers/ws.js';
import { buildRegistry } from '../fixtures/registry/build.mjs';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-home-'));
const run = (root, args, env = {}) => {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME, USERPROFILE: HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
function offline() {
	const ws = workspace();
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	git(ws.root, ['add', '-A']);
	if (git(ws.root, ['status', '--porcelain'])) git(ws.root, ['commit', '-qm', 'fixture: offline engine']);
	return ws;
}
const installed = (root, name) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
const envLines = (root, key) => { try { return fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith(`${key}=`)); } catch { return []; } };

const unitEntry = (id, { title, input = null, envAction = null, crashVar = null }) => `export const apiVersion = 1;
${crashVar ? `if (process.env.${crashVar} === '1') throw new Error('${title} refuses to load (${crashVar})');\n` : ''}export default function activate() {
	return { setup: [{
		id: ${JSON.stringify(id)}, version: 1,
		inputs: ${JSON.stringify(input ? [input] : [])},
		inspect: () => ({ checks: [{ id: ${JSON.stringify(`${id}.v`)}, status: 'unverified', title: ${JSON.stringify(title)}, detail: 'fixture' }] }),
		plan: (ctx, inputs = {}) => ({
			needs: ${input?.required ? `inputs.${input.id} === undefined ? [${JSON.stringify(input.id)}] : []` : '[]'},
			actions: ${envAction ? `[{ id: 'write-version', title: 'record the unit version', env: { ${envAction.key}: ${envAction.whenInput ? `inputs.${envAction.whenInput} === undefined ? undefined : ${JSON.stringify(envAction.value)}` : JSON.stringify(envAction.value)} } }]` : '[]'},
		}),
	}] };
}
`;
const PACKAGES = [
	{ name: '@ho/unit', version: '1.0.0', env: ['HO_CALENDAR', 'HO_UNIT_VERSION'], entry: unitEntry('hounit', { title: 'hounit 1.0.0', input: { id: 'calendar', kind: 'string', env: 'HO_CALENDAR', required: true, title: 'calendar' }, envAction: { key: 'HO_UNIT_VERSION', value: '1.0.0', whenInput: 'calendar' } }) },
	{ name: '@ho/unit', version: '1.1.0', env: ['HO_CALENDAR', 'HO_UNIT_VERSION'], entry: unitEntry('hounit', { title: 'hounit 1.1.0', envAction: { key: 'HO_UNIT_VERSION', value: '1.1.0' }, crashVar: 'HO_UNIT_CRASH' }) },
	{ name: '@ho/host', version: '1.0.0', env: ['HO_HOST_CAL'], entry: unitEntry('hohost', { title: 'hohost 1.0.0', input: { id: 'calendar', kind: 'string', env: 'HO_HOST_CAL', required: true, title: 'calendar' } }) },
	{ name: '@ho/host', version: '1.1.0', env: ['HO_HOST_CAL'], deps: ['@ho/newdep'], entry: unitEntry('hohost', { title: 'hohost 1.1.0' }) },
	{ name: '@ho/newdep', version: '1.0.0', env: [], entry: unitEntry('honewdep', { title: 'honewdep 1.0.0' }) },
];
let REG;
before(() => {
	REG = buildRegistry();
	const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-ho-src-'));
	for (const p of PACKAGES) {
		const dir = path.join(src, `${p.name.replace(/^@/, '').replace('/', '-')}-${p.version}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: p.name, version: p.version, description: `${p.name} ${p.version} (held-out fixture)`, type: 'module', files: ['entry.js'], dreamteamer: { description: `${p.name} — a held-out fixture.`, extension: './entry.js', env: p.env, ...(p.deps ? { dependencies: p.deps } : {}) } }, null, '\t') + '\n');
		fs.writeFileSync(path.join(dir, 'entry.js'), p.entry);
		const r = spawnSync('npm', ['pack', dir, '--pack-destination', REG, '--silent'], { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
		if (r.status !== 0) throw new Error(`npm pack ${p.name}@${p.version} failed: ${r.stderr}`);
	}
});
const all = (r) => r.stdout + r.stderr;

describe('held-out: an update of a package with no extension prints what it did before', () => {
	test('@fix/a 1.0.0 → 1.1.0 (collections only): exit 0, the ✔ line last, no unit line, no "dt setup", clean stderr, one commit', () => {
		const ws = offline();
		assert.equal(run(ws.root, ['install', '@fix/a@1.0.0', '--from', REG]).code, 0);
		const r = run(ws.root, ['update', '@fix/a', '--from', REG]);
		assert.equal(r.code, 0, all(r));
		const lines = r.stdout.split('\n').filter((l) => l.trim() !== '');
		assert.match(lines[0], /^▶ update: @fix\/a 1\.0\.0 → 1\.1\.0$/);
		assert.match(lines.at(-1), /^✔ @fix\/a 1\.0\.0 → 1\.1\.0 — compiled, committed \(package\.json, package-lock\.json(, \.env\.example)?\)$/);
		// nothing a unit prints: no state line, no action line, no needs line
		assert.ok(!lines.some((l) => /^[✔—✖] [a-z0-9-]+: (ready|configured|blocked|skipped|no-evidence)\b/.test(l) || /^ {4}(✔|✖|…|needs input)/.test(l)), r.stdout);
		assert.doesNotMatch(all(r), /dt setup/);
		assert.doesNotMatch(r.stderr, /✖|Error|SyntaxError|JSON/);
		assert.match(git(ws.root, ['log', '-1', '--pretty=%s']), /^dreamteamer: update @fix\/a 1\.0\.0 → 1\.1\.0$/);
		assert.equal(git(ws.root, ['status', '--porcelain']), '');
	});
});
