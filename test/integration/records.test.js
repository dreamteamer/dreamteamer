// Tier 2 — the record verbs from the parity table in CLAUDE.md, through the real store and CLI.
//
// The invariant every one of these asserts is "nothing was written": a rejected write must leave NO
// partial state. That is the promise the whole hard-validation design rests on, and it is the one that
// is cheapest to break by accident.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, tree, readFile } from '../helpers/ws.js';

const TASKS = {
	id: { generate: '{{ title | slug }}', pattern: '^[a-z0-9-]+$' },
	storage: { suffix: 'task' },
	schema: {
		type: 'object',
		required: ['title', 'status'],
		properties: {
			title: { type: 'string' },
			status: { type: 'string', enum: ['todo', 'doing', 'done'], default: 'todo' },
			due: { type: 'string', format: 'date' },
			owner: { type: 'string', 'x-reference': 'people' },
			tags: { type: 'array', items: { type: 'string' } },
			body: { type: 'string', format: 'markdown', 'x-body': true },
		},
	},
};
const PEOPLE = simpleCollection({ storage: { suffix: 'person' } });

const base = (extra = {}) => workspace({ collections: { tasks: TASKS, people: PEOPLE, ...extra } });

describe('add', () => {
	test('generates the id, materializes defaults and writes the file', () => {
		const ws = base();
		const { id } = ws.store.add('tasks', { title: 'Fix Login' });
		assert.equal(id, 'fix-login');
		const { fields } = ws.store.read('tasks', id);
		assert.equal(fields.status, 'todo', 'the schema default must materialize');
		assert.ok(readFile(ws.root, 'data/tasks/fix-login.task.md'));
	});

	test('an explicit --id wins over the template', () => {
		const ws = base();
		assert.equal(ws.store.add('tasks', { title: 'Fix Login' }, { id: 'custom' }).id, 'custom');
	});

	test('a body field becomes the markdown body, not frontmatter', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T', body: 'the prose' });
		const text = readFile(ws.root, 'data/tasks/t.task.md');
		assert.match(text, /^---\n[\s\S]*\n---\nthe prose\n$/);
		assert.doesNotMatch(text, /body:/);
	});

	test('a duplicate id is refused', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		assert.throws(() => ws.store.add('tasks', { title: 'T' }), /already exists/);
	});
});

describe('hard validation — nothing was written', () => {
	const cases = [
		['an unknown field', { title: 'T', assinee: 'x' }, /unknown field\(s\).*assinee/],
		['a bad enum value', { title: 'T', status: 'nope' }, /not in enum/],
		['a missing required field', { status: 'todo' }, /required/],
		['a dangling reference', { title: 'T', owner: 'people/ghost' }, /dangling reference/],
		['a malformed reference', { title: 'T', owner: 'ghost' }, /is not <collection>\/<id>/],
		['a reference to the wrong collection', { title: 'T', owner: 'tasks/x' }, /must target collection "people"/],
	];

	for (const [label, fields, re] of cases) {
		test(`${label} is rejected and leaves no file`, () => {
			const ws = base();
			assert.throws(() => ws.store.add('tasks', fields), re);
			assert.deepEqual(tree(ws.root, 'data/tasks'), []);
		});
	}

	test('an id that misses id.pattern is rejected', () => {
		const ws = base();
		assert.throws(() => ws.store.add('tasks', { title: 'T' }, { id: 'Not Legal' }), /does not match pattern/);
		assert.deepEqual(tree(ws.root, 'data/tasks'), []);
	});

	// review finding 1: an escaping `--id` wrote a record OUTSIDE the repo and orphaned others inside
	// it. Two independent gates catch it — `id.pattern` (when the descriptor declares one) and
	// `assertSafeId` (always) — so both are exercised.
	test('an escaping id is refused by id.pattern when one is declared', () => {
		const ws = base();
		assert.throws(() => ws.store.add('tasks', { title: 'T' }, { id: '../../escaped' }), /does not match pattern/);
		assert.equal(readFile(ws.root, '../escaped.task.md'), null);
	});

	test('an escaping id is refused by assertSafeId even with NO pattern declared', () => {
		const ws = workspace({ collections: { loose: simpleCollection({ storage: { suffix: 'loose' } }) } });
		assert.throws(() => ws.store.add('loose', { name: 'T' }, { id: '../../escaped' }), /invalid id/);
		assert.equal(readFile(ws.root, '../escaped.loose.md'), null);
		assert.equal(readFile(ws.root, '../../escaped.loose.md'), null);
	});
});

describe('set', () => {
	test('merges changes and keeps the rest', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T', due: '2026-07-28' });
		ws.store.set('tasks', 't', { status: 'doing' });
		const { fields } = ws.store.read('tasks', 't');
		assert.equal(fields.status, 'doing');
		assert.equal(fields.due, '2026-07-28');
	});

	test('an empty value REMOVES the field', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T', due: '2026-07-28' });
		ws.store.set('tasks', 't', { due: '' });
		assert.equal(ws.store.read('tasks', 't').fields.due, undefined);
	});

	test('an invalid change leaves the file byte-identical', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		const before = readFile(ws.root, 'data/tasks/t.task.md');
		assert.throws(() => ws.store.set('tasks', 't', { status: 'nope' }), /not in enum/);
		assert.equal(readFile(ws.root, 'data/tasks/t.task.md'), before);
	});
});

describe('rm', () => {
	test('refuses while an inbound reference exists, and --force overrides', () => {
		const ws = base();
		ws.store.add('people', { name: 'Ada' });
		ws.store.add('tasks', { title: 'T', owner: 'people/ada' });
		assert.throws(() => ws.store.rm('people', 'ada'), /is referenced by/);
		assert.ok(readFile(ws.root, 'data/people/ada.person.md'));

		ws.store.rm('people', 'ada', { force: true });
		assert.equal(readFile(ws.root, 'data/people/ada.person.md'), null);
	});

	test('an unreferenced record removes cleanly', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		ws.store.rm('tasks', 't');
		assert.deepEqual(tree(ws.root, 'data/tasks'), []);
	});
});

describe('rename', () => {
	test('moves the file and rewrites inbound frontmatter references in one go', () => {
		const ws = base();
		ws.store.add('people', { name: 'Ada' });
		ws.store.add('tasks', { title: 'T', owner: 'people/ada' });

		const out = ws.store.rename('people', 'ada', 'ada-l');
		assert.equal(out.rewrites, 1);
		assert.equal(ws.store.read('tasks', 't').fields.owner, 'people/ada-l');
		assert.equal(readFile(ws.root, 'data/people/ada.person.md'), null);
	});

	// decision 7: prose is rewritten ONLY inside wikilinks, because raw-text replacement corrupted
	// look-alike URLs. A raw prose mention is counted and reported, never touched.
	test('a [[wikilink]] in a body is rewritten but a raw prose mention is not', () => {
		const ws = base();
		ws.store.add('people', { name: 'Ada' });
		ws.store.add('tasks', { title: 'T', body: 'see [[people/ada]] and people/ada raw' });
		ws.store.rename('people', 'ada', 'ada-l');
		const body = readFile(ws.root, 'data/tasks/t.task.md');
		assert.match(body, /\[\[people\/ada-l\]\]/);
		assert.match(body, /people\/ada raw/, 'the raw prose mention must be left alone');
	});

	test('renaming to an existing id is refused', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'A' });
		ws.store.add('tasks', { title: 'B' });
		assert.throws(() => ws.store.rename('tasks', 'a', 'b'), /already exists/);
	});
});

describe('list — sort and filter', () => {
	const seeded = () => {
		const ws = base();
		ws.store.add('tasks', { title: 'A', status: 'todo', due: '2026-07-03' });
		ws.store.add('tasks', { title: 'B', status: 'done', due: '2026-07-01' });
		ws.store.add('tasks', { title: 'C', status: 'todo', due: '2026-07-02' });
		return ws;
	};

	test('--sort orders by a field, and a leading minus reverses', () => {
		const ws = seeded();
		const asc = JSON.parse(ws.dt('list', 'tasks', '--sort', 'due', '--json').stdout);
		assert.deepEqual(asc.map((r) => r.id), ['b', 'c', 'a']);
		const desc = JSON.parse(ws.dt('list', 'tasks', '--sort', '-due', '--json').stdout);
		assert.deepEqual(desc.map((r) => r.id), ['a', 'c', 'b']);
	});

	test('--where takes the studio operator set', () => {
		const ws = seeded();
		const res = ws.dt('list', 'tasks', '--where', '{"status":{"_eq":"todo"}}', '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(JSON.parse(res.stdout).map((r) => r.id).sort(), ['a', 'c']);
	});

	test('--where with a date range compares as instants', () => {
		const ws = seeded();
		const res = ws.dt('list', 'tasks', '--where', '{"due":{"_gte":"2026-07-02"}}', '--json');
		assert.deepEqual(JSON.parse(res.stdout).map((r) => r.id).sort(), ['a', 'c']);
	});

	// An ENUM already declares the vocabulary, so that is what a filter dropdown should offer — offering
	// only the values currently present would hide a legal choice nobody has used yet.
	test('values on an enum field reports the declared vocabulary', () => {
		const ws = seeded();
		const res = ws.dt('values', 'tasks', 'status', '--json');
		assert.equal(res.code, 0, res.stderr);
		const out = JSON.parse(res.stdout);
		assert.equal(out.collection, 'tasks');
		assert.equal(out.field, 'status');
		assert.equal(out.source, 'enum');
		assert.deepEqual(out.values.map((v) => v.value).sort(), ['doing', 'done', 'todo']);
	});

	test('values on a free field reports what the DATA uses, with counts', () => {
		const ws = seeded();
		ws.store.add('tasks', { title: 'D', due: '2026-07-03' }); // a duplicate of A's due date
		const out = JSON.parse(ws.dt('values', 'tasks', 'due', '--json').stdout);
		assert.equal(out.source, 'data');
		assert.deepEqual(out.values.map((v) => v.value).sort(), ['2026-07-01', '2026-07-02', '2026-07-03']);
		assert.equal(out.values.find((v) => v.value === '2026-07-03').count, 2);
	});
});

describe('history, diff and revert', () => {
	test('history lists revisions newest-first and revert restores content', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		ws.git(['add', '-A']);
		ws.git(['commit', '-qm', 'add t']);
		const firstSha = ws.git(['rev-parse', 'HEAD']);

		ws.store.set('tasks', 't', { status: 'done' });
		ws.git(['add', '-A']);
		ws.git(['commit', '-qm', 'set t']);

		const hist = JSON.parse(ws.dt('history', 'tasks/t', '--json').stdout);
		assert.ok(hist.length >= 2, 'both commits should appear');

		assert.equal(ws.store.read('tasks', 't').fields.status, 'done');
		ws.store.revert('tasks', 't', firstSha);
		assert.equal(ws.store.read('tasks', 't').fields.status, 'todo');
	});

	// Tightened from a two-alternative regex that would have passed on either message: assert the exact
	// sentence AND that the file is byte-identical afterwards, which is the claim that matters.
	test('revert against a sha with no content for the record refuses, and changes nothing', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		const before = readFile(ws.root, 'data/tasks/t.task.md');
		assert.throws(
			() => ws.store.revert('tasks', 't', 'HEAD'),
			/no content at HEAD for data\/tasks\/t\.task\.md — nothing was reverted\./,
		);
		assert.equal(readFile(ws.root, 'data/tasks/t.task.md'), before);
	});

	test('revert to the CURRENT content is a reported no-op, not a write', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		ws.git(['add', '-A']);
		ws.git(['commit', '-qm', 'add t']);
		const sha = ws.git(['rev-parse', 'HEAD']);
		const out = ws.store.revert('tasks', 't', sha);
		assert.deepEqual(out, { id: 't', reverted: false });
	});

	test('diff prints the patch one revision applied', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		ws.git(['add', '-A']);
		ws.git(['commit', '-qm', 'add t']);
		const res = ws.dt('diff', 'tasks/t');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /title: T|\+\+\+/);
	});
});

describe('nested ids', () => {
	test('a multi-segment id round-trips through add, get and rm', () => {
		const ws = workspace({
			collections: {
				meetings: {
					id: { generate: '{{ date }}/{{ title | slug }}' },
					storage: { suffix: 'meeting' },
					schema: {
						type: 'object', required: ['title', 'date'],
						properties: { title: { type: 'string' }, date: { type: 'string' } },
					},
				},
			},
		});
		const { id } = ws.store.add('meetings', { title: 'Kickoff', date: '2026/07' });
		assert.equal(id, '2026/07/kickoff');
		assert.ok(readFile(ws.root, 'data/meetings/2026/07/kickoff.meeting.md'));
		assert.equal(ws.store.read('meetings', id).fields.title, 'Kickoff');

		ws.store.rm('meetings', id);
		// the now-empty date folders are pruned rather than left behind
		assert.deepEqual(tree(ws.root, 'data/meetings'), []);
	});
});

describe('system-stored collections are read-only through the store', () => {
	test('writing one refuses and says where to edit instead', () => {
		const ws = base();
		assert.throws(() => ws.store.add('collections', { name: 'x' }), /are compiled sources — edit/);
	});

	test('the CLI refuses too', () => {
		const ws = base();
		const res = ws.dt('set', 'collections/tasks', 'icon=star');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /compiled sources/);
	});
});

describe('commit and changes', () => {
	test('commit publishes pending writes and changes reports them', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		assert.notEqual(ws.git(['status', '--porcelain', 'data']), '');

		const res = ws.dt('commit', '-m', 'publish');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(ws.git(['status', '--porcelain', 'data']), '');

		const changes = JSON.parse(ws.dt('changes', '--json').stdout);
		assert.ok(changes.events.some((e) => e.collection === 'tasks' && e.id === 't'));
	});

	test('--dry-run changes nothing', () => {
		const ws = base();
		ws.store.add('tasks', { title: 'T' });
		const before = ws.git(['rev-parse', 'HEAD']);
		assert.equal(ws.dt('commit', '--dry-run').code, 0);
		assert.equal(ws.git(['rev-parse', 'HEAD']), before);
		assert.notEqual(ws.git(['status', '--porcelain', 'data']), '');
	});

	test('nothing pending is reported, not invented', () => {
		const ws = base();
		ws.git(['add', '-A']);
		ws.git(['commit', '-qm', 'clean']);
		assert.match(ws.dt('commit').stdout, /nothing pending/);
	});
});
