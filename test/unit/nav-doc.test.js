// Tier 1 — the nav document (cr-dt-008, design §3): nav.yaml read, validated, written and merged, with no
// workspace anywhere near it. A module's fragment only ever ADDS rows the document does not place yet;
// what the operator arranged is never moved.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseNavDoc, serializeNavDoc, validateNavDoc, placedNames, mergeFragment, NavDocError } from '../../src/nav.js';

// the design's own example, verbatim
const EXAMPLE = `# The left nav of this workspace. Drag and drop writes this file; so may you.
tree:
  - folder: Work                      # a folder: label, optional icon, optional hidden, items
    icon: rocket
    items:
      - tasks                         # a collection by name
      - projects
      - folder: Plans                 # folders nest
        items: [deliverables, decisions, risks]
      - workflows
  - folder: People
    items: [users, teams, roles, responsibilities, agents]
  - collection: contacts              # the long form, when an icon is overridden
    icon: person
  - namespace: rnd                    # a namespace folder; its items are its rows and folders
    items:
      - rnd/change-requests
      - rnd/issues
      - folder: Product
        items: [rnd/user-journeys, rnd/user-stories]
  - folder: Old
    hidden: true                      # a hidden folder: not drawn, contents included
    items: [metrics]
hidden: [file-drives]                 # hidden rows, by name
`;

const COLLECTIONS = new Set(['tasks', 'projects', 'deliverables', 'decisions', 'risks', 'workflows', 'users', 'teams', 'roles',
	'responsibilities', 'agents', 'contacts', 'rnd/change-requests', 'rnd/issues', 'rnd/user-journeys', 'rnd/user-stories', 'metrics', 'file-drives']);

describe('parseNavDoc / serializeNavDoc', () => {
	test('the design example parses into tree and hidden', () => {
		const doc = parseNavDoc(EXAMPLE);
		assert.equal(doc.tree.length, 5);
		assert.deepEqual(doc.tree[0].items[2], { folder: 'Plans', items: ['deliverables', 'decisions', 'risks'] });
		assert.deepEqual(doc.tree[2], { collection: 'contacts', icon: 'person' });
		assert.equal(doc.tree[3].namespace, 'rnd');
		assert.equal(doc.tree[4].hidden, true);
		assert.deepEqual(doc.hidden, ['file-drives']);
	});
	test('an empty file, and a mapping with neither key, read as an empty document', () => {
		assert.deepEqual(parseNavDoc(''), { tree: [], hidden: [] });
		assert.deepEqual(parseNavDoc('# only a comment\n'), { tree: [], hidden: [] });
		assert.deepEqual(parseNavDoc('tree:\n  - tasks\n'), { tree: ['tasks'], hidden: [] });
	});
	test('serialize then parse round-trips, under the header line, with one trailing newline', () => {
		const doc = parseNavDoc(EXAMPLE);
		const text = serializeNavDoc(doc);
		assert.equal(text.split('\n')[0], '# The left nav of this workspace. Drag and drop writes this file; so may you.');
		assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
		assert.deepEqual(parseNavDoc(text), doc);
		const bare = { tree: ['tasks'], hidden: [] };
		assert.doesNotMatch(serializeNavDoc(bare), /hidden/);
		assert.deepEqual(parseNavDoc(serializeNavDoc(bare)), bare);
	});
	test('a list, a scalar, bad yaml and a non-list tree or hidden throw NavDocError', () => {
		assert.throws(() => parseNavDoc('- a'), (e) => e instanceof NavDocError && e.name === 'NavDocError' && /not a mapping/.test(e.message));
		assert.throws(() => parseNavDoc('just words'), NavDocError);
		assert.throws(() => parseNavDoc('tree: [a\n'), NavDocError);
		assert.throws(() => parseNavDoc('tree: tasks\n'), /tree must be a list/);
		assert.throws(() => parseNavDoc('hidden: tasks\n'), /hidden must be a list/);
	});
});

describe('validateNavDoc', () => {
	test('the design example over its own collections is clean', () => {
		assert.deepEqual(validateNavDoc(parseNavDoc(EXAMPLE), { collections: COLLECTIONS, namespaces: ['rnd'] }), []);
	});
	test('an unknown collection, an unknown namespace and a name listed twice each warn', () => {
		const doc = { tree: ['tasks', 'ghost', { namespace: 'nope' }, { folder: 'W', items: ['tasks'] }], hidden: [] };
		const w = validateNavDoc(doc, { collections: COLLECTIONS, namespaces: ['rnd'] }).map((x) => x.warning);
		assert.ok(w.includes('unknown collection "ghost"'), w.join('\n'));
		assert.ok(w.includes('unknown namespace "nope"'), w.join('\n'));
		assert.ok(w.includes('"tasks" is listed twice — it draws at its first place'), w.join('\n'));
	});
	test('tree and hidden count together; a hidden name may be a collection or a declared namespace', () => {
		const doc = { tree: ['tasks'], hidden: ['tasks', 'rnd', 'ghost'] };
		const w = validateNavDoc(doc, { collections: COLLECTIONS, namespaces: ['rnd'] }).map((x) => x.warning);
		assert.deepEqual(w.sort(), ['"tasks" is listed twice — it draws at its first place', 'unknown collection "ghost"'].sort());
	});
});

describe('placedNames', () => {
	test('every collection in the tree at any depth, short or long form, and every hidden name — never a namespace entry', () => {
		const placed = placedNames(parseNavDoc(EXAMPLE));
		for (const n of ['tasks', 'deliverables', 'contacts', 'rnd/user-stories', 'metrics', 'file-drives']) assert.ok(placed.has(n), n);
		assert.ok(!placed.has('rnd'));
		assert.ok(!placed.has('Work'));
	});
});

describe('mergeFragment', () => {
	const merge = (doc, fragment) => mergeFragment(doc, fragment, { placed: placedNames(doc) });

	test('places only names the document does not place, and reuses a same-label top-level folder', () => {
		const doc = { tree: [{ folder: 'Work', items: ['tasks'] }, 'contacts'], hidden: ['metrics'] };
		const frozen = structuredClone(doc);
		const { doc: out, placedNow } = merge(doc, { tree: [{ folder: 'Work', items: ['tasks', 'projects', 'metrics'] }, 'contacts', 'risks'], hidden: [] });
		assert.deepEqual(placedNow, ['projects', 'risks']);
		assert.deepEqual(out.tree, [{ folder: 'Work', items: ['tasks', 'projects'] }, 'contacts', 'risks']);
		assert.deepEqual(out.hidden, ['metrics']);
		assert.deepEqual(doc, frozen, 'the input is never mutated');
	});
	test('a fragment folder whose items are all placed creates no folder', () => {
		const doc = { tree: ['tasks', 'projects'], hidden: [] };
		const r = merge(doc, { tree: [{ folder: 'Work', items: ['tasks', 'projects'] }], hidden: [] });
		assert.equal(r.doc, doc);
		assert.deepEqual(r.placedNow, []);
	});
	test('a new folder keeps the fragment icon and hidden flag; a long-form entry keeps its icon', () => {
		const { doc } = merge({ tree: [], hidden: [] }, { tree: [{ folder: 'People', icon: 'person', items: [{ collection: 'users', icon: 'account' }, { collection: 'teams' }] }], hidden: [] });
		assert.deepEqual(doc.tree, [{ folder: 'People', icon: 'person', items: [{ collection: 'users', icon: 'account' }, 'teams'] }]);
	});
	test('the fragment hidden list is ignored — a module never hides a row', () => {
		const { doc } = merge({ tree: [], hidden: [] }, { tree: ['tasks'], hidden: ['projects'] });
		assert.deepEqual(doc, { tree: ['tasks'], hidden: [] });
	});
	test('a second merge of the same fragment returns the same object', () => {
		const fragment = { tree: [{ folder: 'Work', items: ['tasks', 'projects'] }], hidden: [] };
		const once = merge({ tree: [], hidden: [] }, fragment).doc;
		const twice = merge(once, fragment);
		assert.equal(twice.doc, once);
		assert.deepEqual(twice.placedNow, []);
	});
	test('a folder of the same label at another level is never reused', () => {
		const doc = { tree: [{ folder: 'Outer', items: [{ folder: 'Work', items: ['tasks'] }] }], hidden: [] };
		const { doc: out } = merge(doc, { tree: [{ folder: 'Work', items: ['projects'] }], hidden: [] });
		assert.deepEqual(out.tree, [{ folder: 'Outer', items: [{ folder: 'Work', items: ['tasks'] }] }, { folder: 'Work', items: ['projects'] }]);
	});
	test('a doc namespace entry with no items is filled', () => {
		const doc = { tree: [{ namespace: 'rnd' }], hidden: [] };
		const { doc: out } = merge(doc, { tree: [{ namespace: 'rnd', items: ['rnd/issues', { folder: 'Product', items: ['rnd/user-stories'] }] }], hidden: [] });
		assert.deepEqual(out.tree, [{ namespace: 'rnd', items: ['rnd/issues', { folder: 'Product', items: ['rnd/user-stories'] }] }]);
	});
	test('an existing namespace entry gains only the unplaced item', () => {
		const doc = { tree: [{ namespace: 'rnd', items: ['rnd/issues'] }], hidden: [] };
		const { doc: out, placedNow } = merge(doc, { tree: [{ namespace: 'rnd', items: ['rnd/issues', 'rnd/tests'] }], hidden: [] });
		assert.deepEqual(out.tree, [{ namespace: 'rnd', items: ['rnd/issues', 'rnd/tests'] }]);
		assert.deepEqual(placedNow, ['rnd/tests']);
	});
	test('no second namespace entry when the doc holds the namespace inside a folder', () => {
		const doc = { tree: [{ folder: 'Product', items: [{ namespace: 'rnd', items: ['rnd/issues'] }] }], hidden: [] };
		const r = merge(doc, { tree: [{ namespace: 'rnd', items: ['rnd/issues', 'rnd/tests'] }], hidden: [] });
		assert.equal(r.doc, doc);
		assert.deepEqual(r.placedNow, []);
	});
	test('a namespace the doc names nowhere is appended — with its placed items, or bare when the fragment entry has none', () => {
		const a = merge({ tree: ['tasks'], hidden: [] }, { tree: [{ namespace: 'rnd', items: ['rnd/issues'] }], hidden: [] }).doc;
		assert.deepEqual(a.tree, ['tasks', { namespace: 'rnd', items: ['rnd/issues'] }]);
		const b = merge({ tree: [], hidden: [] }, { tree: [{ namespace: 'fixns' }], hidden: [] }).doc;
		assert.deepEqual(b.tree, [{ namespace: 'fixns' }]);
		assert.equal(merge(b, { tree: [{ namespace: 'fixns' }], hidden: [] }).doc, b);
	});
});
