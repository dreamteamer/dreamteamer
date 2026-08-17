// Tier 1 — the namespace semantics, with no workspace anywhere near them.
//
// This file is the specification for the slash delimiter. Every ambiguity that made a slash-delimited
// namespace a risk is written down here as a passing assertion, so the resolution can never quietly
// change: which prefix wins, what a bare collection name means, and which spellings are refused.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeNamespaces, namespaceProblems, unqualifiedProblems, qualify, namespaceOf, baseNameOf,
	parseRef, defaultStoragePath, storageOverlaps, RESERVED_NAMESPACES,
} from '../../src/namespace.js';

const NS = normalizeNamespaces(['health', 'finance', 'work/clients', 'work']);

describe('normalizeNamespaces', () => {
	test('sorts longest first so a nested namespace beats its parent', () => {
		assert.deepEqual(normalizeNamespaces(['work', 'work/clients']), ['work/clients', 'work']);
	});

	test('de-duplicates, trims slashes and drops non-strings', () => {
		assert.deepEqual(normalizeNamespaces(['/health/', 'health', 42, null, ' finance ']), ['finance', 'health']);
	});

	test('a missing or malformed declaration is an empty list, never a throw', () => {
		assert.deepEqual(normalizeNamespaces(undefined), []);
		assert.deepEqual(normalizeNamespaces('health'), []);
	});
});

describe('parseRef — the boundary decision', () => {
	test('an unnamespaced ref splits at the first slash', () => {
		assert.deepEqual(parseRef('contacts/ada', NS), { collection: 'contacts', id: 'ada' });
	});

	test('a multi-segment id stays whole', () => {
		assert.deepEqual(parseRef('meetings/2026/07/kickoff', NS), { collection: 'meetings', id: '2026/07/kickoff' });
	});

	test('a declared namespace claims exactly one more segment as the collection', () => {
		assert.deepEqual(parseRef('health/doctors/dana-levi', NS), { collection: 'health/doctors', id: 'dana-levi' });
	});

	test('a namespaced collection keeps multi-segment ids too', () => {
		assert.deepEqual(parseRef('health/visits/2026/03/checkup', NS), { collection: 'health/visits', id: '2026/03/checkup' });
	});

	// The reason the declared list is sorted longest-first. Parent-first would read this as the
	// namespace `work`, the collection `clients` and the id `acme/2026`, which is a different record.
	test('the LONGEST declared namespace wins', () => {
		assert.deepEqual(parseRef('work/clients/acme/2026', NS), { collection: 'work/clients/acme', id: '2026' });
		assert.deepEqual(parseRef('work/invoices/i-1', NS), { collection: 'work/invoices', id: 'i-1' });
	});

	test('an UNdeclared prefix is not a namespace — it is a collection with a nested id', () => {
		assert.deepEqual(parseRef('health/doctors/dana-levi', []), { collection: 'health', id: 'doctors/dana-levi' });
	});

	test('a collection name alone is not a reference', () => {
		assert.equal(parseRef('health/doctors', NS), null);
		assert.equal(parseRef('contacts', NS), null);
	});

	test('trailing and leading slashes are not references', () => {
		assert.equal(parseRef('contacts/', NS), null);
		assert.equal(parseRef('/ada', NS), null);
		assert.equal(parseRef('health/doctors/', NS), null);
	});

	test('non-strings and empties are null, never a throw', () => {
		for (const bad of ['', null, undefined, 7, {}]) assert.equal(parseRef(bad, NS), null);
	});

	// `ui-views` point at `collections/<qualified-name>`, and `collections` is not a namespace — so a
	// namespaced collection is addressed as a RECORD id containing slashes, with no special case.
	test('a reference INTO the collections collection carries a qualified name as its id', () => {
		assert.deepEqual(parseRef('collections/health/doctors', NS), { collection: 'collections', id: 'health/doctors' });
	});
});

describe('qualify / namespaceOf / baseNameOf', () => {
	test('round-trips through the default namespace unchanged', () => {
		assert.equal(qualify('', 'tasks'), 'tasks');
		assert.equal(namespaceOf('tasks', NS), '');
		assert.equal(baseNameOf('tasks', NS), 'tasks');
	});

	test('round-trips a namespaced name', () => {
		assert.equal(qualify('health', 'doctors'), 'health/doctors');
		assert.equal(namespaceOf('health/doctors', NS), 'health');
		assert.equal(baseNameOf('health/doctors', NS), 'doctors');
	});

	test('resolves against the DECLARED list, not the last slash', () => {
		assert.equal(namespaceOf('work/clients/acme', NS), 'work/clients');
		assert.equal(baseNameOf('work/clients/acme', NS), 'acme');
		// `crm` is not declared, so this is a default-namespace collection that merely has a slash —
		// which unqualifiedProblems refuses separately.
		assert.equal(namespaceOf('crm/contacts', NS), '');
	});
});

describe('namespaceProblems', () => {
	test('a clean declaration has no problems', () => {
		assert.deepEqual(namespaceProblems(NS, ['tasks', 'health/doctors']), []);
	});

	test('`default` is reserved, in any segment', () => {
		assert.match(namespaceProblems(['default'], [])[0], /reserved/);
		assert.match(namespaceProblems(['work/default'], [])[0], /reserved/);
		assert.ok(RESERVED_NAMESPACES.has('default'));
	});

	// The collision that makes slash-delimited namespaces dangerous, refused up front.
	test('a namespace colliding with a collection name is refused', () => {
		const p = namespaceProblems(['health'], ['health', 'tasks']);
		assert.equal(p.length, 1);
		assert.match(p[0], /collides with the collection/);
	});

	test('segments must be lowercase-alphanumeric-hyphen', () => {
		assert.match(namespaceProblems(['Health'], [])[0], /lowercase/);
		assert.match(namespaceProblems(['my_ns'], [])[0], /lowercase/);
		assert.match(namespaceProblems(['a--b'], [])[0], /lowercase/);
	});
});

describe('unqualifiedProblems — the silent-vanish guard', () => {
	test('a namespaced collection whose prefix is declared is fine', () => {
		assert.deepEqual(unqualifiedProblems(['health/doctors', 'tasks'], NS), []);
	});

	test('a slashed collection name with an UNdeclared prefix is refused', () => {
		const p = unqualifiedProblems(['crm/contacts'], NS);
		assert.equal(p.length, 1);
		assert.match(p[0], /"crm" is not declared/);
	});
});

describe('defaultStoragePath', () => {
	test('the default namespace gets no extra folder — this is what "transparent" means', () => {
		assert.equal(defaultStoragePath('tasks', NS), 'data/tasks');
	});

	test('a namespace becomes real directory nesting', () => {
		assert.equal(defaultStoragePath('health/doctors', NS), 'data/health/doctors');
		assert.equal(defaultStoragePath('work/clients/acme', NS), 'data/work/clients/acme');
	});

	test('honours a workspace data-path', () => {
		assert.equal(defaultStoragePath('health/doctors', NS, 'vault'), 'vault/health/doctors');
	});
});

describe('storageOverlaps — the measured data-loss guard', () => {
	const at = (name, p, base = 'workspace') => ({ name, path: p, base });

	test('sibling folders are fine', () => {
		assert.deepEqual(storageOverlaps([at('a', 'data/health/doctors'), at('b', 'data/health/visits')]), []);
	});

	test('a collection nested INSIDE another is refused', () => {
		const p = storageOverlaps([at('outer', 'data/health'), at('inner', 'data/health/doctors')]);
		assert.equal(p.length, 1);
		assert.match(p[0], /"inner".*INSIDE "outer"/);
	});

	// The reason the test is segment-wise: these two share a string prefix and must NOT flag.
	test('a shared string prefix that is not a path prefix is fine', () => {
		assert.deepEqual(storageOverlaps([at('a', 'data/health'), at('b', 'data/health-notes')]), []);
	});

	test('runtime and workspace paths never collide with each other', () => {
		assert.deepEqual(storageOverlaps([at('a', 'collections', 'runtime'), at('b', 'collections/health', 'workspace')]), []);
	});

	test('the engine\'s own core collections do not overlap', () => {
		const core = ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'collection-templates', 'modules']
			.map((k) => at(k, k, 'runtime'))
			.concat([at('users', 'data/users'), at('repos', 'data/repos')]);
		assert.deepEqual(storageOverlaps(core), []);
	});
});
