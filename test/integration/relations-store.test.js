// Tier 2 — a generated mirror field is ENGINE-OWNED. It is on the target's schema, so it looks
// writable to anyone reading the descriptor, and `readOnly` is presentation rather than a gate: ajv
// does not enforce it. Without a guard, `dt set meetings/standup recordings=...` lands a value the
// store is about to recompute from the owning side, and the two silently disagree.
//
// So the store refuses, and the refusal is only worth anything if it names the write that WOULD have
// worked — the owning field, on the owning collection, pointing back at this record. That sentence
// is the assertion here.
//
// Tier 2 rather than a unit test because the thing under test is the compiled artifact: the mirror
// only exists after compile stamps it, and only the real CLI proves the message reaches stderr with
// a non-zero exit rather than being swallowed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';

// The same four-collection cast as relations-compile.test.js — one anchor plus the three
// cardinalities: many-to-one (recordings), one-to-one (summaries, via x-unique) and many-to-many
// (analyses). Copied rather than shared: test files run in separate processes, and a fixture module
// imported by two of them is read twice anyway, so the sharing would buy nothing and cost the
// ability to read either file on its own.
const MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });

const RECORDINGS = simpleCollection({
	storage: { suffix: 'recording' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'recordings' },
		},
	},
});

const SUMMARIES = simpleCollection({
	storage: { suffix: 'summary' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-unique': true, 'x-inverse': 'summary' },
		},
	},
});

const ANALYSES = simpleCollection({
	storage: { suffix: 'analysis' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			// authored on the PROPERTY: normalizeRelationKeywords hoists it onto `items`, which is
			// where every relation consumer reads it from
			meetings: { type: 'array', 'x-inverse': 'analyses', items: { type: 'string', 'x-reference': 'meetings' } },
		},
	},
});

const relWorkspace = () => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
});

describe('mirror fields are engine-owned', () => {
	test('dt set on a mirror is refused with the owning-side command', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		const res = ws.dt('set', 'meetings/standup', 'recordings=recordings/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /recordings is generated from recordings\.meeting — set that instead: dreamteamer set recordings\/<id> meeting=meetings\/standup/);
	});

	test('a scalar (unique) mirror refuses in exactly the same shape', () => {
		// the array mirror above and this scalar one are the two shapes the message has to render;
		// nothing in the sentence varies with cardinality, and that is the point of checking both
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		const res = ws.dt('set', 'meetings/standup', 'summary=summaries/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /summary is generated from summaries\.meeting — set that instead: dreamteamer set summaries\/<id> meeting=meetings\/standup/);
	});

	test('dt add naming a mirror is refused too, and nothing lands', () => {
		// `add` has no id yet, so the suggested command carries the placeholder — the refusal still
		// has to name the owning field, because that is the only actionable half
		const ws = relWorkspace();
		const res = ws.dt('add', 'meetings', '--name', 'Kickoff', '--analyses', 'analyses/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /analyses is generated from analyses\.meetings — set that instead: dreamteamer set analyses\/<id> meetings=meetings\/<id>/);
		assert.match(res.stderr, /nothing was written/);
		assert.equal(readFile(ws.root, 'data/meetings/kickoff.meeting.md'), null);
	});

	test('the OWNING field is untouched by the guard', () => {
		// the guard is scoped to generated mirrors on the collection being written; the foreign key
		// that generates them is an ordinary writable field and must stay one
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'recordings', '--name', 'Cut', '--meeting', 'meetings/standup').code, 0);
		assert.equal(ws.dt('set', 'recordings/cut', 'meeting=meetings/standup').code, 0);
	});
});
