// Tier 2 — `x-reference` as a LIST of targets (the union), through the real store and CLI.
//
// Values stay fully qualified `<collection>/<id>`: the qualified value itself says which branch of
// the union it took, which is why unions cost zero record migration. The load-bearing assertions
// are the REFUSALS — a ref into an unlisted collection must fail naming the allowed set.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection } from '../helpers/ws.js';

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

	test('x-inverse symmetry works across a union field', () => {
		const { store, dt } = workspace({
			collections: {
				meetings: {
					id: { generate: '{{ name | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
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
		// symmetric pair: review → brief, brief → review. The union value names WHICH collection
		// the symmetry pass must look in — no per-target syntax needed.
		store.add('reviews', { name: 'r1', of: 'briefs/pitch' });
		store.set('briefs', 'pitch', { analyses: ['reviews/r1'] });
		assert.equal(dt('check').code, 0);
		// break it: the brief stops pointing back
		store.set('briefs', 'pitch', { analyses: [] });
		const res = dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout + res.stderr, /analyses: must point back to "reviews\/r1"/);
	});
});
