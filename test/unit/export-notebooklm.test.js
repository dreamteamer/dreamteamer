// Tier 1 — the pure halves of `dt export notebooklm`: projection, sharding, the sync planner, the
// persona template. Everything here runs with no workspace, no git and no `notebooklm` binary — which
// is the point: the vendor CLI is a network call the suite cannot make, so the decisions that FEED
// it are pinned here and the calls themselves are one thin function.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	words, projectRecord, omittedFields, exportability, shardSections, planSync, renderInstructions, redactWithheld,
	sourceTitle, sourceFile, OWNED_PREFIX, PERSONA_MAX, PLANS, sourceLimit,
} from '../../src/export-notebooklm.js';

const PEOPLE = {
	name: 'people',
	storage: { path: 'data/people', codec: 'md', base: 'workspace' },
	schema: { type: 'object', properties: {
		name: { type: 'string' },
		email: { type: 'string', 'x-sensitive': true },
		phone: { type: 'string', 'x-sensitive': true },
		notes: { type: 'string', 'x-body': true },
	} },
};

describe('projection — the mark is the decision', () => {
	test('x-sensitive fields are dropped, everything else kept, and the dropped set is named', () => {
		const { kept, dropped } = projectRecord(PEOPLE, { name: 'Ada', email: 'ada@example.invalid', phone: '000', notes: 'hi' });
		assert.deepEqual(kept, { name: 'Ada', notes: 'hi' });
		assert.deepEqual(dropped, ['email', 'phone']);
	});
	test('omittedFields reads the descriptor, not a record', () => {
		assert.deepEqual(omittedFields(PEOPLE), ['email', 'phone']);
	});
	test('a system collection, a codec:file collection and a sensitive collection are each refused with their reason', () => {
		assert.equal(exportability({ ...PEOPLE, storage: { ...PEOPLE.storage, base: 'runtime' } }), 'system');
		assert.equal(exportability({ ...PEOPLE, storage: { ...PEOPLE.storage, codec: 'file' } }), 'file');
		assert.equal(exportability({ ...PEOPLE, sensitive: true }), 'sensitive');
		assert.equal(exportability(PEOPLE), null);
	});
});

describe('sharding — greedy, in order, never over the cap', () => {
	const sec = (id, n) => ({ id, text: Array.from({ length: n }, (_, i) => `w${i}`).join(' ') });
	test('everything fits → one shard', () => {
		const shards = shardSections([sec('a', 10), sec('b', 10)], 100);
		assert.equal(shards.length, 1);
		assert.deepEqual(shards[0].map((s) => s.id), ['a', 'b']);
	});
	test('splits when the running total would exceed the cap, keeping id order and every id once', () => {
		const shards = shardSections([sec('a', 40), sec('b', 40), sec('c', 40), sec('d', 40)], 100);
		assert.deepEqual(shards.map((s) => s.map((x) => x.id)), [['a', 'b'], ['c', 'd']]);
		for (const s of shards) assert.ok(s.reduce((n, x) => n + words(x.text), 0) <= 100);
	});
	test('a single record over the cap is an error that names it', () => {
		assert.throws(() => shardSections([sec('huge', 200)], 100), /huge.*200 words.*cap 100/s);
	});
	test('words counts whitespace-separated tokens, non-Latin scripts included', () => {
		assert.equal(words('\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd  hello\nworld'), 4); // escaped so the public repo carries no non-Latin bytes
		assert.equal(words('   '), 0);
	});
});

describe('titles and files', () => {
	test('one shard carries no index; several carry [N/M]; the prefix marks ownership', () => {
		assert.equal(sourceTitle('people', 1, 1), `${OWNED_PREFIX}people`);
		assert.equal(sourceTitle('rnd/issues', 2, 3), `${OWNED_PREFIX}rnd/issues [2/3]`);
	});
	test('a namespaced collection flattens to a filename', () => {
		assert.equal(sourceFile('people', 1, 1), 'people.md');
		assert.equal(sourceFile('rnd/issues', 2, 3), 'rnd--issues--02.md');
	});
	test('a plan is a name from Google\'s table or a bare number', () => {
		assert.equal(sourceLimit('standard'), PLANS.standard);
		assert.equal(sourceLimit('pro'), 300);
		assert.equal(sourceLimit('7'), 7);
		assert.throws(() => sourceLimit('enterprise'), /unknown plan "enterprise".*standard/);
	});
});

describe('planSync — what a sync would do, decided before any call is made', () => {
	const src = (title, sha) => ({ title, sha256: sha });
	const A = `${OWNED_PREFIX}a`, B = `${OWNED_PREFIX}b`, C = `${OWNED_PREFIX}c`;
	test('tracked id live + same sha → skip; tracked id live + new sha → replace; untracked → add; stale owned → remove; foreign → untouched', () => {
		const wanted = [src(A, '1'), src(B, '2'), src(C, '3')];
		const existing = [
			{ id: 'sa', title: A }, { id: 'sb', title: 'b.md' } /* the vendor kept the file name */,
			{ id: 'sx', title: `${OWNED_PREFIX}stale` }, { id: 'sf', title: 'a paper I added by hand' },
		];
		const state = { [A]: { source_id: 'sa', sha256: '1' }, [B]: { source_id: 'sb', sha256: 'OLD' } };
		const plan = planSync(wanted, existing, state);
		assert.deepEqual(plan.skip.map((s) => [s.title, s.sourceId]), [[A, 'sa']]);
		assert.deepEqual(plan.replace.map((s) => [s.title, s.oldId]), [[B, 'sb']]);
		assert.deepEqual(plan.add.map((s) => s.title), [C]);
		assert.deepEqual(plan.remove.map((s) => s.id), ['sx']);
	});
	test('a skipped source whose live title is wrong asks to be renamed; a correct one does not', () => {
		const plan = planSync([src(A, '1'), src(B, '2')], [{ id: 'sa', title: 'a.md' }, { id: 'sb', title: B }], { [A]: { source_id: 'sa', sha256: '1' }, [B]: { source_id: 'sb', sha256: '2' } });
		assert.deepEqual(plan.skip.map((s) => s.renameFrom), ['a.md', null]);
	});
	test('a tracked id the notebook no longer has is an add, not a skip', () => {
		const plan = planSync([src(A, '1')], [], { [A]: { source_id: 'gone', sha256: '1' } });
		assert.equal(plan.add.length, 1);
		assert.equal(plan.skip.length, 0);
	});
	test('a source titled like one of the bundle FILES is ours to remove — the shape the dropped-title bug leaves', () => {
		const plan = planSync([src(A, '1')], [{ id: 's1', title: 'a.md' }, { id: 's2', title: '00-schema.md' }, { id: 's3', title: 'notes.pdf' }], {}, new Set(['a.md', '00-schema.md']));
		assert.deepEqual(plan.add.map((s) => s.title), [A]);
		assert.deepEqual(plan.remove.map((s) => s.id).sort(), ['s1', 's2']);
	});
	test('a title the state tracks but that is no longer wanted is removed by its id even when its title is foreign-looking', () => {
		const plan = planSync([], [{ id: 'old', title: 'whatever the vendor kept' }], { [A]: { source_id: 'old', sha256: '1' } });
		assert.deepEqual(plan.remove.map((s) => s.id), ['old']);
	});
});

describe('redactWithheld — an id is not an opaque handle', () => {
	const W = new Set(['finance/accounts', 'finance/account-source-artifacts', 'family/travel/trips']);
	test('a reference into a withheld collection keeps its collection and loses its id', () => {
		assert.equal(redactWithheld('pay from finance/accounts/bank-main-349911 today', W), 'pay from finance/accounts/… (withheld) today');
	});
	test('it reaches body prose, wikilinks included', () => {
		assert.equal(redactWithheld('see [[family/travel/trips/2026-08--slovakia]]', W), 'see [[family/travel/trips/… (withheld)]]');
	});
	test('the LONGEST collection name wins, so a prefix cannot claim another collection\'s reference', () => {
		assert.equal(redactWithheld('finance/account-source-artifacts/bank/2026/07', W), 'finance/account-source-artifacts/… (withheld)');
	});
	test('a reference to an exported collection is untouched, and so is the bare collection name', () => {
		assert.equal(redactWithheld('companies/acme and finance/accounts alone', W), 'companies/acme and finance/accounts alone');
	});
	test('nothing withheld, nothing changed', () => {
		assert.equal(redactWithheld('finance/accounts/bank-main', new Set()), 'finance/accounts/bank-main');
	});
});

describe('the persona template', () => {
	test('placeholders render; an unknown one is an error rather than a literal in the prompt', () => {
		assert.equal(renderInstructions('You answer about {{workspace}} ({{count}}).', { workspace: 'acme', count: 3 }), 'You answer about acme (3).');
		assert.throws(() => renderInstructions('{{workspce}}', { workspace: 'acme' }), /unknown placeholder "workspce".*workspace/s);
	});
	test('the rendered persona is bounded by what NotebookLM accepts', () => {
		assert.equal(PERSONA_MAX, 10000);
		assert.throws(() => renderInstructions('x'.repeat(PERSONA_MAX + 1), {}), /10001 characters.*10000/s);
	});
});
