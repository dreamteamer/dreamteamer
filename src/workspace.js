// workspace discovery: the NEAREST package.json with a `dreamteamer` section wins, except when
// that candidate is only nested inside a higher one as a MODULE — modules are themselves
// dreamteamer packages (fractal), so `git_modules/dreamteamer`, `node_modules/@dreamteamer/*` and
// `modules/<workspace-module>` must all resolve outward to the workspace that contains them.
// It used to be "topmost wins", which got the module cases right by accident and every genuinely
// nested workspace wrong: a workspace living under another one's tree (hq3 keeps per-identity
// repos at projects/<identity>/<repo>/) resolved to the OUTER workspace, so every command
// silently operated on the wrong repo — compile wrote the wrong runtime, check counted the wrong
// records, all reporting success. `projects/` is not a module segment, so nesting there is a
// real workspace and now resolves as one.
import fs from 'node:fs';
import path from 'node:path';

// path segments that mean "the thing below me is a module of the thing above me", never a workspace
const MODULE_SEGMENTS = new Set(['node_modules', 'git_modules', 'modules']);

export function findWorkspace(start = process.cwd()) {
	let dir = path.resolve(start);
	const candidates = []; // nearest → topmost
	while (true) {
		const p = path.join(dir, 'package.json');
		if (fs.existsSync(p)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
				if ('dreamteamer' in pkg) candidates.push({ root: dir, pkg });
			} catch { /* unparseable package.json never disqualifies a dir */ }
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!candidates.length) {
		throw new Error('not a dreamteamer workspace — no package.json with a "dreamteamer" section found here or above');
	}
	// climb out of module nesting only: stop at the first ancestor that contains the current pick
	// as something OTHER than a module.
	let found = candidates[0];
	for (const higher of candidates.slice(1)) {
		if (!nestedAsModule(higher.root, found.root)) break;
		found = higher;
	}
	return found;
}

/** Is `inner` reached from `outer` by descending through a module folder? */
export function nestedAsModule(outer, inner) {
	return path
		.relative(outer, inner)
		.split(path.sep)
		.some((seg) => MODULE_SEGMENTS.has(seg));
}
