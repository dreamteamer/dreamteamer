// Tier 2 — manual ordering through the real store, CLI and compiler.
//
// ⚠ THE FIELD NAME IS NOT HARDCODED ANYWHERE IN THE ENGINE. This fixture deliberately calls its sort
// field `position`, not `rank`, so any literal that creeps into compile, the CLI or the server fails
// here rather than in a workspace that happened to pick a different name.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, writeCollection, compileError } from '../helpers/ws.js';
import { presentation } from '../../src/presentation.js';
import { Store } from '../../src/store.js';

const ORDERED = {
	sort_field: 'position',
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'task' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			position: { type: 'string', pattern: '^[a-z]+$' },
		},
	},
};

const PLAIN = { ...ORDERED, sort_field: undefined };

/** ids in the order the collection's own sort field puts them. */
const ids = (ws) => JSON.parse(ws.dt('list', 'ordered', '--sort', 'position', '--json').stdout).map((r) => r.id);
const rows = (ws) => JSON.parse(ws.dt('list', 'ordered', '--sort', 'position', '--json').stdout);
const seed = (names) => ({ collections: { ordered: ORDERED }, records: { ordered: names.map((name) => ({ name })) } });

describe('the declaration', () => {
	test('sort_field naming a field the schema does not declare is a COMPILE error', () => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'ordered', { ...ORDERED, sort_field: 'nope' });
		assert.match(compileError(ws.ws) ?? '', /sort_field "nope" is not a field of its schema/);
	});

	test('a non-string sort_field is a COMPILE error', () => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'ordered', { ...ORDERED, sort_field: 3 });
		assert.match(compileError(ws.ws) ?? '', /sort_field must be a string/);
	});

	test('a collection with no sort_field still compiles — the feature is opt-in', () => {
		const ws = workspace({ collections: { ordered: PLAIN } });
		assert.equal(ws.out.code, 0);
	});
});

describe('move', () => {
	test('a collection with no sort_field refuses, and names what is missing', () => {
		const ws = workspace({ collections: { ordered: PLAIN }, records: { ordered: [{ name: 'Alpha' }] } });
		const r = ws.dt('move', 'ordered/alpha', '--top');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /sort_field/);
	});

	test('--init places every record in display order, and is idempotent', () => {
		const ws = workspace(seed(['Alpha', 'Bravo', 'Charlie']));
		assert.equal(ws.dt('move', 'ordered', '--init').code, 0);
		const first = rows(ws);
		assert.deepEqual(first.map((r) => r.id), ['alpha', 'bravo', 'charlie']);
		for (const r of first) assert.match(r.position, /^[a-z]+$/);

		ws.dt('move', 'ordered', '--init');
		assert.deepEqual(rows(ws).map((r) => r.position), first.map((r) => r.position));
	});

	test('a move writes EXACTLY ONE file — the whole point of the feature', () => {
		const ws = workspace(seed(['Alpha', 'Bravo', 'Charlie']));
		ws.dt('move', 'ordered', '--init');
		ws.git(['add', '-A']);
		ws.git(['commit', '-m', 'seed']);
		ws.dt('move', 'ordered/charlie', '--top');
		const dirty = ws.git(['status', '--porcelain']).trim().split('\n').filter(Boolean);
		assert.equal(dirty.length, 1, `expected one changed file, got:\n${dirty.join('\n')}`);
		assert.match(dirty[0], /charlie\.task\.md$/);
	});

	test('--top --bottom --before --after produce the intended order', () => {
		const ws = workspace(seed(['Alpha', 'Bravo', 'Charlie']));
		ws.dt('move', 'ordered', '--init');
		ws.dt('move', 'ordered/charlie', '--top');
		assert.deepEqual(ids(ws), ['charlie', 'alpha', 'bravo']);
		ws.dt('move', 'ordered/charlie', '--after', 'alpha');
		assert.deepEqual(ids(ws), ['alpha', 'charlie', 'bravo']);
		ws.dt('move', 'ordered/alpha', '--bottom');
		assert.deepEqual(ids(ws), ['charlie', 'bravo', 'alpha']);
		ws.dt('move', 'ordered/alpha', '--before', 'bravo');
		assert.deepEqual(ids(ws), ['charlie', 'alpha', 'bravo']);
	});

	test('moving onto an unplaced target fails closed — nothing written', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.git(['add', '-A']);
		ws.git(['commit', '-m', 'seed']);
		const r = ws.dt('move', 'ordered/bravo', '--after', 'alpha');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /dreamteamer move ordered --init/);
		assert.equal(ws.git(['status', '--porcelain']).trim(), '');
	});

	test('move with no destination says so instead of guessing', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('move', 'ordered', '--init');
		const r = ws.dt('move', 'ordered/bravo');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /--after|--before|--top|--bottom/);
	});
});

describe('the properties a sidecar file would not have', () => {
	test('a rename keeps the sort value — the failure mode this design exists to avoid', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('move', 'ordered', '--init');
		const before = rows(ws).find((r) => r.id === 'bravo').position;
		assert.equal(ws.dt('rename', 'ordered/bravo', 'bravo-two').code, 0);
		assert.equal(rows(ws).find((r) => r.id === 'bravo-two').position, before);
	});

	test('the sort value is an ordinary field — check stays clean', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('move', 'ordered', '--init');
		assert.equal(ws.dt('check').code, 0);
	});

	test('records sharing a key fall back to id order, repeatably', () => {
		const ws = workspace({
			collections: { ordered: ORDERED },
			records: { ordered: [{ name: 'Bravo', position: 'm' }, { name: 'Alpha', position: 'm' }] },
		});
		for (let i = 0; i < 3; i++) assert.deepEqual(ids(ws), ['alpha', 'bravo']);
	});

	test('a record with no sort value sorts first, so nothing is hidden before --init', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('move', 'ordered', '--init');
		ws.dt('add', 'ordered', '--name', 'Charlie');
		assert.deepEqual(ids(ws), ['charlie', 'alpha', 'bravo']);
	});
});

describe('the UI read model', () => {
	test('sort_field reaches the presentation contract — a surface cannot offer a handle it cannot see', () => {
		const ws = workspace({ collections: { ordered: ORDERED } });
		const { collections } = presentation(new Store(ws.ws).descriptors);
		assert.equal(collections.find((c) => c.collection === 'ordered').meta.sort_field, 'position');
	});

	test('a collection without one carries no sort_field key at all', () => {
		const ws = workspace({ collections: { ordered: PLAIN } });
		const { collections } = presentation(new Store(ws.ws).descriptors);
		assert.ok(!('sort_field' in collections.find((c) => c.collection === 'ordered').meta));
	});
});
