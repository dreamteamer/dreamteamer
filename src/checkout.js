// src/checkout.js — which checkout am I, and how does it become ready.
// WORKSPACE layer: knows git and the compiler, never the harness.
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const defaultGit = (args, cwd) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Git answers --git-common-dir as a REALPATH, so the two sides of the insideRoot test must be
// spelled the same way or a checkout reached through a symlink reads as outside its own primary
// (macOS /tmp → /private/tmp is the everyday case). A unit test's git is a fake and its paths need
// not exist, so a path that cannot be resolved on disk keeps the spelling it came with.
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** Primary vs linked, derived from git — never configured. `primary` is the common dir's parent. */
export function describeCheckout(rootArg, git = defaultGit) {
	const root = path.resolve(rootArg);
	let gitDir, commonDir;
	try {
		gitDir = git(['rev-parse', '--git-dir'], root);
		commonDir = git(['rev-parse', '--git-common-dir'], root);
	} catch (e) {
		throw new Error(`${root} is not a git checkout — dreamteamer install needs one (${e.message.split('\n')[0]})`);
	}
	const abs = (p) => path.resolve(root, p);
	const linked = abs(gitDir) !== abs(commonDir);
	// The common dir's parent is the primary checkout whichever kind this is — and unlike `root` it
	// stays the primary when the caller hands us a SUBDIRECTORY of one.
	const primary = path.dirname(abs(commonDir));
	const rel = path.relative(real(primary), real(root));
	return { root, kind: linked ? 'linked' : 'primary', gitDir: abs(gitDir), commonDir: abs(commonDir), primary,
	         insideRoot: !rel.startsWith('..') && !path.isAbsolute(rel) };
}

/** The install plan as DATA: every step names what it found and what it would do, so the same
 * decisions are testable without a disk and printable without being run. Task 3 observes the state
 * and executes the steps; nothing here touches fs or git. */
export function planInstall(state, opts = {}) {
	const { checkout: c } = state;
	const steps = [];
	steps.push(state.hasEngine
		? { id: 'engine', label: 'engine: node_modules/dreamteamer present', state: 'already' }
		: { id: 'engine', label: 'engine: npm ci --prefer-offline (package-lock.json) or npm install', state: 'todo' });
	if (c.kind === 'primary') steps.push({ id: 'env', label: '.env: primary checkout — nothing to link', state: 'skip' });
	else if (state.hasEnv && !state.envIsLink) steps.push({ id: 'env', label: '.env: this worktree carries its own .env — left alone', state: 'already' });
	else if (state.hasEnv && state.envIsLink) steps.push({ id: 'env', label: '.env: linked to the primary', state: 'already' });
	else if (!state.primaryHasEnv) steps.push({ id: 'env', label: '.env: the primary has none — nothing to link', state: 'skip' });
	else if (!c.insideRoot && !opts.linkEnv) steps.push({ id: 'env', label: '.env: NOT linked', state: 'skip',
		why: 'this worktree lies outside the primary root — credentials are not linked there by default; pass --link-env to override for this run' });
	else steps.push({ id: 'env', label: `.env: link → ${c.primary}/.env`, state: 'todo' });
	for (const a of state.localAssets) {
		const id = `asset:${a.rel}`;
		if (a.presentHere && !a.isLinkHere) steps.push({ id, label: `${a.rel}: a real directory is here — left alone`, state: 'already' });
		else if (a.isLinkHere) steps.push({ id, label: `${a.rel}: linked`, state: 'already' });
		else if (c.kind === 'primary') steps.push({ id, label: `${a.rel}: primary checkout — nothing to link`, state: 'skip' });
		else if (!a.presentInPrimary) steps.push({ id, label: `${a.rel}: absent in the primary — skipped (the doctor reports the capability degraded)`, state: 'skip' });
		else steps.push({ id, label: `${a.rel}: link → ${c.primary}/${a.rel}`, state: 'todo' });
	}
	// gitModules carries the declared clones that are MISSING on this checkout, not every declared
	// one — the observer narrows it, which is what makes an empty array mean "nothing to restore"
	// rather than "none declared", and what lets a settled checkout plan with nothing todo.
	steps.push({ id: 'git-modules', label: state.gitModules.length ? `git modules: restore ${state.gitModules.join(', ')}` : 'git modules: nothing to restore', state: state.gitModules.length ? 'todo' : 'skip' });
	steps.push({ id: 'compile', label: state.stale ? 'compile: runtime missing or stale' : 'compile: fresh', state: state.stale ? 'todo' : 'already' });
	steps.push(state.postinstall
		? { id: 'postinstall', label: `postinstall: ${state.postinstall}`, state: 'todo' }
		: { id: 'postinstall', label: 'postinstall: none declared', state: 'skip' });
	return steps;
}
