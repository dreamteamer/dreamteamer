// dt commit — publish what is already on disk. Model: GIT IS THE JOURNAL. There is no pending
// file and no cursor; the set of things to commit is sampled from `git status` over the record
// directories of every collection, which means it cannot disagree with reality.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToRecord } from './events.js';

const VERB = { A: 'add', M: 'set', D: 'rm', R: 'rename', '?': 'add' };

/** Record directories to watch, grouped by owning repo. System-stored collections are excluded:
 *  they live in the gitignored runtime and their sources are module files — the same exclusion
 *  pathToRecord already applies. */
function scopeByRepo(descriptors, only) {
	const byRepo = new Map();
	for (const d of descriptors.values()) {
		const p = d.storage?.path;
		if (!p || p.startsWith('system/')) continue;
		if (only.length && !only.includes(d.name)) continue;
		const repo = d.storage.repo ?? '.';
		if (!byRepo.has(repo)) byRepo.set(repo, []);
		byRepo.get(repo).push(p);
	}
	return byRepo;
}

/** In-progress merge/rebase/cherry-pick makes a commit's meaning ambiguous. Ordinary dirtiness
 *  is NOT a refusal condition — committing dirty records is this verb's entire job. */
function inProgress(cwd) {
	let gitDir;
	try { gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd }).toString().trim(); }
	catch { return 'not a git repository'; }
	for (const [marker, label] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
		if (fs.existsSync(path.join(gitDir, marker))) return `a ${label} is in progress`;
	}
	return null;
}

/** A commit on a detached HEAD is reachable only by sha. Worth saying out loud before making one;
 *  not worth refusing over, since it is sometimes exactly what someone means to do. */
function detached(cwd) {
	try { return execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd }).toString().trim() === ''; }
	catch { return true; }
}

/** Sample one repo: porcelain status over its record dirs → [{repoRel, collection, id, verb}].
 *  `git status` run in a module repo returns REPO-relative paths; pathToRecord takes
 *  WORKSPACE-relative ones, so every path is re-prefixed before matching. Skip this and every
 *  module-owned path maps to null — dt commit would commit nothing and report success. */
function sample(root, repo, dirs, descriptors) {
	const cwd = path.resolve(root, repo);
	const prefix = repo === '.' ? '' : `${repo}/`;
	const relDirs = dirs.map((d) => (prefix && d.startsWith(prefix) ? d.slice(prefix.length) : d));
	// `-uall` is load-bearing: by default porcelain COLLAPSES an untracked directory to a single
	// `?? data/notes/` entry, which maps to no record — so the first records of a brand-new
	// collection would be invisible and dt commit would report success having committed nothing.
	const out = execFileSync('git', ['status', '--porcelain', '-z', '-uall', '--', ...relDirs], { cwd }).toString();
	const chunks = out.split('\0').filter((c) => c.length > 0);
	const rows = [];
	for (let i = 0; i < chunks.length; i++) {
		const status = chunks[i].slice(0, 2).trim()[0] ?? 'M';
		const repoRel = chunks[i].slice(3);
		// -z emits a rename/copy as TWO chunks: the new path carries the `XY ` prefix, the old
		// path follows BARE. Consume it here or the next iteration reads a path as a status code
		// — and worse, the old path never gets staged, so the commit keeps half a rename.
		const fromRel = (status === 'R' || status === 'C') ? chunks[++i] : null;
		const rec = pathToRecord(descriptors, prefix + repoRel);
		if (!rec) continue;
		rows.push({ repoRel, fromRel, ...rec, verb: VERB[status] ?? 'set' });
	}
	return { cwd, rows };
}

/** One subject for one repo's rows. The git status letter IS the verb, which is why a
 *  single-record commit keeps exactly the subject it had when writes committed themselves. */
export function composeSubject(rows) {
	if (rows.length === 1) return `dreamteamer: ${rows[0].collection} ${rows[0].verb} ${rows[0].id}`;
	const collections = [...new Set(rows.map((r) => r.collection))].sort();
	if (collections.length === 1) {
		const counts = {};
		for (const r of rows) counts[r.verb] = (counts[r.verb] ?? 0) + 1;
		const parts = Object.entries(counts).map(([v, n]) => `${n} ${v}`).join(', ');
		return `dreamteamer: ${collections[0]} ${rows.length} changes (${parts})`;
	}
	return `dreamteamer: ${rows.length} changes across ${collections.join(', ')}`;
}

export function commitPending(store, { only = [], message, dryRun = false } = {}) {
	const byRepo = scopeByRepo(store.descriptors, only);
	const results = [];
	for (const [repo, dirs] of byRepo) {
		const { cwd, rows } = sample(store.root, repo, dirs, store.descriptors);
		if (!rows.length) continue;
		const blocked = inProgress(cwd);
		if (blocked) { results.push({ repo, rows, blocked }); continue; }
		const warning = detached(cwd) ? 'HEAD is detached — this commit will be reachable only by sha' : null;
		const subject = message ?? composeSubject(rows);
		if (!dryRun) {
			const paths = rows.map((r) => r.repoRel);
			// A rename only reports as `R` once it is STAGED, so its old path is in neither the
			// worktree nor the index and `git add` refuses it ("did not match any files"). It needs
			// no adding — only naming, so the partial commit below carries the deletion half too.
			const alreadyStaged = rows.filter((r) => r.fromRel).map((r) => r.fromRel);
			// `--all` here is PATHSPEC-SCOPED — "including deletions of these named files", not
			// "everything in the tree" (the unscoped form CLAUDE.md rule 6 forbids). Same shape
			// store.js has always used.
			execFileSync('git', ['add', '--all', '--', ...paths], { cwd });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...paths, ...alreadyStaged], { cwd });
		}
		const sha = dryRun ? null : execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd }).toString().trim();
		results.push({ repo, rows, subject, sha, warning });
	}
	return results;
}
