// Tier 2 — `dt relations` and `dt relations rebuild`.
//
// Rebuild is not a convenience: `check` prints "…: stale — run: dreamteamer relations rebuild
// <target>", so this verb is the other half of that sentence. A test that only proved rebuild
// changes bytes would leave the interesting claim unmeasured, which is why one case here vandalizes
// a mirror, asserts `check` FAILS, rebuilds, and asserts `check` passes — the round trip the message
// promises.
//
// Tier 2 rather than a unit test for the same reason as relations-store.test.js: the mirror fields
// only exist after compile stamps them onto the target, so nothing below is true of a hand-built
// descriptor map.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';

// The same four-collection cast as relations-store.test.js — one anchor plus the three
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

const relWorkspace = (extra = {}) => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
	...extra,
});

describe('dt relations', () => {
	test('lists the pairs', () => {
		const ws = relWorkspace();
		const res = ws.dt('relations');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /recordings\.meeting\s+→\s+meetings\.recordings\[\]\s+m2o\s+restrict/);
		assert.match(res.stdout, /summaries\.meeting\s+→\s+meetings\.summary\s+o2o/);
	});

	test('a collection argument filters to its rows, on either side of the arrow', () => {
		// `recordings` is only ever an OWNER here, so a filter that matched targets alone would
		// return nothing and one that matched owners alone would miss the meetings view — both
		// sides are asserted rather than assumed.
		const ws = relWorkspace();
		const owner = ws.dt('relations', 'recordings');
		assert.equal(owner.code, 0);
		assert.match(owner.stdout, /recordings\.meeting/);
		assert.doesNotMatch(owner.stdout, /summaries\.meeting/);

		const target = ws.dt('relations', 'meetings');
		assert.match(target.stdout, /recordings\.meeting/);
		assert.match(target.stdout, /summaries\.meeting/);
		assert.match(target.stdout, /analyses\.meetings/);
	});

	test('--json emits the rows', () => {
		const ws = relWorkspace();
		const res = ws.dt('relations', 'summaries', '--json');
		assert.equal(res.code, 0);
		const rows = JSON.parse(res.stdout);
		assert.deepEqual(rows, [{
			owner: 'summaries', field: 'meeting', target: 'meetings', mirror: 'summary',
			list: false, unique: true, onDelete: 'restrict', kind: 'o2o',
		}]);
	});

	test('rebuild repairs a vandalized mirror and reports the count', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings/cap', 'recordings/ghost'));
		const res = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /rebuilt 1 record/);
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings\/cap/);
		assert.equal(ws.dt('check').code, 0);
	});

	test('rebuild repairs exactly the state `check` complains about', () => {
		// the message check prints names this verb; if the two ever disagreed about what "stale"
		// means, the operator would be sent round a loop that never converges
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings/cap', 'recordings/ghost'));

		const before = ws.dt('check');
		assert.equal(before.code, 1);
		assert.match(before.stdout + before.stderr, /recordings: stale — run: dreamteamer relations rebuild meetings/);

		assert.equal(ws.dt('relations', 'rebuild', 'meetings').code, 0);
		const after = ws.dt('check');
		assert.equal(after.code, 0);
		assert.doesNotMatch(after.stdout + after.stderr, /stale/);
	});

	test('rebuild is idempotent — a second run rewrites nothing', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap', '--meeting', 'meetings/standup');
		ws.dt('add', 'summaries', '--name', 'Sum', '--meeting', 'meetings/standup');
		ws.dt('add', 'analyses', '--name', 'An', '--meetings', 'meetings/standup');

		// the store already maintains these on write, so even the FIRST run has nothing to do
		const first = ws.dt('relations', 'rebuild', 'meetings');
		assert.equal(first.code, 0);
		assert.match(first.stdout, /rebuilt 0 records/);

		const before = readFile(ws.root, 'data/meetings/standup.meeting.md');
		const second = ws.dt('relations', 'rebuild', 'meetings');
		assert.match(second.stdout, /rebuilt 0 records/);
		assert.equal(readFile(ws.root, 'data/meetings/standup.meeting.md'), before);
	});

	test('rebuild --drop removes a stale ex-mirror key', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('---\nname:', '---\ncaptures:\n  - recordings/old\nname:'));
		const res = ws.dt('relations', 'rebuild', 'meetings', '--drop', 'captures');
		assert.equal(res.code, 0);
		assert.doesNotMatch(readFile(ws.root, 'data/meetings/standup.meeting.md'), /captures/);
	});

	test('rebuild refuses the two shapes it must never rewrite', () => {
		// compile never stamps a mirror onto either, so the relation loop would simply be empty and
		// look harmless — but --drop writes whether or not a relation targets the collection, and
		// `serialize` has no `codec: file` branch: it would replace an SVG with frontmatter.
		const files = workspace({ collections: { pics: { description: 'x', storage: { codec: 'file', suffix: 'pic' }, id: { pattern: '^[a-z/-]+$' } } } });
		const onFiles = files.dt('relations', 'rebuild', 'pics', '--drop', 'captures');
		assert.equal(onFiles.code, 1);
		assert.match(onFiles.stderr, /`codec: file`.+will not rewrite it/s);

		// a runtime-based collection's records are build artifacts; its source lives elsewhere
		const onRuntime = files.dt('relations', 'rebuild', 'skills', '--drop', 'captures');
		assert.equal(onRuntime.code, 1);
		assert.match(onRuntime.stderr, /is a compiled source/);
	});

	test('rebuild --drop refuses a field the schema declares', () => {
		const ws = relWorkspace();
		const res = ws.dt('relations', 'rebuild', 'meetings', '--drop', 'recordings');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /is a live field/);
	});
});
