// Tier 1 — `land`'s three pure decisions: what a conflict IS, which collection a conflicted path
// belongs to, and what the landing would do. No fs, no git, no subprocess: every input here is
// hand-built, which is the only way these can be asserted at all — the interesting states (a
// rebase conflict entirely inside a generated block, a primary with pending store writes, a lock
// held by a live pid) are expensive and racy to manufacture on a disk and trivial to state as data.
//
// WHY THE CLASSIFICATION IS THE FIRST THING WRITTEN. Getting it wrong is silent in the direction
// that costs most: call a hand-written rule a "generated block" and `land` resolves it with
// `checkout --ours`, throwing away the operator's own instructions with no output at all. So the
// test that matters is the NEGATIVE one — a hunk one line above the BEGIN marker is a records-row
// conflict, and the file being CLAUDE.md does not make it anything else.
//
// The refusal strings are contracts, not messages: `dt land` prints them verbatim and each one has
// to be enough to fix the state without reading the engine. They are asserted whole, one state at a
// time, so a reworded refusal shows up as a failing test rather than as a support question.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { LAND_LOCK, MANAGED_FILES, isManaged, classifyConflict, groupByCollection, planLand, mirrorModules } from '../../src/land.js';
import { BEGIN, END } from '../../src/harnesses.js';

const markers = { BEGIN, END };

/** One `<<<<<<<` … `>>>>>>>` hunk, as git leaves it in a conflicted file. */
const hunk = (ours, theirs) => `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> land/w\n`;
/** A managed root file: the operator's own prose, then the generated block. */
const managed = (prose, inside) => `# house rules\n\n${prose}\n\n${BEGIN}\nthis workspace is a typed record DSL.\n${inside}${END}\n`;

describe('classifyConflict — a generated block is not the operator\'s prose', () => {
	test('every hunk inside BEGIN/END of a managed root file is a managed-block conflict', () => {
		const text = managed('be brief.', hunk('- notes — a note', '- notes — a note, revised'));
		assert.equal(classifyConflict('CLAUDE.md', text, markers), 'managed-block');
	});

	test('two hunks, both inside the block, are still managed-block — a branch of N system writes conflicts N times', () => {
		const text = managed('be brief.', hunk('- a', '- b') + 'context\n' + hunk('- c', '- d'));
		assert.equal(classifyConflict('CLAUDE.md', text, markers), 'managed-block');
	});

	test('ONE hunk outside the block makes the whole file managed-outside-block — the operator\'s rules are never taken from ours', () => {
		const text = managed(hunk('be brief.', 'be very brief.'), hunk('- a', '- b'));
		assert.equal(classifyConflict('CLAUDE.md', text, markers), 'managed-outside-block');
	});

	test('a managed file with no block at all is managed-outside-block, not managed-block', () => {
		assert.equal(classifyConflict('AGENTS.md', `# rules\n\n${hunk('x', 'y')}`, markers), 'managed-outside-block');
	});

	// R33: cursor's output is a WHOLE generated file — frontmatter, body and STAMP, no BEGIN/END
	// (harnesses.js:97) — so there is nothing to take `--ours` on. A conflict there aborts.
	test('.cursor/rules/ is NOT managed — a whole-file generated output has no block', () => {
		const text = managed('be brief.', hunk('- a', '- b'));
		assert.equal(classifyConflict('.cursor/rules/dreamteamer.mdc', text, markers), 'other');
		assert.equal(isManaged('.cursor/rules/dreamteamer.mdc'), false);
	});

	// R32: Claude Code reads hand-written nested instruction files, and compile never regenerates
	// one. A basename match would resolve somebody's own prose with `--ours` and say nothing.
	test('a NESTED file with a managed basename is not managed — the match is the exact root-relative path', () => {
		const text = managed('be brief.', hunk('- a', '- b'));
		assert.equal(classifyConflict('docs/CLAUDE.md', text, markers), 'other');
		assert.equal(classifyConflict('CLAUDE.md', text, markers), 'managed-block', 'the root file still is');
		assert.equal(isManaged('docs/CLAUDE.md'), false);
		assert.equal(isManaged('CLAUDE.md'), true);
	});

	test('every file in MANAGED_FILES is managed by its exact root path; every other root file is not', () => {
		const inside = managed('be brief.', hunk('- a', '- b'));
		for (const f of MANAGED_FILES) assert.equal(classifyConflict(f, inside, markers), 'managed-block', f);
		assert.equal(classifyConflict('README.md', inside, markers), 'other', 'README.md carries no managed block, whatever it contains');
	});

	// ⚠ THE LIST IS A SECOND HAND-ENUMERATION of what `harnesses.js` writes a block into, and the two
	// drift silently in the expensive direction: a harness that grows a fourth block file gets its
	// conflicts classified `other` (an abort — loud, recoverable), while a file dropped from
	// harnesses.js and left here would be resolved `--ours` as if it were generated. So the source is
	// read rather than the memory of it.
	test('MANAGED_FILES is exactly the set of root files harnesses.js writes a block into', () => {
		const src = fs.readFileSync(fileURLToPath(new URL('../../src/harnesses.js', import.meta.url)), 'utf8');
		const written = [...src.matchAll(/^\tblock\('([^']+)'/gm)].map((m) => m[1]);
		assert.deepEqual([...new Set(written)].sort(), [...MANAGED_FILES].sort());
	});

	test('a record is a records conflict — the row that aborts the whole landing', () => {
		assert.equal(classifyConflict('data/notes/a.note.md', hunk('one', 'two'), markers), 'records');
		assert.equal(classifyConflict('data/hr/people/b.person.md', hunk('one', 'two'), markers), 'records');
	});

	test('a non-record, non-managed file is other', () => {
		assert.equal(classifyConflict('README.md', hunk('one', 'two'), markers), 'other');
		assert.equal(classifyConflict('src/x.js', hunk('one', 'two'), markers), 'other');
	});

	test('the data path is configurable — a workspace with data-path "records" classifies there', () => {
		const m = { BEGIN, END, dataPath: 'records' };
		assert.equal(classifyConflict('records/notes/a.note.md', hunk('one', 'two'), m), 'records');
		assert.equal(classifyConflict('data/notes/a.note.md', hunk('one', 'two'), m), 'other');
	});
});

const descriptors = new Map([
	['notes', { name: 'notes', storage: { path: 'data/notes', base: 'workspace' } }],
	['hr/people', { name: 'hr/people', storage: { path: 'data/hr/people', base: 'workspace' } }],
	// a compiled source: its records live in the gitignored runtime, and a conflict can never be one
	['collections', { name: 'collections', storage: { path: 'collections', base: 'runtime' } }],
]);

describe('groupByCollection — conflicted paths, named by the collection the operator knows', () => {
	test('three paths become two collections and the residue', () => {
		const g = groupByCollection(['data/notes/a.note.md', 'data/hr/people/b.person.md', 'README.md'], descriptors);
		assert.deepEqual([...g.keys()], ['notes', 'hr/people', 'other files'], 'insertion order follows the paths given');
		assert.deepEqual(g.get('notes'), ['data/notes/a.note.md']);
		assert.deepEqual(g.get('hr/people'), ['data/hr/people/b.person.md']);
		assert.deepEqual(g.get('other files'), ['README.md']);
	});

	test('the LONGEST storage path wins — a namespace parent must not swallow its child', () => {
		// The exact shape `storageOverlaps` exists to refuse at compile time; grouping a conflict is
		// the wrong place to discover it, so the resolution is longest-prefix regardless.
		const overlapping = new Map([
			['hr', { name: 'hr', storage: { path: 'data/hr', base: 'workspace' } }],
			['hr/people', { name: 'hr/people', storage: { path: 'data/hr/people', base: 'workspace' } }],
		]);
		const g = groupByCollection(['data/hr/people/b.person.md', 'data/hr/c.hr.md'], overlapping);
		assert.deepEqual(g.get('hr/people'), ['data/hr/people/b.person.md']);
		assert.deepEqual(g.get('hr'), ['data/hr/c.hr.md']);
	});

	test('a path under the data path that no collection claims is named as such, not filed under other files', () => {
		const g = groupByCollection(['data/orphans/x.md', 'README.md'], descriptors);
		assert.deepEqual([...g.keys()], ['data (no collection)', 'other files']);
		assert.deepEqual(g.get('data (no collection)'), ['data/orphans/x.md']);
		// and the classifier agrees it is a record — the two halves must not disagree
		assert.equal(classifyConflict('data/orphans/x.md', hunk('a', 'b'), markers), 'records');
	});

	test('a runtime collection never claims a path — .dreamteamer is build output, not a record', () => {
		const g = groupByCollection(['collections/notes.collection.yaml'], descriptors);
		assert.deepEqual([...g.keys()], ['other files']);
	});

	test('several paths in one collection stay in the order they were given', () => {
		const g = groupByCollection(['data/notes/b.note.md', 'data/notes/a.note.md'], descriptors);
		assert.deepEqual(g.get('notes'), ['data/notes/b.note.md', 'data/notes/a.note.md']);
	});

	test('an empty path list is an empty map, not a map of empty groups', () => {
		assert.equal(groupByCollection([], descriptors).size, 0);
	});

	test('the data path is a parameter — a descriptor outside it is not a collection here', () => {
		const g = groupByCollection(['data/notes/a.note.md'], descriptors, 'records');
		assert.deepEqual([...g.keys()], ['other files'], 'data/notes is outside the declared data path');
	});

	test('… and the unclaimed group follows the same parameter', () => {
		assert.deepEqual([...groupByCollection(['records/x/y.md'], descriptors, 'records').keys()], ['data (no collection)']);
	});
});

/** A worktree that can be landed: every refusal test below turns exactly one thing bad. */
const clean = () => ({
	name: 'w',
	worktree: { kind: 'linked', root: '/w/ws/.worktrees/w' },
	branch: 'worktree-w',
	primaryBranch: 'main',
	detached: false,
	upstream: null,
	dirtyRecords: 0,
	uncommitted: 0,
	pendingPrimary: 0,
	dirtyPrimaryTouched: [],
	range: { commits: 2, files: ['data/notes/a.note.md'] },
	lock: { held: false, pid: null, age_s: 0, path: `/w/ws/.git/${LAND_LOCK}` },
	keep: false,
});

const refusalsFor = (patch) => planLand({ ...clean(), ...patch }).refusals;

describe('planLand — the refusals, each for exactly its state', () => {
	test('a clean state refuses nothing', () => {
		assert.deepEqual(refusalsFor({}), []);
	});

	test('the primary checkout', () => {
		assert.deepEqual(refusalsFor({ worktree: { kind: 'primary', root: '/w/ws' } }), ['it is the primary checkout']);
	});

	test('a detached worktree — the refusal carries the two commands that fix it', () => {
		assert.deepEqual(refusalsFor({ detached: true, branch: null }),
			['it is DETACHED (no branch) — inside it: git switch -c worktree-w, or dt land worktrees/w --branch <name> to do that first']);
	});

	test('dirty records in the worktree', () => {
		assert.deepEqual(refusalsFor({ dirtyRecords: 3 }), ['3 dirty record(s) — dt commit them first']);
	});

	test('uncommitted changes in the worktree', () => {
		assert.deepEqual(refusalsFor({ uncommitted: 1 }), ['1 uncommitted change(s) — commit or discard them first']);
	});

	test('a pushed branch is refused rather than rewritten', () => {
		assert.deepEqual(refusalsFor({ upstream: 'origin/worktree-w' }),
			['branch worktree-w has an upstream (origin/worktree-w) — a pushed branch is not rebased; land it by hand']);
	});

	test('the primary has pending store writes — decision 308, and rule 6\'s reason is in the text', () => {
		assert.deepEqual(refusalsFor({ pendingPrimary: 4 }),
			['the primary has 4 pending record write(s) — dt commit them first (a landing would sweep them into someone else\'s subject)']);
	});

	test('the primary has uncommitted changes to a file this branch touches', () => {
		assert.deepEqual(refusalsFor({ dirtyPrimaryTouched: ['data/notes/a.note.md', 'README.md'] }),
			['the primary has uncommitted changes to 2 file(s) this branch also touches: data/notes/a.note.md, README.md']);
	});

	test('… and only the first five paths are named', () => {
		const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `data/notes/${n}.note.md`);
		const [r] = refusalsFor({ dirtyPrimaryTouched: six });
		assert.match(r, /^the primary has uncommitted changes to 6 file\(s\) this branch also touches: /);
		assert.ok(r.endsWith('data/notes/a.note.md, data/notes/b.note.md, data/notes/c.note.md, data/notes/d.note.md, data/notes/e.note.md, …'),
			`the sixth path is elided, not printed: ${r}`);
	});

	test('another land holds the lock — the pid, the age and the path to remove', () => {
		assert.deepEqual(refusalsFor({ lock: { held: true, pid: 4242, age_s: 12, path: '/w/ws/.git/dreamteamer-land.lock' } }),
			['another land holds the lock (pid 4242, 12s) — wait, or remove /w/ws/.git/dreamteamer-land.lock if that process is gone']);
	});

	test('an old lock reads in minutes, not in four-digit seconds', () => {
		const [r] = refusalsFor({ lock: { held: true, pid: 7, age_s: 3600, path: '/w/ws/.git/dreamteamer-land.lock' } });
		assert.match(r, /\(pid 7, 60m\)/);
	});

	test('nothing to land', () => {
		assert.deepEqual(refusalsFor({ range: { commits: 0, files: [] } }),
			['nothing to land — worktree-w is already on main']);
	});

	test('… and a detached worktree with nothing to land says (detached), never "null"', () => {
		const r = refusalsFor({ detached: true, branch: null, range: { commits: 0, files: [] } });
		assert.equal(r.at(-1), 'nothing to land — (detached) is already on main');
	});

	test('several bad things are ALL reported, in the contract\'s order — one run, one fix list', () => {
		assert.deepEqual(refusalsFor({ dirtyRecords: 1, uncommitted: 2, pendingPrimary: 3 }), [
			'1 dirty record(s) — dt commit them first',
			'2 uncommitted change(s) — commit or discard them first',
			'the primary has 3 pending record write(s) — dt commit them first (a landing would sweep them into someone else\'s subject)',
		]);
	});

	test('a refused plan has no steps — nothing is offered that would not run', () => {
		assert.deepEqual(planLand({ ...clean(), uncommitted: 1 }).steps, []);
	});
});

const idsFor = (patch) => planLand({ ...clean(), ...patch }).steps.map((s) => s.id);

describe('planLand — the steps, in the order they run', () => {
	test('the ordinary landing: lock, a copy, the rebase, recompile the copy, check, ff, recompile the primary, retire', () => {
		assert.deepEqual(idsFor({}), ['lock', 'copy', 'rebase', 'recompile-copy', 'check', 'ff', 'recompile-primary', 'retire']);
	});

	test('every step says why — the plan is what --dry-run prints', () => {
		for (const s of planLand(clean()).steps) assert.ok(s.why && s.why.length > 0, `step ${s.id} has no why`);
	});

	// ⚠ THE PLAN IS THE RUN, and this test used to lock in the opposite. `landWorktree` compiles the
	// copy on EVERY landing — `.dreamteamer/` is gitignored, so a fresh checkout has no runtime for
	// `check` to read — while the plan listed the step only when a managed file was in the range. A
	// --dry-run over pure record commits therefore printed a plan the real run did not follow.
	test('recompile-copy is in EVERY plan, and its why names the managed files when there are any', () => {
		assert.deepEqual(idsFor({}),
			['lock', 'copy', 'rebase', 'recompile-copy', 'check', 'ff', 'recompile-primary', 'retire']);
		assert.deepEqual(idsFor({ range: { commits: 1, files: ['CLAUDE.md', 'data/notes/a.note.md'] } }),
			['lock', 'copy', 'rebase', 'recompile-copy', 'check', 'ff', 'recompile-primary', 'retire']);
		const whyOf = (state) => planLand({ ...clean(), ...state }).steps.find((x) => x.id === 'recompile-copy').why;
		assert.match(whyOf({ range: { commits: 1, files: ['AGENTS.md'] } }), /AGENTS\.md/, 'AGENTS.md carries a block too');
		// a nested instruction file and a cursor rule are NOT managed — the step still runs, but its
		// why must not claim they are blocks being regenerated
		assert.doesNotMatch(whyOf({ range: { commits: 1, files: ['docs/CLAUDE.md', '.cursor/rules/dreamteamer.mdc'] } }), /managed file/);
	});

	test('npm-ci appears iff package-lock.json is in the range, and after the fast-forward', () => {
		assert.ok(!idsFor({}).includes('npm-ci'));
		assert.deepEqual(idsFor({ range: { commits: 1, files: ['package-lock.json'] } }),
			['lock', 'copy', 'rebase', 'recompile-copy', 'check', 'ff', 'npm-ci', 'recompile-primary', 'retire']);
	});

	test('--keep drops retire and nothing else', () => {
		assert.deepEqual(idsFor({ keep: true }), ['lock', 'copy', 'rebase', 'recompile-copy', 'check', 'ff', 'recompile-primary']);
	});

	test('both extras together, still in the contract\'s order', () => {
		assert.deepEqual(idsFor({ keep: true, range: { commits: 3, files: ['GEMINI.md', 'package-lock.json'] } }),
			['lock', 'copy', 'rebase', 'recompile-copy', 'check', 'ff', 'npm-ci', 'recompile-primary']);
	});

	test('the lock step names the file land takes, and it is the engine\'s own', () => {
		const [lock] = planLand(clean()).steps;
		assert.equal(lock.id, 'lock');
		assert.ok(lock.why.includes(LAND_LOCK), `the lock step names ${LAND_LOCK}: ${lock.why}`);
	});
});

// ⚠ THE SEAM BETWEEN TWO TASKS, and the one thing a per-task review could not see. `createWorktree`
// (checkout.js) learned to mirror a shadowing `git_modules/<name>` symlink into a new worktree;
// `land` makes a SECOND worktree — the throwaway the rebase runs in — and never got the same fix.
// `git_modules/` is gitignored, so the copy had none, and `land` runs only `compile` there, never
// `install`. The copy therefore compiled without a whole module and did two silent things with the
// result: committed an orientation block missing that module's collections onto the primary branch,
// and ran the `check` gate against fewer collections than the workspace has.
describe('mirrorModules — the copy compiles with the SAME modules as the primary', () => {
	const mk = () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mirror-'));
		fs.mkdirSync(path.join(root, 'primary', 'git_modules'), { recursive: true });
		fs.mkdirSync(path.join(root, 'primary', 'node_modules'), { recursive: true });
		fs.mkdirSync(path.join(root, 'temp'), { recursive: true });
		fs.mkdirSync(path.join(root, 'elsewhere', 'extra'), { recursive: true });
		return root;
	};

	test('a SYMLINKED git_modules entry is mirrored into the temp tree', () => {
		const root = mk();
		fs.symlinkSync(path.join(root, 'elsewhere', 'extra'), path.join(root, 'primary', 'git_modules', 'extra'), 'dir');
		mirrorModules(path.join(root, 'primary'), path.join(root, 'temp'));
		const at = path.join(root, 'temp', 'git_modules', 'extra');
		assert.ok(fs.existsSync(at), 'the shadowing module never reached the copy — it would compile a truncated orientation block');
		assert.equal(fs.realpathSync(at), fs.realpathSync(path.join(root, 'elsewhere', 'extra')));
	});

	// LINKS ONLY, for the reason createWorktree gives: a real clone under git_modules/ is
	// per-checkout working state, and linking it would hand two checkouts one working tree.
	test('a REAL git_modules clone is left alone', () => {
		const root = mk();
		fs.mkdirSync(path.join(root, 'primary', 'git_modules', 'hr'), { recursive: true });
		mirrorModules(path.join(root, 'primary'), path.join(root, 'temp'));
		assert.equal(fs.existsSync(path.join(root, 'temp', 'git_modules', 'hr')), false);
	});

	test('node_modules is still mirrored, and no git_modules folder is invented when there is none', () => {
		const root = mk();
		fs.rmSync(path.join(root, 'primary', 'git_modules'), { recursive: true });
		mirrorModules(path.join(root, 'primary'), path.join(root, 'temp'));
		assert.ok(fs.existsSync(path.join(root, 'temp', 'node_modules')));
		assert.equal(fs.existsSync(path.join(root, 'temp', 'git_modules')), false);
	});
});
