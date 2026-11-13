// `.env` span writer (cr-dt-007, D61): the engine performs a unit's env action — each key's value
// span replaced in place or appended, every other byte kept, and what is written reads back through
// parseEnvValues exactly. Pure on strings; the file half on a temp dir, outside any workspace.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnvValues } from '../../src/env-vars.js';
import { envSpans, setEnvValues, fingerprint, leftoverTemps, gitExposure, writeEnvAtomic, EnvRefusal } from '../../src/env-write.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-env-write-')));

describe('envSpans — the assignments parseEnvValues reads, with their value spans', () => {
	test('plain, quoted, export and comment lines', () => {
		const text = '# a comment\nA=1\nexport B="two words"\nC=\'single\'\n# D=not an assignment\nE=\n';
		const spans = envSpans(text);
		assert.deepEqual(spans.map((s) => [s.key, s.value, s.quoted]), [['A', '1', false], ['B', 'two words', '"'], ['C', 'single', "'"], ['E', '', false]]);
		for (const s of spans) assert.equal(text.slice(s.start, s.end), s.raw, `${s.key}: the span is the raw value text`);
		assert.deepEqual([...parseEnvValues(text)], [['A', '1'], ['B', 'two words'], ['C', 'single'], ['E', '']]);
	});
	test('a double-quoted value spanning lines is one span (meetings keeps its calendar rows that way)', () => {
		const text = 'WORK_CALENDARS="\nprimary\nteam@example.invalid\n"\nAFTER=1\n';
		const spans = envSpans(text);
		assert.deepEqual(spans.map((s) => s.key), ['WORK_CALENDARS', 'AFTER']);
		assert.equal(spans[0].value, '\nprimary\nteam@example.invalid\n');
		assert.equal(parseEnvValues(text).get('WORK_CALENDARS'), spans[0].value);
	});
});

describe('setEnvValues — replace in place, append when absent, keep every other byte', () => {
	const cases = [
		['empty file', ''],
		['plain', 'A=1\nK=old\nB=2\n'],
		['quoted', 'A=1\nK="old value"\nB=2\n'],
		['export prefix', 'export K=old\nB=2\n'],
		['comments around', '# head\nK=old # tail comment kept as value\n# foot\n'],
		['CRLF', 'A=1\r\nK=old\r\nB=2\r\n'],
		['no trailing newline', 'A=1\nK=old'],
		['a multi-line neighbour before', 'WORK_CALENDARS="\na\nb\n"\nK=old\nB=2\n'],
		['a multi-line neighbour after', 'K=old\nWORK_CALENDARS="\na\nb\n"\nB=2\n'],
		['absent key', 'A=1\nB=2\n'],
		['absent key, no trailing newline', 'A=1\nB=2'],
	];
	for (const [name, text] of cases) {
		test(`${name}: K reads back as written and every other key is unchanged`, () => {
			const before = parseEnvValues(text);
			const { text: out, changed } = setEnvValues(text, { K: 'new value' });
			assert.deepEqual(changed, ['K']);
			const after = parseEnvValues(out);
			assert.equal(after.get('K'), 'new value');
			for (const [k, v] of before) if (k !== 'K') assert.equal(after.get(k), v, `${k} unchanged`);
			// every byte outside K's span is kept: a present K has its line(s) swapped and nothing else moves;
			// an absent K is appended after the text (plus the newline the last line lacked), nothing before it touched
			const strip = (t) => t.replace(/^(?:export\s+)?K=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\n]*)\r?\n?/m, '');
			if (before.has('K')) assert.equal(strip(out), strip(text));
			else { assert.ok(out.startsWith(text), 'the original text is a prefix'); assert.match(out.slice(text.length), /^(\r?\n)?K="new value"\r?\n$/); }
		});
	}
	test('a value with a newline is written double-quoted and reads back whole', () => {
		const { text } = setEnvValues('A=1\n', { K: '\nprimary\nteam\n' });
		assert.equal(parseEnvValues(text).get('K'), '\nprimary\nteam\n');
		assert.equal(parseEnvValues(text).get('A'), '1');
	});
	test('a value with spaces or # is quoted; a plain one is not', () => {
		assert.match(setEnvValues('', { K: 'two words' }).text, /^K="two words"$/m);
		assert.match(setEnvValues('', { K: 'a#b' }).text, /^K="a#b"$/m);
		assert.match(setEnvValues('', { K: 'plain' }).text, /^K=plain$/m);
	});
	test('several keys in one call, in the given order for the appended ones', () => {
		const { text, changed } = setEnvValues('B=2\n', { A: '1', B: '3', C: '4' });
		assert.deepEqual(changed, ['A', 'B', 'C']);
		assert.equal(text, 'B=3\nA=1\nC=4\n');
	});
	test('a key already holding the value is not in changed, and the text is identical', () => {
		const { text, changed } = setEnvValues('K=same\n', { K: 'same' });
		assert.deepEqual(changed, []);
		assert.equal(text, 'K=same\n');
	});
	test('a key assigned twice is refused by code', () => {
		assert.throws(() => setEnvValues('K=1\nK=2\n', { K: '3' }), (e) => e instanceof EnvRefusal && e.code === 'twice' && /K is assigned more than once in \.env/.test(e.message));
	});
	test('a value holding a double quote is refused by code — the reader does not unescape', () => {
		assert.throws(() => setEnvValues('', { K: 'say "hi"' }), (e) => e instanceof EnvRefusal && e.code === 'value' && /K: a value with characters this action does not write/.test(e.message));
	});
});

describe('fingerprint, leftoverTemps, gitExposure', () => {
	test('absent, a regular file, a symlink, a folder', () => {
		const d = tmp();
		assert.equal(fingerprint(path.join(d, '.env')), 'absent');
		fs.writeFileSync(path.join(d, '.env'), 'A=1\n');
		assert.match(fingerprint(path.join(d, '.env')), /^sha256:[0-9a-f]{64}$/);
		fs.symlinkSync(path.join(d, '.env'), path.join(d, 'link'));
		assert.throws(() => fingerprint(path.join(d, 'link')), (e) => e instanceof EnvRefusal && e.code === 'symlink');
		fs.mkdirSync(path.join(d, 'dir'));
		assert.throws(() => fingerprint(path.join(d, 'dir')), (e) => e instanceof EnvRefusal && e.code === 'not-file');
	});
	test('leftover temps beside the file are listed by name', () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, '.env.setup-abc.tmp'), '');
		fs.writeFileSync(path.join(d, 'other.tmp'), '');
		assert.deepEqual(leftoverTemps(path.join(d, '.env')), ['.env.setup-abc.tmp']);
	});
	test('git exposure: no repo is safe; ignored is safe; not ignored is unsafe; tracked is unsafe', () => {
		const d = tmp();
		assert.deepEqual(gitExposure(d, '.env'), { safe: true });
		execFileSync('git', ['init', '-q'], { cwd: d });
		assert.equal(gitExposure(d, '.env').safe, false);
		assert.match(gitExposure(d, '.env').reason, /git would commit \.env/);
		fs.writeFileSync(path.join(d, '.gitignore'), '.env\n');
		assert.deepEqual(gitExposure(d, '.env'), { safe: true });
		fs.writeFileSync(path.join(d, '.env'), 'A=1\n');
		execFileSync('git', ['add', '-f', '.env'], { cwd: d });
		assert.equal(gitExposure(d, '.env').safe, false);
		assert.match(gitExposure(d, '.env').reason, /tracked/);
	});
});

describe('writeEnvAtomic — confined, fingerprint-checked, atomic', () => {
	test('writes when the fingerprint matches, leaves no temp behind', () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, '.env'), 'A=1\n');
		const expect = fingerprint(path.join(d, '.env'));
		writeEnvAtomic(d, 'A=1\nK=2\n', expect);
		assert.equal(fs.readFileSync(path.join(d, '.env'), 'utf8'), 'A=1\nK=2\n');
		assert.deepEqual(leftoverTemps(path.join(d, '.env')), []);
	});
	test('creates the file when expect is absent', () => {
		const d = tmp();
		writeEnvAtomic(d, 'K=2\n', 'absent');
		assert.equal(fs.readFileSync(path.join(d, '.env'), 'utf8'), 'K=2\n');
	});
	test('refuses when the file changed since the plan, and writes nothing', () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, '.env'), 'A=1\n');
		const expect = fingerprint(path.join(d, '.env'));
		fs.writeFileSync(path.join(d, '.env'), 'A=2\n');
		assert.throws(() => writeEnvAtomic(d, 'A=1\nK=2\n', expect), (e) => e instanceof EnvRefusal && e.code === 'changed' && /\.env changed after the preview — nothing was written; plan again/.test(e.message));
		assert.equal(fs.readFileSync(path.join(d, '.env'), 'utf8'), 'A=2\n');
	});
	test('refuses a symlinked .env', () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, 'real'), 'A=1\n');
		fs.symlinkSync(path.join(d, 'real'), path.join(d, '.env'));
		assert.throws(() => writeEnvAtomic(d, 'A=2\n', 'absent'), (e) => e instanceof EnvRefusal && e.code === 'symlink');
		assert.equal(fs.readFileSync(path.join(d, 'real'), 'utf8'), 'A=1\n');
	});
});
