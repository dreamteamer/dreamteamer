// item events — DERIVED from git history, never observed live (the slice-5 contract in
// detecting-data-changes-via-git): a closed laptop loses nothing, every evaluation is
// auditable and replayable forever. history IS the queue; there is no events file.
import { execFileSync } from 'node:child_process';
import { EXT } from './records.js';

/** git diff --name-status over the cursor range, scoped to data/ + state/, mapped to
 *  record events via the compiled descriptors. renames emit removed+added. */
export function deriveEvents(root, descriptors, fromSha, toSha = 'HEAD') {
	const raw = execFileSync(
		'git', ['diff', '--name-status', '-z', `${fromSha}..${toSha}`, '--', 'data/', 'state/'],
		{ cwd: root },
	).toString();
	const parts = raw.split('\0').filter((s) => s.length > 0);
	const events = [];
	const push = (type, relPath) => {
		const rec = pathToRecord(descriptors, relPath);
		if (rec) events.push({ type, ...rec, path: relPath });
	};
	for (let i = 0; i < parts.length; ) {
		const status = parts[i++];
		const p1 = parts[i++];
		if (status.startsWith('R') || status.startsWith('C')) {
			const p2 = parts[i++];
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
		if (!base || base.startsWith('system/')) continue; // system entities aren't item events
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
	const tail = `.${best.storage.suffix}${EXT[best.storage.codec ?? 'md']}`;
	if (!rest.endsWith(tail)) return null;
	return { collection: best.name, id: rest.slice(0, -tail.length) };
}

/** the commit that last touched `path` inside the range — the event's provenance sha,
 *  and one leg of the deterministic run-dedupe key (trigger + item + commit). */
export function eventCommit(root, fromSha, toSha, path) {
	const out = execFileSync('git', ['log', '--format=%H', '-1', `${fromSha}..${toSha}`, '--', path], { cwd: root })
		.toString().trim();
	return out || toSha;
}
