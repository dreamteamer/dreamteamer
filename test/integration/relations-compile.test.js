// Tier 2 — compile is the ONLY producer of the compiled relation shape, and it accepts TWO source
// spellings for the same relation: `x-inverse` on the owning (foreign-key) side, or `x-inverse-of`
// on the side that wants the mirror. Both must land on disk as the SAME bytes, because everything
// downstream (relations.js, check, the store's mirror maintenance) reads the compiled artifact and
// must never learn that two spellings existed.
//
// The load-bearing assertions are therefore (a) the generated mirror's exact shape and (b) the
// byte-for-byte equality of the two spellings — an assertion no unit test can make, because the
// thing being compared is the artifact.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

// The four-collection cast every case here is cut from: one anchor plus the three cardinalities —
// many-to-one (recordings), one-to-one (summaries, via x-unique) and many-to-many (analyses).
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

describe('compile materializes relations', () => {
	test('spelling A stamps a readOnly mirror on the target', () => {
		const ws = relWorkspace();
		const meetings = load(readFile(ws.root, '.dreamteamer/collections/meetings.collection.yaml'));
		const rec = meetings.schema.properties.recordings;
		assert.equal(rec.type, 'array');
		assert.equal(rec.readOnly, true);
		assert.equal(rec.items['x-reference'], 'recordings');
		assert.equal(rec.items['x-inverse-of'], 'recordings.meeting');
		assert.match(rec.description, /Generated from recordings\.meeting/);
		const sum = meetings.schema.properties.summary;
		assert.equal(sum.type, 'string'); // unique ⇒ scalar mirror
		assert.equal(sum['x-inverse-of'], 'summaries.meeting');
	});

	test('spelling B compiles to the identical pair (spelling equivalence)', () => {
		// same relation declared from the OTHER side: meetings authors the mirror, recordings has a plain ref
		const B_RECORDINGS = structuredClone(RECORDINGS);
		delete B_RECORDINGS.schema.properties.meeting['x-inverse'];
		const B_MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });
		B_MEETINGS.schema.properties.recordings = {
			type: 'array',
			items: { type: 'string', 'x-reference': 'recordings' },
			'x-inverse-of': 'recordings.meeting',
		};
		const a = relWorkspace();
		const b = workspace({ collections: { meetings: B_MEETINGS, recordings: B_RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES } });
		for (const f of ['meetings', 'recordings']) {
			assert.equal(
				readFile(b.root, `.dreamteamer/collections/${f}.collection.yaml`),
				readFile(a.root, `.dreamteamer/collections/${f}.collection.yaml`),
				`${f}: spelling B must compile byte-identical to spelling A`);
		}
	});

	test('a scalar spelling-B mirror closes cardinality backwards: x-unique lands on the FK', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summary = { type: 'string', 'x-inverse-of': 'summaries.meeting' };
		const S = structuredClone(SUMMARIES);
		delete S.schema.properties.meeting['x-unique'];
		delete S.schema.properties.meeting['x-inverse'];
		const ws = workspace({ collections: { meetings: M, summaries: S } });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/summaries.collection.yaml'));
		assert.equal(compiled.schema.properties.meeting['x-unique'], true);
	});
});
