// Tier 2 — the two ways `x-choices` is silently wrong, and the warnings that name them.
//
// `x-choices` decorates ENUM VALUES (0.21.0, see presentation.js#choiceRow). Both mistakes an
// author can make produce no error and no symptom — the decoration simply never appears, on a
// surface the author is probably not looking at while editing the descriptor:
//
//   1. a key that is not one of the enum's values — a typo, or a value since removed from the enum
//   2. the keyword on a field with no enum at all
//
// ⚠ WARNINGS, NOT FAILURES, and the reasoning is the `x-unique` warning's next door in compile.js:
// neither breaks anything today, and a descriptor being edited must stay compilable. A workspace
// that already carries one must not be stopped from compiling by a diagnosis of it.
//
// The last test here pins something the design depends on rather than a behaviour a user sees:
// compile carries unknown `x-` keywords into the compiled descriptor untouched. That is why this
// keyword needed no serializer work, and why a workspace authoring it against an OLDER engine
// compiles cleanly and simply sees no decoration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, simpleCollection, compileQuietly, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

/** A workspace whose `tickets.lane` field is spelled however the case under test needs. */
function withLane(lane) {
	return workspace({
		collections: {
			tickets: simpleCollection({
				description: 'A ticket somebody has to work.',
				use_when: 'work arrives that somebody has to pick up and finish',
				schema: {
					type: 'object',
					required: ['name'],
					properties: { name: { type: 'string' }, lane: lane },
				},
			}),
		},
	});
}

const choiceWarnings = (ws) => compileQuietly(ws.ws).warnings.filter((w) => w.includes('x-choices'));

describe('a correct x-choices is silent', () => {
	test('every key names an enum value, so compile says nothing about it', () => {
		const ws = withLane({
			type: 'string',
			enum: ['alpha', 'bravo'],
			'x-choices': { alpha: { icon: 'rocket' }, bravo: { color: 'charts.blue' } },
		});
		assert.deepEqual(choiceWarnings(ws), []);
	});

	test('and a partial map is correct — decorating one value of three is the point', () => {
		const ws = withLane({ type: 'string', enum: ['alpha', 'bravo', 'charlie'], 'x-choices': { bravo: { icon: 'rocket' } } });
		assert.deepEqual(choiceWarnings(ws), []);
	});
});

describe('a key that is not an enum value', () => {
	const ws = withLane({
		type: 'string',
		enum: ['alpha', 'bravo'],
		'x-choices': { alpha: { icon: 'rocket' }, delta: { icon: 'bug' } },
	});
	const result = compileQuietly(ws.ws);
	const warning = result.warnings.find((w) => w.includes('x-choices'));

	test('warns once, naming the collection, the field and the offending key', () => {
		assert.ok(warning, `expected an x-choices warning, saw: ${result.warnings.join(' | ')}`);
		assert.match(warning, /collection tickets/);
		assert.match(warning, /"lane"/);
		assert.match(warning, /"delta"/);
	});

	test('and lists the values it could have named, so the fix needs no second lookup', () => {
		assert.match(warning, /alpha, bravo/);
	});

	test('the correctly spelled key is NOT warned about', () => {
		assert.equal(result.warnings.filter((w) => w.includes('x-choices')).length, 1);
		assert.doesNotMatch(warning, /"alpha"/);
	});

	test('compile still succeeds — a descriptor mid-edit stays compilable', () => {
		assert.equal(result.code, 0);
	});
});

describe('x-choices on a field with no enum', () => {
	const ws = withLane({ type: 'string', 'x-choices': { alpha: { icon: 'rocket' } } });
	const result = compileQuietly(ws.ws);

	test('warns that it is inert, and says what it decorates', () => {
		const warning = result.warnings.find((w) => w.includes('x-choices'));
		assert.ok(warning, `expected an x-choices warning, saw: ${result.warnings.join(' | ')}`);
		assert.match(warning, /collection tickets/);
		assert.match(warning, /"lane"/);
		assert.match(warning, /inert/);
		assert.match(warning, /enum/);
	});

	test('compile still succeeds', () => {
		assert.equal(result.code, 0);
	});
});

describe('the keyword reaches the compiled descriptor untouched', () => {
	test('so it needs no serializer work, and an older engine compiles it and ignores it', () => {
		const ws = withLane({ type: 'string', enum: ['alpha'], 'x-choices': { alpha: { icon: 'rocket', color: 'charts.blue' } } });
		compileQuietly(ws.ws);
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/tickets.collection.yaml'));
		assert.deepEqual(compiled.schema.properties.lane['x-choices'], { alpha: { icon: 'rocket', color: 'charts.blue' } });
	});
});
