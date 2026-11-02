// held-out cr-dt-004-h6 — dt exports with a conflicted manifest, mid-merge (also in a linked worktree),
// mid-cherry-pick, and with another session's staged path
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkws, coll, rec, NAME, MANIFEST, manifest, head, dt, git, write, compileQuietly } from './held-out-cr-dt-004-lib.js';
import { serializeExports } from '../../src/exports.js';

const COLLS = { people: coll('people', NAME), memos: coll('memos', { ...NAME, about: { type: 'people' } }) };
const L = (labels = {}) => Object.fromEntries(['ann', 'dan', 'eve', 'zoe'].map((p) => [`data/people/${p}.person.md`, rec({ name: labels[p] ?? p.toUpperCase() })]));
const note = (p) => ({ [`data/memos/${p}.memo.md`]: rec({ name: p, about: `people/${p}` }) });
const fresh = () => {
	const w = mkws({ colls: COLLS, files: { ...note('ann'), ...note('dan') }, layers: { l: { pkg: 'l-ws', files: L() } } });
	assert.equal(dt(w.root, 'exports').code, 0);
	return w;
};
const exists = (dir, f) => { try { return fs.existsSync(path.join(git(dir, ['rev-parse', '--absolute-git-dir']).trim(), f)); } catch { return false; } };

function mergeScenario(dir, lDir) {
	git(dir, ['checkout', '-q', '-b', 'b1']);
	write(dir, note('eve')); git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'eve']);
	assert.equal(dt(dir, 'exports').code, 0);
	git(dir, ['checkout', '-q', '-']);
	write(dir, note('zoe')); git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'zoe']);
	assert.equal(dt(dir, 'exports').code, 0);
	try { git(dir, ['merge', '-q', '--no-edit', 'b1']); } catch { /* the conflict is the point */ }
	const conflicted = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
	assert.match(conflicted, /<<<<<<</);
	const ck = dt(dir, 'check');
	assert.notEqual(ck.code, 0); assert.match(ck.stdout, /dreamteamer-exports\.json/);
	const ex = dt(dir, 'exports');
	assert.notEqual(ex.code, 0); assert.match(ex.stderr, /dreamteamer-exports\.json/);
	assert.equal(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'), conflicted);
	// the union, by hand; L retitles ann so dt exports has a change to make
	fs.writeFileSync(path.join(dir, MANIFEST), serializeExports({ people: Object.fromEntries(['ann', 'dan', 'eve', 'zoe'].map((p) => [p, { label: p.toUpperCase(), from: 'l-ws' }])) }));
	write(lDir, L({ ann: 'Ann Renamed' })); git(lDir, ['commit', '-qam', 'retitle']);
	const h = head(dir);
	const mid = dt(dir, 'exports');
	assert.equal(mid.code, 0, mid.stderr);
	assert.match(mid.stdout, /merge is in progress — the manifest is written; git add it and conclude it/);
	assert.doesNotMatch(mid.stdout + mid.stderr, /fatal/);
	assert.equal(head(dir), h); assert.ok(exists(dir, 'MERGE_HEAD'));
	assert.equal(manifest(dir).people.ann.label, 'Ann Renamed');
	git(dir, ['add', MANIFEST]); git(dir, ['commit', '-qm', 'merge', '--no-edit']);
	assert.deepEqual(Object.keys(JSON.parse(git(dir, ['show', `HEAD:${MANIFEST}`])).references.people).sort(), ['ann', 'dan', 'eve', 'zoe']);
	assert.match(dt(dir, 'exports').stdout, /exports manifest current/);
	assert.doesNotMatch(dt(dir, 'check').stdout, /stale/);
}

test('h6 1-2: a conflicted manifest is refused and kept; the union mid-merge is written, not committed; nothing lost', () => {
	const w = fresh();
	mergeScenario(w.root, path.join(w.root, 'git_modules', 'l'));
});

test('h6 3: the same inside a linked worktree (.git is a file)', () => {
	const w = fresh();
	const wt = `${w.root}-wt`;
	git(w.root, ['worktree', 'add', '-q', '-b', 'wtmain', wt]);
	try {
		fs.cpSync(path.join(w.root, 'git_modules'), path.join(wt, 'git_modules'), { recursive: true, verbatimSymlinks: true });
		fs.symlinkSync(path.join(w.root, 'node_modules'), path.join(wt, 'node_modules'));
		compileQuietly({ root: wt, pkg: w.ws.pkg });
		assert.ok(fs.statSync(path.join(wt, '.git')).isFile());
		mergeScenario(wt, path.join(wt, 'git_modules', 'l'));
	} finally { git(w.root, ['worktree', 'remove', '--force', wt]); }
});

test('h6 4: mid-cherry-pick the manifest is written, nothing committed, the cherry-pick state kept', () => {
	const w = fresh();
	git(w.root, ['checkout', '-q', '-b', 'side']);
	write(w.root, { 'data/memos/ann.memo.md': rec({ name: 'side-ann', about: 'people/ann' }) }); git(w.root, ['commit', '-qam', 'side']);
	git(w.root, ['checkout', '-q', '-']);
	write(w.root, { 'data/memos/ann.memo.md': rec({ name: 'main-ann', about: 'people/ann' }) }); git(w.root, ['commit', '-qam', 'main']);
	try { git(w.root, ['cherry-pick', 'side']); } catch { /* conflict */ }
	write(path.join(w.root, 'git_modules', 'l'), L({ dan: 'Dan Renamed' }));
	const h = head(w.root);
	const res = dt(w.root, 'exports');
	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /cherry-pick is in progress — the manifest is written/);
	assert.doesNotMatch(res.stdout + res.stderr, /fatal/);
	assert.equal(head(w.root), h); assert.ok(exists(w.root, 'CHERRY_PICK_HEAD'));
	assert.equal(manifest(w.root).people.dan.label, 'Dan Renamed');
});

test('h6 5: another session\'s staged path and a dirty package.json stay out of the commit', () => {
	const w = fresh();
	write(w.root, { 'data/memos/ann.memo.md': rec({ name: 'staged', about: 'people/ann' }) }); git(w.root, ['add', 'data/memos/ann.memo.md']);
	fs.appendFileSync(path.join(w.root, 'package.json'), '\n');
	write(path.join(w.root, 'git_modules', 'l'), L({ dan: 'Dan Renamed' }));
	const h = head(w.root);
	assert.equal(dt(w.root, 'exports').code, 0);
	assert.equal(git(w.root, ['rev-parse', 'HEAD~1']).trim(), h);
	assert.deepEqual(git(w.root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n'), [MANIFEST]);
	assert.match(git(w.root, ['log', '-1', '--format=%s']), /exports/);
	const st = git(w.root, ['status', '--porcelain']);
	assert.match(st, /^M  data\/memos\/ann\.memo\.md$/m); assert.match(st, /M package\.json$/m);
});
