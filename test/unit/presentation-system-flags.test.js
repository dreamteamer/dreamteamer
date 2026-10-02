// Tier 1 — the two facts a collection row states about machinery, and why they are two.
//
//   `runtime`   — STORAGE: are these records build output compile writes? (`compiled.runtime`) A write
//                 goes through the compile gate, and the CLI and REST layer dispatch on it.
//   `internal`  — PLACEMENT: is this workspace plumbing rather than a domain noun? (authored
//                 `internal: true`) A surface draws it on the schema surface, out of the record tree.
//
// They agree for most kinds and split on `repos`: plumbing whose records are ordinary hand-edited
// files under `data/`. A surface that routes a `repos` write by `internal` sends it to the system
// write path, which knows no such kind — so each flag is read from its own source and neither fills
// in for the other.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presentation } from '../../src/presentation.js';
import { compiledCollection } from '../helpers/clinic-compiled.js';

const rowFor = (d) => presentation(new Map([[d.name, d]])).collections.find((c) => c.collection === d.name);
const kind = (name, { internal, runtime } = {}) => compiledCollection(name, {
	authored: internal === undefined ? {} : { internal },
	runtime,
	fields: { name: { type: 'string', title: 'Name' } },
});

describe('runtime and internal are two flags', () => {
	test('a compiled kind is both build output and plumbing', () => {
		const row = rowFor(kind('skills', { internal: true, runtime: true }));
		assert.equal(row.runtime, true);
		assert.equal(row.internal, true);
	});

	// ⚠ THE ASSERTION THIS FILE EXISTS FOR: the two agree everywhere else, so the wrong wiring reads
	// identical to the right one until a `repos` write dies as a 400.
	test('repos is plumbing whose records are workspace files — internal, not runtime', () => {
		const row = rowFor(kind('repos', { internal: true }));
		assert.equal(row.runtime, false, 'its records are files under data/ and are written as records');
		assert.equal(row.internal, true, 'and it is drawn as plumbing');
	});

	test('a runtime kind nobody marked internal is build output and nothing else', () => {
		const row = rowFor(kind('reports', { runtime: true }));
		assert.equal(row.runtime, true);
		assert.equal(row.internal, false, 'internal is authored, never inferred from storage');
	});

	test('a domain collection is neither', () => {
		const row = rowFor(kind('people'));
		assert.equal(row.runtime, false);
		assert.equal(row.internal, false);
	});

	test('a runtime kind carries no `created` — compile writes its records, nothing stamps them', () => {
		const fields = presentation(new Map([['skills', kind('skills', { runtime: true })]])).fields.skills.map((f) => f.field);
		assert.deepEqual(fields, ['id', 'last_modified', 'name']);
	});
});
