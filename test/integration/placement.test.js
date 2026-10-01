// Tier 2 — relationship-based storage: a collection whose records live UNDER the record they
// belong to. `storage.under: { field, path }` on the CHILD says "a meeting with a `company` lives in
// that company's folder, in `meetings/`"; one without a company stays in the collection's own root.
//
// The contract this file holds:
//   - ONE logical collection. `dt list meetings` is the union across every company folder and the
//     fallback root; a reference is `meetings/<id>` wherever the file sits.
//   - the id is INDEPENDENT of placement. Changing a meeting's company moves its file and nothing
//     else — not its id, not a single inbound reference.
//   - conventional storage is untouched: no `under`, no change (every other tier-2 file is that proof).
//
// Invented names throughout — this engine is published and the vault it is dogfooded on is not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { workspace, writeCollection, compileError, readFile, tree } from '../helpers/ws.js';
const require = createRequire(import.meta.url);

// The PARENT: a folder-shape collection, one folder per company, `company.md` as its entry file.
const COMPANIES = {
	id: { generate: '{{ name | slug }}' },
	storage: { shape: 'folder', entry: 'company.md', suffix: 'company', codec: 'md' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' }, notes: { type: 'string', format: 'markdown', 'x-body': true } },
	},
};

// The CHILD: a dated, path-shaped id (`2026/10/kickoff`), the shape a real meetings collection has,
// so the test proves the id survives placement with its slashes intact.
const MEETINGS = {
	id: { generate: '{{ when }}/{{ name | slug }}' },
	storage: { suffix: 'meeting', under: { field: 'company', path: 'meetings' } },
	schema: {
		type: 'object',
		required: ['name', 'when'],
		properties: {
			name: { type: 'string' },
			when: { type: 'string' },
			company: { type: 'string', 'x-reference': 'companies' },
			notes: { type: 'string', format: 'markdown', 'x-body': true },
		},
	},
};

// A third collection that points AT meetings — the inbound reference a move must leave intact.
const TASKS = {
	id: { generate: '{{ name | slug }}' },
	storage: { suffix: 'task' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: { name: { type: 'string' }, meeting: { type: 'string', 'x-reference': 'meetings' } },
	},
};

const placed = (extra = {}) => workspace({ collections: { companies: COMPANIES, meetings: MEETINGS, tasks: TASKS }, ...extra });

/** Two companies, one meeting each, one meeting with no company. */
function seeded() {
	const ws = placed();
	ws.store.add('companies', { name: 'Northwind' });
	ws.store.add('companies', { name: 'Harbor' });
	ws.store.add('meetings', { name: 'Kickoff', when: '2026/10', company: 'companies/northwind' });
	ws.store.add('meetings', { name: 'Review', when: '2026/10', company: 'companies/harbor' });
	ws.store.add('meetings', { name: 'Offsite', when: '2026/10' });
	return ws;
}

const KICKOFF = 'data/companies/northwind/meetings/2026/10/kickoff.meeting.md';
const REVIEW = 'data/companies/harbor/meetings/2026/10/review.meeting.md';
const OFFSITE = 'data/meetings/2026/10/offsite.meeting.md';

describe('declaring storage.under', () => {
	test('compiles, derives the parent collection, and the compiled descriptor passes check', () => {
		const ws = placed();
		const d = ws.store.descriptor('meetings');
		assert.deepEqual(d.storage.under, { field: 'company', path: 'meetings', collection: 'companies' });
		assert.equal(d.storage.path, 'data/meetings', 'the fallback root is still the ordinary one');
		// ⚠ The 0.25.0 lesson: a descriptor shape compile accepts must ALSO pass the meta-schema `check`
		// validates compiled descriptors against. Walk the validator, not only the generator.
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	const refused = (patch, parentPatch = {}) => {
		const ws = workspace({ compile: false });
		writeCollection(ws.root, 'companies', { ...COMPANIES, ...parentPatch });
		writeCollection(ws.root, 'tasks', patch.extra?.tasks ?? TASKS);
		writeCollection(ws.root, 'meetings', { ...MEETINGS, storage: { ...MEETINGS.storage, ...patch.storage }, schema: patch.schema ?? MEETINGS.schema });
		for (const [name, d] of Object.entries(patch.extra ?? {})) writeCollection(ws.root, name, d);
		return compileError(ws.ws);
	};

	test('the field must be a single-target scalar reference', () => {
		assert.match(refused({ storage: { under: { field: 'name', path: 'meetings' } } }), /under\.field "name".*not a reference/s);
		assert.match(refused({ storage: { under: { field: 'nope', path: 'meetings' } } }), /under\.field "nope".*no such field/s);
		const union = structuredClone(MEETINGS.schema);
		union.properties.company['x-reference'] = ['companies', 'tasks'];
		assert.match(refused({ storage: {}, schema: union }), /under\.field "company".*exactly one collection/s);
		const list = structuredClone(MEETINGS.schema);
		list.properties.company = { type: 'array', items: { type: 'string', 'x-reference': 'companies' } };
		assert.match(refused({ storage: {}, schema: list }), /under\.field "company".*scalar/s);
	});

	test('the parent must be a folder-shape collection', () => {
		assert.match(refused({ storage: {} }, { storage: { suffix: 'company' } }), /"companies" is not shape: folder/);
	});

	test('the child must be a file-shape text record', () => {
		assert.match(refused({ storage: { codec: 'file' } }), /codec: file/);
		assert.match(refused({ storage: { shape: 'folder', entry: 'meeting.md' } }), /shape: folder/);
	});

	test('the path is a safe relative subfolder and never the parent entry', () => {
		assert.match(refused({ storage: { under: { field: 'company', path: '../meetings' } } }), /under\.path/);
		assert.match(refused({ storage: { under: { field: 'company', path: '/meetings' } } }), /under\.path/);
		assert.match(refused({ storage: { under: { field: 'company', path: 'company.md' } } }), /entry file/);
		assert.match(refused({ storage: { under: { field: 'company' } } }), /under\.path/);
		assert.match(refused({ storage: { under: { field: 'company', path: 'meetings', mode: 'x' } } }), /unknown key/);
	});

	test('one level only: a placed collection cannot itself be a parent, and siblings cannot share a path', () => {
		const NESTED = {
			id: { generate: '{{ name | slug }}' },
			storage: { suffix: 'note', under: { field: 'meeting', path: 'notes' } },
			schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, meeting: { type: 'string', 'x-reference': 'meetings' } } },
		};
		assert.match(refused({ storage: {}, extra: { notes: NESTED } }), /"meetings" is itself stored under/);
		const SIBLING = { ...TASKS, storage: { suffix: 'task', under: { field: 'company', path: 'meetings' } } };
		SIBLING.schema = { ...TASKS.schema, properties: { ...TASKS.schema.properties, company: { type: 'string', 'x-reference': 'companies' } } };
		assert.match(refused({ storage: {}, extra: { tasks: SIBLING } }), /both store records under companies\/<id>\/meetings/);
	});
});

describe('reading one logical collection across every folder', () => {
	test('a record with an owner lands in its folder; one without stays in the fallback root', () => {
		const ws = seeded();
		assert.deepEqual(tree(ws.root, 'data').filter((p) => p.includes('meeting')), [KICKOFF, REVIEW, OFFSITE].sort());
	});

	test('list is the union, ordered by id; get and read resolve the real file', () => {
		const ws = seeded();
		assert.deepEqual([...ws.store.ids('meetings').keys()], ['2026/10/kickoff', '2026/10/offsite', '2026/10/review']);
		assert.equal(path.relative(ws.root, ws.store.read('meetings', '2026/10/kickoff').file), KICKOFF);
		assert.equal(path.relative(ws.root, ws.store.read('meetings', '2026/10/offsite').file), OFFSITE);
		const res = ws.dt('list', 'meetings');
		assert.equal(res.code, 0, res.stderr);
		for (const id of ['2026/10/kickoff', '2026/10/review', '2026/10/offsite']) assert.match(res.stdout, new RegExp(id));
		assert.equal(ws.dt('get', 'meetings/2026/10/review').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('the index is fresh across a Store that saw neither write', () => {
		// a second process (here: a second Store) must see a record another process placed under a
		// company whose folder did not exist when the first Store was built
		const ws = seeded();
		ws.dt('add', 'companies', '--name', 'Acme');
		ws.dt('add', 'meetings', '--name', 'Intro', '--when', '2026/11', '--company', 'companies/acme');
		assert.ok(ws.store.ids('meetings').has('2026/11/intro'));
	});

	test('the same id in two places is a check violation and an add refusal, never last-one-wins', () => {
		const ws = seeded();
		fs.mkdirSync(path.join(ws.root, 'data/meetings/2026/10'), { recursive: true });
		fs.copyFileSync(path.join(ws.root, KICKOFF), path.join(ws.root, 'data/meetings/2026/10/kickoff.meeting.md'));
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /holds the id "2026\/10\/kickoff" twice/);
		const add = ws.dt('add', 'meetings', '--id', '2026/10/kickoff', '--name', 'Again', '--when', '2026/10');
		assert.equal(add.code, 1);
		assert.match(add.stderr, /already exists/);
	});
});

describe('the owner field moves the file; nothing else does', () => {
	test('set <owner> moves the record to the new parent — same id, inbound refs untouched, old folder pruned', () => {
		const ws = seeded();
		ws.store.add('tasks', { name: 'Follow up', meeting: 'meetings/2026/10/kickoff' });
		const res = ws.dt('set', 'meetings/2026/10/kickoff', 'company=companies/harbor');
		assert.equal(res.code, 0, res.stderr);
		const moved = 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md';
		assert.ok(readFile(ws.root, moved), 'the file is in the new owner\'s folder');
		assert.equal(readFile(ws.root, KICKOFF), null, 'and gone from the old one');
		assert.equal(fs.existsSync(path.join(ws.root, 'data/companies/northwind/meetings')), false, 'the emptied meetings/ folder went with it');
		assert.ok(fs.existsSync(path.join(ws.root, 'data/companies/northwind/company.md')), 'the parent record itself is untouched');
		assert.equal(ws.store.read('tasks', 'follow-up').fields.meeting, 'meetings/2026/10/kickoff', 'the reference did not change — the id is not the path');
		assert.equal(ws.dt('check').code, 0);
	});

	test('clearing the owner moves the record back to the fallback root', () => {
		const ws = seeded();
		assert.equal(ws.dt('set', 'meetings/2026/10/kickoff', 'company=').code, 0);
		assert.ok(readFile(ws.root, 'data/meetings/2026/10/kickoff.meeting.md'));
		assert.equal(readFile(ws.root, KICKOFF), null);
		assert.equal(ws.dt('check').code, 0);
	});

	test('editing another field leaves a mis-placed file where it is, and check keeps saying so', () => {
		const ws = seeded();
		// a hand move: the file now sits under harbor while its field still says northwind
		const wrong = path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md');
		fs.mkdirSync(path.dirname(wrong), { recursive: true });
		fs.renameSync(path.join(ws.root, KICKOFF), wrong);
		const before = ws.dt('check');
		assert.equal(before.code, 1);
		assert.match(before.stdout, /placed under companies\/harbor but company is companies\/northwind.*dreamteamer relocate meetings\/2026\/10\/kickoff/);
		assert.equal(ws.dt('set', 'meetings/2026/10/kickoff', 'name=Kickoff II').code, 0);
		assert.ok(fs.existsSync(wrong), 'a non-owner edit does not relocate as a side effect');
		assert.equal(ws.dt('check').code, 1, 'still reported, until relocate is asked');
	});

	test('a write to an id two files claim is refused before anything is written', () => {
		// the only way a move can find its destination occupied is a duplicate id — and a write to
		// EITHER copy would leave the other saying something else, so the refusal is on the id
		const ws = seeded();
		fs.mkdirSync(path.join(ws.root, 'data/companies/harbor/meetings/2026/10'), { recursive: true });
		fs.copyFileSync(path.join(ws.root, KICKOFF), path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md'));
		for (const args of [['set', 'meetings/2026/10/kickoff', 'company=companies/harbor'], ['rm', 'meetings/2026/10/kickoff'], ['rename', 'meetings/2026/10/kickoff', '2026/10/k2']]) {
			const res = ws.dt(...args);
			assert.equal(res.code, 1, args.join(' '));
			assert.match(res.stderr, /is held by 2 files .*harbor.*northwind.*Remove one/s);
		}
		assert.match(readFile(ws.root, KICKOFF), /company: companies\/northwind/, 'the source file is as it was');
		assert.equal(ws.dt('list', 'meetings').code, 0, 'reads still answer — only writes refuse');
	});

	test('rm prunes the emptied folder under the parent and nothing above it', () => {
		const ws = seeded();
		assert.equal(ws.dt('rm', 'meetings/2026/10/review').code, 0);
		assert.equal(fs.existsSync(path.join(ws.root, 'data/companies/harbor/meetings')), false);
		assert.ok(fs.existsSync(path.join(ws.root, 'data/companies/harbor/company.md')));
	});

	test('rename keeps the record in the folder it is in', () => {
		const ws = seeded();
		assert.equal(ws.dt('rename', 'meetings/2026/10/kickoff', '2026/10/kickoff-day').code, 0);
		assert.ok(readFile(ws.root, 'data/companies/northwind/meetings/2026/10/kickoff-day.meeting.md'));
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('the parent record', () => {
	test('cannot be removed while records live inside its folder — not even with --force', () => {
		const ws = seeded();
		const res = ws.dt('rm', 'companies/northwind', '--force');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /holds records of other collections inside its folder/);
		assert.match(res.stderr, /1 meetings record\(s\) under meetings\//);
		assert.ok(fs.existsSync(path.join(ws.root, KICKOFF)), 'nothing was removed');
		// reassign the one meeting away, and the removal is ordinary
		assert.equal(ws.dt('set', 'meetings/2026/10/kickoff', 'company=companies/harbor').code, 0);
		assert.equal(ws.dt('rm', 'companies/northwind').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('rename moves the folder with its records inside, rewrites their owner field, and keeps every child id', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'companies/northwind', 'northwind-plc');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, 'data/companies/northwind-plc/meetings/2026/10/kickoff.meeting.md'));
		assert.deepEqual([...ws.store.ids('meetings').keys()], ['2026/10/kickoff', '2026/10/offsite', '2026/10/review']);
		assert.equal(ws.store.read('meetings', '2026/10/kickoff').fields.company, 'companies/northwind-plc');
		assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
	});
});

describe('git sees the right record', () => {
	test('dt changes maps a file inside a company folder to the meeting, and the entry file to the company', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		const events = JSON.parse(ws.dt('changes', '--json').stdout).events;
		const kickoff = events.find((e) => e.collection === 'meetings' && e.id === '2026/10/kickoff');
		assert.ok(kickoff, JSON.stringify(events));
		assert.equal(kickoff.path, KICKOFF);
		assert.ok(events.find((e) => e.collection === 'companies' && e.id === 'northwind'));
		assert.equal(events.filter((e) => e.collection === 'companies').length, 2, 'the meetings inside a folder are not company events');
	});

	test('dt commit <record> after a move stages both halves and leaves a sibling pending', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		assert.equal(ws.dt('set', 'meetings/2026/10/kickoff', 'company=companies/harbor').code, 0);
		assert.equal(ws.dt('set', 'meetings/2026/10/offsite', 'name=Offsite II').code, 0);
		const res = ws.dt('commit', 'meetings/2026/10/kickoff');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(ws.git(['status', '--porcelain', '--', 'data/companies']), '', 'old path and new path both published');
		assert.match(ws.git(['status', '--porcelain', '--', 'data/meetings']), /offsite/, 'the sibling is exactly as pending as it was');
		assert.equal(ws.dt('commit', 'meetings').code, 0, 'the collection-scoped form reaches records inside parent folders too');
		assert.equal(ws.git(['status', '--porcelain', '--', 'data']), '');
	});

	test('revert restores the owner AND the placement', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		const sha = ws.git(['rev-parse', 'HEAD']);
		assert.equal(ws.dt('set', 'meetings/2026/10/kickoff', 'company=companies/harbor').code, 0);
		assert.equal(ws.dt('commit', '-m', 'moved').code, 0);
		const res = ws.dt('revert', 'meetings/2026/10/kickoff', '--hash', sha);
		assert.equal(res.code, 0, res.stderr);
		assert.ok(readFile(ws.root, KICKOFF), 'back in the historical owner\'s folder');
		assert.equal(fs.existsSync(path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md')), false);
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('dt relocate', () => {
	test('a dry run names the move and changes nothing; apply moves; a second apply is a no-op', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		const wrong = path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md');
		fs.mkdirSync(path.dirname(wrong), { recursive: true });
		fs.renameSync(path.join(ws.root, KICKOFF), wrong);
		assert.equal(ws.dt('commit', '-m', 'hand move').code, 0); // relocate wants a clean source
		const dry = ws.dt('relocate', 'meetings', '--dry-run');
		assert.equal(dry.code, 0, dry.stderr);
		assert.match(dry.stdout, /→ meetings\/2026\/10\/kickoff\s+data\/companies\/harbor\/.*→ data\/companies\/northwind\//);
		assert.ok(fs.existsSync(wrong), 'dry run moved nothing');
		const apply = ws.dt('relocate', 'meetings');
		assert.equal(apply.code, 0, apply.stderr);
		assert.ok(readFile(ws.root, KICKOFF));
		assert.equal(fs.existsSync(wrong), false);
		assert.ok(readFile(ws.root, REVIEW), 'the record that belongs under harbor is untouched');
		assert.equal(ws.dt('check').code, 0);
		const again = ws.dt('relocate', 'meetings');
		assert.equal(again.code, 0);
		assert.match(again.stdout, /nothing to relocate/);
	});

	test('refuses a source with unpublished changes, and an occupied destination', () => {
		const ws = seeded();
		const wrong = path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md');
		fs.mkdirSync(path.dirname(wrong), { recursive: true });
		fs.renameSync(path.join(ws.root, KICKOFF), wrong);
		const dirty = ws.dt('relocate', 'meetings');
		assert.equal(dirty.code, 1);
		assert.match(dirty.stderr, /unpublished changes/);
		assert.ok(fs.existsSync(wrong), 'nothing moved');
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		fs.mkdirSync(path.join(ws.root, 'data/companies/northwind/meetings/2026/10'), { recursive: true });
		fs.copyFileSync(wrong, path.join(ws.root, KICKOFF));
		const clash = ws.dt('relocate', 'meetings');
		assert.equal(clash.code, 1);
		assert.match(clash.stderr, /already exists — two files claim one id/);
	});

	test('a file record in a collection that became shape: folder is reported by check and converted by relocate', () => {
		// the state a collection is in the moment its descriptor gains `shape: folder` so something
		// can live inside its records — the first step of adopting storage.under on existing data
		const ws = placed();
		fs.mkdirSync(path.join(ws.root, 'data/companies'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'data/companies/acme.company.md'), '---\nname: Acme\n---\n');
		ws.git(['add', 'data']);
		ws.git(['commit', '-qm', 'legacy']);
		const before = ws.dt('check');
		assert.match(before.stdout, /acme\.company\.md.*a file-shape record in a folder-shape collection.*dreamteamer relocate companies/);
		assert.equal(ws.store.ids('companies').size, 0, 'the legacy file is not indexed as a record');
		const res = ws.dt('relocate', 'companies');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(readFile(ws.root, 'data/companies/acme/company.md'), '---\nname: Acme\n---\n', 'the bytes moved, unchanged');
		assert.equal(ws.store.ids('companies').get('acme'), path.join(ws.root, 'data/companies/acme/company.md'));
		assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
		// and a meeting can now live inside it
		assert.equal(ws.dt('add', 'meetings', '--name', 'Intro', '--when', '2026/11', '--company', 'companies/acme').code, 0);
		assert.ok(readFile(ws.root, 'data/companies/acme/meetings/2026/11/intro.meeting.md'));
	});
});

describe('with a generated mirror on the parent', () => {
	// the vault shape: `companies.meetings` is GENERATED from `meetings.company`, so the mirror has to
	// follow a move exactly as it follows any other change to the owning side
	const MIRRORED = structuredClone(MEETINGS);
	MIRRORED.schema.properties.company['x-inverse'] = 'meetings';

	test('the mirror detaches from the old parent and attaches to the new one in the same write', () => {
		const ws = workspace({ collections: { companies: COMPANIES, meetings: MIRRORED } });
		ws.store.add('companies', { name: 'Northwind' });
		ws.store.add('companies', { name: 'Harbor' });
		ws.store.add('meetings', { name: 'Kickoff', when: '2026/10', company: 'companies/northwind' });
		assert.deepEqual(ws.store.read('companies', 'northwind').fields.meetings, ['meetings/2026/10/kickoff']);
		assert.equal(ws.dt('set', 'meetings/2026/10/kickoff', 'company=companies/harbor').code, 0);
		assert.equal(ws.store.read('companies', 'northwind').fields.meetings, undefined);
		assert.deepEqual(ws.store.read('companies', 'harbor').fields.meetings, ['meetings/2026/10/kickoff']);
		assert.ok(readFile(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md'));
		assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
	});
});

// ── the five review findings (rnd/issues 2026-10-01, Codex) ──────────────────────────────────────
// Each block below was a reproduction that passed through the 32 tests above. They are pinned here
// as behaviour, in the order the review numbered them.

describe('R1 — a failed owner move leaves the record exactly as it was', () => {
	const inject = (fn, failWhen) => {
		const real = fs[fn];
		fs[fn] = (...a) => { if (failWhen(...a)) throw new Error(`injected ${fn} failure`); return real(...a); };
		return () => { fs[fn] = real; };
	};
	for (const [fn, when] of [
		['renameSync', (from) => from.endsWith('kickoff.meeting.md')],
		['mkdirSync', (p) => String(p).includes(`${path.sep}harbor${path.sep}meetings`)],
	]) {
		test(`${fn} failing mid-move: bytes, location and mirrors untouched, and the Store still resolves the record`, () => {
			const ws = seeded();
			ws.store.add('tasks', { name: 'Follow up', meeting: 'meetings/2026/10/kickoff' });
			const file = path.join(ws.root, KICKOFF);
			const before = fs.readFileSync(file, 'utf8');
			const restore = inject(fn, when);
			try {
				assert.throws(() => ws.store.set('meetings', '2026/10/kickoff', { company: 'companies/harbor' }), /injected/);
			} finally { restore(); }
			assert.equal(fs.readFileSync(file, 'utf8'), before, 'the original bytes are back');
			assert.equal(fs.existsSync(path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md')), false, 'no partial destination');
			assert.equal(path.relative(ws.root, ws.store.read('meetings', '2026/10/kickoff').file), KICKOFF, 'the index still points at the original');
			assert.equal(ws.dt('check').code, 0, ws.dt('check').stdout);
		});
	}
});

describe('R2 — a symlink inside a parent folder never leads a write or a read outside it', () => {
	test('a symlinked child root refuses the write and is not read as a root', () => {
		const ws = seeded();
		const outside = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'dt-outside-'));
		try {
			fs.writeFileSync(path.join(outside, 'sentinel.meeting.md'), '---\nname: Sentinel\n---\n');
			const link = path.join(ws.root, 'data/companies/acme');
			fs.mkdirSync(link);
			fs.writeFileSync(path.join(link, 'company.md'), '---\nname: Acme\n---\n');
			fs.symlinkSync(outside, path.join(link, 'meetings'), 'dir');
			const res = ws.dt('add', 'meetings', '--name', 'Escape', '--when', '2026/11', '--company', 'companies/acme');
			assert.equal(res.code, 1);
			assert.match(res.stderr, /symlink/);
			assert.equal(fs.readdirSync(outside).length, 1, 'nothing was written outside');
			assert.equal(ws.store.ids('meetings').has('sentinel'), false, 'and nothing outside is indexed as a record');
			// a symlinked PARENT folder is refused the same way
			fs.symlinkSync(outside, path.join(ws.root, 'data/companies/ghost'), 'dir');
			const res2 = ws.dt('add', 'meetings', '--name', 'Escape', '--when', '2026/11', '--company', 'companies/ghost');
			assert.equal(res2.code, 1, res2.stderr);
			assert.equal(fs.readdirSync(outside).length, 1);
		} finally { fs.rmSync(outside, { recursive: true, force: true }); }
	});
});

describe('R3 — dropping or changing `under` cannot strand the records it placed', () => {
	const recompileWith = (ws, storage) => {
		writeCollection(ws.root, 'meetings', { ...MEETINGS, storage });
		return compileError(ws.ws);
	};
	test('compile refuses to drop the declaration while records sit under parents, and names the way out', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		const err = recompileWith(ws, { suffix: 'meeting' });
		assert.match(err, /2 meetings record\(s\) still sit inside companies folders/);
		assert.match(err, /dreamteamer relocate meetings --to-root/);
		// the runtime still describes the placed layout, so the records are still visible
		assert.deepEqual([...ws.store.ids('meetings').keys()].length, 3);
	});
	test('changing under.path is refused the same way; --to-root moves everything to the fallback root, ids intact', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		assert.match(recompileWith(ws, { suffix: 'meeting', under: { field: 'company', path: 'calls' } }), /--to-root/);
		const dry = ws.dt('relocate', 'meetings', '--to-root', '--dry-run');
		assert.equal(dry.code, 0, dry.stderr);
		assert.match(dry.stdout, /2 move\(s\) planned/);
		const res = ws.dt('relocate', 'meetings', '--to-root');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(tree(ws.root, 'data/meetings'), ['data/meetings/2026/10/kickoff.meeting.md', 'data/meetings/2026/10/offsite.meeting.md', 'data/meetings/2026/10/review.meeting.md']);
		assert.equal(fs.existsSync(path.join(ws.root, 'data/companies/northwind/meetings')), false);
		// now the transition compiles, and under the new path check reports the fallback records as misplaced until relocate runs
		assert.equal(recompileWith(ws, { suffix: 'meeting', under: { field: 'company', path: 'calls' } }), null);
		const s2 = new (require('../../src/store.js').Store)(ws.ws);
		assert.equal(s2.ids('meetings').size, 3);
		assert.equal(ws.dt('commit', '-m', 'flattened').code, 0);
		assert.equal(ws.dt('relocate', 'meetings').code, 0);
		assert.ok(readFile(ws.root, 'data/companies/northwind/calls/2026/10/kickoff.meeting.md'));
		assert.equal(ws.dt('check').code, 0);
	});
	test('the rename refusal teaches the supported procedure', () => {
		const ws = seeded();
		const res = ws.dt('rename', 'collections/meetings', 'calls');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /relocate meetings --to-root/);
	});
});

describe('R4 — a long-lived Store sees what other writers did inside existing folders', () => {
	test('an external add, an external delete and another Store\'s move are all visible without a restart', () => {
		const ws = seeded();
		assert.deepEqual([...ws.store.ids('meetings').keys()].length, 3); // warm
		const external = path.join(ws.root, 'data/companies/northwind/meetings/2026/10/external.meeting.md');
		fs.writeFileSync(external, '---\nname: External\nwhen: 2026/10\ncompany: companies/northwind\n---\n');
		assert.ok(ws.store.ids('meetings').has('2026/10/external'), 'added inside an existing folder');
		fs.rmSync(external);
		assert.equal(ws.store.ids('meetings').has('2026/10/external'), false, 'and removed again');
		const other = new (require('../../src/store.js').Store)(ws.ws);
		other.set('meetings', '2026/10/kickoff', { company: 'companies/harbor' });
		assert.equal(path.relative(ws.root, ws.store.read('meetings', '2026/10/kickoff').file), 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md', 'moved by another Store');
	});
});

describe('R5 — relocate never creates a folder for an owner that does not exist', () => {
	test('a dangling owner is a problem in the plan, and apply refuses the whole batch', () => {
		const ws = seeded();
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		fs.writeFileSync(path.join(ws.root, OFFSITE), '---\nname: Offsite\nwhen: 2026/10\ncompany: companies/missing\n---\n');
		// a second, VALID mismatch in the same batch — it must not move either
		const wrong = path.join(ws.root, 'data/companies/harbor/meetings/2026/10/kickoff.meeting.md');
		fs.mkdirSync(path.dirname(wrong), { recursive: true });
		fs.renameSync(path.join(ws.root, KICKOFF), wrong);
		assert.equal(ws.dt('commit', '-m', 'hand edits').code, 0);
		const dry = ws.dt('relocate', 'meetings', '--dry-run');
		assert.equal(dry.code, 1);
		assert.match(dry.stderr, /companies\/missing.*no such record/);
		const res = ws.dt('relocate', 'meetings');
		assert.equal(res.code, 1);
		assert.equal(fs.existsSync(path.join(ws.root, 'data/companies/missing')), false, 'no orphan folder');
		assert.ok(fs.existsSync(wrong), 'the valid move did not apply either — nothing partial');
	});
});
