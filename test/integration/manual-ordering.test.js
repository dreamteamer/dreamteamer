// Tier 2 — manual ordering through the real store, CLI and compiler: a collection's one
// `type: position` field, written by `dt reorder`.
//
// ⚠ THE FIELD NAME IS NOT HARDCODED ANYWHERE IN THE ENGINE. This fixture deliberately calls its
// position field `place`, so any literal `position` that creeps into compile, the CLI or the
// server fails here rather than in a workspace that happened to pick a different name.
//
// test/integration/reorder.test.js pins the refusal on a collection with no position field, the
// one-position-field compile rule and `dt move` being no verb; this file holds the rest.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from '../helpers/ws.js';
import { presentation } from '../../src/presentation.js';
import { Store } from '../../src/store.js';

const ORDERED = {
	ids: { from: '{{ name | slug }}' },
	storage: { suffix: 'task' },
	fields: {
		name: { type: 'string', required: true },
		place: { type: 'position' },
	},
};

const PLAIN = { ...ORDERED, fields: { name: ORDERED.fields.name } };

/** ids in the order the collection's own position field puts them. */
const ids = (ws) => JSON.parse(ws.dt('list', 'ordered', '--sort', 'place', '--json').stdout).map((r) => r.id);
const rows = (ws) => JSON.parse(ws.dt('list', 'ordered', '--sort', 'place', '--json').stdout);
const seed = (names) => ({ collections: { ordered: ORDERED }, records: { ordered: names.map((name) => ({ name })) } });

describe('the declaration', () => {
	test('a collection with no position field still compiles — the feature is opt-in', () => {
		const ws = workspace({ collections: { ordered: PLAIN } });
		assert.equal(ws.out.code, 0);
	});
});

describe('reorder', () => {
	test('--init places every record in display order, and is idempotent', () => {
		const ws = workspace(seed(['Alpha', 'Bravo', 'Charlie']));
		assert.equal(ws.dt('reorder', 'ordered', '--init').code, 0);
		const first = rows(ws);
		assert.deepEqual(first.map((r) => r.id), ['alpha', 'bravo', 'charlie']);
		for (const r of first) assert.match(r.place, /^[a-z]+$/);

		ws.dt('reorder', 'ordered', '--init');
		assert.deepEqual(rows(ws).map((r) => r.place), first.map((r) => r.place));
	});

	test('a reorder writes EXACTLY ONE file — the whole point of the feature', () => {
		const ws = workspace(seed(['Alpha', 'Bravo', 'Charlie']));
		ws.dt('reorder', 'ordered', '--init');
		ws.git(['add', '-A']);
		ws.git(['commit', '-m', 'seed']);
		ws.dt('reorder', 'ordered/charlie', '--top');
		const dirty = ws.git(['status', '--porcelain']).trim().split('\n').filter(Boolean);
		assert.equal(dirty.length, 1, `expected one changed file, got:\n${dirty.join('\n')}`);
		assert.match(dirty[0], /charlie\.task\.md$/);
	});

	test('--top --bottom --before --after produce the intended order', () => {
		const ws = workspace(seed(['Alpha', 'Bravo', 'Charlie']));
		ws.dt('reorder', 'ordered', '--init');
		ws.dt('reorder', 'ordered/charlie', '--top');
		assert.deepEqual(ids(ws), ['charlie', 'alpha', 'bravo']);
		ws.dt('reorder', 'ordered/charlie', '--after', 'alpha');
		assert.deepEqual(ids(ws), ['alpha', 'charlie', 'bravo']);
		ws.dt('reorder', 'ordered/alpha', '--bottom');
		assert.deepEqual(ids(ws), ['charlie', 'bravo', 'alpha']);
		ws.dt('reorder', 'ordered/alpha', '--before', 'bravo');
		assert.deepEqual(ids(ws), ['charlie', 'alpha', 'bravo']);
	});

	test('reordering onto an unplaced target fails closed — nothing written', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.git(['add', '-A']);
		ws.git(['commit', '-m', 'seed']);
		const r = ws.dt('reorder', 'ordered/bravo', '--after', 'alpha');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /dreamteamer reorder ordered --init/);
		assert.equal(ws.git(['status', '--porcelain']).trim(), '');
	});

	test('reorder with no destination says so instead of guessing', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('reorder', 'ordered', '--init');
		const r = ws.dt('reorder', 'ordered/bravo');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /--after|--before|--top|--bottom/);
	});
});

describe('the properties a sidecar file would not have', () => {
	test('a rename keeps the sort value — the failure mode this design exists to avoid', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('reorder', 'ordered', '--init');
		const before = rows(ws).find((r) => r.id === 'bravo').place;
		assert.equal(ws.dt('rename', 'ordered/bravo', 'bravo-two').code, 0);
		assert.equal(rows(ws).find((r) => r.id === 'bravo-two').place, before);
	});

	test('the sort value is an ordinary field — check stays clean', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('reorder', 'ordered', '--init');
		assert.equal(ws.dt('check').code, 0);
	});

	test('records sharing a key fall back to id order, repeatably', () => {
		const ws = workspace({
			collections: { ordered: ORDERED },
			records: { ordered: [{ name: 'Bravo', place: 'm' }, { name: 'Alpha', place: 'm' }] },
		});
		for (let i = 0; i < 3; i++) assert.deepEqual(ids(ws), ['alpha', 'bravo']);
	});

	test('a record with no sort value sorts first, so nothing is hidden before --init', () => {
		const ws = workspace(seed(['Alpha', 'Bravo']));
		ws.dt('reorder', 'ordered', '--init');
		ws.dt('add', 'ordered', '--name', 'Charlie');
		assert.deepEqual(ids(ws), ['charlie', 'alpha', 'bravo']);
	});
});

describe('the UI read model', () => {
	test('position_field reaches the presentation contract — a surface cannot offer a handle it cannot see', () => {
		const ws = workspace({ collections: { ordered: ORDERED } });
		const { collections } = presentation(new Store(ws.ws).descriptors);
		assert.equal(collections.find((c) => c.collection === 'ordered').position_field, 'place');
	});

	test('a collection without one carries no position_field key at all', () => {
		const ws = workspace({ collections: { ordered: PLAIN } });
		const { collections } = presentation(new Store(ws.ws).descriptors);
		assert.ok(!('position_field' in collections.find((c) => c.collection === 'ordered')));
	});
});
