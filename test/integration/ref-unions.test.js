// Tier 2 — a reference to a LIST of targets (the union, `type: [a, b]`), through the real store and CLI.
//
// Values stay fully qualified `<collection>/<id>`: the qualified value itself says which branch of
// the union it took, which is why unions cost zero record migration. The load-bearing assertions
// are the REFUSALS — a ref into an unlisted collection must fail naming the allowed set.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, compileError, readFile } from '../helpers/ws.js';
import { presentation } from '../../src/presentation.js';
import { renderDisplay } from '../../src/template.js';

/** A collection with `name`, the given fields, and a body. */
const coll = (suffix, fields = {}, extra = {}) => simpleCollection({
	storage: { suffix },
	fields: { name: { type: 'string', required: true }, ...fields, notes: { type: 'markdown', body: true } },
	...extra,
});

function unionWorkspace() {
	return workspace({
		namespaces: ['finance'],
		collections: {
			meetings: coll('meeting'),
			clients: coll('client'),
			'finance/accounts': coll('account'),
			notes: coll('note', {
				about: { type: ['meetings', 'finance/accounts'] },
				sources: { type: ['meetings', 'clients'], many: true },
			}),
		},
		records: {
			meetings: [{ name: 'Standup' }],
			clients: [{ name: 'Acme' }],
			'finance/accounts': [{ name: 'Checking' }],
		},
	});
}

function conceptWorkspace() {
	return workspace({
		namespaces: ['content'],
		collections: {
			'content/audiences': coll('audience'),
			'content/concepts': coll('concept', { audiences: { type: 'content/audiences', many: true } }),
		},
		records: { 'content/audiences': [{ name: 'Executives' }] },
	});
}

describe('bare ids on input (single-target fields only)', () => {
	test('a bare id lands on disk qualified', () => {
		const { store, root } = conceptWorkspace();
		store.add('content/concepts', { name: 'X', audiences: ['executives'] });
		const file = readFile(root, 'data/content/concepts/x.concept.md');
		assert.match(file, /content\/audiences\/executives/);
		assert.doesNotMatch(file, /^\s*- executives\s*$/m);
	});

	test('an already-qualified value is byte-identical after the write', () => {
		// same fixture; write the qualified spelling and assert it is exactly that value on both the
		// parsed record and the file text — a non-anchored substring match also passes for a
		// double-qualified "content/audiences/content/audiences/executives", which is exactly the bug
		// this guards.
		const { store, root } = conceptWorkspace();
		store.add('content/concepts', { name: 'Y', audiences: ['content/audiences/executives'] });
		assert.deepEqual(store.read('content/concepts', 'y').fields.audiences, ['content/audiences/executives']);
		assert.match(
			readFile(root, 'data/content/concepts/y.concept.md'),
			/^\s*-\s*content\/audiences\/executives\s*$/m,
		);
	});

	test('a bare id on a UNION field is rejected as malformed — the prefix is its type info', () => {
		const { store } = unionWorkspace();
		assert.throws(
			() => store.add('notes', { name: 'f', about: 'standup' }),
			/is not <collection>\/<id>/,
		);
	});

	test('a bare TYPO on a single-target field fails as a dangling reference, not as syntax', () => {
		const { store } = conceptWorkspace();
		assert.throws(
			() => store.add('content/concepts', { name: 'Z', audiences: ['exceutives'] }),
			/dangling reference "content\/audiences\/exceutives"/,
		);
	});
});

describe('reference unions: store write path', () => {
	test('accepts a ref into each listed target, scalar and list fields', () => {
		const { store } = unionWorkspace();
		store.add('notes', { name: 'a', about: 'meetings/standup' });
		store.add('notes', { name: 'b', about: 'finance/accounts/checking' });
		store.add('notes', { name: 'c', sources: ['meetings/standup', 'clients/acme'] });
	});

	test('rejects a ref into an unlisted collection, naming the allowed set', () => {
		const { store } = unionWorkspace();
		assert.throws(
			() => store.add('notes', { name: 'd', about: 'clients/acme' }),
			/must target one of: meetings, finance\/accounts/,
		);
	});

	test('still rejects a dangling ref into a listed target', () => {
		const { store } = unionWorkspace();
		assert.throws(
			() => store.add('notes', { name: 'e', about: 'meetings/nope' }),
			/dangling reference/,
		);
	});

	test('scalar target error message is unchanged (single-collection wording)', () => {
		const { store } = workspace({
			collections: {
				companies: coll('company'),
				widgets: coll('widget'),
				contacts: coll('contact', { company: { type: 'companies' } }),
			},
			records: { widgets: [{ name: 'Gizmo' }] },
		});
		assert.throws(
			() => store.add('contacts', { name: 'Jane', company: 'widgets/gizmo' }),
			/must target collection "companies"/,
		);
	});
});

describe('reference unions: check', () => {
	test('flags a hand-edited ref into an unlisted collection; passes listed ones', () => {
		const { store, root, dt } = unionWorkspace();
		store.add('notes', { name: 'ok', about: 'meetings/standup' });
		// hand-edit past the store, the way a human with an editor does
		const file = `${root}/data/notes/ok.note.md`;
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('meetings/standup', 'clients/acme'));
		const res = dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout + res.stderr, /should target one of: meetings, finance\/accounts/);
	});

	test('a union FK mirrors into whichever collection the value names', () => {
		// one owner field, two targets, and each target declares its own mirror of it
		const { store, dt, root } = workspace({
			collections: {
				meetings: coll('meeting', { analyses: { type: 'reviews', many: true, mirror_of: 'of' } }),
				briefs: coll('brief', { analyses: { type: 'reviews', many: true, mirror_of: 'of' } }),
				reviews: coll('review', { of: { type: ['meetings', 'briefs'] } }),
			},
			records: { meetings: [{ name: 'Standup' }], briefs: [{ name: 'Pitch' }] },
		});
		// the union value names WHICH collection the mirror lands in, so `meetings.analyses` must stay
		// empty while `briefs.analyses` fills — no per-target syntax
		store.add('reviews', { name: 'r1', of: 'briefs/pitch' });
		assert.deepEqual(store.read('briefs', 'pitch').fields.analyses, ['reviews/r1']);
		assert.equal(store.read('meetings', 'standup').fields.analyses, undefined);
		assert.equal(dt('check').code, 0);
		// break it past the store: the mirror falls behind the owning side
		const pitch = `${root}/data/briefs/pitch.brief.md`;
		fs.writeFileSync(pitch, '---\nname: Pitch\n---\n');
		const res = dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout + res.stderr, /analyses: stale — run: dreamteamer relations rebuild briefs/);
	});
});

describe('reference unions: compile contract', () => {
	const noteWith = (type) => coll('note', { about: { type } });

	test('a union member nothing provides fails compile naming the member', () => {
		const { ws } = workspace({
			compile: false,
			collections: { meetings: coll('meeting'), notes: noteWith(['meetings', 'ghosts']) },
		});
		assert.match(compileError(ws), /field "about": union member "ghosts" is not a collection/);
	});

	test('an empty list fails compile — a union names at least one collection', () => {
		const { ws } = workspace({ compile: false, collections: { notes: noteWith([]) } });
		assert.match(compileError(ws) ?? 'compiled', /field "about": .*union/);
	});

	test("'*' inside a list fails compile — any-collection is `type: reference`, never a union member", () => {
		const { ws } = workspace({ compile: false, collections: { meetings: coll('meeting'), notes: noteWith(['meetings', '*']) } });
		assert.match(compileError(ws), /field "about": union member "\*" is not a collection/);
	});

	test('a valid union over owned collections compiles clean', () => {
		const { out } = workspace({
			collections: {
				meetings: coll('meeting'),
				clients: coll('client'),
				notes: noteWith(['meetings', 'clients']),
			},
		});
		assert.equal(out.code, 0);
	});
});

describe('reference unions: presentation', () => {
	test('a union field emits one relations row per member; each value renders through its own target\'s record_title', () => {
		const { store } = workspace({
			collections: {
				meetings: coll('meeting', {}, { record_title: '{{ name }}' }),
				clients: coll('client', {}, { record_title: '{{ name }} (client)' }),
				invoices: coll('invoice', { number: { type: 'string' } }, { record_title: '{{ number }}' }),
				notes: coll('note', {
					agree: { type: ['meetings', 'clients'] },
					disagree: { type: ['meetings', 'invoices'] },
				}),
			},
		});
		// presentation() takes the compiled descriptor map — `store.descriptors`
		const p = presentation(store.descriptors);
		const rel = p.relations.filter((r) => r.collection === 'notes');
		assert.deepEqual(
			rel.map((r) => [r.field, r.related_collection]).sort(),
			[['agree', 'clients'], ['agree', 'meetings'], ['disagree', 'invoices'], ['disagree', 'meetings']],
		);
		// a reference carries no title template of its own: the value names its collection, and that
		// collection's `record_title` renders it — so union members whose titles differ need no agreement
		const fields = Object.fromEntries(p.fields.notes.map((f) => [f.field, f]));
		assert.equal(fields.agree.role, 'reference');
		assert.equal(fields.agree.viewer_options, undefined);
		assert.equal(fields.disagree.viewer_options, undefined);
		const titleOf = (c) => p.collections.find((r) => r.collection === c).record_title;
		assert.equal(renderDisplay(titleOf('meetings'), { name: 'Standup' }), 'Standup');
		assert.equal(renderDisplay(titleOf('clients'), { name: 'Acme' }), 'Acme (client)');
		assert.equal(renderDisplay(titleOf('invoices'), { name: 'ignored', number: 'INV-7' }), 'INV-7');
	});
});
