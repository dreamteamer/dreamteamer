// item events — DERIVED from git history, never observed live (the slice-5 contract in
// using-dreamteamer → references/changes.md): a closed laptop loses nothing, every evaluation is
// auditable and replayable forever. history IS the queue; there is no events file.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { idFromRecordPath } from './records.js';
import { placedChildAt } from './placement.js';

import { storageOf } from './descriptor.js';
/** Record events between two points, across EVERY repo that holds records. `from` is a sha or a
 *  date — a sha is meaningless in another repo, so it is resolved to its commit DATE and each
 *  repo then resolves that date to its own sha. Still cursor-less and stores nothing, so it can
 *  be run twice with no consequence. Every ROOT of a collection is sampled — the write root and
 *  each record layer's — and an event carries the repo it was read from; sampling the write root
 *  alone answered `events: []` for a commit made in a layer's clone. */
export function deriveEvents(root, descriptors, from, to = 'HEAD') {
	const byRepo = new Map();
	for (const d of descriptors.values()) {
		if (storageOf(d).runtime) continue; // runtime entities aren't item events
		if (storageOf(d).external || storageOf(d).unavailable) continue; // an env-pointed root: no repo here holds its history
		for (const { path: p, repo } of storageOf(d).roots) {
			if (!p) continue;
			if (!byRepo.has(repo)) byRepo.set(repo, []);
			if (!byRepo.get(repo).includes(p)) byRepo.get(repo).push(p);
		}
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
 *  match + suffix/format (file shape) or entry (folder shape). non-records → null. */
export function pathToRecord(descriptors, relPath) {
	let best = null; // { d, base } — the longest root, across the write root and every record layer
	for (const d of descriptors.values()) {
		if (storageOf(d).runtime) continue; // runtime entities aren't item events
		if (storageOf(d).unavailable) continue; // its path is still the template — a literal `${env:…}/` folder is nobody's record
		for (const { path: base } of storageOf(d).roots) {
			if (!base || !relPath.startsWith(base + '/')) continue;
			if (best && base.length <= best.base.length) continue;
			best = { d, base };
		}
	}
	if (!best) return null;
	const rest = relPath.slice(best.base.length + 1);
	best = best.d;
	if (storageOf(best).shape === 'folder') {
		const entry = storageOf(best).entry ?? 'SKILL.md';
		// `<id>/<entry>` is the parent's own record; anything deeper may be a record of a collection
		// stored UNDER it (`<id>/meetings/2026/10/kickoff.meeting.md`), which the longest-prefix match
		// above can never see because its own storage.path is elsewhere. One place decides, so a
		// commit, an event and a surface agree on whose record a path is.
		if (rest.endsWith('/' + entry) && rest.indexOf('/') === rest.length - entry.length - 1) return { collection: best.name, id: rest.slice(0, -(entry.length + 1)) };
		return placedChildAt(descriptors, best.name, rest);
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

// ── the record-change report (0.42.0) ────────────────────────────────────────────────────────────
// What `dt changes` and `dt commit` print, and what a session appends to its reply after a write.
// A change is `{ collection, id, ref, path, repo, layer, change }` with `change` one of the three
// words the report uses; `deriveEvents`' `item-*` types are the same three facts, older spelling.
export const CHANGE_OF = { 'item-added': 'created', 'item-updated': 'updated', 'item-removed': 'deleted' };
export const TYPE_OF = { created: 'item-added', updated: 'item-updated', deleted: 'item-removed' };

/** `before` (the committed half, oldest first) folded with `after` (the pending half) — one entry per
 *  record per repo, `committed` true when no pending part is left. Inside one half a ref can appear
 *  twice only as a MOVE (a relocate, a placed record re-parented: deleted at one path, created at
 *  another), which is one update at the live path. Across the halves the net change wins: created
 *  then deleted never existed at either end and is dropped; created then edited is still created;
 *  deleted then re-created is an update. The SAME ref in two repos is two records — a layer's copy
 *  is not the workspace's. */
export function foldChanges(before, after) {
	const key = (c) => `${c.repo}\0${c.ref}`;
	const half = (list) => {
		const m = new Map();
		for (const c of list) {
			const had = m.get(key(c));
			m.set(key(c), had ? { ...(c.change === 'deleted' ? had : c), change: 'updated' } : c);
		}
		return m;
	};
	const out = new Map();
	for (const [k, c] of half(before)) out.set(k, { ...c, committed: true });
	for (const [k, c] of half(after)) {
		const was = out.get(k)?.change;
		const change = !was ? c.change
			: was === 'created' ? (c.change === 'deleted' ? null : 'created')
			: was === 'deleted' && c.change === 'created' ? 'updated' : c.change;
		if (change) out.set(k, { ...c, change, committed: false });
		else out.delete(k);
	}
	const order = (c) => [c.collection, c.layer ?? '', c.id];
	return [...out.values()].sort((a, b) => {
		const [x, y] = [order(a), order(b)];
		for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
		return 0;
	});
}

/** One group per collection AND layer, in the order `foldChanges` sorted them: a collection changed
 *  both here and in a layer is two entries, so the line never hides which repo a write landed in. */
export function groupChanges(changes) {
	const groups = new Map();
	for (const c of changes) {
		const k = `${c.collection}\0${c.layer ?? ''}`;
		if (!groups.has(k)) groups.set(k, { collection: c.collection, layer: c.layer ?? null, created: 0, updated: 0, deleted: 0, records: [] });
		const g = groups.get(k);
		g[c.change]++;
		g.records.push(c);
	}
	return [...groups.values()];
}

/** `records — contacts: 1 created, 2 updated · issues (project-a): 1 created` — the report's first
 *  line, the one the skill tells a session to end its reply with. Empty when nothing changed: the
 *  rule is that nothing written appends nothing. */
export function reportLine(groups) {
	if (!groups.length) return '';
	const counts = (g) => ['created', 'updated', 'deleted'].filter((w) => g[w]).map((w) => `${g[w]} ${w}`).join(', ');
	return `records — ${groups.map((g) => `${g.collection}${g.layer ? ` (${g.layer})` : ''}: ${counts(g)}`).join(' · ')}`;
}
