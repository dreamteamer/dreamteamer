// Tier 1 — an enum's values reach a surface as choice rows: `{ label, value }` plus whatever the
// descriptor's enum MAP decorates each value with (`description`, `icon`, `color`, `background`).
//
// Two properties are load-bearing:
//   1. THE ENUM DECIDES WHICH VALUES EXIST AND THEIR ORDER. A list enum is undecorated; a map enum's
//      key order is the band order a board groups by.
//   2. THE KEYS ARE COPIED BY NAME. A descriptor is authored data; spreading whatever an entry carries
//      into a contract every surface reads would let a workspace inject arbitrary keys.
//
// The rows ride in the field's component options (`editor_options.choices`, the same object as
// `viewer_options.choices`), beside any authored `display.options`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presentation } from '../../src/presentation.js';
import { compiledCollection } from '../helpers/clinic-compiled.js';

/** One collection whose `lane` field carries `field` — compiled v2 shape. */
const withLane = (field) => new Map([['tickets', compiledCollection('tickets', { fields: { name: { type: 'string', title: 'Name' }, lane: { title: 'Lane', ...field } } })]]);
const laneRow = (descriptors) => presentation(descriptors).fields.tickets.find((r) => r.field === 'lane');
const choicesOf = (descriptors) => laneRow(descriptors).editor_options?.choices;

describe('a list enum', () => {
	test('projects one undecorated row per value, labelled by the value', () => {
		assert.deepEqual(choicesOf(withLane({ type: 'string', enum: ['alpha', 'bravo'] })), [
			{ label: 'alpha', value: 'alpha' },
			{ label: 'bravo', value: 'bravo' },
		]);
	});

	test('the viewer reads the same rows as the editor', () => {
		const row = laneRow(withLane({ type: 'string', enum: ['alpha'] }));
		assert.deepEqual(row.viewer_options, row.editor_options);
	});

	test('a many enum is a multi-select over the same rows', () => {
		const row = laneRow(withLane({ type: 'string', many: true, enum: ['alpha', 'bravo'] }));
		assert.equal(row.many, true);
		assert.deepEqual(row.editor_options.choices.map((c) => c.value), ['alpha', 'bravo']);
	});
});

describe('a map enum decorates its values', () => {
	const descriptors = withLane({
		type: 'string',
		enum: {
			alpha: { label: 'Alpha team', description: 'the one that ships', icon: 'rocket', color: 'charts.blue', background: 'charts.blue' },
			bravo: { icon: 'assets/icons/lucide/anchor' },
			charlie: {},
		},
	});

	test('all five decoration keys arrive under their own names', () => {
		assert.deepEqual(choicesOf(descriptors)[0], {
			label: 'Alpha team', value: 'alpha', description: 'the one that ships', icon: 'rocket', color: 'charts.blue', background: 'charts.blue',
		});
	});

	test('a partially decorated value carries only what it declared, labelled by the value', () => {
		assert.deepEqual(choicesOf(descriptors)[1], { label: 'bravo', value: 'bravo', icon: 'assets/icons/lucide/anchor' });
		assert.deepEqual(choicesOf(descriptors)[2], { label: 'charlie', value: 'charlie' });
	});

	test('the map order is the band order', () => {
		assert.deepEqual(choicesOf(descriptors).map((c) => c.value), ['alpha', 'bravo', 'charlie']);
	});
});

describe('what an enum map may NOT do', () => {
	test('an unknown key inside an entry is dropped — the vocabulary is closed', () => {
		const [alpha] = choicesOf(withLane({ type: 'string', enum: { alpha: { icon: 'rocket', onclick: 'rm -rf /', weight: 3, text: 'old' } } }));
		assert.deepEqual(alpha, { label: 'alpha', value: 'alpha', icon: 'rocket' });
	});

	test('a non-string value for a known key is dropped rather than passed through', () => {
		const [alpha] = choicesOf(withLane({ type: 'string', enum: { alpha: { icon: 42, color: null, description: '' } } }));
		assert.deepEqual(alpha, { label: 'alpha', value: 'alpha' });
	});

	test('a null entry is an undecorated value', () => {
		assert.deepEqual(choicesOf(withLane({ type: 'string', enum: { alpha: null } })), [{ label: 'alpha', value: 'alpha' }]);
	});

	test('a field with no enum has no choices and, with nothing else, no component options', () => {
		const row = laneRow(withLane({ type: 'string' }));
		assert.equal(row.editor_options, undefined);
		assert.equal(row.viewer_options, undefined);
	});
});

describe('authored component options ride beside the choices', () => {
	test('display.options merges into the same object', () => {
		const row = laneRow(withLane({ type: 'string', enum: ['alpha'], display: { editor: 'segmented', options: { compact: true } } }));
		assert.equal(row.editor, 'segmented');
		assert.deepEqual(row.editor_options, { choices: [{ label: 'alpha', value: 'alpha' }], compact: true });
	});
});
