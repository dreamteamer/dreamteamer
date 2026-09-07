// Tier 1 — `x-choices`: optional metadata attached to ENUM VALUES, projected into the `choices`
// rows the presentation contract already emits.
//
// Until 0.21.0 an enum value had a label and nothing else: `{ text: String(v), value: v }`, which is
// all any surface could ever know about it. A board grouping by that field could draw a header with
// the value on it and no glyph, no colour and no explanation — and there was nowhere to author one,
// because a field row's `schema` key is a Directus stub and the raw JSON Schema property never
// reaches a surface at all. `edit_options.choices` is the ONLY channel, so this is where the
// vocabulary had to grow.
//
// Two properties are load-bearing and each has a test that fails loudly if it stops holding:
//
//   1. IT IS PURELY ADDITIVE. An enum with no `x-choices` must project byte-identically to what it
//      projected before, because every existing descriptor is one of those and none of them were
//      touched. That is the regression test, and it is first on purpose.
//   2. THE KEYS ARE COPIED BY NAME. A descriptor is authored data; spreading whatever it happens to
//      carry into the presentation contract would let a workspace inject arbitrary keys into a
//      structure every surface reads. The vocabulary is closed and one line names it.
//
// `presentation()` takes a Map of descriptors and returns a projection — pure, no workspace, no fs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presentation } from '../../src/presentation.js';

/** One collection whose `lane` field is an enum, optionally decorated. Synthetic throughout. */
function withLane(prop) {
	return new Map([
		['tickets', {
			name: 'tickets',
			storage: { suffix: 'ticket' },
			schema: { type: 'object', properties: { name: { type: 'string' }, lane: prop } },
		}],
	]);
}

const choicesOf = (descriptors, field = 'lane') =>
	descriptors && presentation(descriptors).fields['tickets'].find((r) => r.field === field)?.meta?.edit_options?.choices;

const laneRow = (descriptors, field = 'lane') =>
	presentation(descriptors).fields['tickets'].find((r) => r.field === field);

describe('an enum with no x-choices is untouched', () => {
	test('projects exactly what it always projected', () => {
		const choices = choicesOf(withLane({ type: 'string', enum: ['alpha', 'bravo'] }));
		assert.deepEqual(choices, [
			{ text: 'alpha', value: 'alpha' },
			{ text: 'bravo', value: 'bravo' },
		]);
	});

	test('and a non-string enum still stringifies its label while keeping the raw value', () => {
		const choices = choicesOf(withLane({ enum: [1, 2] }));
		assert.deepEqual(choices, [
			{ text: '1', value: 1 },
			{ text: '2', value: 2 },
		]);
	});
});

describe('x-choices decorates a value', () => {
	const descriptors = withLane({
		type: 'string',
		enum: ['alpha', 'bravo', 'charlie'],
		'x-choices': {
			alpha: {
				label: 'Alpha team',
				description: 'the one that ships',
				icon: 'rocket',
				color: 'charts.blue',
				background: 'charts.blue',
			},
			bravo: { icon: 'assets/icons/lucide/anchor' },
		},
	});

	test('all five keys arrive, and `label` becomes `text`', () => {
		const [alpha] = choicesOf(descriptors);
		assert.deepEqual(alpha, {
			text: 'Alpha team',
			value: 'alpha',
			description: 'the one that ships',
			icon: 'rocket',
			color: 'charts.blue',
			background: 'charts.blue',
		});
		assert.ok(!('label' in alpha), '`label` is never emitted under its own name — `text` is the contract');
	});

	test('a partially decorated value carries only what it declared', () => {
		const bravo = choicesOf(descriptors)[1];
		assert.deepEqual(bravo, { text: 'bravo', value: 'bravo', icon: 'assets/icons/lucide/anchor' });
	});

	test('a value absent from the map is exactly as it was before', () => {
		assert.deepEqual(choicesOf(descriptors)[2], { text: 'charlie', value: 'charlie' });
	});

	test('the enum still decides which values exist, and their ORDER', () => {
		// The map is unordered and partial by design; a surface that groups by this field takes its
		// band order from `enum`, so a map key must never be able to add, remove or reorder a value.
		assert.deepEqual(choicesOf(descriptors).map((c) => c.value), ['alpha', 'bravo', 'charlie']);
	});
});

describe('what x-choices may NOT do', () => {
	test('a key that is not an enum value contributes nothing', () => {
		const choices = choicesOf(withLane({
			type: 'string',
			enum: ['alpha'],
			'x-choices': { alpha: { icon: 'rocket' }, delta: { icon: 'bug' } },
		}));
		assert.deepEqual(choices, [{ text: 'alpha', value: 'alpha', icon: 'rocket' }]);
	});

	test('an unknown key INSIDE an entry is dropped — the vocabulary is closed', () => {
		const [alpha] = choicesOf(withLane({
			type: 'string',
			enum: ['alpha'],
			'x-choices': { alpha: { icon: 'rocket', onclick: 'rm -rf /', weight: 3 } },
		}));
		assert.deepEqual(alpha, { text: 'alpha', value: 'alpha', icon: 'rocket' });
	});

	test('a non-string value for a known key is dropped rather than passed through', () => {
		const [alpha] = choicesOf(withLane({
			type: 'string',
			enum: ['alpha'],
			'x-choices': { alpha: { icon: 42, color: null, description: '' } },
		}));
		assert.deepEqual(alpha, { text: 'alpha', value: 'alpha' });
	});

	test('on a field with no enum it produces no edit_options at all', () => {
		const row = laneRow(withLane({ type: 'string', 'x-choices': { alpha: { icon: 'rocket' } } }));
		assert.equal(row.meta.edit_options, undefined, 'no enum, no choices — compile warns about this separately');
	});

	test('a malformed x-choices does not throw — an array, a string, null', () => {
		for (const bad of [[], 'nope', null, 7]) {
			const choices = choicesOf(withLane({ type: 'string', enum: ['alpha'], 'x-choices': bad }));
			assert.deepEqual(choices, [{ text: 'alpha', value: 'alpha' }], `x-choices: ${JSON.stringify(bad)}`);
		}
	});
});
