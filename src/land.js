// src/land.js — landing a linked worktree's commits onto the primary branch.
// WORKSPACE layer: knows git, the compiler and the store's pending writes; never the harness surface.
//
// This file is the PURE half — the three decisions a landing is made of, each expressed as a
// function over data so it can be asserted without a disk: what a conflicted file IS, which
// collection a conflicted path belongs to, and what the landing would do. The git work, the lock
// and the printing live beside it and read these.
//
// WHY THE CLASSIFICATION IS THE WHOLE DESIGN (decision 308). A rebase of a worktree branch onto the
// primary conflicts in exactly two interesting places. One is the managed orientation block that
// `compile` regenerates into CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules — a file BOTH sides
// legitimately rewrote, whose content is derived and therefore has no merge to do: take the
// primary's, recompile at the tip, done. The other is a record two sessions edited, which is a real
// disagreement no policy can settle — abort, name the paths by collection, leave both trees
// byte-identical, and let a human write the merged prose. Getting the first case wrong in the
// direction of "managed" is the expensive one: `checkout --ours` on the operator's own hand-written
// rules discards them with no output at all. So a single hunk outside the markers demotes the whole
// file to the records row.
//
// Union merge is deliberately ABSENT (§13.5): DECISION-LOG.md is not append-only by construction,
// and a union driver runs once per replayed commit, so two branches each appending a row keep both
// copies. A decision-log conflict is a records-row conflict.
import path from 'node:path';

/** The advisory mutex, a directory under `describeCheckout(root).commonDir` — so all of a repo's
 *  worktrees contend for ONE lock, whichever of them the operator ran `dt land` from. */
export const LAND_LOCK = 'dreamteamer-land.lock';

/** The root files `harnesses.js` writes a managed block into, by BASENAME — plus any path under
 *  `.cursor/rules/`, where cursor's block is a whole generated `.mdc` rather than a section. */
export const MANAGED_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

const CURSOR_RULES = '.cursor/rules/';
const isManaged = (filePath) => MANAGED_FILES.includes(path.basename(filePath)) || filePath.startsWith(CURSOR_RULES);

/**
 * What a conflicted file is, from its path and its conflicted bytes alone.
 *
 *   'managed-block'         every hunk lies inside a BEGIN…END block → resolvable by taking ours
 *   'managed-outside-block' a managed file, but a hunk touches the operator's own prose
 *   'records'               a record under the data path → the row that aborts the landing
 *   'other'                 source, config, anything else → also aborts, reported separately
 *
 * `markers` is `{ BEGIN, END }` from harnesses.js, plus an optional `dataPath` (default `data`).
 * A managed file carrying NO block is `managed-outside-block`: whatever conflicted there, it was
 * not something compile wrote.
 */
export function classifyConflict(filePath, conflictedText, markers) {
	const { BEGIN, END, dataPath = 'data' } = markers;
	if (isManaged(filePath)) {
		const blocks = blockSpans(conflictedText, BEGIN, END);
		const hunks = hunkSpans(conflictedText);
		const inside = (h) => blocks.some((b) => h.start >= b.start && h.end <= b.end);
		return hunks.length > 0 && hunks.every(inside) ? 'managed-block' : 'managed-outside-block';
	}
	return filePath.startsWith(dataPath + '/') ? 'records' : 'other';
}

/** `[{start, end}]` for every BEGIN…END pair — the marker LINES included, since git leaves them as
 *  context and a hunk can legitimately abut them. */
function blockSpans(text, BEGIN, END) {
	const spans = [];
	let from = 0;
	for (;;) {
		const b = text.indexOf(BEGIN, from);
		if (b < 0) return spans;
		const e = text.indexOf(END, b);
		if (e < 0) return spans;                       // an unterminated block claims nothing
		spans.push({ start: b, end: e + END.length });
		from = e + END.length;
	}
}

/** `[{start, end}]` for every `<<<<<<<` … `>>>>>>>` hunk git left in the file. */
function hunkSpans(text) {
	const spans = [];
	for (const m of text.matchAll(/^<<<<<<< [\s\S]*?^>>>>>>> .*$/gm)) spans.push({ start: m.index, end: m.index + m[0].length });
	return spans;
}

/**
 * Conflicted paths grouped by the collection the operator knows them as, with everything else under
 * `other files`. Longest `storage.path` wins — `data/hr` must not swallow `data/hr/people` (the
 * shape `storageOverlaps` refuses at compile time; a conflict report is the wrong place to discover
 * it). Runtime collections are skipped: `.dreamteamer/` is build output, never a record.
 * Insertion order follows the paths given, so the report reads in the order git listed them.
 */
export function groupByCollection(paths, descriptors, dataPath = 'data') {
	const bases = [];
	for (const d of descriptors.values()) {
		const p = d.storage?.path;
		if (!p || d.storage.base === 'runtime' || !(p + '/').startsWith(dataPath + '/')) continue;
		bases.push({ name: d.name, prefix: p + '/' });
	}
	bases.sort((a, b) => b.prefix.length - a.prefix.length);
	const groups = new Map();
	for (const p of paths) {
		const hit = bases.find((b) => p.startsWith(b.prefix));
		const key = hit ? hit.name : 'other files';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(p);
	}
	return groups;
}

const age = (s) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);

/**
 * The landing as DATA: everything refused, in the contract's order, and — only if nothing is —
 * every step that would run. `--dry-run` prints this object and `landWorktree` executes it, so
 * what the operator is shown is what happens, not a description of it.
 *
 * EVERY refusal is reported, not just the first: a worktree with dirty records AND a dirty primary
 * is one fix list, not two runs. `state` comes from `observeLand`.
 */
export function planLand(state) {
	const { name, worktree, branch, primaryBranch, upstream, dirtyPrimaryTouched: touched, range, lock } = state;
	const refusals = [];
	if (worktree.kind === 'primary') refusals.push('it is the primary checkout');
	if (state.detached) refusals.push(`it is DETACHED (no branch) — inside it: git switch -c worktree-${name}, or dt land worktrees/${name} --branch <name> to do that first`);
	if (state.dirtyRecords) refusals.push(`${state.dirtyRecords} dirty record(s) — dt commit them first`);
	if (state.uncommitted) refusals.push(`${state.uncommitted} uncommitted change(s) — commit or discard them first`);
	// A pushed branch is REFUSED rather than rewritten: rebase rewrites hashes, which is free for a
	// local branch deleted a minute later and a lie for one someone else may have fetched.
	if (upstream) refusals.push(`branch ${branch} has an upstream (${upstream}) — a pushed branch is not rebased; land it by hand`);
	// Decision 308 / rule 6: a fast-forward plus a compile in the primary would sweep another
	// session's uncommitted records into this landing's subject, invisibly.
	if (state.pendingPrimary) refusals.push(`the primary has ${state.pendingPrimary} pending record write(s) — dt commit them first (a landing would sweep them into someone else's subject)`);
	if (touched.length) refusals.push(`the primary has uncommitted changes to ${touched.length} file(s) this branch also touches: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', …' : ''}`);
	if (lock.held) refusals.push(`another land holds the lock (pid ${lock.pid}, ${age(lock.age_s)}) — wait, or remove ${lock.path} if that process is gone`);
	if (!range.commits) refusals.push(`nothing to land — ${branch} is already on ${primaryBranch}`);
	if (refusals.length) return { refusals, steps: [] };

	const managed = range.files.filter(isManaged);
	const steps = [
		{ id: 'lock', why: `take ${lock.path} — ${LAND_LOCK} serialises every land in this repo, whichever worktree it was run from` },
		{ id: 'copy', why: `create land/${name} from ${branch} — the original branch keeps its hashes until the fast-forward succeeds` },
		{ id: 'rebase', why: `rebase land/${name} onto ${primaryBranch} — ${range.commits} commit(s) replayed, GIT_EDITOR=true` },
	];
	if (managed.length) steps.push({ id: 'recompile-copy', why: `${managed.length} managed file(s) in the range (${managed.join(', ')}) — recompile once on the copy's tip and commit the regenerated block, pathspec-scoped` });
	steps.push({ id: 'check', why: `dt check on the copy — a failure stops here, and says the branch is rebased but NOT landed` });
	steps.push({ id: 'ff', why: `git merge --ff-only land/${name} in the primary — ${primaryBranch} moves` });
	if (range.files.includes('package-lock.json')) steps.push({ id: 'npm-ci', why: 'package-lock.json is in the range — npm ci in the primary before it compiles against the new engine' });
	steps.push({ id: 'recompile-primary', why: `compile the primary — its runtime is per checkout and is now behind its tree` });
	if (!state.keep) steps.push({ id: 'retire', why: `git worktree remove ${worktree.root} and git branch -d ${branch}` });
	return { refusals, steps };
}
