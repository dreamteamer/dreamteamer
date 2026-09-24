// workspace discovery: the NEAREST package.json with a `dreamteamer` section wins, except when
// that candidate is only nested inside a higher one as a MODULE — modules are themselves
// dreamteamer packages (fractal), so `git_modules/dreamteamer`, `node_modules/@dreamteamer/*` and
// `modules/<workspace-module>` must all resolve outward to the workspace that contains them.
// It used to be "topmost wins", which got the module cases right by accident and every genuinely
// nested workspace wrong: a workspace living under another one's tree (a vault may keep per-identity
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

/** The VS Code-family extension for this workspace, as the editor learns of it: a recommendation
 *  in `.vscode/extensions.json`, which VS Code, Cursor and code-server all read on open and offer to
 *  install. Written by `init` and kept current by `compile`, because a compiled workspace that never
 *  names its editor left a first-run agent searching a registry for the id (measured 2026-09-24:
 *  three install attempts, two of them into a directory the running editor did not read). An
 *  existing file is MERGED, never replaced: a file the operator authored (comments included) is left
 *  alone whenever it already names the extension; one that does not is re-read as JSON and gains the
 *  id, and one that is neither is left with a warning rather than clobbered. */
export const EDITOR_EXTENSION_ID = 'dreamteamer.dreamteamer-vscode';
export function ensureEditorRecommendation(root, warn = console.warn) {
	const file = path.join(root, '.vscode', 'extensions.json');
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ recommendations: [EDITOR_EXTENSION_ID] }, null, '\t') + '\n');
		return 'written';
	}
	const text = fs.readFileSync(file, 'utf8');
	if (text.includes(EDITOR_EXTENSION_ID)) return 'present';
	let parsed;
	try { parsed = JSON.parse(text); } catch {
		warn(`⚠ .vscode/extensions.json does not recommend ${EDITOR_EXTENSION_ID} and is not plain JSON, so it was left alone — add the id to its "recommendations" by hand`);
		return 'left';
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { warn(`⚠ .vscode/extensions.json is not an object — left alone; add ${EDITOR_EXTENSION_ID} to "recommendations" by hand`); return 'left'; }
	parsed.recommendations = [...(Array.isArray(parsed.recommendations) ? parsed.recommendations : []), EDITOR_EXTENSION_ID];
	fs.writeFileSync(file, JSON.stringify(parsed, null, '\t') + '\n');
	return 'merged';
}

/** `.env.example` lists every env key the installed modules declare — the file the missing-key
 *  warning points at, which used to carry two comment lines and none of the keys it was cited for.
 *  Append-only and idempotent: a key already named in the file (as `KEY=` or `# KEY`) is not added
 *  again, and nothing an operator wrote is touched. Values never appear here — an example does. */
export function ensureEnvExample(root, entries, header = '') {
	if (!entries.length) return [];
	const file = path.join(root, '.env.example');
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : header;
	const named = new Set([...existing.matchAll(/^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]));
	const added = [];
	let out = existing;
	for (const e of entries) {
		if (named.has(e.key)) continue;
		const who = e.modules?.length ? ` (module ${e.modules.join(', ')})` : '';
		out = out.trimEnd() + `\n\n# ${e.description ?? `declared by ${e.modules.join(', ')}`}${e.description ? who : ''}\n${e.key}=${e.example ?? ''}\n`;
		added.push(e.key);
	}
	if (added.length) fs.writeFileSync(file, out.replace(/^\n+/, ''));
	return added;
}
