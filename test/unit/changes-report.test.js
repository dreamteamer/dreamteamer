// The record-change report (0.42.0): what `dt changes` and `dt commit` print, and what a session
// appends to its reply after a write. Pure functions — the fold of the committed half into the
// pending half, the grouping by collection AND layer, and the one report line.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { foldChanges, groupChanges, reportLine } from '../../src/events.js';

const ch = (ref, change, extra = {}) => {
	const at = ref.indexOf('/');
	const collection = ref.slice(0, at);
	const id = ref.slice(at + 1);
	return { collection, id, ref, path: `data/${collection}/${id}.md`, repo: '.', layer: null, change, ...extra };
};
const brief = (list) => list.map((c) => [c.ref, c.change, c.committed]);

describe('foldChanges — the committed half folded into the pending half', () => {
	test('a pending change alone is uncommitted; a committed one alone is committed', () => {
		assert.deepEqual(brief(foldChanges([ch('contacts/dana-oren', 'updated')], [ch('contacts/sam-diaz', 'created')])), [
			['contacts/dana-oren', 'updated', true],
			['contacts/sam-diaz', 'created', false],
		]);
	});

	test('created in the window and deleted since: the record never existed at either end, so it is not reported', () => {
		assert.deepEqual(foldChanges([ch('contacts/sam-diaz', 'created')], [ch('contacts/sam-diaz', 'deleted')]), []);
	});

	test('created in the window and edited since is still CREATED, and uncommitted', () => {
		assert.deepEqual(brief(foldChanges([ch('contacts/sam-diaz', 'created')], [ch('contacts/sam-diaz', 'updated')])), [['contacts/sam-diaz', 'created', false]]);
	});

	test('deleted in the window and re-created since reads UPDATED', () => {
		assert.deepEqual(brief(foldChanges([ch('contacts/sam-diaz', 'deleted')], [ch('contacts/sam-diaz', 'created')])), [['contacts/sam-diaz', 'updated', false]]);
	});

	test('a MOVE inside one half — one ref deleted at one path and created at another — is one update at the live path', () => {
		const out = foldChanges([], [
			ch('meetings/kickoff', 'created', { path: 'data/companies/northwind/meetings/kickoff.meeting.md' }),
			ch('meetings/kickoff', 'deleted', { path: 'data/meetings/kickoff.meeting.md' }),
		]);
		assert.deepEqual(brief(out), [['meetings/kickoff', 'updated', false]]);
		assert.equal(out[0].path, 'data/companies/northwind/meetings/kickoff.meeting.md');
	});

	test('the same ref in two repos is two records — a layer\'s copy is not folded into the workspace\'s', () => {
		const out = foldChanges([], [ch('tasks/kickoff', 'updated'), ch('tasks/kickoff', 'created', { repo: 'git_modules/project-a', layer: 'project-a' })]);
		assert.equal(out.length, 2);
	});

	test('ordered by collection, then layer (the workspace first), then id', () => {
		const out = foldChanges([], [
			ch('tasks/b', 'created', { repo: 'git_modules/project-a', layer: 'project-a' }),
			ch('tasks/c', 'created'),
			ch('contacts/z', 'deleted'),
			ch('tasks/a', 'created'),
		]);
		assert.deepEqual(out.map((c) => `${c.ref}@${c.layer ?? '-'}`), ['contacts/z@-', 'tasks/a@-', 'tasks/c@-', 'tasks/b@project-a']);
	});
});

describe('groupChanges and reportLine — the line a reply ends with', () => {
	const changes = foldChanges([], [
		ch('contacts/sam-diaz', 'created'),
		ch('contacts/dana-oren', 'updated'),
		ch('contacts/harbor-mutual-desk', 'updated'),
		ch('meetings/2026/10/kickoff', 'deleted'),
		ch('issues/login-times-out', 'created', { repo: 'git_modules/project-a', layer: 'project-a' }),
		ch('issues/report-is-empty', 'updated'),
	]);

	test('one group per collection AND layer, with counts per verb', () => {
		assert.deepEqual(groupChanges(changes).map(({ records, ...g }) => [g, records.length]), [
			[{ collection: 'contacts', layer: null, created: 1, updated: 2, deleted: 0 }, 3],
			[{ collection: 'issues', layer: null, created: 0, updated: 1, deleted: 0 }, 1],
			[{ collection: 'issues', layer: 'project-a', created: 1, updated: 0, deleted: 0 }, 1],
			[{ collection: 'meetings', layer: null, created: 0, updated: 0, deleted: 1 }, 1],
		]);
	});

	test('the line: counts in a fixed order (created, updated, deleted), zero omitted, a layer write named after its collection', () => {
		assert.equal(reportLine(groupChanges(changes)),
			'records — contacts: 1 created, 2 updated · issues: 1 updated · issues (project-a): 1 created · meetings: 1 deleted');
	});

	test('nothing changed: no groups, and an empty line rather than a report of nothing', () => {
		assert.deepEqual(groupChanges([]), []);
		assert.equal(reportLine([]), '');
	});
});
