// Tier 1 — the two answers `collectionRow` emits about a collection's SYSTEM-ness, and why they are
// two and not one.
//
//   `system`      — the STORAGE question: are these records the compiled runtime's build output?
//                   The CLI and the REST layer dispatch a write on it. Repointing it is how the
//                   extension's write router started answering 400 to every `repos` edit.
//   `meta.group`  — the PRESENTATION question: which partition is this collection in? Its reserved
//                   value `system` says this is the workspace's machinery rather than one of its
//                   domain nouns, and decides WHERE the collection is drawn — folded out of the
//                   record tree, onto the Schema rail.
//
// They agreed for every collection that has ever existed until `repos`: machinery whose records are
// real, hand-edited files under `data/`. That one collection is why the answer had to split, and why
// the `system: false` assertion below matters more than the partition one — it is the guard against
// a later "simplification" that answers write dispatch from the partition and silently breaks it.
//
// `presentation()` takes a Map of descriptors and returns a projection — pure, no workspace, no fs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presentation } from '../../src/presentation.js';

/** One descriptor, minimal: `presentation` needs a name, a storage block and a schema. */
function descriptor(name, extra = {}) {
	return {
		name,
		storage: { path: `data/${name}`, base: 'workspace', suffix: name },
		schema: { type: 'object', properties: { name: { type: 'string' } } },
		...extra,
	};
}

const rowFor = (d) => presentation(new Map([[d.name, d]])).collections.find((c) => c.collection === d.name);

describe('the presentation projection carries both system answers', () => {
	// The compiled kinds: build output AND machinery. Both answers agree, and nothing about the rail
	// or the write router changes for them.
	test('a runtime-stored kind is both build output and machinery', () => {
		const row = rowFor(descriptor('skills', {
			storage: { path: 'skills', base: 'runtime', suffix: 'skill' },
			group: 'system',
		}));
		assert.equal(row.system, true, 'storage.base is runtime — dispatch keys on this');
		assert.equal(row.meta.group, 'system', 'and it is drawn on the Schema rail');
	});

	// ⚠ THE ASSERTION THIS FILE EXISTS FOR. `repos` is machinery the operator EDITS: its records are
	// ordinary files under `data/repos`, written through the record store like any other. If a later
	// change points `system` at the descriptor's partition, this fails — and it is the only thing
	// that would, because the two agree for every other collection and the wrong wiring reads
	// identical to the right one.
	test('a system-partitioned collection whose records are workspace files is NOT build output', () => {
		const row = rowFor(descriptor('repos', { group: 'system' }));
		assert.equal(
			row.system, false,
			'`repos` records are real files under `data/` — the CLI and REST write path must keep dispatching them as records',
		);
		assert.equal(row.meta.group, 'system', '…and it is still drawn as machinery, on the Schema rail');
	});

	// The accepted consequence: `repos` is not special-cased, so any collection an operator puts in
	// the partition is drawn the same way — `assets` in the dogfood vault is the second.
	test('and so is any other collection the operator puts in the partition — this is `assets`', () => {
		const row = rowFor(descriptor('assets', { group: 'system', storage: { path: 'data/assets', base: 'workspace', suffix: 'asset' } }));
		assert.equal(row.system, false, 'its records are files under `data/` and stay writable');
		assert.equal(row.meta.group, 'system', 'and it is drawn on the Schema rail, exactly like repos');
	});

	test('an ordinary domain collection is neither', () => {
		const row = rowFor(descriptor('people'));
		assert.equal(row.system, false);
		assert.equal(row.meta.group, undefined);
	});

	// A collection in a DOMAIN partition is not machinery. The reserved value is `system` and only
	// `system` — a surface testing `meta.group !== undefined` would sweep the whole vault onto the
	// Schema rail.
	test('a collection in a domain partition is not machinery', () => {
		const row = rowFor(descriptor('accounts', { group: 'finance' }));
		assert.equal(row.meta.group, 'finance', 'the partition is carried verbatim, not coerced to a boolean');
		assert.equal(row.system, false);
	});

	// ⚠ NO SECOND FIELD. The projection emitted a derived presentation boolean for one release; it
	// was deleted because the partition already carried the fact and two spellings of one answer is
	// how they drift apart. If one comes back, this fails.
	test('the projection emits exactly one storage flag and no derived presentation boolean', () => {
		const row = rowFor(descriptor('repos', { group: 'system' }));
		assert.deepEqual(Object.keys(row).sort(), ['collection', 'meta', 'system']);
	});

	// A runtime-stored kind that is NOT in the partition is still build output: the two answers are
	// independent in both directions, and storage never fills in for an absent partition.
	test('a runtime-stored kind outside the partition is build output and nothing else', () => {
		const row = rowFor(descriptor('reports', {
			storage: { path: 'reports', base: 'runtime', suffix: 'report' },
		}));
		assert.equal(row.meta.group, undefined, 'no partition is authored, so none is invented from storage');
		assert.equal(row.system, true, 'but it is still build output, and the write path must know');
	});
});
