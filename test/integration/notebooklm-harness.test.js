// Tier 2 — the `notebooklm` harness. NOTEBOOKLM.md is a USER-OWNED root file carrying a managed
// block, exactly like CLAUDE.md: the operator's own notes above and below must survive every
// compile, and switching the harness off must remove the block without deleting his file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, readFile } from '../helpers/ws.js';

const PEOPLE = {
	description: 'A person we deal with.',
	storage: { suffix: 'person' },
	id: { generate: '{{ name | slug }}' },
	schema: { type: 'object', required: ['name'], properties: {
		name: { type: 'string' },
		email: { type: 'string', 'x-sensitive': true },
	} },
};
const LEDGER = {
	description: 'Money that moved.',
	sensitive: true,
	storage: { suffix: 'entry' },
	id: { generate: '{{ name | slug }}' },
	schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, amount: { type: 'number' } } },
};

const fixture = (harnesses = ['notebooklm']) =>
	workspace({ pkg: { harnesses }, collections: { people: PEOPLE, ledger: LEDGER } });

describe('NOTEBOOKLM.md is written when the harness is on', () => {
	test('⚠ it warns that --mode DISCARDS the persona, and never advises setting one', () => {
		const md = readFile(fixture().root, 'NOTEBOOKLM.md');
		assert.match(md, /chat mode \| \*\*do not set one\*\*/);
		assert.match(md, /passing `--mode` with a persona silently discards the persona/);
		assert.match(md, /a bare `configure`.*CLEARS them/s, 'the no-read-only-inspection trap must be stated');
		assert.ok(!/\| chat mode \| \*\*default\*\*/.test(md), 'advising --mode default is the defect');
	});

	test('it carries the settings, the persona and the limits', () => {
		const ws = fixture();
		const md = readFile(ws.root, 'NOTEBOOKLM.md');
		assert.ok(md, 'NOTEBOOKLM.md was not written');
		assert.match(md, /## settings/);
		assert.match(md, /response length \| \*\*longer\*\*/);
		assert.match(md, /## custom instructions/);
		assert.match(md, /## limits/);
		assert.match(md, /\| pro \| 300 \|/, 'the plan table must carry the source ceilings');
	});

	test('⚠ the persona NAMES what was withheld, so the notebook can say "withheld" instead of "I don\'t know"', () => {
		const ws = fixture();
		const md = readFile(ws.root, 'NOTEBOOKLM.md');
		assert.match(md, /the whole collection ledger/);
		assert.match(md, /people\.email/);
		assert.ok(!md.includes('Nothing has been withheld'), 'it claimed nothing was withheld');
	});

	test('a workspace with no marks says so rather than printing an empty list', () => {
		const ws = workspace({ pkg: { harnesses: ['notebooklm'] }, collections: { people: { ...PEOPLE, schema: { type: 'object', properties: { name: { type: 'string' } } } } } });
		assert.match(readFile(ws.root, 'NOTEBOOKLM.md'), /Nothing has been withheld from this export\./);
	});

	test('the exported collection count is stated, because it decides which plan is needed', () => {
		const ws = fixture();
		assert.match(readFile(ws.root, 'NOTEBOOKLM.md'), /exports \*\*\d+ collections\*\* \(1 withheld\)/);
	});

	// ⚠ TWO RENDERERS, ONE NUMBER — and nothing related them, so they diverged silently.
	//
	// `notebooklmBlock` (harnesses.js) filtered on the `system` PARTITION, which is a question about
	// where a collection is DRAWN; `renderSchema` (export-notebooklm.js) filters on storage, which is
	// what actually decides whether a collection is shipped as a source. They answered identically
	// until a collection was in the partition WITHOUT being build output —
	// `repos` — and then NOTEBOOKLM.md said "exports 1 collections" and listed only `notes` for an export that
	// shipped `repos.md` and headed a `## module: System` group for it in the schema map. The
	// persona generated from that brief would not know about a source it had been handed.
	//
	// So the assertion is made ACROSS the two, from their own output, rather than by re-deriving the
	// number a third time here.
	test('the count and the brief describe what the export actually ships', () => {
		const ws = workspace({ pkg: { harnesses: ['notebooklm'] }, collections: { people: PEOPLE, ledger: LEDGER } });
		ws.dt('add', 'repos', '--name', 'acme', '--url', 'git@example.invalid:acme/acme.git');
		const out = path.join(ws.root, '.notebook-out');
		const res = ws.dt('export', 'notebooklm', '--out', out);
		assert.equal(res.code, 0, `the export must run — stderr:\n${res.stderr}`);

		// what the EXPORT says it is shipping, from the schema source it writes
		const schema = fs.readFileSync(path.join(out, '00-schema.md'), 'utf8');
		const counted = /· (\d+) collections \((\d+) exported, (\d+) omitted as sensitive\)/.exec(schema);
		assert.ok(counted, `the schema source must state its counts — got:\n${schema.split('\n')[4]}`);
		const [, , exported, omitted] = counted;

		// what NOTEBOOKLM.md tells the operator to plan for
		const md = readFile(ws.root, 'NOTEBOOKLM.md');
		const stated = /exports \*\*(\d+) collections\*\*(?: \((\d+) withheld\))?/.exec(md);
		assert.ok(stated, `NOTEBOOKLM.md must state a count — got:\n${md}`);
		assert.equal(stated[1], exported, 'the plan-slot count must be the number of sources the export ships');
		assert.equal(stated[2] ?? '0', omitted, 'and the withheld count must be the export\'s own');

		// and every collection the export heads in its schema map must be named in the brief the
		// persona is built from — a source the reference desk was given but never told about is the
		// same defect wearing a different number
		const brief = md.split('What this workspace keeps, by module:')[1].split('\n\n')[0];
		for (const [, name] of schema.matchAll(/^### collection: (\S+)$/gm)) {
			assert.match(brief, new RegExp(`\\b${name}\\b`), `the brief must name ${name}, which the export ships — got:\n${brief}`);
		}
		assert.match(brief, /\brepos\b/, 'data-backed machinery is exported, so it belongs in the brief');
	});

	test('the measured CSV ceiling is carried, and it names no workspace', () => {
		const md = readFile(fixture().root, 'NOTEBOOKLM.md');
		assert.match(md, /805,081 bytes indexed/);
		assert.match(md, /a large private workspace/, 'the measurement keeps its numbers and loses the source');
	});
});

describe('it is the operator\'s file, with a managed block inside', () => {
	test('notes above and below the block survive a recompile', () => {
		const ws = fixture();
		const file = path.join(ws.root, 'NOTEBOOKLM.md');
		const md = fs.readFileSync(file, 'utf8');
		fs.writeFileSync(file, `# my notes\n\nkeep me\n\n${md}\n\ntrailing note\n`);
		assert.equal(ws.dt('compile').code, 0);
		const after = fs.readFileSync(file, 'utf8');
		assert.match(after, /^# my notes$/m);
		assert.match(after, /^keep me$/m);
		assert.match(after, /^trailing note$/m);
		assert.equal((after.match(/dreamteamer:begin/g) || []).length, 1, 'the block was duplicated');
	});

	test('turning the harness OFF removes the block and keeps the file', () => {
		const ws = fixture();
		const file = path.join(ws.root, 'NOTEBOOKLM.md');
		fs.writeFileSync(file, `# my notes\n\n${fs.readFileSync(file, 'utf8')}`);
		const pkgPath = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		pkg.dreamteamer.harnesses = ['claude-code'];
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t'));
		assert.equal(ws.dt('compile').code, 0);
		const after = fs.readFileSync(file, 'utf8');
		assert.match(after, /^# my notes$/m, 'the operator\'s own file was deleted');
		assert.ok(!after.includes('dreamteamer:begin'), 'the block should be gone');
	});

	test('no NOTEBOOKLM.md at all when the harness was never on', () => {
		const ws = workspace({ pkg: { harnesses: ['claude-code'] }, collections: { people: PEOPLE } });
		assert.equal(readFile(ws.root, 'NOTEBOOKLM.md'), null);
	});

	test('an unknown harness still warns, and notebooklm is not it', () => {
		const ws = workspace({ pkg: { harnesses: ['notebooklm', 'bogus-harness'] }, collections: { people: PEOPLE } });
		assert.match(ws.out.warnings.join('\n'), /unknown harness "bogus-harness"/);
		assert.ok(readFile(ws.root, 'NOTEBOOKLM.md'), 'notebooklm must be recognised');
	});
});
