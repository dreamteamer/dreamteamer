// The driver's judgement of an env action when a plan is read (cr-dt-007, D61), and `redact`
// bounded to failure text (D67). Pure: the judge is handed the file text, the exposure verdict and
// the leftover temps, never a path.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { judgeEnvAction, redact } from '../../src/setup.js';

const declared = new Set(['PROBE_HOME', 'PROBE_LABEL']);
const action = (env, extra = {}) => ({ id: 'make-home', title: 'write .env', env, ...extra });
const judge = (a, over = {}) => judgeEnvAction(a, { declared, text: 'OTHER=1\n', temps: [], exposure: { safe: true }, expect: 'sha256:abc', ...over });

describe('judgeEnvAction — state and reason from what the driver can see without writing', () => {
	test('a plain action passes through untouched', () => {
		const a = { id: 'fetch', title: 'download', effects: [{ kind: 'download', detail: 'x' }] };
		assert.equal(judge(a), a);
	});
	test('ready: the file does not hold the values; expect is the plan-time fingerprint; effects default', () => {
		const j = judge(action({ PROBE_HOME: '/h', PROBE_LABEL: 'demo' }));
		assert.equal(j.state, 'ready');
		assert.equal(j.expect, 'sha256:abc');
		assert.deepEqual(j.effects, [{ kind: 'workspace-files', detail: '.env: PROBE_HOME, PROBE_LABEL' }]);
	});
	test('done: every key already holds its value — the unit need not compute it', () => {
		const j = judge(action({ PROBE_HOME: '/h' }), { text: 'PROBE_HOME=/h\n' });
		assert.equal(j.state, 'done');
		assert.match(j.reason, /already holds/);
	});
	test('needs-input: a value not yet known, whatever the unit said', () => {
		assert.equal(judge(action({ PROBE_LABEL: undefined }, { state: 'ready' })).state, 'needs-input');
	});
	test('blocked: an undeclared key, a non-string value, a key assigned twice, a quote in the value', () => {
		assert.equal(judge(action({ NOPE: 'x' })).state, 'blocked');
		assert.match(judge(action({ NOPE: 'x' })).reason, /NOPE is not declared/);
		assert.equal(judge(action({ PROBE_HOME: 1 })).state, 'blocked');
		assert.match(judge(action({ PROBE_HOME: '/h' }), { text: 'PROBE_HOME=a\nPROBE_HOME=b\n' }).reason, /assigned more than once/);
		assert.match(judge(action({ PROBE_HOME: 'say "hi"' })).reason, /characters this action does not write/);
	});
	test('blocked: git would commit .env; a leftover temp file sits beside it', () => {
		assert.match(judge(action({ PROBE_HOME: '/h' }), { exposure: { safe: false, reason: 'git would commit .env — add it to .gitignore first' } }).reason, /git would commit/);
		assert.match(judge(action({ PROBE_HOME: '/h' }), { temps: ['.env.setup-1.tmp'] }).reason, /\.env\.setup-1\.tmp/);
	});
	test('the unit\'s own blocked state and reason stand when the shape is fine', () => {
		const j = judge(action({ PROBE_HOME: '/h' }, { state: 'blocked', reason: 'the folder is on a read-only volume' }));
		assert.equal(j.state, 'blocked');
		assert.equal(j.reason, 'the folder is on a read-only volume');
	});
	test('the unit\'s effects are kept when it gave some', () => {
		const j = judge(action({ PROBE_HOME: '/h' }, { effects: [{ kind: 'workspace-files', detail: 'custom' }] }));
		assert.deepEqual(j.effects, [{ kind: 'workspace-files', detail: 'custom' }]);
	});
});

describe('redact — failure text only, the kit\'s rules folded in (D62, D67)', () => {
	test('key=value and Bearer, as before', () => {
		assert.equal(redact('probe exploded: token=hunter2 at /x'), 'probe exploded: token=[redacted] at /x');
		assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]');
	});
	test('a placeholder value is not a value: --input token=<token> prints whole', () => {
		assert.equal(redact('dt setup acme --input token=<token>'), 'dt setup acme --input token=<token>');
	});
	test('an e-mail address, a home path and a long token are gone', () => {
		assert.equal(redact('signed in as dana.o@northwind.example'), 'signed in as <email>');
		assert.equal(redact('wrote /Users/dana/.config/x and /home/dana/y'), 'wrote ~/.config/x and ~/y');
		assert.equal(redact('C:\\Users\\dana\\x'), '~\\x');
		assert.equal(redact('got ' + 'a'.repeat(40)), 'got [redacted]');
	});
	test('a 31-character token, a dated id and a sha prefix stay', () => {
		const dated = '2026-11-13--cr-dt-007-he5';
		assert.equal(redact(`see ${dated} and ${'b'.repeat(31)}`), `see ${dated} and ${'b'.repeat(31)}`);
	});
});
