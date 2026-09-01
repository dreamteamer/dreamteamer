// Tier 2 — the BATCH ref rewrite, and the parity it has to keep with the per-pair one it replaced.
//
// `collections rename` used to ask the store to rewrite references once PER RECORD ID, and to walk
// every record file a second time before that to snapshot them for rollback: O(ids x files) with an
// uncounted factor of two. The batch entry point opens each file once and applies every pair to the
// bytes in hand, which is only a safe trade if it produces the SAME bytes, the SAME bookkeeping and
// the SAME rollback. So the assertions here are mostly literal file contents — every spelling a
// reference has (a frontmatter scalar, a list entry, a qualified wikilink, a bare-basename wikilink,
// an ambiguous bare basename, raw prose, a look-alike URL), in one workspace, byte for byte.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, readFile, tree } from '../helpers/ws.js';
import { renameCollection } from '../../src/schema-ops.js';
import { load } from '../../src/yaml.js';

const bodied = (props) => simpleCollection({
	schema: {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' }, notes: { type: 'string', format: 'markdown', 'x-body': true }, ...props },
	},
});

const LEDGER = { ...bodied({ settles: { type: 'string', 'x-reference': 'ledger' } }), storage: { suffix: 'entry' } };
const MEMOS = {
	...bodied({
		entry: { type: 'string', 'x-reference': 'ledger' },
		entries: { type: 'array', items: { type: 'string', 'x-reference': 'ledger' } },
	}),
	storage: { suffix: 'memo' },
};
const TASKS = { ...bodied({}), storage: { suffix: 'task' } };

// Every spelling in one body. The last two lines are the ones a naive `oldName/` regex corrupts.
const BODY = [
	'qualified: [[ledger/beta]]',
	'labelled: [[ledger/beta|Beta]]',
	'bare: [[alpha]]',
	'prose: ledger/alpha is not a wikilink',
	'url: https://example.invalid/ledger/alpha-x',
].join('\n');

/** A workspace whose `ledger` is pointed at from every direction, ready to be namespaced. */
function seeded(extraLedger = 0) {
	const ws = workspace({
		namespaces: ['finance'],
		collections: { ledger: LEDGER, memos: MEMOS, tasks: TASKS },
	});
	ws.store.add('ledger', { name: 'Alpha' });
	ws.store.add('ledger', { name: 'Beta', settles: 'ledger/alpha' }); // a SELF-reference
	for (let i = 0; i < extraLedger; i++) ws.store.add('ledger', { name: `Row ${i}` });
	ws.store.add('memos', { name: 'M one', entry: 'ledger/alpha', notes: BODY });
	ws.store.add('memos', { name: 'M two', entries: ['ledger/alpha', 'ledger/beta'] });
	ws.store.add('tasks', { name: 'Alpha' }); // tasks/alpha — so "alpha" names two records
	return ws;
}

/** renameCollection, with the recompile it performs kept quiet. */
function renameQuietly(ws, ...args) {
	const log = console.log, warn = console.warn;
	console.log = console.warn = () => {};
	try { return renameCollection(ws.ws, ws.store, ...args); } finally { console.log = log; console.warn = warn; }
}

describe('a collection rename rewrites every spelling of a reference', () => {
	test('the bytes are what the per-id loop produced, spelling by spelling', () => {
		const ws = seeded();
		const out = renameQuietly(ws, 'ledger', 'finance/ledger');
		assert.equal(out.renamed, true);

		// 1. a frontmatter SELF-reference, inside the collection being moved
		assert.match(readFile(ws.root, 'data/finance/ledger/beta.entry.md'), /^settles: finance\/ledger\/alpha$/m);

		// 2. a frontmatter scalar from another collection, and 3. the wikilink spellings in its body
		const one = readFile(ws.root, 'data/memos/m-one.memo.md');
		assert.match(one, /^entry: finance\/ledger\/alpha$/m);
		assert.match(one, /^qualified: \[\[finance\/ledger\/beta\]\]$/m);
		assert.match(one, /^labelled: \[\[finance\/ledger\/beta\|Beta\]\]$/m, 'the |label form keeps its label');
		// 4. a BARE wikilink is untouched — the id did not change, so `[[alpha]]` still names what it named
		assert.match(one, /^bare: \[\[alpha\]\]$/m);
		// 5. raw prose is counted, never rewritten (decision 7)
		assert.match(one, /^prose: ledger\/alpha is not a wikilink$/m);
		// 6. and the boundary holds: `ledger/alpha-x` is a different string
		assert.match(one, /^url: https:\/\/example\.invalid\/ledger\/alpha-x$/m);

		// 7. list entries, both of them
		const two = readFile(ws.root, 'data/memos/m-two.memo.md');
		assert.match(two, /^ {2}- finance\/ledger\/alpha$/m);
		assert.match(two, /^ {2}- finance\/ledger\/beta$/m);
		assert.doesNotMatch(two, /^ {2}- ledger\//m);

		// 8. the x-reference targets in the descriptors — a different mechanism, unchanged by the batch
		// the round-trip writer quotes only what YAML requires, and `finance/ledger` is a plain scalar —
		// so assert what it PARSES to rather than the spelling the old line editor happened to emit
		assert.equal(load(readFile(ws.root, 'modules/default/collections/memos.collection.yaml'))
			.schema.properties.entry['x-reference'], 'finance/ledger');

		// and the whole thing still validates
		assert.equal(ws.dt('check').code, 0);
	});

	test('a file naming SEVERAL renamed ids is rewritten once, with every pair applied', () => {
		// The per-id loop wrote m-two twice (once per id it names); the batch writes it once. Same bytes,
		// and the count the caller reports must still be per OCCURRENCE, not per file.
		const ws = seeded();
		const out = renameQuietly(ws, 'ledger', 'finance/ledger');
		// alpha: memos/m-one (entry + wikilink-free head) + m-two list entry + nothing in beta
		// beta: m-one two wikilinks + m-two list entry; plus the self-reference in beta, plus the
		// `collections/ledger` retarget in the ui-view-less workspace (none here) and the descriptors.
		assert.equal(out.rewrites, 8, 'one per occurrence rewritten, descriptors included');
		assert.equal(out.records, 2);
	});
});

describe('the walk is one pass, not one pass per id', () => {
	test('renameCollection reads each record file a fixed number of times, whatever N is', () => {
		// Counted, not timed — the trick test/integration/store-index.test.js uses, for the reason it
		// states there. Only reads under `data/` are counted, so the number isolates the reference walk
		// from the recompile a rename performs.
		const ws = seeded(20); // 22 ledger records in all
		const dataFiles = tree(ws.root, 'data').length;
		const ids = ws.store.ids('ledger').size;

		const real = fs.readFileSync;
		const dataDir = path.join(ws.root, 'data');
		let reads = 0;
		fs.readFileSync = (p, ...rest) => { if (String(p).startsWith(dataDir)) reads++; return real(p, ...rest); };
		try { renameQuietly(ws, 'ledger', 'finance/ledger'); } finally { fs.readFileSync = real; }

		// Before the batch this was `ids x files x 2` — the snapshot pass and the rewrite pass, each
		// per id. After it, the record files are read by the batch pass and by the `collections/<name>`
		// pass, which is a second mechanism and deliberately left alone.
		assert.ok(reads <= dataFiles * 4, `${reads} reads of ${dataFiles} data files for ${ids} ids — the walk is still per-id`);
		assert.ok(reads < ids * dataFiles, `${reads} reads — expected far below the old ${ids * dataFiles * 2}`);
	});
});

describe('a failure mid-batch leaves nothing half-written', () => {
	test('every file the batch had already rewritten is restored', () => {
		const ws = seeded();
		const before = new Map(tree(ws.root, 'data').map((rel) => [rel, readFile(ws.root, rel)]));
		const descriptor = readFile(ws.root, 'modules/default/collections/ledger.collection.yaml');

		// Fail the SECOND write the batch makes into `data/`, so at least one file is already rewritten
		// when it throws. One-shot: the restore that follows needs a working writeFileSync.
		const real = fs.writeFileSync;
		const dataDir = path.join(ws.root, 'data');
		let writes = 0;
		fs.writeFileSync = (p, ...rest) => {
			if (String(p).startsWith(dataDir) && ++writes === 2) { fs.writeFileSync = real; throw new Error('injected write failure'); }
			return real(p, ...rest);
		};
		try {
			assert.throws(() => renameQuietly(ws, 'ledger', 'finance/ledger'), /injected write failure/);
		} finally { fs.writeFileSync = real; }

		for (const [rel, text] of before) assert.equal(readFile(ws.root, rel), text, `${rel} was not rolled back`);
		assert.deepEqual(tree(ws.root, 'data'), [...before.keys()], 'no file moved, none appeared');
		assert.equal(readFile(ws.root, 'modules/default/collections/ledger.collection.yaml'), descriptor);
		assert.equal(readFile(ws.root, 'modules/default/collections/finance/ledger.collection.yaml'), null);
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('the batch keeps the per-pair bookkeeping', () => {
	test('skipped prose and ambiguous bare links are reported against the pair that found them', () => {
		const ws = seeded();
		// Two pairs at once, and only ONE of them changes the basename — so exactly one runs the bare
		// wikilink pass, and it finds `[[alpha]]` claimed by tasks/alpha as well.
		const out = ws.store.rewriteRefsBatch([
			['ledger/alpha', 'ledger/alpha-1'],
			['ledger/beta', 'finance/ledger/beta'],
		]);

		const ambiguous = out.ambiguous.map((a) => ({ file: path.relative(ws.root, a.file), count: a.count, base: a.base, claimants: a.claimants }));
		// `ledger/alpha` is among the claimants because this calls the store directly, before anything
		// has moved — `rename` asks after the move, which is why its own warning names only the others.
		assert.deepEqual(ambiguous, [{ file: 'data/memos/m-one.memo.md', count: 1, base: 'alpha', claimants: ['ledger/alpha', 'tasks/alpha'] }],
			'the bare pass belongs to the pair whose basename moved, and it names the other claimants');

		const skipped = out.skipped.map((s) => ({ file: path.relative(ws.root, s.file), count: s.count, oldRef: s.oldRef }));
		// ⚠ there is NO `ledger/beta` row, and there used to be one of 2. Both were the two wikilinks
		// this same pass had just rewritten to `[[finance/ledger/beta]]`, which still ENDS in
		// `ledger/beta` at a legal boundary — a warning naming bytes that are already correct. The
		// `ledger/alpha` row is real raw prose and still counts.
		assert.deepEqual(skipped, [
			{ file: 'data/memos/m-one.memo.md', count: 1, oldRef: 'ledger/alpha' },
		], 'the raw-prose occurrences are attributed to the ref that found them');

		// and the writes themselves are the union of both pairs, one write per file
		assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^entry: ledger\/alpha-1$/m);
		assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^qualified: \[\[finance\/ledger\/beta\]\]$/m);
		assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^bare: \[\[alpha\]\]$/m, 'ambiguous stays put');
		assert.match(readFile(ws.root, 'data/finance/ledger/beta.entry.md') ?? readFile(ws.root, 'data/ledger/beta.entry.md'),
			/^settles: ledger\/alpha-1$/m);

		out.restore();
		assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^entry: ledger\/alpha$/m, 'restore puts the pre-image back');
		assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^qualified: \[\[ledger\/beta\]\]$/m);
	});

	// ⚠ THE PARITY PROOF, and the reason the numbers above can be read rather than trusted. The shape
	// this replaced was N sequential single-pair calls over the same files, so parity is exactly
	// "batch(pairs) == pairs.reduce(single)". Asserted on two identical fixtures rather than on
	// remembered goldens, so it keeps holding when the rules underneath it change.
	test('batch(N) is byte-for-byte the N sequential single-pair calls it replaced', () => {
		const PAIRS = [
			['ledger/alpha', 'finance/ledger/alpha'],   // basename kept — no bare pass
			['ledger/beta', 'finance/ledger/beta'],
		];
		const RENAMES = [
			['ledger/alpha', 'ledger/alpha-1'],          // basename MOVED — bare pass, and ambiguous
			['ledger/beta', 'ledger/beta-1'],
		];
		for (const pairs of [PAIRS, RENAMES]) {
			const one = seeded();
			const many = seeded();
			const sequential = pairs.map(([o, n]) => one.store.rewriteRefs(o, n));
			const batched = many.store.rewriteRefsBatch(pairs);

			const bytes = (ws) => tree(ws.root, 'data').map((rel) => [rel, readFile(ws.root, rel)]);
			assert.deepEqual(bytes(many), bytes(one), `${pairs[0][1]}: the bytes on disk differ`);

			// the two fixtures live in different tmp dirs, so compare by basename
			const strip = (rows) => rows.map((r) => ({ ...r, file: path.basename(r.file) }));
			assert.deepEqual(strip(batched.skipped), strip(sequential.flatMap((s) => s.skipped)), 'skipped');
			assert.deepEqual(strip(batched.ambiguous), strip(sequential.flatMap((s) => s.ambiguous)), 'ambiguous');
			assert.equal(batched.rewrites, sequential.reduce((n, s) => n + s.rewrites, 0), 'rewrites');
			assert.deepEqual(
				[...new Set(batched.touched.map((f) => path.basename(f)))].sort(),
				[...new Set(sequential.flatMap((s) => s.touched).map((f) => path.basename(f)))].sort(), 'touched');

			// and the restores agree too — each fixture back to what the other's untouched copy holds
			batched.restore();
			for (const s of [...sequential].reverse()) s.restore();
			assert.deepEqual(bytes(many), bytes(one), 'restore left the two fixtures in different states');
		}
	});

	// ⚠ THE COUNTER IS A WARNING, and a warning that names correct bytes is worse than none: the
	// operator greps, finds the rewrite, and learns to ignore the line. `ledger/beta` →
	// `finance/ledger/beta` is the ordinary shape of `collections rename`, so this was every
	// namespacing move.
	describe('an already-rewritten occurrence is not skipped prose', () => {
		const suffixShared = (body) => {
			const ws = seeded();
			fs.writeFileSync(path.join(ws.root, 'data', 'memos', 'm-one.memo.md'),
				`---\nname: M one\nentry: ledger/alpha\n---\n${body}\n`);
			return ws;
		};

		test('a body holding only the correct refs reports nothing skipped', () => {
			const ws = suffixShared('qualified: [[ledger/beta]]\nlabelled: [[ledger/beta|Beta]]');
			const out = ws.store.rewriteRefsBatch([['ledger/beta', 'finance/ledger/beta']]);
			assert.deepEqual(out.skipped, [], 'the two occurrences left are the rewrite, not prose');
			assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^qualified: \[\[finance\/ledger\/beta\]\]$/m);
		});

		test('a genuine raw-prose occurrence beside a rewritten one still counts', () => {
			const ws = suffixShared('qualified: [[ledger/beta]]\nprose: see ledger/beta for the detail');
			const out = ws.store.rewriteRefsBatch([['ledger/beta', 'finance/ledger/beta']]);
			assert.equal(out.skipped.length, 1);
			assert.equal(out.skipped[0].count, 1, 'the wikilink is rewritten; only the prose line is skipped');
			assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^prose: see ledger\/beta for the detail$/m);
		});

		test('a pair whose new spelling does NOT end in the old one is unchanged', () => {
			const ws = suffixShared('qualified: [[ledger/beta]]\nprose: see ledger/beta for the detail');
			const out = ws.store.rewriteRefsBatch([['ledger/beta', 'ledger/beta-1']]);
			assert.equal(out.skipped.length, 1);
			assert.equal(out.skipped[0].count, 1);
		});
	});

	// ⚠ AN ANCHOR IS PART OF THE LINK, NOT OF THE TARGET. Both passes used to match up to the closing
	// `]]` or a `|label`, so `[[id#heading]]` survived a rename of `id` untouched — the bare form
	// silently, the qualified form counted only as raw prose. A vault that starts writing heading
	// anchors gets dangling links nothing names. The anchor rides through verbatim: only the record
	// moved, and the heading inside it did not.
	describe('a wikilink carrying a #anchor follows the rename', () => {
		const withBody = (body) => {
			const ws = seeded();
			fs.writeFileSync(path.join(ws.root, 'data', 'memos', 'm-one.memo.md'),
				`---\nname: M one\nentry: ledger/alpha\n---\n${body}\n`);
			return ws;
		};

		test('the qualified form, plain and labelled', () => {
			const ws = withBody('a: [[ledger/beta#part-one]]\nb: [[ledger/beta#part-one|See here]]');
			const out = ws.store.rewriteRefsBatch([['ledger/beta', 'finance/ledger/beta']]);
			const one = readFile(ws.root, 'data/memos/m-one.memo.md');
			assert.match(one, /^a: \[\[finance\/ledger\/beta#part-one\]\]$/m);
			assert.match(one, /^b: \[\[finance\/ledger\/beta#part-one\|See here\]\]$/m);
			assert.deepEqual(out.skipped, [], 'a followed link is not skipped prose');
		});

		test('the bare form, when the basename names exactly one record', () => {
			// through `rename`, which asks `basenameOwners` AFTER the move — so `beta` is claimed by
			// nothing and the bare pass runs. (`alpha` is also a task, which is the ambiguous case below.)
			const ws = withBody('a: [[beta#part-one]]\nb: [[beta#part-one|See here]]\nc: [[beta]]');
			ws.store.rename('ledger', 'beta', 'beta-1');
			const one = readFile(ws.root, 'data/memos/m-one.memo.md');
			assert.match(one, /^a: \[\[beta-1#part-one\]\]$/m);
			assert.match(one, /^b: \[\[beta-1#part-one\|See here\]\]$/m);
			assert.match(one, /^c: \[\[beta-1\]\]$/m, 'the unanchored form is unaffected by the change');
		});

		test('an ambiguous bare anchored link is counted and warned about, exactly like an unanchored one', () => {
			const ws = withBody('a: [[alpha#part-one]]\nb: [[alpha]]');
			const out = ws.store.rewriteRefsBatch([['ledger/alpha', 'ledger/alpha-1']]);
			assert.equal(out.ambiguous.length, 1);
			assert.equal(out.ambiguous[0].count, 2, 'the anchored link is in the count, not silently dropped');
			assert.deepEqual(out.ambiguous[0].claimants, ['ledger/alpha', 'tasks/alpha']);
			assert.match(readFile(ws.root, 'data/memos/m-one.memo.md'), /^a: \[\[alpha#part-one\]\]$/m, 'left exactly as it was');
		});

		test('the anchor is carried through byte for byte, whatever is in it', () => {
			// a heading slug is not an id: spaces, case and punctuation all survive a rename untouched
			const ws = withBody('a: [[ledger/beta#Part One — the setup]]\nb: [[ledger/beta#]]');
			ws.store.rewriteRefsBatch([['ledger/beta', 'finance/ledger/beta']]);
			const one = readFile(ws.root, 'data/memos/m-one.memo.md');
			assert.match(one, /^a: \[\[finance\/ledger\/beta#Part One — the setup\]\]$/m);
			assert.match(one, /^b: \[\[finance\/ledger\/beta#\]\]$/m);
		});

		test('a rename leaves no anchored link pointing at the old id', () => {
			const ws = withBody('a: [[ledger/beta#part-one]]\nb: [[beta#part-one]]');
			renameQuietly(ws, 'ledger', 'finance/ledger');
			const one = readFile(ws.root, 'data/memos/m-one.memo.md');
			assert.doesNotMatch(one, /\[\[ledger\/beta#/, 'the qualified spelling followed the move');
			// the basename did not change, so `[[beta#…]]` still names what it named — and still resolves
			assert.match(one, /^b: \[\[beta#part-one\]\]$/m);
			assert.equal(ws.dt('check').code, 0);
		});
	});

	test('rewriteRefs is the batch of one, and still reports what `rename` prints', () => {
		const ws = seeded();
		const out = ws.store.rewriteRefs('ledger/alpha', 'ledger/alpha-1');
		assert.equal(out.ambiguous.length, 1);
		assert.equal(out.ambiguous[0].base, 'alpha');
		assert.deepEqual(out.ambiguous[0].claimants, ['ledger/alpha', 'tasks/alpha']);
		assert.equal(out.skipped.length, 1);
		assert.equal(out.skipped[0].oldRef, 'ledger/alpha');
	});
});
