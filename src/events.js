// item events — DERIVED from git history, never observed live (the slice-5 contract in
// using-dreamteamer → references/git-events.md): a closed laptop loses nothing, every evaluation is
// auditable and replayable forever. history IS the queue; there is no events file.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { idFromRecordPath } from './records.js';

/** Record events between two points, across EVERY repo that holds records. `from` is a sha or a
 *  date — a sha is meaningless in another repo, so it is resolved to its commit DATE and each
 *  repo then resolves that date to its own sha. Still cursor-less and stores nothing, so it can
 *  be run twice with no consequence. */
export function deriveEvents(root, descriptors, from, to = 'HEAD') {
	const byRepo = new Map();
	for (const d of descriptors.values()) {
		const p = d.storage?.path;
		if (!p || d.storage.base === 'runtime') continue; // runtime entities aren't item events
		const repo = d.storage.repo ?? '.';
		if (!byRepo.has(repo)) byRepo.set(repo, []);
		byRepo.get(repo).push(p);
	}
	const when = asDate(root, from);
	const events = [];
	for (const [repo, dirs] of byRepo) {
		const cwd = path.resolve(root, repo);
		const prefix = repo === '.' ? '' : `${repo}/`;
		// descriptors carry WORKSPACE-relative paths; git in the module repo wants its own
		const relDirs = dirs.map((d) => (prefix && d.startsWith(prefix) ? d.slice(prefix.length) : d));
		// a repo whose history STARTS after the baseline (the agentlog clone is younger than the
		// workspace) has no commit to diff against — but every record in it IS new since then,
		// so fall back to the empty tree rather than silently contributing zero events
		const fromSha = shaAt(cwd, when) ?? EMPTY_TREE;
		let out = '';
		try {
			out = execFileSync(
				'git', ['diff', '--name-status', '-z', `${fromSha}..${to}`, '--', ...relDirs],
				{ cwd },
			).toString();
		} catch { continue; }
		events.push(...parseNameStatus(out, prefix, descriptors, repo));
	}
	return events;
}

// git's own "no parent" object — the diff baseline for a repo younger than the requested date
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A sha or a date in → an ISO instant. A sha is resolved in the WORKSPACE repo, since that is
 *  the only repo a caller could have got one from. */
function asDate(root, from) {
	// a BARE date is pinned to midnight: git's approxidate fills unspecified fields from NOW, so
	// `--before=2026-08-01` means 2026-08-01 at the current clock time and the same command
	// answers differently in the morning and the evening (measured, 2026-08-03)
	if (/^\d{4}-\d{2}-\d{2}$/.test(from)) return `${from}T00:00:00`;
	if (/^\d{4}-\d{2}-\d{2}/.test(from)) return from;
	try {
		return execFileSync('git', ['show', '-s', '--format=%cI', from], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString().trim();
	} catch {
		throw new Error(`--since "${from}" is neither a date (YYYY-MM-DD) nor a commit in this workspace`);
	}
}

function shaAt(cwd, when) {
	try {
		return execFileSync('git', ['rev-list', '-1', `--before=${when}`, 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString().trim() || null;
	} catch { return null; }
}

/** `git diff --name-status -z` output → record events. `prefix` turns each REPO-relative path
 *  into the WORKSPACE-relative one pathToRecord expects; without it every module-owned path
 *  matches nothing and the repo silently contributes zero events. Note the -z layout: unlike
 *  `status --porcelain -z`, the status letter and the path are SEPARATE NUL-terminated chunks. */
function parseNameStatus(out, prefix, descriptors, repo) {
	const parts = out.split('\0').filter((s) => s.length > 0);
	const events = [];
	const push = (type, relPath) => {
		const rec = pathToRecord(descriptors, relPath);
		if (rec) events.push({ type, ...rec, path: relPath, repo });
	};
	for (let i = 0; i < parts.length; ) {
		const status = parts[i++];
		const p1 = prefix + parts[i++];
		if (status.startsWith('R') || status.startsWith('C')) {
			const p2 = prefix + parts[i++];
			if (status.startsWith('R')) push('item-removed', p1);
			push('item-added', p2);
		} else {
			push(status[0] === 'A' ? 'item-added' : status[0] === 'D' ? 'item-removed' : 'item-updated', p1);
		}
	}
	return events;
}

/** map a workspace-relative path to {collection, id} via storage.path longest-prefix
 *  match + suffix/codec (file shape) or entry (folder shape). non-records → null. */
export function pathToRecord(descriptors, relPath) {
	let best = null;
	for (const d of descriptors.values()) {
		const base = d.storage?.path;
		if (!base || d.storage.base === 'runtime') continue; // runtime entities aren't item events
		if (!relPath.startsWith(base + '/')) continue;
		if (best && base.length <= best.storage.path.length) continue;
		best = d;
	}
	if (!best) return null;
	const rest = relPath.slice(best.storage.path.length + 1);
	if (best.storage.shape === 'folder') {
		const entry = best.storage.entry ?? 'SKILL.md';
		if (!rest.endsWith('/' + entry)) return null;
		return { collection: best.name, id: rest.slice(0, -(entry.length + 1)) };
	}
	const id = idFromRecordPath(best, rest);
	return id === null ? null : { collection: best.name, id };
}

/** the commit that last touched `path` inside the range — the event's provenance sha,
 *  and one leg of the deterministic run-dedupe key (trigger + item + commit). */
export function eventCommit(root, fromSha, toSha, relPath) {
	const out = execFileSync('git', ['log', '--format=%H', '-1', `${fromSha}..${toSha}`, '--', relPath], { cwd: root })
		.toString().trim();
	return out || toSha;
}
