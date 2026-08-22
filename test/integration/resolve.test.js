// Tier 2 — `dt resolve`: the ONE place a `${env:…}` template becomes a value.
//
// The central property under test is a NEGATIVE one: no other verb substitutes anything. A record
// holding `${env:FILES_FOLDER}/a.pdf` must still hold exactly that after `dt get --json`, after
// `check`, on disk — because the alternative (resolving on read) makes a record mean different
// things on two machines and there is no way to tell from the file which one you got.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspace, readFile } from '../helpers/ws.js';

const DOCS = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'doc' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			source_file: { type: 'string' },
			attachments: { type: 'array', items: { type: 'string' } },
			mixed: { type: 'array' },
			pages: { type: 'integer' },
		},
	},
};

// Invented values in a throwaway workspace — this fixture never reads the machine's own .env.
const ENV = 'FILES_FOLDER=/tmp/annex\n';

function fixture({ vars = ['FILES_FOLDER'], env = ENV } = {}) {
	const ws = workspace({ pkg: { vars }, collections: { docs: DOCS } });
	if (env !== null) fs.writeFileSync(path.join(ws.root, '.env'), env);
	// the real root as the child process sees it — mkdtemp may hand back a symlinked path
	ws.real = fs.realpathSync(ws.root);
	return ws;
}

describe('dt resolve <string> — a string template', () => {
	test('${env:KEY} renders the value from .env', () => {
		const ws = fixture();
		const res = ws.dt('resolve', '${env:FILES_FOLDER}/x');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), '/tmp/annex/x');
	});

	test('${workspaceFolder} renders the workspace root', () => {
		const ws = fixture();
		const res = ws.dt('resolve', '${workspaceFolder}/media/a');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), `${ws.real}/media/a`);
	});

	test('${userHome} renders the home directory', () => {
		const ws = fixture();
		const res = ws.dt('resolve', '${userHome}/Downloads');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), `${os.homedir()}/Downloads`);
	});

	test('a string with no variables renders to itself', () => {
		const ws = fixture();
		const res = ws.dt('resolve', '/tmp/plain/path');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), '/tmp/plain/path');
	});

	// The heuristic's whole job: a `${` means the argument is a TEMPLATE, even when what surrounds
	// it looks exactly like a reference. Without this, `docs/${env:X}` would be split as a record id.
	test('a ref-shaped argument containing ${ is a template, not a reference', () => {
		const ws = fixture();
		const res = ws.dt('resolve', 'docs/${env:FILES_FOLDER}');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), 'docs//tmp/annex');
	});

	test('an undeclared key is refused, and the error names it', () => {
		const ws = fixture();
		const res = ws.dt('resolve', '${env:UNDECLARED_ANYTHING}');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /not declared/);
		assert.match(res.stderr, /UNDECLARED_ANYTHING/);
	});

	test('a declared key with no value on this machine is a DIFFERENT error', () => {
		const ws = fixture({ vars: ['FILES_FOLDER', 'ABSENT_KEY'] });
		const res = ws.dt('resolve', '${env:ABSENT_KEY}');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no value in \.env/);
	});

	test('resolve with no argument says what it takes', () => {
		const ws = fixture();
		const res = ws.dt('resolve');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /resolve/);
	});
});

describe('dt resolve <collection>/<id> <field> — a stored template', () => {
	const seeded = (opts) => {
		const ws = fixture(opts);
		assert.equal(ws.dt('add', 'docs', '--name', 'Q3',
			'--source_file', '${env:FILES_FOLDER}/a.pdf',
			'--attachments', '${env:FILES_FOLDER}/one.pdf,${env:FILES_FOLDER}/two.pdf',
			'--pages', '12').code, 0);
		return ws;
	};

	test('a string field renders on one line', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'docs/q3', 'source_file');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), '/tmp/annex/a.pdf');
	});

	test('an array field renders one item per line', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'docs/q3', 'attachments');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(res.stdout.trim().split('\n'), ['/tmp/annex/one.pdf', '/tmp/annex/two.pdf']);
	});

	// THE property. Everything else here is convenience; this is the design.
	test('get --json still shows the field as the TEMPLATE — nothing auto-substitutes', () => {
		const ws = seeded();
		const res = ws.dt('get', 'docs/q3', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(JSON.parse(res.stdout).source_file, '${env:FILES_FOLDER}/a.pdf');
		assert.match(readFile(ws.root, 'data/docs/q3.doc.md'), /\$\{env:FILES_FOLDER\}\/a\.pdf/);
		assert.equal(ws.dt('check').code, 0, 'a template is ordinary data — check must not object');
	});

	// A shell loop reading this output has no way to notice a partial list, so a field that cannot
	// render must print NOTHING — the failure has to be the exit code, not a shorter list.
	test('a mixed array prints nothing at all before failing', () => {
		const ws = fixture();
		ws.store.add('docs', { name: 'Mixed', mixed: ['${env:FILES_FOLDER}/ok.pdf', 42] });
		const res = ws.dt('resolve', 'docs/mixed', 'mixed');
		assert.equal(res.code, 1);
		assert.equal(res.stdout, '', 'no item may reach stdout when one of them cannot render');
	});

	test('an extra argument is an error, not silently ignored', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'docs/q3', 'source_file', 'garbage');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /takes/);
	});

	test('a flag-shaped target is refused rather than rendered as itself', () => {
		const ws = fixture();
		const res = ws.dt('resolve', '--help');
		assert.equal(res.code, 1);
		assert.doesNotMatch(res.stdout, /--help/);
	});

	test('a reference with no field says which field it needs', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'docs/q3');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /needs a field/);
	});

	test('a field the record does not have is an error', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'docs/q3', 'nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /no field "nope"/);
	});

	test('a non-string field is refused rather than stringified', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'docs/q3', 'pages');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /string/);
	});

	test('an unknown collection prefix falls back to string rendering, not a collection error', () => {
		const ws = seeded();
		const res = ws.dt('resolve', 'nope/q3');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), 'nope/q3');
	});
});

describe('compile warns per declared var with no value', () => {
	test('a var missing from .env is named — and no value is printed', () => {
		const ws = fixture({ vars: ['FILES_FOLDER', 'MISSING_KEY'] });
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stderr);
		const out = res.stdout + res.stderr;
		assert.match(out, /MISSING_KEY/);
		assert.doesNotMatch(out, /\/tmp\/annex/, 'values must never reach the output');
		assert.doesNotMatch(out, /FILES_FOLDER — missing/, 'a var that HAS a value must not warn');
	});

	test('no .env at all still names the declared vars', () => {
		const ws = fixture({ vars: ['MISSING_KEY'], env: null });
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout + res.stderr, /MISSING_KEY/);
	});

	// THE invariant: compile warns about a var if and only if resolve cannot render it. Two lines
	// that the one parser drops but a hand-rolled key regex would accept — `KEY =value` (space
	// before `=`) and an indented key — used to pass compile silently and then fail at resolve with
	// "no value in .env" while the operator was looking straight at the line.
	test('compile and resolve agree on a .env line the parser does not accept', () => {
		const ws = fixture({
			vars: ['FILES_FOLDER', 'SPACED', 'INDENTED'],
			env: 'FILES_FOLDER=/tmp/annex\nSPACED = /tmp/one\n  INDENTED=/tmp/two\n',
		});
		const out = (() => { const r = ws.dt('compile'); assert.equal(r.code, 0, r.stderr); return r.stdout + r.stderr; })();
		assert.match(out, /SPACED/, 'compile must warn about the key resolve cannot render');
		assert.match(out, /INDENTED/);
		assert.doesNotMatch(out, /tmp\/one|tmp\/two|tmp\/annex/, 'names only — never values');

		for (const key of ['SPACED', 'INDENTED']) {
			const res = ws.dt('resolve', `\${env:${key}}`);
			assert.equal(res.code, 1, `${key} rendered, but compile said it was missing`);
			assert.match(res.stderr, /no value in \.env/);
		}
		// and the key the parser DOES accept is not warned about, in the same .env
		assert.doesNotMatch(out, /FILES_FOLDER/);
		assert.equal(ws.dt('resolve', '${env:FILES_FOLDER}').stdout.trim(), '/tmp/annex');
	});

	test('a var that has a value warns about nothing', () => {
		const ws = fixture();
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stdout + res.stderr, /FILES_FOLDER/);
	});

	// Same invariant, the empty-value case: `EMPTY_KEY=` is PRESENT in .env but has nothing behind
	// it, which is exactly what resolve now refuses (same message as an unset key). compile must
	// warn about it too — silence here is the same trap as the unaccepted-line case above, just one
	// key away: an operator staring at `EMPTY_KEY=` in .env, told nothing is wrong, hits "no value
	// in .env" at resolve.
	test('compile and resolve agree on a PRESENT but EMPTY value', () => {
		const ws = fixture({
			vars: ['FILES_FOLDER', 'EMPTY_KEY'],
			env: 'FILES_FOLDER=/tmp/annex\nEMPTY_KEY=\n',
		});
		const out = (() => { const r = ws.dt('compile'); assert.equal(r.code, 0, r.stderr); return r.stdout + r.stderr; })();
		assert.match(out, /EMPTY_KEY/, 'compile must warn about a declared-but-empty value');
		assert.doesNotMatch(out, /FILES_FOLDER/);

		const res = ws.dt('resolve', '${env:EMPTY_KEY}');
		assert.equal(res.code, 1, 'EMPTY_KEY rendered, but compile said it was missing');
		assert.match(res.stderr, /no value in \.env/);
	});
});
