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
// `compile` regenerates into the root CLAUDE.md / AGENTS.md / GEMINI.md — a file BOTH sides
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
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { defaultGit, describeCheckout, findWorktree, removeWorktree, resolveNpm, childEnv, readHookInput, readStdin } from './checkout.js';
import { BEGIN, END } from './harnesses.js';
import { loadDescriptors, readManifest } from './runtime.js';
import { commitPending } from './commit.js';
import { findWorkspace } from './workspace.js';
import { compile } from './compile.js';
import { check } from './check.js';
import { Store } from './store.js';

/** The advisory mutex, a directory under `describeCheckout(root).commonDir` — so all of a repo's
 *  worktrees contend for ONE lock, whichever of them the operator ran `dt land` from. */
export const LAND_LOCK = 'dreamteamer-land.lock';

/**
 * The files `harnesses.js` writes a managed BEGIN…END block into — matched by EXACT root-relative
 * path, never by basename. Claude Code also reads hand-written nested files (`docs/CLAUDE.md`), and
 * compile never touches one: matching on the basename would let a nested file that happens to carry
 * a copied block be resolved `--ours` and discarded silently (ruling R32).
 *
 * ⚠ `.cursor/rules/dreamteamer.mdc` is deliberately NOT here (ruling R33). Cursor's output is a
 * WHOLE generated file — frontmatter, body and STAMP, no begin/end markers (harnesses.js:97) — so
 * there is no block to take `--ours` on, and `init` gitignores `.cursor/` anyway. A conflict there
 * is an ordinary non-records conflict and aborts the landing like any other.
 */
export const MANAGED_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

/** Does compile write a managed block into this exact path? Task C's per-commit loop asks too. */
export const isManaged = (filePath) => MANAGED_FILES.includes(filePath);

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
 * Conflicted paths grouped by the collection the operator knows them as. A path under the data path
 * that no collection claims groups under `data (no collection)`; everything else under
 * `other files`. The LONGEST `storage.path` wins, so `data/hr` cannot swallow `data/hr/people` —
 * an overlap `storageOverlaps` refuses at compile time, and a conflict report is the wrong place to
 * discover one. Runtime collections are skipped: `.dreamteamer/` is build output, never a record.
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
		// A path under the data path that no collection claims is still a RECORD to `classifyConflict`
		// — an orphan, a folder whose descriptor was removed. Reporting it as "other files" would tell
		// the operator to look in the wrong place, so the two halves say the same thing.
		const key = hit ? hit.name : (p.startsWith(dataPath + '/') ? 'data (no collection)' : 'other files');
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
	if (!range.commits) refusals.push(`nothing to land — ${branch ?? '(detached)'} is already on ${primaryBranch}`);
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
	// `-D`, not `-d`, and the plan says so: the branch has just been fast-forwarded INTO the primary,
	// but a rebase rewrote its hashes, so git's own merged-ness test answers no.
	if (!state.keep) steps.push({ id: 'retire', why: `git worktree remove ${worktree.root} and git branch -D ${branch}` });
	return { refusals, steps };
}

// ---- the runner ------------------------------------------------------------------------------
//
// Everything above is data; everything below moves a disk. The order is the whole safety argument:
// OBSERVE (never mutating), REFUSE (never mutating), then LOCK → COPY → REBASE → CHECK → FF →
// RETIRE, with the copy and the throwaway worktree removed on every exit path. Nothing here writes
// into the operator's worktree until the fast-forward has already succeeded.

/** How many times the primary may move under us before we stop trying (§13.2). */
const FF_ATTEMPTS = 3;
/** Rebase steps we will drive before concluding the loop is not converging — a branch of N commits
 *  conflicts at most N times, so this is a HANG guard, not a policy. */
const REBASE_STEPS = 200;

/** Root-relative paths out of a path-producing git call.
 *
 *  ⚠ `-C <root>` AND `--no-relative`, and both are load-bearing (the precondition Task A's review
 *  wrote down). `diff.relative=true` in a user's gitconfig makes `git diff --name-only` answer paths
 *  relative to the CWD — so a landing run from anywhere but the root would hand `isManaged` a path
 *  like `../CLAUDE.md` and `classifyConflict` would quietly demote a records conflict to `other`.
 *  `status --porcelain` is already root-relative by definition and takes no such flag. */
const gitLines = (git, root, args) => git(['-C', root, ...args], root).split('\n').filter(Boolean);

/** The same, for a `-z` command — NUL-separated and UNQUOTED.
 *
 *  ⚠ THE QUOTING IS THE BUG. Without `-z`, git renders a path holding a non-ASCII byte, a space or a
 *  quote as a C-quoted string (`"data/notes/\303\251.note.md"`) — so a record with an accent in its
 *  id read as one path out of `diff --name-only` and a DIFFERENT one out of `status --porcelain`,
 *  and the two would never match. Every path this file compares, classifies or hands to git comes
 *  through here. */
const gitZ = (git, root, args) => git(['-C', root, ...args], root).split('\0').filter(Boolean);

/** `git status --porcelain -z` paths.
 *
 *  ⚠ A RENAME IS TWO RECORDS in the `-z` format — `R  <new>\0<old>\0` — with no arrow to split on.
 *  The second one is consumed rather than read as a status line of its own, which it is not. */
const statusPaths = (git, root) => {
	const parts = gitZ(git, root, ['status', '--porcelain', '-z']);
	const paths = [];
	for (let i = 0; i < parts.length; i++) {
		const xy = parts[i].slice(0, 2);
		paths.push(parts[i].slice(3));
		if (xy.includes('R') || xy.includes('C')) i++; // its source follows in its own record
	}
	return paths;
};

/** Is that pid a process we could signal? EPERM means it exists and is someone else's — alive. */
const alive = (pid) => {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** The lock as data: whether a LIVE process holds it, and how long it has. A directory whose pid is
 *  gone reads as free — `takeLock` is what reclaims it, out loud. */
function readLock(lockPath) {
	const state = { held: false, pid: null, age_s: 0, path: lockPath };
	let st;
	try { st = fs.statSync(lockPath); } catch { return state; }
	try { state.pid = Number(String(fs.readFileSync(path.join(lockPath, 'pid'), 'utf8')).trim()) || null; } catch { /* no pid file — a half-made lock */ }
	state.age_s = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
	state.held = alive(state.pid);
	return state;
}

/** Take it, or say who has it. `mkdir` is the mutex: it is atomic on every filesystem this engine
 *  runs on, which `writeFile` is not. The re-read on EEXIST is not paranoia — the observation that
 *  planned this landing happened before the copy branch was made, and a second `dt land` may have
 *  started in between. */
function takeLock(lock, log = console.log) {
	try {
		fs.mkdirSync(lock.path);
	} catch (e) {
		if (e.code !== 'EEXIST') throw e;
		const now = readLock(lock.path);
		if (now.held) return { refused: `another land holds the lock (pid ${now.pid}, ${age(now.age_s)}) — wait, or remove ${now.path} if that process is gone` };
		// ⚠ SAID OUT LOUD. A lock that silently reclaims itself is a lock nobody can trust the next
		// time it refuses: the operator has to be able to tell "a land is running" from "a land died".
		log(`  reclaimed ${now.path} — pid ${now.pid ?? '(none)'} is gone`);
		fs.rmSync(lock.path, { recursive: true, force: true });
		fs.mkdirSync(lock.path);
	}
	fs.writeFileSync(path.join(lock.path, 'pid'), String(process.pid));
	return { refused: null };
}

/**
 * The state a landing is planned from. Every field is READ — nothing here writes, so an operator can
 * always ask what would happen. The key set is the contract `planLand` is unit-tested against.
 */
export function observeLand(ws, ref, { keep = false, assumeBranch = null } = {}, git = defaultGit) {
	const c = describeCheckout(ws.root, git);
	const w = findWorktree(ws, ref);
	if (!w) throw new Error(`no worktree "${ref}" — dt list worktrees`);
	const primaryBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], c.primary);
	// `assumeBranch` is `--dry-run --branch <n>` asking what would happen AFTER the switch it
	// deliberately does not make. The branch does not exist yet, so the range is measured from the
	// worktree's own HEAD — which is exactly what that branch would point at.
	const branch = w.primary ? null : (w.branch ?? (assumeBranch ? `worktree-${assumeBranch}` : null));
	const rev = w.primary ? null : (w.branch ?? (branch ? w.head : null));
	const range = { commits: 0, files: [] };
	if (rev) {
		range.commits = Number(gitLines(git, c.primary, ['rev-list', '--count', `${primaryBranch}..${rev}`])[0] ?? 0);
		// `...` (symmetric difference), not `..`: the range is what THIS branch added, so a file the
		// primary changed underneath it is not part of what would land.
		range.files = gitZ(git, c.primary, ['diff', '--name-only', '-z', '--no-relative', `${primaryBranch}...${rev}`]);
	}
	// The two dirty counts PARTITION the worktree's status, so a tree holding both kinds gets both
	// refusals and one fix list. `dirtyRecords` is git's own count under the data path (listWorktrees).
	const dirty = w.primary ? [] : statusPaths(git, w.path);
	// ⚠ THE PRIMARY'S PENDING WRITES ARE READ FROM THE STORE, not from git status (§13.2): a landing
	// fast-forwards and then compiles in the primary, and an uncommitted record there would be swept
	// into this landing's subject by whatever commits next. `dryRun` samples and commits nothing.
	const primaryWs = findWorkspace(c.primary);
	const pending = commitPending(new Store(primaryWs), { dryRun: true });
	const primaryDirty = statusPaths(git, c.primary);
	return {
		name: w.name,
		worktree: { kind: w.primary ? 'primary' : 'linked', root: w.path },
		branch,
		primaryBranch,
		detached: !w.primary && !branch,
		upstream: branch ? upstreamOf(git, c.primary, branch) : null,
		dirtyRecords: w.dirtyRecords,
		uncommitted: Math.max(0, dirty.length - w.dirtyRecords),
		pendingPrimary: pending.reduce((n, r) => n + r.rows.length, 0),
		dirtyPrimaryTouched: range.files.filter((f) => primaryDirty.includes(f)),
		range,
		lock: readLock(path.join(c.commonDir, LAND_LOCK)),
		keep,
	};
}

/** The branch's upstream, or null. A branch with none makes git EXIT NON-ZERO rather than answer
 *  empty, which is why this is a try and not a read. */
function upstreamOf(git, primary, branch) {
	try { return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], primary) || null; } catch { return null; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the range holds, by collection — the same grouping the conflict report uses, counted. */
const recordsIn = (range, descriptors, dataPath) => {
	const groups = groupByCollection(range.files.filter((f) => f.startsWith(dataPath + '/')), descriptors, dataPath);
	return new Map([...groups].map(([k, v]) => [k, v.length]));
};

const summarize = (range, records) =>
	`${plural(range.commits, 'commit')} · ${plural([...records.values()].reduce((a, b) => a + b, 0), 'record file')} in ${plural(records.size, 'collection')} · managed files: ${range.files.filter(isManaged).join(', ') || 'none'}`;

const refusalBlock = (name, refusals) => `✖ cannot land worktrees/${name}:\n${refusals.map((r) => `  ${r}`).join('\n')}`;

/**
 * `dt land worktrees/<name>` — the whole verb. Returns rather than exits, so the CLI owns the
 * process code and `--json` can report the same object the operator was shown.
 *
 * `kept` answers ONE question a script cannot otherwise ask of an exit code: is that worktree still
 * on disk now? It is true for every refusal and conflict (nothing was touched), true after `--keep`,
 * true when the tree CHANGED during the landing and was therefore spared (ruling R53) — and false
 * only when the landing retired it. So `--keep` and "kept because you were still typing in it" read
 * identically to a caller, which is the point: either way the next `dt land` has something to land.
 */
export function landWorktree(ws, ref, { keep = false, dryRun = false, branch = null, npmRun } = {}, git = defaultGit) {
	const c = describeCheckout(ws.root, git);
	// ⚠ `--branch` NAMES THE WORKTREE, it does not choose a branch. `worktree-<name>` is the one
	// spelling `list`, `rm` and this verb all key on — recovering the name FROM the branch is how
	// `listWorktrees` knows what a worktree is called — so a `--branch zulu` on the worktree `a`
	// renamed it out from under every one of those readers and then failed on the next lookup
	// (measured). It is refused rather than honoured.
	const target = findWorktree(ws, ref);
	let switchTo = null;
	if (branch && target && !target.primary) {
		if (branch !== target.name) throw new Error(`--branch must be ${target.name} — the worktree's branch is worktree-${target.name}`);
		// ⚠ AND IT IS A MUTATION, so `--dry-run` must not perform it: `--dry-run --branch a` created
		// and checked out the branch before printing a plan whose whole promise is that it changed
		// nothing (measured). Under a dry run it becomes the first line of the plan instead.
		if (target.branch) switchTo = null;
		else if (dryRun) switchTo = `would switch ${target.path} to worktree-${target.name}`;
		else git(['-C', target.path, 'switch', '-c', `worktree-${target.name}`], target.path);
	}
	const state = observeLand(ws, ref, { keep, assumeBranch: dryRun && switchTo ? branch : null }, git);
	const plan = planLand(state);
	const dataPath = ws.pkg.dreamteamer?.['data-path'] ?? 'data';
	const descriptors = loadDescriptors(c.primary) ?? new Map();
	// ⚠ THE PRIMARY IS ONE FACT, NOT FIVE. Every other refusal a primary checkout collects — nothing
	// ahead, no branch to land — is a CONSEQUENCE of that one, and a fix list of five lines for a
	// state with one fix reads as five problems.
	const refusals = state.worktree.kind === 'primary' ? ['it is the primary checkout'] : plan.refusals;
	// ⚠ MEASURED, NEVER INFERRED. Every non-landing path leaves the tree alone, and `--keep` and the
	// R53 rescue both keep it — but so does a throw out of git in the middle, so the honest answer is
	// the disk's, read after the work rather than derived from the flags that went in.
	const kept = () => fs.existsSync(state.worktree.root);
	if (refusals.length) {
		console.error(refusalBlock(state.name, refusals));
		return { code: 1, landed: null, refused: refusals, kept: kept() };
	}
	if (dryRun) {
		console.log(`dt land worktrees/${state.name} → ${state.primaryBranch} (dry run)`);
		console.log(`  ${summarize(state.range, recordsIn(state.range, descriptors, dataPath))}`);
		if (switchTo) console.log(`  ▶ branch: ${switchTo}`);
		for (const s of plan.steps) console.log(`  ▶ ${s.id}: ${s.why}`);
		return { code: 0, landed: null, refused: null, kept: kept() };
	}
	const taken = takeLock(state.lock);
	if (taken.refused) {
		console.error(refusalBlock(state.name, [taken.refused]));
		return { code: 1, landed: null, refused: [taken.refused], kept: kept() };
	}
	try {
		return { ...runLanding(ws, c, state, { descriptors, dataPath, npmRun }, git), kept: kept() };
	} finally {
		fs.rmSync(state.lock.path, { recursive: true, force: true });
	}
}

/** The mutating half, under the lock. Split out so the lock's `finally` is one line and every early
 *  return inside it is still covered by the cleanup below. */
function runLanding(ws, c, state, { descriptors, dataPath, npmRun }, git) {
	const { name, worktree, branch, primaryBranch, range, keep } = state;
	const copy = `land/${name}`;
	// ⚠ A LEFTOVER COPY IS EVIDENCE, not scratch. `land/<name>` survives exactly one failure — a
	// `dt check` that refused the rebased tree — and the message that left it there says to inspect
	// it. Forcing it forward would delete the one thing the operator was told to look at.
	if (git(['branch', '--list', copy], c.primary)) {
		const why = `${copy} exists from an earlier landing — inspect or delete it first`;
		console.error(refusalBlock(name, [why]));
		return { code: 1, landed: null, refused: [why] };
	}
	const holder = path.join(c.primary, '.worktrees');
	const temp = path.join(holder, `.land-${randomBytes(4).toString('hex')}`);
	const managed = [];
	let keptCopy = false;
	let landed = null;
	try {
		// The COPY (§13.3). The worktree's own branch keeps its hashes until the fast-forward has
		// succeeded, which is what makes "both trees are exactly as before" true after an abort.
		git(['branch', '-f', copy, branch], c.primary);
		fs.mkdirSync(holder, { recursive: true });
		// ⚠ A DETACHED THROWAWAY, never the operator's worktree: a rebase there would leave a session
		// mid-conflict in the tree it is working in, and `land/<name>` must stay un-checked-out so
		// `git branch -f` can move it.
		git(['worktree', 'add', '--detach', temp, copy], c.primary);
		mirrorModules(c.primary, temp);
		for (let attempt = 1; attempt <= FF_ATTEMPTS; attempt++) {
			const conflict = rebaseCopy(temp, primaryBranch, managed, dataPath, git);
			if (conflict) {
				const groups = groupByCollection(conflict.paths, descriptors, dataPath);
				console.error(`✖ landing worktrees/${name} conflicts with ${primaryBranch} at commit ${conflict.at} "${conflict.subject}":`);
				for (const [key, paths] of groups) console.error(`  ${key}: ${paths.join(' · ')}`);
				console.error(`  both trees are exactly as before. Resolve in the worktree (rebase it onto ${primaryBranch} by hand, or edit and commit), then land again.`);
				return { code: 1, landed: null, refused: null };
			}
			// ⚠ ALWAYS COMPILED, not only when a block conflicted: `.dreamteamer/` is gitignored in
			// every workspace `init` writes, so a fresh checkout of the copy has NO runtime at all and
			// `check` would answer "no compiled runtime" for every landing there has ever been.
			compile({ root: temp, pkg: JSON.parse(fs.readFileSync(path.join(temp, 'package.json'), 'utf8')) });
			if (managed.length) commitBlocks(temp, git);
			// ⚠ AFTER the block commit, not before it. The copy is what the fast-forward moves the
			// primary to, and a `branch -f` taken before that commit landed the rebase WITHOUT the
			// regenerated block — the block was committed onto a detached HEAD no ref named, so the
			// landing succeeded and quietly shipped a stale orientation block. It is set here, so a
			// failing `check` below also leaves `land/<name>` at exactly what was inspected.
			git(['-C', temp, 'branch', '-f', copy, 'HEAD'], temp);
			if (check({ root: temp })) {
				keptCopy = true;
				console.error(`✖ rebased as ${copy} but NOT landed — dt check failed on the rebased tree; inspect with git log ${copy}`);
				return { code: 1, landed: null, refused: null };
			}
			const ff = spawnSync('git', ['-C', c.primary, 'merge', '--ff-only', copy], { encoding: 'utf8' });
			if (ff.status === 0) break;
			// ⚠ THE SECOND LAND FAILS HERE, not at the lock (§13.2) — two lands that rebased onto the
			// same tip both produce a non-fast-forward, and a retry WITHOUT re-rebasing fails
			// identically. So the loop goes back to the rebase, onto whatever the primary is now.
			//
			// ⚠ AND THE QUESTION IS ASKED OF GIT, not of git's English. Matching "not a fast-forward"
			// in stderr makes the retry depend on the operator's locale: under any translated git the
			// pattern misses and a routine race becomes a thrown error. `merge-base --is-ancestor`
			// answers the same question numerically — if the primary is still an ancestor of the copy
			// the fast-forward WAS possible, so this failure is something else entirely.
			const ancestor = spawnSync('git', ['-C', c.primary, 'merge-base', '--is-ancestor', primaryBranch, copy], { encoding: 'utf8' }).status;
			if (ancestor !== 1) throw new Error(String(ff.stderr).trim().split('\n')[0] || `git merge --ff-only ${copy} exited ${ff.status}`);
			if (attempt === FF_ATTEMPTS) {
				const why = `the primary moved ${FF_ATTEMPTS} times during the landing — try again`;
				console.error(refusalBlock(name, [why]));
				return { code: 1, landed: null, refused: [why] };
			}
		}
		// ---- landed: the primary is now on the branch's commits -------------------------------
		const primaryWs = findWorkspace(c.primary); // re-read: package.json may itself be in the range
		if (range.files.includes('package-lock.json')) installDeps(primaryWs, npmRun);
		compile(primaryWs);
		// ⚠ RE-MEASURED, AS LATE AS POSSIBLE, AND IT IS A DATA-LOSS GUARD (ruling R53). The
		// worktree's cleanliness was measured before the lock was even taken, and a landing is
		// seconds of rebasing, compiling and checking — a session (or a hook) writing a record into
		// that worktree meanwhile had it DESTROYED at exit 0 with nothing printed: `--force` removed
		// it under the default retire, `reset --hard` discarded it under `--keep`. Both were probed.
		// The landing itself has already succeeded, so this is not a refusal — it keeps the worktree
		// and says why, and the next `dt land` picks the new work up.
		const changed = statusPaths(git, worktree.root);
		let retired;
		if (changed.length) {
			retired = `  worktree kept at ${worktree.root} — it changed during the landing (${plural(changed.length, 'path')}); land again to pick them up`;
		} else if (keep) {
			// Clean by re-measurement, so `--hard` discards nothing: it moves the branch the operator
			// is standing on to what actually landed, which is the only state that will land next
			// time. Its runtime is then behind its tree, exactly as the primary's was.
			git(['-C', worktree.root, 'reset', '--hard', copy], worktree.root);
			compile(findWorkspace(worktree.root));
			retired = `  worktree kept at ${worktree.root}, branch reset to ${git(['-C', worktree.root, 'rev-parse', '--short=7', 'HEAD'], worktree.root)}`;
		} else {
			// ⚠ `force` IS THE HONEST FLAG HERE. `removeWorktree` refuses over dirty records and
			// commits that are on no other branch — both of which this landing has just published to
			// the primary. Asking it to re-derive that would only make it refuse over the work it is
			// being removed BECAUSE of. What `force` must NOT skip is the measurement above.
			removeWorktree(primaryWs, worktree.root, { force: true }, git);
			if (git(['branch', '--list', `worktree-${name}`], c.primary)) git(['branch', '-D', `worktree-${name}`], c.primary);
			retired = '  worktree and branch removed';
		}
		const records = recordsIn(range, descriptors, dataPath);
		landed = { records, commits: range.commits };
		console.log(`✔ landed worktrees/${name} onto ${primaryBranch}: ${plural(range.commits, 'commit')}`);
		for (const [collection, n] of records) console.log(`  ${collection}: ${plural(n, 'record')}`);
		if (managed.length) console.log(`  managed block regenerated: ${managed.join(', ')}`);
		console.log('  primary recompiled');
		console.log(retired);
		return { code: 0, landed, refused: null };
	} finally {
		// EVERY exit path — success, conflict, a failed check, a throw out of git itself. The holder is
		// gitignored, so anything left here would accumulate unseen.
		if (fs.existsSync(temp)) {
			try { git(['worktree', 'remove', '--force', temp], c.primary); } catch { fs.rmSync(temp, { recursive: true, force: true }); }
		}
		try { git(['worktree', 'prune'], c.primary); } catch { /* nothing registered to prune */ }
		if (!keptCopy && git(['branch', '--list', copy], c.primary)) git(['branch', '-D', copy], c.primary);
	}
}

/** Make the copy's compile see what the primary's does. The engine itself is discovered as an
 *  npm-channel MODULE (`node_modules/dreamteamer`) and so is every installed dt module — a copy
 *  compiled without them would regenerate the orientation block MISSING half the workspace and then
 *  commit it. One symlink, because nothing here writes into node_modules and it is gitignored in
 *  every workspace `init` writes, so it can never dirty the tree being landed. */
function mirrorModules(primary, temp) {
	const src = path.join(primary, 'node_modules');
	const at = path.join(temp, 'node_modules');
	if (!fs.existsSync(src) || fs.existsSync(at)) return;
	try { fs.symlinkSync(fs.realpathSync(src), at, 'dir'); } catch { /* a copy without modules still compiles its inline ones */ }
}

/** Rebase the copy onto the primary branch, resolving generated blocks and nothing else.
 *  Returns null when it lands, or `{at, subject, paths}` for a conflict it refuses to resolve —
 *  after aborting, so the caller inherits a clean tree either way. */
function rebaseCopy(temp, onto, managed, dataPath, git) {
	// GIT_EDITOR=true: a rebase that stops to open an editor in a hook or an unattended run is a hang.
	const step = (...args) => spawnSync('git', ['-C', temp, ...args], { encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
	let r = step('rebase', onto);
	let skipped = false;
	for (let guard = REBASE_STEPS; r.status !== 0; guard--) {
		if (!guard) throw new Error(`the rebase of ${onto} did not converge after ${REBASE_STEPS} steps — nothing was landed and every tree is unchanged`);
		const unmerged = gitZ(git, temp, ['diff', '--name-only', '-z', '--diff-filter=U', '--no-relative']);
		if (!unmerged.length) {
			// ⚠ A STOP WITH NOTHING TO RESOLVE IS REPORTED, NOT DRIVEN. `git rebase` also fails
			// without ever starting — an unstaged change, a ref it cannot find, a hook refusing — and
			// that state has no unmerged paths either. Driving it with `--skip` in a loop would burn
			// every one of the guard's steps and then report the wrong thing entirely, so exactly ONE
			// skip is allowed, and only while a rebase is genuinely in progress with an empty index
			// diff: the replayed commit resolved to nothing because the primary already carries its
			// content (the ordinary shape when both sides ran the same system write).
			const empty = spawnSync('git', ['-C', temp, 'diff', '--cached', '--quiet', 'HEAD'], { encoding: 'utf8' }).status === 0;
			if (empty && !skipped && rebaseInProgress(temp)) { skipped = true; r = step('rebase', '--skip'); continue; }
			throw new Error(`rebase stopped without a conflict: ${String(r.stderr || r.stdout).trim().split('\n')[0]}`);
		}
		skipped = false;
		const classes = unmerged.map((p) => classifyConflict(p, readOrEmpty(path.join(temp, p)), { BEGIN, END, dataPath }));
		if (!classes.every((k) => k === 'managed-block')) {
			// Read BEFORE the abort: REBASE_HEAD is what the abort throws away.
			const at = git(['-C', temp, 'rev-parse', '--short=7', 'REBASE_HEAD'], temp);
			const subject = git(['-C', temp, 'log', '-1', '--format=%s', 'REBASE_HEAD'], temp);
			step('rebase', '--abort');
			return { at, subject, paths: unmerged };
		}
		for (const p of unmerged) if (!managed.includes(p)) managed.push(p);
		// `--ours` during a rebase is the side being replayed ONTO — the primary's block. It is thrown
		// away again by the recompile at the tip; what matters is that neither side's stale block wins.
		git(['-C', temp, 'checkout', '--ours', '--', ...unmerged], temp);
		git(['-C', temp, 'add', '--', ...unmerged], temp);
		r = step('rebase', '--continue');
	}
	return null;
}

const readOrEmpty = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** Is a rebase actually running in this checkout? Git's own test: the state directory either backend
 *  writes. A stop with no rebase in progress is a rebase that never started. */
const rebaseInProgress = (root) => ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(root, '.git', d)) || fs.existsSync(path.join(gitDirOf(root), d)));

/** A linked worktree's own git dir (`.git` is a FILE there, pointing at it). */
function gitDirOf(root) {
	try { return path.resolve(root, /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(root, '.git'), 'utf8'))?.[1] ?? '.git'); } catch { return path.join(root, '.git'); }
}

/** Commit the blocks this compile rewrote, pathspec-scoped — the system-write contract, applied to
 *  a landing. TRACKED ONLY: an untracked CLAUDE.md is the operator's to add, and an ignored one is a
 *  hard error to `git add` (the lesson `schema-ops.regeneratedOutputs` already paid for). */
function commitBlocks(temp, git) {
	const blocks = (readManifest(temp)?.['adapter-blocks'] ?? []).filter((p) => fs.existsSync(path.join(temp, p)));
	if (!blocks.length) return;
	const tracked = gitZ(git, temp, ['ls-files', '-z', '--', ...blocks]);
	if (!tracked.length) return;
	git(['-C', temp, 'add', '--', ...tracked], temp);
	// Nothing staged means the block already equalled what the primary had — a commit here would be
	// an empty one, and `git commit` would fail rather than say so.
	if (spawnSync('git', ['-C', temp, 'diff', '--cached', '--quiet'], { encoding: 'utf8' }).status === 0) return;
	git(['-C', temp, 'commit', '--quiet', '-m', 'dreamteamer: land regenerated harness blocks', '--', ...tracked], temp);
}

/** `npm ci` in the primary, when the landing moved the lockfile. Resolved beside the running node
 *  first and handed node's own directory on PATH — a hook's `sh` has neither (see `resolveNpm`). */
function installDeps(primaryWs, run = (npm, args, opts) => spawnSync(npm, args, opts)) {
	const npm = resolveNpm();
	if (!npm) return console.warn('⚠ package-lock.json changed and npm is not on PATH — run npm ci in the primary before its next compile');
	const r = run(npm, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: primaryWs.root, stdio: ['ignore', 2, 2], env: childEnv() });
	// ⚠ `!== 0`, NOT TRUTHINESS. A spawn that never STARTED — the binary vanished between the resolve
	// and the call, EACCES, ENOENT — comes back with `status: null` and an `error`, and a truthy test
	// reads that as success: the one failure mode this warning exists for would print nothing at all.
	if (r?.status !== 0) console.warn(`⚠ npm ci ${typeof r?.status === 'number' ? `exited ${r.status}` : `never started (${r?.error?.message ?? 'no exit status'})`} in the primary — the landing stands; re-run it there`);
}

/**
 * `dt land …` — the surface. Prints; never exits.
 *
 * ⚠ `--hook` IS ALWAYS A DRY RUN, whatever else is on the line. Claude's WorktreeRemove fires while
 * the harness is deleting the tree, so a real landing there would race the removal for the same
 * directory — and the one useful thing to say at that moment is what is about to be lost, in a
 * payload the session reads.
 */
export function landCommand(ws, rest) {
	const flags = new Set(rest.filter((a) => a.startsWith('--')));
	const json = flags.has('--json');
	const args = [];
	let branch = null;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '--branch') { branch = rest[++i]; continue; }
		if (!rest[i].startsWith('--')) args.push(rest[i]);
	}
	// A bare `--branch` swallowed the NEXT flag as its value, so the name it made was `--json`.
	if (flags.has('--branch') && (!branch || branch.startsWith('--'))) throw new Error('--branch takes a name: dt land worktrees/<name> --branch <name>');
	let ref = args[0];
	let dryRun = flags.has('--dry-run');
	if (flags.has('--hook')) {
		// Refused BEFORE the read, so a mistake about the invocation is not answered by a blocking
		// wait on a pipe nobody is filling. `--hook` takes the worktree from the payload, and a
		// positional beside it names a second, possibly different one.
		if (args.length) throw new Error(`--hook reads the worktree from stdin — drop the positional ("${args[0]}")`);
		const input = readHookInput(readStdin());
		// The tree being removed, named by the event. `cwd` is the harness's own — in a hook that is
		// the PRIMARY checkout ($CLAUDE_PROJECT_DIR), so it is a fallback for a payload shaped by
		// another event, never the preferred spelling.
		ref = input.raw.worktree_path ?? input.cwd;
		if (!ref) throw new Error(`hook input carries no worktree_path — keys received: ${Object.keys(input.raw).join(', ')}`);
		// ⚠ AND THE TREE MAY ALREADY BE GONE. WorktreeRemove fires around a removal the harness is
		// performing, so by the time this runs git may no longer list it — which is not an error,
		// it is the event having nothing left to report on. A non-zero exit here would surface in
		// the session as a failed hook on every ordinary worktree deletion.
		if (!findWorktree(ws, ref)) {
			console.log(`${ref} is not a registered worktree (already removed?)`);
			return 0;
		}
		dryRun = true;
	} else if (!ref?.startsWith('worktrees/')) {
		throw new Error('dt land needs a worktree: dt land worktrees/<name>');
	} else {
		// SLICE, never split: `worktrees//abs/path` is one valid id.
		ref = ref.slice('worktrees/'.length);
	}
	// Under --json stdout carries the payload and NOTHING else — compile, check and the retire step
	// all report through console.log, and a board spliced ahead of the object is not parseable.
	const stdout = console.log;
	if (json) console.log = console.error;
	let out;
	try {
		out = landWorktree(ws, ref, { keep: flags.has('--keep'), dryRun, branch });
	} finally {
		console.log = stdout;
	}
	if (json) console.log(JSON.stringify({ ...out, landed: out.landed && { ...out.landed, records: Object.fromEntries(out.landed.records) } }, null, 2));
	return out.code;
}
