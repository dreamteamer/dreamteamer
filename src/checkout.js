// src/checkout.js — which checkout am I, and how does it become ready.
// WORKSPACE layer: knows git and the compiler, never the harness.
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const defaultGit = (args, cwd) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Primary vs linked, derived from git — never configured. `primary` is the common dir's parent. */
export function describeCheckout(root, git = defaultGit) {
	let gitDir, commonDir;
	try {
		gitDir = git(['rev-parse', '--git-dir'], root);
		commonDir = git(['rev-parse', '--git-common-dir'], root);
	} catch (e) {
		throw new Error(`${root} is not a git checkout — dreamteamer install needs one (${e.message.split('\n')[0]})`);
	}
	const abs = (p) => path.resolve(root, p);
	const linked = abs(gitDir) !== abs(commonDir);
	const primary = linked ? path.dirname(abs(commonDir)) : root;
	const rel = path.relative(primary, root);
	return { root, kind: linked ? 'linked' : 'primary', gitDir: abs(gitDir), commonDir: abs(commonDir), primary,
	         insideRoot: !rel.startsWith('..') && !path.isAbsolute(rel) };
}
