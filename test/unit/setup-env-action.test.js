// The driver's judgement of an env action when a plan is read (cr-dt-007, D61), and `redact`
// bounded to failure text (D67). Pure: the judge is handed the file text, the exposure verdict and
// the leftover temps, never a path.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { judgeEnvAction, redact, safeInspect } from '../../src/setup.js';

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
	test('held-out he3: a key another unit wrote in this run, with another value, is blocked naming that unit', () => {
		const written = new Map([['PROBE_LABEL', { unit: 'other', value: 'theirs' }]]);
		const j = judge(action({ PROBE_LABEL: 'mine' }), { written, unit: 'probe' });
		assert.equal(j.state, 'blocked');
		assert.match(j.reason, /PROBE_LABEL was written by unit other in this run with another value — two units disagree on it; set it by hand/);
		assert.equal(judge(action({ PROBE_LABEL: 'theirs' }), { written, unit: 'probe', text: 'PROBE_LABEL=theirs\n' }).state, 'done', 'agreeing is fine');
		assert.equal(judge(action({ PROBE_LABEL: 'mine' }), { written: new Map([['PROBE_LABEL', { unit: 'probe', value: 'x' }]]), unit: 'probe' }).state, 'ready', 'its own earlier write is not a conflict');
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
	});
	test('a prefixed key=value is a value too: ACME_TOKEN=… is redacted', () => {
		assert.equal(redact('ACME_TOKEN=abc123 and DB_PASSWORD=x'), 'ACME_TOKEN=[redacted] and DB_PASSWORD=[redacted]');
	});
	test('legitimate text stays: a long env key name, a long dated id, a sha, a /home/ URL segment, a git remote, /Users/Shared', () => {
		const keep = [
			'WORKSPACE_MCP_CREDENTIALS_DIR_AND_SOME_MORE is unset',
			'see 2026-11-13--cr-dt-007-code-review-of-module-authoring-engine',
			'https://example.invalid/home/docs/x',
			'git@github.com:northwind/portal.git',
			'wrote /Users/Shared/cache',
		];
		for (const t of keep) assert.equal(redact(t), t, t);
	});
	test('round 2: a home path in a file URL, in backticks, second in a comma list — gone; a single-case long token — gone', () => {
		assert.equal(redact('see file:///Users/dana/x'), 'see file://~/x');
		assert.equal(redact('in `/home/dana/y`'), 'in `~/y`');
		assert.equal(redact('a,/Users/dana/z'), 'a,~/z');
		assert.equal(redact('key ' + 'a1'.repeat(20)), 'key [redacted]');
		assert.equal(redact('xoxb-' + '1234567890'.repeat(4)), '[redacted]');
	});
	test('round 2: primary_key= and monkey= are not secrets; ACME_KEY= is not taken for one either, ACME_TOKEN= is', () => {
		assert.equal(redact('primary_key=id monkey=banana'), 'primary_key=id monkey=banana');
		assert.equal(redact('ACME_TOKEN=abc'), 'ACME_TOKEN=[redacted]');
		assert.equal(redact('key=abc'), 'key=[redacted]');
	});
	test('held-out he5: a 32+ run of capitals and digits (a base32 seed) and of lower-case letters alone are redacted; an env key name with underscores and a kebab id stay', () => {
		assert.equal(redact('seed ' + 'JBSWY3DPEHPK3PXP'.repeat(2)), 'seed [redacted]');
		assert.equal(redact('got ' + 'B'.repeat(40)), 'got [redacted]');
		assert.equal(redact('got ' + 'abcdefgh'.repeat(5)), 'got [redacted]');
		assert.equal(redact('WORKSPACE_MCP_CREDENTIALS_DIR_AND_SOME_MORE is unset'), 'WORKSPACE_MCP_CREDENTIALS_DIR_AND_SOME_MORE is unset');
		assert.equal(redact('see module-authoring-on-the-engine-alone-and-more'), 'see module-authoring-on-the-engine-alone-and-more');
	});
	test('a mixed-case token with digits is still redacted', () => {
		assert.equal(redact('got Ab3' + 'xY9'.repeat(11)), 'got [redacted]');
	});
	test('a 31-character token, a dated id and a sha prefix stay', () => {
		const dated = '2026-11-13--cr-dt-007-he5';
		assert.equal(redact(`see ${dated} and ${'b'.repeat(31)}`), `see ${dated} and ${'b'.repeat(31)}`);
	});
});

describe('an inspect that returns a Promise — a plain function hiding an async body', () => {
	test('reads blocked with the reason, never "no evidence"', () => {
		const unit = { id: 'acme', inspect: () => Promise.resolve({ checks: [] }) };
		assert.deepEqual(safeInspect(unit, {}), [{ id: 'acme.inspect', status: 'blocked', title: 'inspect', detail: 'inspect returned a Promise — dt status reads it without awaiting; make it synchronous' }]);
	});
});
