// Tier 1 — the pure half of relationship-based storage: the path rules the store, check and events
// all read through. The behaviour over a real workspace is test/integration/placement.test.js; this
// file pins the three functions that decide WHERE without touching disk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { subpathProblem, placedRoot, placementOfFile, placedChildAt, ownerIdOf } from '../../src/placement.js';
import { pathToRecord } from '../../src/events.js';
import { parseRef } from '../../src/namespace.js';

// the RESOLVED placement (`storageOf(d).under`): the authored parent field and subfolder, plus the
// parent collection compile records in `compiled.under_collection`
const UNDER = { parent: 'company', subfolder: 'meetings', collection: 'companies' };
const placed = (name, storage, parent) => ({ name, storage, compiled: parent ? { under_collection: parent } : {} });
const descriptors = new Map([
	['companies', placed('companies', { path: 'data/companies', shape: 'folder', entry: 'company.md', suffix: 'company', format: 'md' })],
	['meetings', placed('meetings', { path: 'data/meetings', suffix: 'meeting', format: 'md', under: { parent: 'company', subfolder: 'meetings' } }, 'companies')],
	['contacts', placed('contacts', { path: 'data/contacts', suffix: 'contact', format: 'md', under: { parent: 'company', subfolder: 'people/contacts' } }, 'companies')],
]);

describe('subpathProblem', () => {
	test('accepts a relative folder, one or several segments deep', () => {
		for (const p of ['meetings', 'people/contacts', 'a-b/c_d']) assert.equal(subpathProblem(p), null, p);
	});
	test('refuses what assertSafeId refuses: absolute, traversal, empty segments, backslashes, nothing', () => {
		for (const p of ['/meetings', '../x', 'a/../b', 'a//b', './a', 'a\\b', '', undefined, 42]) assert.ok(subpathProblem(p), `${p} must be refused`);
	});
});

describe('placedRoot ⟷ placementOfFile', () => {
	const fallback = '/ws/data/meetings';
	const parent = '/ws/data/companies';
	test('an owner puts the record inside the parent folder; no owner, the fallback root', () => {
		assert.equal(placedRoot(UNDER, fallback, parent, 'northwind'), path.join(parent, 'northwind', 'meetings'));
		assert.equal(placedRoot(UNDER, fallback, parent, null), fallback);
	});
	test('a file maps back to the root it sits under, and to nothing outside both', () => {
		assert.deepEqual(placementOfFile(UNDER, path.join(parent, 'northwind/meetings/2026/10/kickoff.meeting.md'), fallback, parent), { root: path.join(parent, 'northwind/meetings'), parentId: 'northwind' });
		assert.deepEqual(placementOfFile(UNDER, path.join(fallback, '2026/10/offsite.meeting.md'), fallback, parent), { root: fallback, parentId: null });
		assert.equal(placementOfFile(UNDER, '/ws/data/tasks/x.task.md', fallback, parent), null);
		// a sibling root that merely shares a prefix is not inside
		assert.equal(placementOfFile(UNDER, '/ws/data/meetings-archive/x.meeting.md', fallback, parent), null);
	});
});

describe('ownerIdOf', () => {
	const parse = (v) => parseRef(v, []);
	test('reads the parent id off a qualified reference, and nothing off an empty or foreign one', () => {
		assert.equal(ownerIdOf({ company: 'companies/northwind' }, UNDER, parse), 'northwind');
		assert.equal(ownerIdOf({}, UNDER, parse), null);
		assert.equal(ownerIdOf({ company: '' }, UNDER, parse), null);
		assert.equal(ownerIdOf({ company: 'tasks/x' }, UNDER, parse), null, 'a reference to another collection owns nothing');
	});
});

describe('pathToRecord inside a parent folder', () => {
	test('the entry file is the parent; a file in a declared child folder is the child; anything else is nothing', () => {
		assert.deepEqual(pathToRecord(descriptors, 'data/companies/northwind/company.md'), { collection: 'companies', id: 'northwind' });
		assert.deepEqual(pathToRecord(descriptors, 'data/companies/northwind/meetings/2026/10/kickoff.meeting.md'), { collection: 'meetings', id: '2026/10/kickoff' });
		assert.deepEqual(pathToRecord(descriptors, 'data/companies/northwind/people/contacts/ada.contact.md'), { collection: 'contacts', id: 'ada' });
		assert.equal(pathToRecord(descriptors, 'data/companies/northwind/meetings/2026/10/kickoff.contact.md'), null, 'the wrong suffix in a child folder is not a record');
		assert.equal(pathToRecord(descriptors, 'data/companies/northwind/notes.md'), null, 'a loose file beside the entry is not a record');
		assert.equal(pathToRecord(descriptors, 'data/companies/northwind/deep/company.md'), null, 'the entry name deeper down is not the parent record');
		assert.deepEqual(pathToRecord(descriptors, 'data/meetings/2026/10/offsite.meeting.md'), { collection: 'meetings', id: '2026/10/offsite' }, 'the fallback root is untouched');
	});
	test('placedChildAt alone, for a caller that already knows the parent', () => {
		assert.deepEqual(placedChildAt(descriptors, 'companies', 'harbor/meetings/2026/10/review.meeting.md'), { collection: 'meetings', id: '2026/10/review' });
		assert.equal(placedChildAt(descriptors, 'companies', 'harbor'), null);
	});
});
