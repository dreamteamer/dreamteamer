// Tier 2 — A SCHEMA COMMIT RUNS IN THE REPO THAT HOLDS THE SOURCE (§9).
//
// `writeGated` ran `git add`/`git commit` at the WORKSPACE root, and `git_modules/` is gitignored
// there — so a schema write into a git-shape module compiled, failed to commit, and rolled back.
// The failure named git ("git commit failed — the schema change was rolled back") for a source the
// operator could see on disk and had every right to edit.
//
// `repoRootOf` has been in compile.js since owns-data needed it; this routes the commit through it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, git, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

/**
 * Turn `modules/hr` into a GIT-SHAPE module: its own clone under `git_modules/`, with its own
 * history, which the workspace gitignores.
 *
 * ⚠ Not a real `git clone` from a remote — a clone with no origin is enough, because the thing
 * under test is which repo the commit lands in, and `dt status` reports "ahead" against what is on
 * no remote rather than against a fetched one.
 */
function asGitModule(ws, id) {
	const from = path.join(ws.root, 'modules', id);
	const to = path.join(ws.root, 'git_modules', id);
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.renameSync(from, to);
	git(to, ['init', '-q']);
	git(to, ['config', 'user.email', 'test@example.invalid']);
	git(to, ['config', 'user.name', 'dreamteamer test']);
	git(to, ['add', '-A']);
	git(to, ['commit', '-qm', `${id}: initial`]);
	// the lockfile entry a real git module carries, so `install`/`status` know about it
	const pkgFile = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
	pkg.dreamteamer['git-modules'] = { ...pkg.dreamteamer['git-modules'], [id]: { url: `file://${to}`, ref: 'main' } };
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
	// ⚠ THE FOLDER MOVED OUT OF `modules/`, so the workspace repo still has it in its index. Commit
	// the removal, or the very next `git add -- modules/…` pathspec is a deleted-but-staged tree.
	git(ws.root, ['add', '-A', '--', 'package.json', 'modules']);
	git(ws.root, ['commit', '-qm', 'workspace: declare the git module']);
	return to;
}

describe('a schema write into a git-shape module', () => {
	test('COMMITS IN THE CLONE — it used to compile, fail to commit, and roll back', () => {
		const ws = twoModuleWorkspace();
		const clone = asGitModule(ws, 'hr');
		assert.equal(ws.dt('compile').code, 0);
		const wsBefore = ws.git(['rev-parse', 'HEAD']);
		const cloneBefore = git(clone, ['rev-parse', 'HEAD']);

		const res = ws.dt('add-field', 'hr/positions', '--name', 'grade', '--type', 'integer');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		// the field is on disk, in the clone
		assert.equal(
			load(readFile(ws.root, 'git_modules/hr/collections/hr/positions.collection.yaml')).schema.properties.grade.type,
			'integer',
		);
		// and COMMITTED there, not in the workspace
		assert.notEqual(git(clone, ['rev-parse', 'HEAD']), cloneBefore, 'the clone received the commit');
		assert.equal(ws.git(['rev-parse', 'HEAD']), wsBefore, 'the workspace has nothing to commit');
		assert.equal(git(clone, ['status', '--porcelain']), '', 'nothing left dirty in the clone');
		assert.match(git(clone, ['log', '-1', '--pretty=%s']), /add-field grade/);
	});

	test('the report names the repo and says the clone is ahead', () => {
		const ws = twoModuleWorkspace();
		asGitModule(ws, 'hr');
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('add-field', 'hr/positions', '--name', 'grade', '--type', 'integer');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✔ committed in git_modules\/hr \(\w+, ahead \d+ — push when ready\)/);
	});

	test('a workspace-module write still reports the workspace, with no ahead count', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'collections', '--name', 'grades');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /✔ committed in the workspace \(\w+\)/);
		assert.doesNotMatch(res.stdout, /push when ready/);
	});

	test('dt status shows the clone ahead', () => {
		const ws = twoModuleWorkspace();
		asGitModule(ws, 'hr');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('add-field', 'hr/positions', '--name', 'grade', '--type', 'integer').code, 0);
		const status = ws.dt('status');
		assert.equal(status.code, 0, status.stderr);
		// §10: the folder name IS the label, so there is no `[git]` to decode.
		assert.match(status.stdout, /hr\s+git_modules @ \w+/);
		assert.match(status.stdout, /ahead \d+/);
	});

	test('a write spanning TWO repos is one commit PER repo, and each is complete', () => {
		const ws = twoModuleWorkspace();
		const clone = asGitModule(ws, 'hr');
		// core stays inline (workspace repo); the overlay lives in the clone
		const pkgFile = path.join(clone, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dreamteamer = { ...pkg.dreamteamer, dependencies: ['core'] };
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		git(clone, ['add', '-A']);
		git(clone, ['commit', '-qm', 'hr: depend on core']);
		assert.equal(ws.dt('compile').code, 0);

		const wsBefore = ws.git(['rev-parse', 'HEAD']);
		const cloneBefore = git(clone, ['rev-parse', 'HEAD']);
		// an overlay in hr on core's `people` — the write is in the clone, and `people`'s own
		// descriptor in the workspace repo is untouched by this verb
		const res = ws.dt('add-field', 'people', '--name', 'badge', '--type', 'string', '--module', 'hr');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.notEqual(git(clone, ['rev-parse', 'HEAD']), cloneBefore);
		assert.equal(ws.git(['rev-parse', 'HEAD']), wsBefore);
		assert.equal(git(clone, ['status', '--porcelain']), '');
		// ⚠ SCOPED to what a schema write can touch. `dt init` now seeds every known harness, so a
		// fixture carries untracked AGENTS.md/GEMINI.md/CLAUDE.md — noise for this assertion, and
		// nothing to do with whether the verb left a straggler.
		assert.equal(ws.git(['status', '--porcelain', '--', 'modules', 'git_modules', 'package.json']), '',
			'no stragglers in either repo');
	});

	test('a module that authors its namespaced descriptor FLAT is still the owner', () => {
		// ⚠ THE DEFECT THIS PINS, found by driving a real `dt install --clone` workspace: a module
		// owning its namespace (§8) has no reason to repeat it in every path, so `hr` authors
		// `collections/positions.collection.yaml` with `name: hr/positions`. `baseDescriptorSource`
		// matched a source by requiring `collections/<name>.collection.yaml` in the PATH, so that
		// base was invisible — and `add-field hr/positions` created an overlay in the WORKSPACE
		// module and then failed compile for a dependency nobody asked for. That is the exact defect
		// this wave exists to remove, one layer down from where Task 1 removed it.
		const ws = twoModuleWorkspace();
		const clone = asGitModule(ws, 'hr');
		// flatten the descriptor inside the clone: same `name`, a path that no longer mirrors it
		fs.renameSync(path.join(clone, 'collections/hr/positions.collection.yaml'),
			path.join(clone, 'collections/positions.collection.yaml'));
		fs.rmSync(path.join(clone, 'collections/hr'), { recursive: true, force: true });
		git(clone, ['add', '-A']);
		git(clone, ['commit', '-qm', 'hr: author the descriptor flat']);
		assert.equal(ws.dt('compile').code, 0);

		const res = ws.dt('add-field', 'hr/positions', '--name', 'grade', '--type', 'integer');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /git_modules\/hr\/collections\/positions\.collection\.yaml/,
			'the OWNER\'s own descriptor, at the path it actually has');
		assert.equal(readFile(ws.root, 'modules/default/collections/hr/positions.collection.yaml'), null,
			'no overlay was invented in the workspace module');
		assert.equal(
			load(readFile(ws.root, 'git_modules/hr/collections/positions.collection.yaml')).schema.properties.grade.type,
			'integer',
		);
	});

	test('a FAILED commit in one repo rolls the whole op back, in both', () => {
		const ws = twoModuleWorkspace();
		const clone = asGitModule(ws, 'hr');
		assert.equal(ws.dt('compile').code, 0);
		const before = load(readFile(ws.root, 'git_modules/hr/collections/hr/positions.collection.yaml'));
		// ⚠ UNSETTING THE CLONE'S IDENTITY IS NOT ENOUGH — `dt()` passes GIT_AUTHOR_*/GIT_COMMITTER_*
		// through the environment (test/helpers/ws.js), so git has an identity whatever the repo
		// config says. Make `.git` unwritable instead: no env var rescues that.
		fs.chmodSync(path.join(clone, '.git'), 0o500);
		const res = ws.dt('add-field', 'hr/positions', '--name', 'grade', '--type', 'integer');
		fs.chmodSync(path.join(clone, '.git'), 0o700);
		assert.equal(res.code, 1);
		assert.match(res.stderr, /rolled back/);
		assert.deepEqual(
			load(readFile(ws.root, 'git_modules/hr/collections/hr/positions.collection.yaml')),
			before,
			'the source is byte-for-byte what it was',
		);
		assert.equal(ws.dt('check').code, 0);
	});
});

// ⚠ THE GATE COMPILE REGENERATES CLAUDE.md, AGENTS.md AND GEMINI.md, and the commit used to cover only
// the mutated source — so every schema write left the three COMMITTED root files dirty with the block
// that names the change just committed, and the next unscoped `git add` in a shared tree swept them
// into somebody else's subject. Reproduced twice in one day on a dogfood workspace before this pinned
// it. The generated files ride the manifest's `adapter-outputs` + `adapter-blocks`, narrowed to what
// git already TRACKS: an ignored one (`.claude/`) is a hard error to `git add`, and an UNTRACKED root
// file is the operator's to add — a write into a clone must not start tracking files in the workspace
// repo as a side effect (the two-repo test above holds the workspace HEAD still for exactly that).
describe('a schema write commits the harness files the gate compile regenerated', () => {
	test('the three root files land in the SAME commit, and nothing generated is left dirty', () => {
		const ws = twoModuleWorkspace();
		// init seeds them untracked; track them first so the assertion is about a REGENERATION
		ws.git(['add', '--', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);
		ws.git(['commit', '-qm', 'fixture: harness files']);
		const res = ws.dt('set', 'collections/people', 'description=A person, and the block now says so.');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(ws.git(['status', '--porcelain', '--', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'modules']), '',
			'the regenerated block is in the commit, not left dirty beside it');
		const shown = ws.git(['show', '--stat', '--oneline', 'HEAD']);
		assert.match(shown, /CLAUDE\.md/);
		assert.match(shown, /AGENTS\.md/);
		assert.match(shown, /modules\/core\/collections\/people\.collection\.yaml/);
		assert.match(readFile(ws.root, 'CLAUDE.md'), /A person, and the block now says so\./);
	});

	test('an ignored or untracked generated path is never handed to git add', () => {
		const ws = twoModuleWorkspace();
		assert.ok(fs.existsSync(path.join(ws.root, '.claude/skills')), 'the fixture writes the ignored dir');
		assert.equal(ws.git(['check-ignore', '.claude/skills']).trim(), '.claude/skills');
		assert.match(ws.git(['status', '--porcelain', '--', 'CLAUDE.md']), /^\?\? CLAUDE\.md/, 'init seeds it untracked');
		const res = ws.dt('set', 'collections/people', 'description=Still a person.');
		assert.equal(res.code, 0, `an ignored path in the pathspec would have failed this: ${res.stderr}`);
		assert.match(ws.git(['status', '--porcelain', '--', 'CLAUDE.md']), /^\?\? CLAUDE\.md/, 'still untracked — not the schema write\'s to add');
		assert.doesNotMatch(ws.git(['show', '--stat', '--oneline', 'HEAD']), /CLAUDE\.md/);
	});
});
