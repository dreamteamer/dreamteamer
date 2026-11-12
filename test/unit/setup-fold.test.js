// `src/setup.js`, the pure half: the status fold (the design's table, row by row), the input
// precedence (D33: flag → env → default → prompt; D39: one env key is one input), the consent rule
// per effect kind, and the flag parser. No workspace, no fs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fold, fillInputs, parseInputFlags, consent, redact } from '../../src/setup.js';

const c = (id, status, extra = {}) => ({ id, status, title: id, ...extra });

describe('fold — one line per unit, from its checks', () => {
	test('skipped wins over everything', () => {
		assert.equal(fold([c('a', 'blocked')], { skipped: true }).state, 'skipped');
	});
	test('zero checks is no evidence, never ready', () => {
		assert.equal(fold([], {}).state, 'no-evidence');
	});
	test('any blocked check blocks, and the detail names it', () => {
		const r = fold([c('x.tools', 'blocked', { title: 'ffmpeg', detail: 'not on PATH' }), c('x.home', 'configured')], {});
		assert.equal(r.state, 'blocked');
		assert.match(r.detail, /ffmpeg/);
	});
	test('missing or unverified is configured, with what is still open', () => {
		const r = fold([c('x.home', 'configured'), c('x.live', 'unverified', { title: 'live check' }), c('x.token', 'missing', { title: 'token' })], {});
		assert.equal(r.state, 'configured');
		assert.match(r.detail, /token/);
		assert.match(r.detail, /live check/);
	});
	test('ready or configured everywhere is ready; a receipt date is the verified suffix', () => {
		assert.deepEqual(fold([c('x.home', 'configured'), c('x.tools', 'ready')], {}), { state: 'ready', detail: '', verified: null });
		assert.equal(fold([c('x.live', 'ready', { evidence: { at: '2026-11-13' } }), c('x.home', 'configured')], {}).verified, '2026-11-13');
	});
	test('an unknown status is treated as blocked, naming the status', () => {
		const r = fold([c('x', 'green')], {});
		assert.equal(r.state, 'blocked');
		assert.match(r.detail, /unknown status "green"/);
	});
});

describe('parseInputFlags — --input id=value, repeated, unit-qualified, values may hold =', () => {
	test('shapes', () => {
		assert.deepEqual(parseInputFlags(['--input', 'home=/tmp/x', '--input', 'probe.label=a=b', '--input', 'rows=a|b|c', '--allow', 'download']),
			[{ unit: null, id: 'home', value: '/tmp/x' }, { unit: 'probe', id: 'label', value: 'a=b' }, { unit: null, id: 'rows', value: 'a|b|c' }]);
	});
	test('a flag without = is a usage error', () => {
		assert.throws(() => parseInputFlags(['--input', 'home']), /--input takes id=value/);
	});
});

const unit = (id, inputs) => ({ id, inputs: inputs.map((i) => ({ required: false, ...i })) });

describe('fillInputs — precedence and sharing', () => {
	test('flag, then env, then default; a required input with none of them is missing', async () => {
		const u = unit('probe', [
			{ id: 'home', kind: 'path', env: 'PROBE_HOME', default: '~/.cache/probe' },
			{ id: 'label', kind: 'string', required: true },
			{ id: 'token', kind: 'secret-path', env: 'PROBE_TOKEN_PATH' },
		]);
		const r = await fillInputs([u], { flags: [{ unit: null, id: 'token', value: '/t' }], env: { PROBE_HOME: '/h' }, tty: false, home: '/home/x' });
		assert.deepEqual(r.inputs.get('probe'), { home: '/h', token: '/t' });
		assert.deepEqual(r.missing, [{ unit: 'probe', id: 'label' }]);
		const d = await fillInputs([u], { flags: [{ unit: null, id: 'label', value: 'L' }], env: {}, tty: false, home: '/home/x' });
		assert.deepEqual(d.inputs.get('probe'), { home: '/home/x/.cache/probe', label: 'L' });
		assert.deepEqual(d.missing, []);
	});
	test('a TTY prompts only for what is still missing, with the default prefilled', async () => {
		const u = unit('probe', [{ id: 'home', kind: 'path', default: '/d' }, { id: 'label', kind: 'string', required: true }]);
		const asked = [];
		const r = await fillInputs([u], { flags: [], env: {}, tty: true, prompt: async (input, def) => { asked.push([input.id, def]); return input.id === 'label' ? 'typed' : def; } });
		assert.deepEqual(asked, [['label', undefined]]);
		assert.deepEqual(r.inputs.get('probe'), { home: '/d', label: 'typed' });
	});
	test('--no-input never prompts', async () => {
		const u = unit('probe', [{ id: 'label', kind: 'string', required: true }]);
		const r = await fillInputs([u], { flags: [], env: {}, tty: true, noInput: true, prompt: async () => 'no' });
		assert.deepEqual(r.missing, [{ unit: 'probe', id: 'label' }]);
	});
	test('two inputs naming one env key are one input (D39); a bare id across units with different env is ambiguous', async () => {
		const files = unit('files', [{ id: 'files_folder', kind: 'path', env: 'FILES_FOLDER' }]);
		const rec = unit('recordings', [{ id: 'files_folder', kind: 'path', env: 'FILES_FOLDER' }, { id: 'port', kind: 'string' }]);
		const web = unit('web', [{ id: 'port', kind: 'string' }]);
		const r = await fillInputs([files, rec], { flags: [{ unit: null, id: 'files_folder', value: '/f' }], env: {}, tty: false });
		assert.equal(r.inputs.get('files').files_folder, '/f');
		assert.equal(r.inputs.get('recordings').files_folder, '/f');
		await assert.rejects(fillInputs([rec, web], { flags: [{ unit: null, id: 'port', value: '80' }], env: {}, tty: false }), /--input port= is ambiguous: recordings\.port, web\.port/);
		const q = await fillInputs([rec, web], { flags: [{ unit: 'web', id: 'port', value: '80' }], env: {}, tty: false });
		assert.equal(q.inputs.get('web').port, '80');
		assert.equal(q.inputs.get('recordings').port, undefined);
	});
	test('rows collect every repeated flag; a flag for an unknown input is a usage error', async () => {
		const u = unit('probe', [{ id: 'rows', kind: 'rows', rows: { columns: ['a', 'b'] } }]);
		const r = await fillInputs([u], { flags: [{ unit: null, id: 'rows', value: '1|2' }, { unit: null, id: 'rows', value: '3|4' }], env: {}, tty: false });
		assert.deepEqual(r.inputs.get('probe').rows, ['1|2', '3|4']);
		await assert.rejects(fillInputs([u], { flags: [{ unit: null, id: 'nope', value: '1' }], env: {}, tty: false }), /--input nope= names no input of probe/);
	});
});

describe('consent — per effect kind', () => {
	const act = (...kinds) => ({ id: 'a', title: 'a', effects: kinds.map((kind) => ({ kind, detail: kind })) });
	test('workspace-files never asks; account never here; the rest need --allow or a yes', async () => {
		assert.equal(await consent(act('workspace-files'), { allow: new Set(), tty: false }), true);
		assert.equal(await consent(act('account'), { allow: new Set(['account']), tty: true, ask: async () => true }), false);
		assert.equal(await consent(act('download', 'machine'), { allow: new Set(['download']), tty: false }), false);
		assert.equal(await consent(act('download', 'machine'), { allow: new Set(['download', 'machine']), tty: false }), true);
		let askedFor = null;
		assert.equal(await consent(act('download'), { allow: new Set(), tty: true, ask: async (a) => { askedFor = a.id; return true; } }), true);
		assert.equal(askedFor, 'a');
		assert.equal(await consent(act('download'), { allow: new Set(), tty: true, ask: async () => false }), false);
	});
});

describe('redact — an error from a provider never carries a value', () => {
	test('key=value pairs that look like secrets, and bearer tokens', () => {
		assert.equal(redact('probe exploded: token=hunter2 at /x'), 'probe exploded: token=[redacted] at /x');
		assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]');
	});
});
