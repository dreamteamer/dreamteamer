// per-record revision history, straight out of git.
//
// Extracted because it had drifted into being UI-only in practice: the exact same `git log
// --follow --format=…` and `git diff <hash>~1 <hash>` lived inlined in `server.js`'s routes AND
// copy-pasted into the VS Code extension's `src/api.ts`, with no CLI verb anywhere — so "show me
// how this record changed" was a thing you could do by clicking and not by asking an agent. One
// implementation here, three callers (CLI, server, extension).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FORMAT = '%H%x00%an%x00%aI%x00%s';

/** `git log` for one record's file, newest first. `--follow` so a rename keeps its past. */
export function history(store, collection, id) {
	const { file } = store.read(collection, id);
	const rel = path.relative(store.root, file);
	const out = execFileSync('git', ['log', '--follow', `--format=${FORMAT}`, '--', rel], { cwd: store.root }).toString();
	return out
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [hash, author, date, subject] = line.split('\0');
			return { hash, author, date, subject };
		});
}

/** The patch one revision applied to this record. `hash~1` means the ROOT commit has no diff. */
export function historyDiff(store, collection, id, hash = 'HEAD') {
	const { file } = store.read(collection, id);
	const rel = path.relative(store.root, file);
	const diff = execFileSync('git', ['diff', `${hash}~1`, hash, '--', rel], { cwd: store.root }).toString();
	return { hash, path: rel, diff };
}
