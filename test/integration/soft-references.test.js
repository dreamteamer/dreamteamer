// Tier 2 — a soft reference: the value must still target a named collection, but a missing
// collection or a missing record is tolerated, at write and in check. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, writeCollection, compileQuietly, dt } from '../helpers/ws.js';

const CONCEPTS = {
	description: 'A term.',
	ids: { from: '{{ name | slug }}' },
	fields: {
		name: { type: 'string', required: true },
		related_to: { type: ['concepts', 'terms'], many: true, soft: true, description: 'Concepts or terms this one relates to, whether or not they exist yet.' },
		notes: { type: 'markdown', body: true },
	},
};
const TERMS = { description: 'A word.', ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, notes: { type: 'markdown', body: true } } };

test('a soft reference to a missing record is accepted at write and in check; a wrong collection is still refused', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'concepts', CONCEPTS);
	writeCollection(w.root, 'terms', TERMS);
	compileQuietly(w.ws);
	const ok = dt(w.root, 'add', 'concepts', '--name', 'Graph', '--related_to', 'concepts/not-yet', '--related_to', 'terms/edge');
	assert.equal(ok.code, 0, ok.stderr);
	assert.equal(dt(w.root, 'check').code, 0);
	const wrong = dt(w.root, 'add', 'concepts', '--name', 'Tree', '--related_to', 'notes/whatever');
	assert.notEqual(wrong.code, 0);
	assert.match(wrong.stderr, /must target one of: concepts, terms/);
});

test('without soft, the same missing record is a dangling reference', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'concepts', { ...CONCEPTS, fields: { ...CONCEPTS.fields, related_to: { type: ['concepts', 'terms'], many: true } } });
	writeCollection(w.root, 'terms', TERMS);
	compileQuietly(w.ws);
	const r = dt(w.root, 'add', 'concepts', '--name', 'Graph', '--related_to', 'concepts/not-yet');
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /dangling reference/);
});
