// Tier 2 — enum decoration, compiled.
//
// An enum's values are decorated where they are declared: `enum` is a list of values, or a MAP of
// value → { label, description, icon, color, background } (see presentation.js#choiceRow). Because the
// map's keys ARE the values, a decoration can no longer name a value the enum lacks, and a map row may
// be empty — decorating one value of three is the point. The only way left to author a decoration that
// can never render is to put `enum` on a field that is not a string, and compile refuses that, naming
// the collection and the field.
//
// The last test pins what the surfaces depend on: the map reaches `compiled.fields` untouched, while
// the validator's `compiled.json_schema` carries only the value list.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, simpleCollection, compileQuietly, compileError, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

/** A workspace whose `tickets.lane` field is spelled however the case under test needs. */
function withLane(lane, opts = {}) {
	return workspace({
		compile: opts.compile,
		collections: {
			tickets: simpleCollection({
				description: 'A ticket somebody has to work.',
				use_when: 'work arrives that somebody has to pick up and finish',
				fields: {
					name: { type: 'string', required: true },
					lane,
					notes: { type: 'markdown', body: true },
				},
			}),
		},
	});
}

const laneWarnings = (ws) => compileQuietly(ws.ws).warnings.filter((w) => w.includes('"lane"'));

describe('a correct enum map is silent', () => {
	test('every value decorated, so compile says nothing about it', () => {
		const ws = withLane({
			type: 'string',
			enum: { alpha: { icon: 'rocket' }, bravo: { color: 'charts.blue' } },
		});
		assert.deepEqual(laneWarnings(ws), []);
	});

	test('and a sparse map is correct — decorating one value of three is the point', () => {
		const ws = withLane({ type: 'string', enum: { alpha: {}, bravo: { icon: 'rocket' }, charlie: null } });
		const result = compileQuietly(ws.ws);
		assert.equal(result.code, 0);
		assert.deepEqual(result.warnings.filter((w) => w.includes('"lane"')), []);
	});
});

describe('an enum on a field that is not a string', () => {
	const ws = withLane({ type: 'integer', enum: { 1: { icon: 'rocket' } } }, { compile: false });
	const message = compileError(ws.ws);

	test('fails compile, naming the collection and the field, and saying where enum belongs', () => {
		assert.ok(message, 'expected compile to refuse an enum on an integer field');
		assert.match(message, /collection "tickets"/);
		assert.match(message, /field "lane"/);
		assert.match(message, /`enum` belongs to type string/);
	});
});

describe('the map reaches the compiled descriptor untouched', () => {
	test('compiled.fields carries the decoration; the json_schema carries only the values', () => {
		const ws = withLane({ type: 'string', enum: { alpha: { icon: 'rocket', color: 'charts.blue' }, bravo: { label: 'Bravo' } } });
		compileQuietly(ws.ws);
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/tickets.collection.yaml'));
		assert.deepEqual(compiled.compiled.fields.lane.enum, { alpha: { icon: 'rocket', color: 'charts.blue' }, bravo: { label: 'Bravo' } });
		assert.deepEqual(compiled.compiled.json_schema.properties.lane, { type: 'string', enum: ['alpha', 'bravo'] });
	});
});
