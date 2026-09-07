// Tier 2 — `dt export notebooklm` against a real compiled workspace, through the real binary.
//
// The load-bearing assertions are NEGATIVE: a value of a sensitive field appears in NO file the
// export writes, and a sensitive collection produces NO shard. Everything else — the hierarchy of
// the schema source, the shard titles, the budget refusal — is checked on the bytes on disk, never
// on the exporter's own report of them. The vendor CLI is never called: without `--notebook` or
// `--create`, export is a pure render.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeModule, readFile } from '../helpers/ws.js';

const COMPANIES = {
	description: 'An organisation.',
	storage: { suffix: 'company' },
	id: { generate: '{{ name | slug }}' },
	schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
};
const PEOPLE = {
	description: 'A person we deal with.',
	use_when: 'someone is named',
	storage: { suffix: 'person' },
	id: { generate: '{{ name | slug }}' },
	schema: { type: 'object', required: ['name'], properties: {
		name: { type: 'string', description: 'Full name.' },
		email: { type: 'string', 'x-sensitive': true, description: 'Where to write.' },
		company: { type: 'string', 'x-reference': 'companies' },
		peers: { type: 'array', items: { type: 'string', 'x-reference': 'people' } },
		status: { type: 'string', enum: ['draft', 'verified'], default: 'draft' },
		notes: { type: 'string', format: 'markdown', 'x-body': true },
	} },
};
const LEDGER = {
	description: 'Money that moved.',
	sensitive: true,
	storage: { suffix: 'entry' },
	id: { generate: '{{ name | slug }}' },
	schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, amount: { type: 'number' } } },
};

const EMAILS = ['ada@example.invalid', 'grace@example.invalid', 'linus@example.invalid'];

function fixture() {
	const ws = workspace({
		collections: { companies: COMPANIES, people: PEOPLE, ledger: LEDGER },
		records: {
			companies: [{ name: 'Analytical Engines' }, { name: 'Cobol Corp' }],
			people: [
				{ name: 'Ada', email: EMAILS[0], company: 'companies/analytical-engines', notes: '# Ada\n\nWrote the first program.' },
				{ name: 'Grace', email: EMAILS[1], company: 'companies/cobol-corp', peers: ['people/ada'], notes: 'Coined the bug.' },
				{ name: 'Linus', email: EMAILS[2], notes: 'Kernel.' },
			],
			ledger: [{ name: 'rent', amount: 1234.5 }],
		},
	});
	return ws;
}

const bundleFiles = (root, out = 'bundle') => fs.readdirSync(path.join(root, out)).filter((f) => f.endsWith('.md')).sort();
const manifest = (root, out = 'bundle') => JSON.parse(readFile(root, `${out}/manifest.json`));

describe('dt export notebooklm — the render', () => {
	test('a sensitive field\'s values reach no file, and the omission is reported', () => {
		const ws = fixture();
		const res = ws.dt('export', 'notebooklm', '--out', 'bundle');
		assert.equal(res.code, 0, res.stderr);
		for (const f of fs.readdirSync(path.join(ws.root, 'bundle'))) {
			const text = readFile(ws.root, `bundle/${f}`);
			for (const e of EMAILS) assert.ok(!text.includes(e), `${e} leaked into bundle/${f}`);
		}
		const m = manifest(ws.root);
		assert.deepEqual(m.omitted.fields.people, ['email']);
		assert.ok(readFile(ws.root, 'bundle/people.md').includes('Ada'), 'non-sensitive values are exported');
	});

	test('a sensitive collection produces no shard, is listed as omitted, and is marked in the schema', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		assert.deepEqual(bundleFiles(ws.root), ['00-schema.md', 'companies.md', 'instructions.md', 'people.md']);
		const m = manifest(ws.root);
		assert.deepEqual(m.omitted.collections, ['ledger']);
		assert.match(readFile(ws.root, 'bundle/00-schema.md'), /### collection: ledger[\s\S]*?sensitive — not exported/);
		assert.ok(!readFile(ws.root, 'bundle/00-schema.md').includes('1234.5'));
	});

	test('system collections get no shard — they ARE the schema source', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		const files = bundleFiles(ws.root);
		for (const sys of ['collections', 'skills', 'modules', 'ui-views']) assert.ok(!files.includes(`${sys}.md`), `${sys} was exported as records`);
	});

	test('the schema source renders workspace → module → collection → field, by heading level', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		const schema = readFile(ws.root, 'bundle/00-schema.md');
		const iModule = schema.indexOf('## module: ');
		const iPeople = schema.indexOf('### collection: people');
		const iField = schema.indexOf('- name (string, required)', iPeople);
		assert.ok(iModule > -1 && iPeople > iModule && iField > iPeople, `order was module@${iModule} people@${iPeople} field@${iField}`);
		assert.match(schema, /- email \(string\) — sensitive, not exported/);
		assert.match(schema, /- company \(reference → companies\)/);
		assert.match(schema, /- peers \(reference → people, many\)/, 'a many-reference names its target from items');
		assert.match(schema, /- status \(enum: draft \| verified, default draft\)/);
		assert.match(schema, /system collections \(not exported as records\): .*collections.*skills/);
	});

	test('a record renders its id, its kept fields, a labelled reference and its body with headings demoted', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		const people = readFile(ws.root, 'bundle/people.md');
		assert.match(people, /^## people\/ada$/m);
		assert.match(people, /^- company: companies\/analytical-engines \(Analytical Engines\)$/m);
		assert.match(people, /^### Ada$/m, 'a body H1 becomes H3 so record sections stay the H2 boundary');
		assert.match(people, /^- peers: people\/ada \(Ada\)$/m, 'each element of a many-reference is labelled');
		assert.ok(!people.includes('- email:'));
	});

	test('--collections narrows the render', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle', '--collections', 'companies').code, 0);
		assert.deepEqual(bundleFiles(ws.root), ['00-schema.md', 'companies.md', 'instructions.md']);
	});

	test('two renders of unchanged records hash identically — no timestamp or version in a source', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		const first = manifest(ws.root).sources.map((s) => [s.title, s.sha256]);
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		assert.deepEqual(manifest(ws.root).sources.map((s) => [s.title, s.sha256]), first, 'a sync would re-upload every source otherwise');
	});

	test('a stale shard from a previous export is removed from the bundle', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle', '--collections', 'companies').code, 0);
		assert.ok(!bundleFiles(ws.root).includes('people.md'));
	});
});

describe('dt export notebooklm — sharding and the budget', () => {
	test('--max-words shards a collection into [N/M] sources, every id exactly once, no file over the cap', () => {
		const ws = fixture();
		const res = ws.dt('export', 'notebooklm', '--out', 'bundle', '--max-words', '55');
		assert.equal(res.code, 0, res.stderr);
		const m = manifest(ws.root);
		const shards = m.sources.filter((s) => s.collection === 'people');
		assert.ok(shards.length >= 2, `expected people to shard, got ${shards.length}`);
		assert.deepEqual(shards.map((s) => s.title), shards.map((_, i) => `dt · people [${i + 1}/${shards.length}]`));
		const ids = shards.flatMap((s) => s.records);
		assert.deepEqual([...ids].sort(), ['ada', 'grace', 'linus']);
		for (const s of shards) {
			const text = readFile(ws.root, `bundle/${s.file}`);
			assert.ok(text.trim().split(/\s+/).length <= 55, `${s.file} is over the cap`);
		}
	});

	test('more sources than the plan allows is a refusal that names the count, the plan and the remedies', () => {
		const ws = fixture();
		const res = ws.dt('export', 'notebooklm', '--out', 'bundle', '--plan', '2');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /3 sources.*plan 2 allows 2/s);
		assert.match(res.stderr, /--collections/);
		assert.match(res.stderr, /--plan/);
		assert.ok(!fs.existsSync(path.join(ws.root, 'bundle', 'manifest.json')), 'a refused export writes no bundle');
	});

	test('the manifest carries the budget, and --json prints it', () => {
		const ws = fixture();
		const res = ws.dt('export', 'notebooklm', '--out', 'bundle', '--plan', 'pro', '--json');
		assert.equal(res.code, 0, res.stderr);
		const m = JSON.parse(res.stdout);
		assert.deepEqual(m.budget, { plan: 'pro', limit: 300, used: 3 });
	});
});

describe('dt export notebooklm — the persona', () => {
	test('the default template renders the workspace name and the schema brief into instructions.md', () => {
		const ws = fixture();
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		const text = readFile(ws.root, 'bundle/instructions.md');
		assert.ok(text.includes(ws.ws.pkg.name), 'workspace name');
		assert.match(text, /people/);
		assert.match(text, /ledger/, 'the omitted collection is named so the assistant knows what it cannot answer');
		assert.ok(!text.includes('{{'), 'no placeholder survives');
	});

	test('--instructions takes a template file; an unknown placeholder and an oversize render are refusals', () => {
		const ws = fixture();
		fs.writeFileSync(path.join(ws.root, 'tpl.md'), 'Brain of {{workspace}}. Sources: {{sources}}');
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle', '--instructions', 'tpl.md').code, 0);
		assert.match(readFile(ws.root, 'bundle/instructions.md'), /^Brain of .*\. Sources: dt · schema, dt · companies, dt · people$/);
		fs.writeFileSync(path.join(ws.root, 'bad.md'), 'Brain of {{workspce}}');
		const bad = ws.dt('export', 'notebooklm', '--out', 'bundle', '--instructions', 'bad.md');
		assert.equal(bad.code, 1);
		assert.match(bad.stderr, /unknown placeholder "workspce"/);
		fs.writeFileSync(path.join(ws.root, 'big.md'), 'x'.repeat(10001));
		const big = ws.dt('export', 'notebooklm', '--out', 'bundle', '--instructions', 'big.md');
		assert.equal(big.code, 1);
		assert.match(big.stderr, /10001 characters/);
	});
});

describe('dt export — the verb', () => {
	test('no target is its own complaint; an unknown target lists the known ones; an unknown flag is refused', () => {
		const ws = fixture();
		const none = ws.dt('export');
		assert.equal(none.code, 1);
		assert.match(none.stderr, /dt export needs a target.*notebooklm/s);
		const bogus = ws.dt('export', 'obsidian');
		assert.equal(bogus.code, 1);
		assert.match(bogus.stderr, /unknown export target "obsidian".*notebooklm/s);
		const flag = ws.dt('export', 'notebooklm', '--bogus');
		assert.equal(flag.code, 1);
		assert.match(flag.stderr, /unknown flag "--bogus"/);
	});
});

describe('the marks are written by the schema verbs', () => {
	test('add-field --sensitive writes x-sensitive, update-field --sensitive false clears it, and the export follows', () => {
		const ws = fixture();
		let res = ws.dt('add-field', 'people', '--name', 'phone', '--type', 'string', '--sensitive');
		assert.equal(res.code, 0, res.stderr);
		let d = readFile(ws.root, '.dreamteamer/collections/people.collection.yaml');
		assert.match(d, /phone:[\s\S]*?x-sensitive: true/);
		assert.equal(ws.dt('set', 'people/ada', 'phone=+000-0000').code, 0); // a value that must not travel — through the binary, whose store sees the recompiled descriptor
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		assert.ok(!readFile(ws.root, 'bundle/people.md').includes('+000-0000'));
		assert.deepEqual(manifest(ws.root).omitted.fields.people, ['email', 'phone']);
		res = ws.dt('update-field', 'people', '--name', 'phone', '--sensitive', 'false');
		assert.equal(res.code, 0, res.stderr);
		d = readFile(ws.root, '.dreamteamer/collections/people.collection.yaml');
		assert.ok(!/phone:[\s\S]*?x-sensitive/.test(d.split('company:')[0]), 'the mark is cleared');
		res = ws.dt('update-field', 'people', '--name', 'phone', '--description', 'A number.');
		assert.equal(res.code, 0, res.stderr);
	});

	test('a description-only update-field carries an existing x-sensitive forward', () => {
		const ws = fixture();
		const res = ws.dt('update-field', 'people', '--name', 'email', '--description', 'Still private.');
		assert.equal(res.code, 0, res.stderr);
		assert.match(readFile(ws.root, '.dreamteamer/collections/people.collection.yaml'), /email:[\s\S]*?x-sensitive: true/);
	});

	test('set collections/<c> sensitive=true lands on the descriptor and the next export omits the collection', () => {
		const ws = fixture();
		const res = ws.dt('set', 'collections/people', 'sensitive=true');
		assert.equal(res.code, 0, res.stderr);
		assert.match(readFile(ws.root, '.dreamteamer/collections/people.collection.yaml'), /^sensitive: true$/m);
		assert.equal(ws.dt('export', 'notebooklm', '--out', 'bundle').code, 0);
		assert.deepEqual(manifest(ws.root).omitted.collections, ['ledger', 'people']);
		assert.equal(ws.dt('check').code, 0, 'check accepts the key');
	});
});
