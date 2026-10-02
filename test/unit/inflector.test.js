// Tier 1 — the inflector (namespace.singular), and the converter pinning the suffix records already
// carry wherever the new rule would derive another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { singular, inflects } from '../../src/namespace.js';
import { convertCollection } from '../../scripts/migrate-descriptors-v2.mjs';

test('plurals inflect; non-plurals and invariants come back unchanged', () => {
	const cases = { doctors: 'doctor', stories: 'story', companies: 'company', boxes: 'box', statuses: 'status', analyses: 'analysis', 'meta-analyses': 'meta-analysis', series: 'series', classes: 'class', queries: 'query', days: 'day', 'meeting-summaries': 'meeting-summary', 'agent-decision-log': 'agent-decision-log', finance: 'finance' };
	for (const [plural, one] of Object.entries(cases)) assert.equal(singular(plural), one, plural);
	assert.equal(inflects('doctors'), true);
	assert.equal(inflects('series'), true, 'an invariant is a known plural');
	assert.equal(inflects('agent-decision-log'), false);
});

test('the converter pins the suffix a v1 engine derived when the new inflector differs', () => {
	const conv = (name) => parseDocument(convertCollection(`name: ${name}\nschema: { type: object, properties: { name: { type: string } } }\n`, { bareName: name }).text).toJSON();
	assert.equal(conv('boxes').storage?.suffix, 'boxe', 'v1 derived "boxe"; the files carry it');
	assert.equal(conv('meta-analyses').storage?.suffix, 'meta-analyse');
	assert.equal(conv('doctors').storage, undefined, 'same under both rules: nothing to pin');
});
