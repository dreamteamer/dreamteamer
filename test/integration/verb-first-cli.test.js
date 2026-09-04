// Tier 2 — the CLI's GRAMMAR, through the real binary in a real workspace.
//
// Every other integration file asserts what a verb DOES. This one asserts where the words go:
// `dt <verb> [<target>]`, one reference argument instead of two positionals, and a CLOSED verb set
// whose boundary is a loud failure rather than a guess. The old noun-first spelling
// (`dt contacts list`) must be an error, not a synonym — a half-working grammar is worse than a
// broken one, because it teaches the wrong shape without ever saying so.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';

const CONTACTS = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'contact' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			email: { type: 'string' },
			position: { type: 'string' },
		},
	},
};

// A path-shaped id AND a namespaced collection, together: `finance/transactions/2026/03/coffee` is
// the reference that no first-slash split can read, and it is the reason splitRef exists.
const TRANSACTIONS = {
	id: { generate: '{{ month }}/{{ label | slug }}' },
	storage: { suffix: 'txn' },
	sort_field: 'position',
	schema: {
		type: 'object',
		required: ['label', 'month'],
		properties: { label: { type: 'string' }, month: { type: 'string' }, position: { type: 'string' } },
	},
};

const base = () => workspace({ collections: { contacts: CONTACTS } });
const nsBase = () => workspace({
	namespaces: ['finance'],
	collections: { contacts: CONTACTS, 'finance/transactions': TRANSACTIONS },
});

describe('record verbs — dt <verb> <target>', () => {
	test('add takes the collection as its target', () => {
		const ws = base();
		const res = ws.dt('add', 'contacts', '--name', 'Jane');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'data/contacts/jane.contact.md'), 'the record must be on disk');
	});

	test('list takes the collection as its target', () => {
		const ws = base();
		assert.equal(ws.dt('add', 'contacts', '--name', 'Jane').code, 0);
		const res = ws.dt('list', 'contacts', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(JSON.parse(res.stdout).map((r) => r.id), ['jane']);
	});

	test('get takes a <collection>/<id> reference', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		const res = ws.dt('get', 'contacts/jane', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(JSON.parse(res.stdout), { name: 'Jane', id: 'jane' });
	});

	test('set takes a reference, then key=value pairs', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		const res = ws.dt('set', 'contacts/jane', 'email=e@x.com');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(JSON.parse(ws.dt('get', 'contacts/jane', '--json').stdout).email, 'e@x.com');
	});

	test('a namespaced collection with a path-shaped id resolves as one reference', () => {
		const ws = nsBase();
		assert.equal(ws.dt('add', 'finance/transactions', '--label', 'Coffee', '--month', '2026/03').code, 0);
		const res = ws.dt('get', 'finance/transactions/2026/03/coffee', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(JSON.parse(res.stdout).label, 'Coffee');
	});

	test('values takes the collection, then the field', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane', '--position', 'CTO');
		const res = ws.dt('values', 'contacts', 'position', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(JSON.parse(res.stdout).values.map((v) => v.value), ['CTO']);
	});

	test('rename takes the reference and the new id', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		const res = ws.dt('rename', 'contacts/jane', 'jane-doe');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'data/contacts/jane-doe.contact.md'));
		assert.equal(readFile(ws.root, 'data/contacts/jane.contact.md'), null);
	});

	test('rm takes a reference', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		assert.equal(ws.dt('rm', 'contacts/jane').code, 0);
		assert.equal(readFile(ws.root, 'data/contacts/jane.contact.md'), null);
	});

	test('history takes a reference and reports the commits', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		ws.git(['add', '-A']);
		ws.git(['commit', '-qm', 'add jane']);
		const res = ws.dt('history', 'contacts/jane', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(JSON.parse(res.stdout).length >= 1, 'the commit must appear');
	});

	// `move` is the one record verb whose target is EITHER shape: a reference to place one record,
	// or a bare collection to place all of them with --init.
	test('move takes a reference, and --init takes the bare collection', () => {
		const ws = workspace({
			collections: {
				ordered: simpleCollection({ storage: { suffix: 'ord' }, sort_field: 'position', schema: {
					type: 'object', required: ['name'],
					properties: { name: { type: 'string' }, position: { type: 'string' } },
				} }),
			},
		});
		ws.dt('add', 'ordered', '--name', 'Alpha');
		ws.dt('add', 'ordered', '--name', 'Bravo');
		assert.equal(ws.dt('move', 'ordered', '--init').code, 0);
		const res = ws.dt('move', 'ordered/bravo', '--top');
		assert.equal(res.code, 0, res.stderr);
		const ids = JSON.parse(ws.dt('list', 'ordered', '--sort', 'position', '--json').stdout).map((r) => r.id);
		assert.deepEqual(ids, ['bravo', 'alpha']);
	});

	test('a reference naming no known collection reports splitRef\'s error', () => {
		const ws = base();
		const res = ws.dt('get', 'nope/x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown collection in reference "nope\/x"/);
	});

	test('a flag in the target slot is a word-order error, not a collection', () => {
		const ws = base();
		const res = ws.dt('list', '--json', 'contacts');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /takes its target BEFORE the flags/);
	});

	test('a record verb with no target says so', () => {
		const ws = base();
		const res = ws.dt('get');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /needs a target/);
	});
});

// The fixture above exists so that a NAMESPACED collection is exercised by every target shape, not
// just by `get`. It is not decoration: `commands` was broken for every namespaced target in both
// shapes while `get` passed, because the two resolve the reference in different places.
describe('a namespaced collection, through every target shape', () => {
	const seeded = () => {
		const ws = nsBase();
		assert.equal(ws.dt('add', 'finance/transactions', '--label', 'Coffee', '--month', '2026/03').code, 0);
		assert.equal(ws.dt('add', 'finance/transactions', '--label', 'Rent', '--month', '2026/03').code, 0);
		return ws;
	};

	test('commands takes the namespaced collection', () => {
		const ws = seeded();
		const res = ws.dt('commands', 'finance/transactions', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(JSON.parse(res.stdout).collection, 'finance/transactions');
	});

	test('commands takes a namespaced reference with a path-shaped id', () => {
		const ws = seeded();
		const res = ws.dt('commands', 'finance/transactions/2026/03/coffee', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(JSON.parse(res.stdout).collection, 'finance/transactions');
	});

	test('values takes the namespaced collection', () => {
		const ws = seeded();
		const res = ws.dt('values', 'finance/transactions', 'month', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(JSON.parse(res.stdout).values.map((v) => v.value), ['2026/03']);
	});

	test('move --init takes the namespaced collection, and a reference places one record', () => {
		const ws = seeded();
		const init = ws.dt('move', 'finance/transactions', '--init');
		assert.equal(init.code, 0, init.stderr);
		const top = ws.dt('move', 'finance/transactions/2026/03/rent', '--top');
		assert.equal(top.code, 0, top.stderr);
		const ids = JSON.parse(ws.dt('list', 'finance/transactions', '--sort', 'position', '--json').stdout)
			.map((r) => r.id);
		assert.deepEqual(ids, ['2026/03/rent', '2026/03/coffee']);
	});

	test('rename takes a namespaced reference and a path-shaped new id', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'finance/transactions/2026/03/coffee', '2026/04/coffee');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'data/finance/transactions/2026/04/coffee.txn.md'));
		assert.equal(readFile(ws.root, 'data/finance/transactions/2026/03/coffee.txn.md'), null);
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('commands and ensure absorb their old noun', () => {
	test('commands takes the collection or a record reference', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		const c = ws.dt('commands', 'contacts', '--json');
		assert.equal(c.code, 0, c.stderr);
		assert.equal(JSON.parse(c.stdout).collection, 'contacts');
		const r = ws.dt('commands', 'contacts/jane', '--json');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).collection, 'contacts');
	});

	test('ensure --all is a no-op report when no repos are declared', () => {
		const ws = base();
		const res = ws.dt('ensure', '--all');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /no repos declared/);
	});
});

describe('system verbs — the SAME verbs, on the entities the compiler materializes', () => {
	test('add collections writes the descriptor', () => {
		const ws = base();
		const res = ws.dt('add', 'collections', '--name', 'widgets');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, '.dreamteamer/collections/widgets.collection.yaml'));
	});

	test('the field verbs take the collection as a positional', () => {
		const ws = base();
		const add = ws.dt('add-field', 'contacts', '--name', 'phone', '--type', 'string');
		assert.equal(add.code, 0, add.stderr);
		assert.match(readFile(ws.root, '.dreamteamer/collections/contacts.collection.yaml'), /phone/);

		const rm = ws.dt('remove-field', 'contacts', '--name', 'phone');
		assert.equal(rm.code, 0, rm.stderr);
		assert.doesNotMatch(readFile(ws.root, '.dreamteamer/collections/contacts.collection.yaml'), /phone/);
	});

	test('update-field retypes it', () => {
		const ws = base();
		assert.equal(ws.dt('add-field', 'contacts', '--name', 'tier', '--type', 'string').code, 0);
		const res = ws.dt('update-field', 'contacts', '--name', 'tier', '--type', 'enum', '--options', 'a,b');
		assert.equal(res.code, 0, res.stderr);
		assert.match(readFile(ws.root, '.dreamteamer/collections/contacts.collection.yaml'), /enum/);
	});

	test('rename collections/<old> <new> moves the descriptor and the records', () => {
		const ws = base();
		ws.dt('add', 'contacts', '--name', 'Jane');
		const res = ws.dt('rename', 'collections/contacts', 'people');
		assert.equal(res.code, 0, res.stderr);
		// `.contact.md` is exactly what `contacts` DERIVES, so the rename re-suffixes it too
		assert.ok(readFile(ws.root, 'data/people/jane.people.md'));
		assert.equal(ws.dt('check').code, 0);
	});

	test('rm collections/<name> drops it, and --force is needed once it has records', () => {
		const ws = base();
		assert.equal(ws.dt('add', 'collections', '--name', 'widgets').code, 0);
		assert.equal(ws.dt('add', 'widgets', '--name', 'A').code, 0);
		const refused = ws.dt('rm', 'collections/widgets');
		assert.equal(refused.code, 1);
		assert.equal(ws.dt('rm', 'collections/widgets', '--force').code, 0);
	});

	test('ui-views take add / set / rm under the same verbs', () => {
		const ws = base();
		const add = ws.dt('add', 'ui-views', '--path', '/recent', '--target', 'list',
			'--collection', 'collections/contacts', '--layout', 'table');
		assert.equal(add.code, 0, add.stderr);
		assert.equal(ws.dt('set', 'ui-views/recent', 'options.sort=-name').code, 0);
		assert.equal(ws.dt('rm', 'ui-views/recent').code, 0);
	});

	test('rename-field is a verb of its own', () => {
		const ws = base();
		assert.equal(ws.dt('add-field', 'contacts', '--name', 'tier', '--type', 'string').code, 0);
		assert.equal(ws.dt('rename-field', 'contacts', '--name', 'tier', '--to', 'band').code, 0);
		assert.match(readFile(ws.root, '.dreamteamer/collections/contacts.collection.yaml'), /band/);
	});

	// ⚠ THE BREAKING CHANGE, and it must fail with the TRANSLATION. Every doc, skill and downstream
	// script spelled these `dt schema <op>` for seven releases — the same shape `dt contacts list`
	// had before 0.12.0, and the same policy applies: no alias layer, no deprecation window.
	//
	// This REPLACES `test('an unknown schema sub-verb is refused')`, which asserted
	// `unknown schema operation "nonsense"` — a message the flip deletes. That test deliberately
	// pinned the old grammar, so it is gone rather than rewritten.
	test('dt schema is gone and the error carries the new spellings', () => {
		const ws = base();
		const res = ws.dt('schema', 'add-collection', '--name', 'widgets');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown verb "schema"/);
		assert.match(res.stderr, /schema verbs are gone since 0\.19\.0/);
		assert.match(res.stderr, /dt add collections/);
		assert.match(res.stderr, /dt add-field <c>/);
		assert.match(res.stderr, /UPDATING\.md/);
	});
});

describe('the verb set is closed', () => {
	// THE breaking change. `dt contacts list` used to work, and every doc and skill in every
	// downstream vault spelled it that way — so it must fail with the word "verb" in it, not
	// dispatch to a collection called "contacts".
	test('the old noun-first grammar fails loudly', () => {
		const ws = base();
		const res = ws.dt('contacts', 'list');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /unknown verb "contacts"/);
	});

	test('a nonsense verb prints the usage and exits 1', () => {
		const ws = base();
		const res = ws.dt('nonsense');
		assert.equal(res.code, 1);
		assert.match(res.stderr + res.stdout, /unknown verb "nonsense"/);
		assert.match(res.stderr + res.stdout, /usage: dreamteamer <verb>/);
	});

	test('no arguments at all is the usage, and a success', () => {
		const ws = base();
		const res = ws.dt();
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /usage: dreamteamer <verb>/);
	});

	// resolve is the verb that could not exist under the noun-first grammar — it takes a bare
	// string. What it RENDERS is `resolve.test.js`; this asserts only that the word dispatches.
	test('resolve is a real verb and takes a bare string', () => {
		const ws = base();
		const res = ws.dt('resolve', '${workspaceFolder}/media');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim(), `${fs.realpathSync(ws.root)}/media`);
	});
});

describe('workspace verbs keep their spellings', () => {
	test('check, status and compile still answer', () => {
		const ws = base();
		assert.equal(ws.dt('check').code, 0);
		assert.match(ws.dt('status').stdout, /is fresh/);
		assert.equal(ws.dt('compile').code, 0);
	});

	// THE VERB LIST IS PINNED TO THE DISPATCH. `help` is the single source with it, so this test is
	// what makes the two unable to drift — and it is updated in the SAME commit as the flip, because
	// a help text describing a grammar the dispatch no longer has is worse than no help text.
	test('help prints the four verb groups, and states the commit policy once', () => {
		const ws = base();
		const res = ws.dt('help');
		assert.equal(res.code, 0);
		assert.match(res.stdout, /record verbs/);
		assert.match(res.stdout, /system verbs/);
		assert.match(res.stdout, /field verbs/);
		assert.match(res.stdout, /workspace verbs/);
		assert.doesNotMatch(res.stdout, /schema verbs \(write SOURCES/);
		assert.match(res.stdout, /a SYSTEM write commits itself/);
		assert.match(res.stdout, /a RECORD write does not/);
	});

	// Every verb `help` documents must DISPATCH, and every verb that dispatches must be documented.
	// Derived from the text rather than hand-listed, so adding a verb to one and not the other fails
	// here instead of at the first person who reads the wrong one.
	test('every verb named in help dispatches, and no verb dispatches undocumented', () => {
		const ws = base();
		const help = ws.dt('help').stdout;
		const documented = new Set();
		for (const m of help.matchAll(/^ {2}([a-z][a-z-]*)\s/gm)) documented.add(m[1]);
		// ⚠ A PIN THAT MATCHES NOTHING PASSES VACUOUSLY, which is the one outcome to avoid.
		assert.ok(documented.size >= 25, `help yielded only ${documented.size} verb names — the extraction pattern no longer matches USAGE`);
		// ⚠ `start` IS EXCLUDED FROM THE EXECUTION HALF, AND ONLY FROM IT. It binds a port and never
		// returns, so `dt(verb)` — a spawnSync — waits forever. This hung a release for six hours:
		// the suite passed on a developer machine because something already held the port and the
		// server died on EADDRINUSE, and hung on a CI runner where the port was free. It is still
		// required to be documented by the second loop below, which only reads the set.
		const SERVES_FOREVER = new Set(['start']);
		for (const verb of documented) {
			if (SERVES_FOREVER.has(verb)) continue;
			const res = ws.dt(verb);
			// A documented verb answers with its OWN complaint (a missing target, a missing flag) or
			// succeeds — never with "unknown verb", which is the only failure this asserts against.
			assert.doesNotMatch(res.stderr + res.stdout, new RegExp(`unknown verb "${verb}"`), `help documents \`${verb}\` but the dispatch does not know it`);
		}
		for (const verb of ['add', 'set', 'rm', 'rename', 'list', 'get', 'move', 'values', 'history', 'diff', 'revert', 'commands', 'relations', 'ensure', 'resolve', 'add-field', 'update-field', 'remove-field', 'rename-field', 'init', 'install', 'update', 'compile', 'check', 'status', 'start', 'changes', 'commit', 'help']) {
			assert.ok(documented.has(verb), `\`${verb}\` dispatches but help does not document it`);
		}
	});
});
