// The exports manifest's pure half (cr-dt-004): its bytes, the one reference walk, and the per-entry
// rules `dt exports` and `check` share. A context is faked here — `rootsOf`/`complete` are what
// exportsContext answers from the runtime and the disk, exercised by test/integration/exports.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serializeExports, outsideRefs, regenerate, isStale, sees } from '../../src/exports.ts';

const ctx = ({ seen = [], complete = true } = {}) => ({
	rootsOf: () => seen.map((p) => ({ package: p, present: true })),
	complete: () => complete,
});
const nothingHeld = () => false;

describe('serializeExports', () => {
	test('tab-indented, sorted, one line per entry, a from only when known; empty is null', () => {
		const text = serializeExports({ people: { zed: { label: 'Zed' }, ann: { label: 'Ann "A"', from: 'acme-hq' } }, 'ns/things': { 'a/b': { label: 'AB' } }, empty: {} });
		assert.equal(text, '{\n\t"dreamteamer_exports": 1,\n\t"references": {\n\t\t"ns/things": {\n\t\t\t"a/b": { "label": "AB" }\n\t\t},\n\t\t"people": {\n\t\t\t"ann": { "label": "Ann \\"A\\"", "from": "acme-hq" },\n\t\t\t"zed": { "label": "Zed" }\n\t\t}\n\t}\n}\n');
		assert.deepEqual(JSON.parse(text).references.people.ann, { label: 'Ann "A"', from: 'acme-hq' });
		assert.equal(serializeExports({}), null);
		assert.equal(serializeExports({ people: {} }), null);
	});
});

describe('outsideRefs — the one walk', () => {
	const d = { compiled: { fields: {
		owner: { type: 'people' }, many: { type: 'people', many: true }, either: { type: ['people', 'places'] },
		about: { type: 'people', soft: true }, back: { type: 'people', mirror_of: 'x' },
		meta: { type: 'object', fields: { lead: { type: 'people' } } }, name: { type: 'string' },
	} } };
	test('hard, many-valued, union and nested references count; soft, mirror, held, @tokens and wrong targets do not', () => {
		const records = [{ collection: 'tasks', id: 't1', descriptor: d, fields: {
			owner: 'people/ann', many: ['people/bo', 'people/held'], either: 'places/p1', about: 'people/soft', back: ['people/mir'],
			meta: { lead: 'people/lead' }, name: 'people/not-a-ref',
		} }, { collection: 'tasks', id: 't2', descriptor: d, fields: { owner: 'people/ann', many: ['@me', 'places/wrong'] } }];
		const out = outsideRefs({ records, held: (c, id) => id === 'held', resolve: (c, id) => (id === 'ann' ? { label: 'Ann', from: 'hq' } : null), namespaces: [] });
		assert.deepEqual([...out.keys()].sort(), ['people/ann', 'people/bo', 'people/lead', 'places/p1']);
		assert.deepEqual(out.get('people/ann'), { collection: 'people', id: 'ann', resolved: { label: 'Ann', from: 'hq' }, referrers: ['tasks/t1', 'tasks/t2'] });
		assert.equal(out.get('people/bo').resolved, null);
	});
});

describe('regenerate — design §3', () => {
	const outside = (entries) => new Map(entries.map(([ref, resolved]) => { const [c, id] = ref.split('/'); return [ref, { collection: c, id, resolved, referrers: ['tasks/t'] }]; }));
	const run = (current, out, c = ctx(), held = nothingHeld) => regenerate({ current, outside: outside(out), ctx: c, repo: null, held });

	test('1 add: an outside reference that resolves here; none for one that resolves nowhere', () => {
		const { next, changes } = run({}, [['people/ann', { label: 'Ann', from: 'hq' }], ['people/gone', null]]);
		assert.deepEqual(next, { people: { ann: { label: 'Ann', from: 'hq' } } });
		assert.deepEqual(changes.map((x) => x.kind), ['add']);
		assert.equal(isStale(changes), false, 'an addition alone is not staleness');
	});
	test('2 refresh: only where the holder is seen, and never the from', () => {
		const cur = { people: { ann: { label: 'Old', from: 'hq' } } };
		assert.deepEqual(run(cur, [['people/ann', { label: 'Ann', from: 'hq' }]], ctx({ seen: ['hq'] })).next.people.ann, { label: 'Ann', from: 'hq' });
		assert.deepEqual(run(cur, [['people/ann', { label: 'Ann', from: 'hq' }]], ctx({ seen: [] })).next.people.ann, { label: 'Old', from: 'hq' }, 'unseen holder: kept');
		const other = run(cur, [['people/ann', { label: 'Other', from: 'elsewhere' }]], ctx({ seen: ['elsewhere'] }));
		assert.deepEqual(other.next.people.ann, { label: 'Old', from: 'hq' }, 'another holder answers here: the entry keeps its own');
		assert.equal(isStale(other.changes), false);
	});
	test('2b fill: a holder-less entry whose id resolves here, once; kept where it does not resolve', () => {
		const cur = { people: { ann: { label: 'From a stub' } } };
		const filled = run(cur, [['people/ann', { label: 'Ann', from: 'hq' }]]);
		assert.deepEqual(filled.next.people.ann, { label: 'Ann', from: 'hq' });
		assert.deepEqual(filled.changes.map((x) => x.kind), ['fill']);
		assert.equal(isStale(filled.changes), true);
		const kept = run(cur, [['people/ann', null]], ctx({ complete: false }));
		assert.deepEqual(kept.next, cur);
		assert.deepEqual(kept.changes, []);
	});
	test('3 drop: held by the repo; holder seen and lacking the id (D5); unreferenced only where the repo is read completely', () => {
		const cur = { people: { mine: { label: 'M' }, lost: { label: 'L', from: 'hq' }, idle: { label: 'I', from: 'far' } } };
		const out = [['people/lost', null]];
		const full = run(cur, out, ctx({ seen: ['hq'], complete: true }), (c, id) => id === 'mine');
		assert.deepEqual(full.next, {});
		assert.deepEqual(full.changes.map((x) => `${x.ref}:${x.kind}`).sort(), ['people/idle:drop', 'people/lost:drop', 'people/mine:drop']);
		const partial = run(cur, out, ctx({ seen: [], complete: false }));
		assert.deepEqual(partial.next, cur, 'incomplete, holder unseen: nothing is judged');
		assert.deepEqual(partial.changes, []);
	});
	test('regenerating its own output changes nothing (a fixpoint)', () => {
		const out = [['people/ann', { label: 'Ann', from: 'hq' }]];
		const once = run({}, out, ctx({ seen: ['hq'] })).next;
		assert.deepEqual(run(once, out, ctx({ seen: ['hq'] })).changes, []);
	});
});

describe('sees', () => {
	test('needs a from, a root of the collection with that package, and the clone on disk', () => {
		assert.equal(sees({ label: 'x' }, 'people', ctx({ seen: ['hq'] })), false);
		assert.equal(sees({ label: 'x', from: 'hq' }, 'people', ctx({ seen: ['hq'] })), true);
		assert.equal(sees({ label: 'x', from: 'hq' }, 'people', { rootsOf: () => [{ package: 'hq', present: false }] }), false, 'a removed clone is not seen');
	});
});
