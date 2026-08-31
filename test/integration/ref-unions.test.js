// Tier 2 — `x-reference` as a LIST of targets (the union), through the real store and CLI.
//
// Values stay fully qualified `<collection>/<id>`: the qualified value itself says which branch of
// the union it took, which is why unions cost zero record migration. The load-bearing assertions
// are the REFUSALS — a ref into an unlisted collection must fail naming the allowed set.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, compileError, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';
import { presentation } from '../../src/presentation.js';

function unionWorkspace() {
	return workspace({
		namespaces: ['finance'],
		collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			clients: simpleCollection({ storage: { suffix: 'client' } }),
			'finance/accounts': simpleCollection({ storage: { suffix: 'account' } }),
			notes: {
				id: { generate: '{{ name | slug }}' },
				storage: { suffix: 'note' },
				schema: {
					type: 'object',
					required: ['name'],
					properties: {
						name: { type: 'string' },
						about: { type: 'string', 'x-reference': ['meetings', 'finance/accounts'] },
						sources: { type: 'array', items: { type: 'string', 'x-reference': ['meetings', 'clients'] } },
					},
				},
			},
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
			'content/audiences': simpleCollection({ storage: { suffix: 'audience' } }),
			'content/concepts': {
				id: { generate: '{{ name | slug }}' },
				storage: { suffix: 'concept' },
				schema: {
					type: 'object', required: ['name'],
					properties: {
						name: { type: 'string' },
						audiences: { type: 'array', items: { type: 'string', 'x-reference': 'content/audiences' } },
					},
				},
			},
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
		// parsed record and the file text — a non-anchored substring match (the previous form of this
		// assertion) also passes for a double-qualified
		// "content/audiences/content/audiences/executives", which is exactly the bug this guards.
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

describe('x-reference unions: store write path', () => {
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
				companies: simpleCollection({ storage: { suffix: 'company' } }),
				widgets: simpleCollection({ storage: { suffix: 'widget' } }),
				contacts: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'contact' },
					schema: {
						type: 'object', required: ['name'],
						properties: { name: { type: 'string' }, company: { type: 'string', 'x-reference': 'companies' } },
					},
				},
			},
			records: { widgets: [{ name: 'Gizmo' }] },
		});
		assert.throws(
			() => store.add('contacts', { name: 'Jane', company: 'widgets/gizmo' }),
			/must target collection "companies"/,
		);
	});
});

describe('x-reference unions: check', () => {
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
		const { store, dt, root } = workspace({
			collections: {
				meetings: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							// a mirror target needs an x-body field, or compile refuses to stamp onto it
							notes: { type: 'string', format: 'markdown', 'x-body': true },
							analyses: { type: 'array', items: { type: 'string', 'x-reference': 'reviews' } },
						},
					},
				},
				briefs: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'brief' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							// a mirror target needs an x-body field, or compile refuses to stamp onto it
							notes: { type: 'string', format: 'markdown', 'x-body': true },
							analyses: { type: 'array', items: { type: 'string', 'x-reference': 'reviews' } },
						},
					},
				},
				reviews: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'review' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							of: { type: 'string', 'x-reference': ['meetings', 'briefs'], 'x-inverse': 'analyses' },
						},
					},
				},
			},
			records: { meetings: [{ name: 'Standup' }], briefs: [{ name: 'Pitch' }] },
		});
		// one relation, two targets: the union value names WHICH collection the mirror lands in, so
		// `meetings.analyses` must stay empty while `briefs.analyses` fills — no per-target syntax.
		store.add('reviews', { name: 'r1', of: 'briefs/pitch' });
		// the mirror is written past the store, which refuses direct writes to a generated field —
		// which is fine here, because a hand-edited mirror is precisely what `check` exists to judge
		const pitch = `${root}/data/briefs/pitch.brief.md`;
		fs.writeFileSync(pitch, '---\nname: Pitch\nanalyses:\n  - reviews/r1\n---\n');
		assert.equal(dt('check').code, 0);
		// break it: the mirror falls behind the owning side
		fs.writeFileSync(pitch, '---\nname: Pitch\n---\n');
		const res = dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout + res.stderr, /analyses: stale — run: dreamteamer relations rebuild briefs/);
	});
});

describe('x-reference unions: compile contract', () => {
	const noteWith = (xref) => ({
		id: { generate: '{{ name | slug }}' },
		storage: { suffix: 'note' },
		schema: {
			type: 'object', required: ['name'],
			properties: { name: { type: 'string' }, about: { type: 'string', 'x-reference': xref } },
		},
	});

	test('a union member nothing provides fails compile naming the member', () => {
		const { ws } = workspace({
			compile: false,
			collections: { meetings: simpleCollection({ storage: { suffix: 'meeting' } }), notes: noteWith(['meetings', 'ghosts']) },
		});
		const err = compileError(ws);
		assert.match(err, /"about" references "ghosts"/);
	});

	test('an empty list fails compile as an invalid shape', () => {
		const { ws } = workspace({ compile: false, collections: { notes: noteWith([]) } });
		assert.match(compileError(ws), /invalid x-reference/);
	});

	test("'*' inside a list fails compile — the wildcard is a scalar-only sentinel", () => {
		const { ws } = workspace({ compile: false, collections: { notes: noteWith(['meetings', '*']) } });
		assert.match(compileError(ws), /invalid x-reference/);
	});

	test('a valid union over owned collections compiles clean', () => {
		const { out } = workspace({
			collections: {
				meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
				clients: simpleCollection({ storage: { suffix: 'client' } }),
				notes: noteWith(['meetings', 'clients']),
			},
		});
		assert.equal(out.code, 0);
	});
});

describe('relation keywords normalize onto the x-reference node', () => {
	test('x-inverse authored on the array property lands on items in the compiled descriptor', () => {
		const { root } = workspace({
			collections: {
				reviews: simpleCollection({ storage: { suffix: 'review' } }),
				meetings: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							// authored in the historically-tolerated place: on the property
							analyses: { type: 'array', 'x-inverse': 'of', items: { type: 'string', 'x-reference': 'reviews' } },
						},
					},
				},
			},
		});
		const compiled = readFile(root, '.dreamteamer/collections/meetings.collection.yaml');
		const doc = load(compiled); // use the engine's yaml loader, imported in the test file
		const prop = doc.schema.properties.analyses;
		assert.equal(prop['x-inverse'], undefined);
		assert.equal(prop.items['x-inverse'], 'of');
	});

	test('conflicting duplicates fail compile', () => {
		const { ws } = workspace({
			compile: false,
			collections: {
				reviews: simpleCollection({ storage: { suffix: 'review' } }),
				meetings: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							analyses: {
								type: 'array', 'x-inverse': 'of',
								items: { type: 'string', 'x-reference': 'reviews', 'x-inverse': 'about' },
							},
						},
					},
				},
			},
		});
		assert.match(compileError(ws), /conflicting x-inverse/);
	});

	test('x-title-template authored on the array property lands on items in the compiled descriptor', () => {
		const { root } = workspace({
			collections: {
				reviews: simpleCollection({ storage: { suffix: 'review' } }),
				meetings: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							// authored in the historically-tolerated place: on the property
							analyses: { type: 'array', 'x-title-template': '{{ name }}', items: { type: 'string', 'x-reference': 'reviews' } },
						},
					},
				},
			},
		});
		const compiled = readFile(root, '.dreamteamer/collections/meetings.collection.yaml');
		const doc = load(compiled); // use the engine's yaml loader, imported in the test file
		const prop = doc.schema.properties.analyses;
		assert.equal(prop['x-title-template'], undefined);
		assert.equal(prop.items['x-title-template'], '{{ name }}');
	});

	test('conflicting x-title-template duplicates fail compile', () => {
		const { ws } = workspace({
			compile: false,
			collections: {
				reviews: simpleCollection({ storage: { suffix: 'review' } }),
				meetings: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							analyses: {
								type: 'array', 'x-title-template': '{{ name }}',
								items: { type: 'string', 'x-reference': 'reviews', 'x-title-template': '{{ title }}' },
							},
						},
					},
				},
			},
		});
		assert.match(compileError(ws), /conflicting x-title-template/);
	});
});

describe('x-reference unions: presentation', () => {
	test('a union field emits one relations row per member; title inherits only on agreement', () => {
		const { store } = workspace({
			collections: {
				meetings: simpleCollection({ storage: { suffix: 'meeting' }, title_template: '{{ name }}' }),
				clients: simpleCollection({ storage: { suffix: 'client' }, title_template: '{{ name }}' }),
				invoices: simpleCollection({ storage: { suffix: 'invoice' }, title_template: '{{ number }}' }),
				notes: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'note' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							agree: { type: 'string', 'x-reference': ['meetings', 'clients'] },
							disagree: { type: 'string', 'x-reference': ['meetings', 'invoices'] },
						},
					},
				},
			},
		});
		// presentation() takes the compiled descriptor map — `store.descriptors`, the same shape
		// manual-ordering.test.js passes it (there via `new Store(ws.ws).descriptors`).
		const p = presentation(store.descriptors);
		const rel = p.relations.filter((r) => r.collection === 'notes');
		assert.deepEqual(
			rel.map((r) => [r.field, r.related_collection]).sort(),
			[['agree', 'clients'], ['agree', 'meetings'], ['disagree', 'invoices'], ['disagree', 'meetings']],
		);
		// p.fields is keyed BY COLLECTION (an object, not a flat array) — `fields[d.name] = rows` in
		// presentation.js — so the field rows for `notes` are `p.fields.notes`, not a filter over p.fields.
		const fields = p.fields.notes;
		const tpl = (name) => fields.find((f) => f.field === name)?.meta?.view_options?.template;
		assert.equal(tpl('agree'), '{{ name }}');   // all members agree → inherited
		assert.equal(tpl('disagree'), undefined);   // members disagree → no inheritance
	});
});
