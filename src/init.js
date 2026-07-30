// dreamteamer init — write the workspace skeleton into the current directory.
// non-interactive: flags override sensible defaults (RAD phase; prompts later).
// never compiles — compile is always explicit.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dump } from './yaml.js';
import { slugOrHash } from './template.js';
import { discoverModules } from './compile.js';
import { Store } from './store.js';

const SKELETON_KINDS = ['collections', 'skills', 'agents', 'commands', 'workflows', 'ui-views'];

const GITIGNORE = `node_modules/
git_modules/
.dreamteamer/
.claude/
.agents/
.cursor/
.env
media/
.screenshots/
`;

const ENV_EXAMPLE = `# secrets for skills and modules go here (copy to .env; .env is never committed).
# modules declare the env keys they require in their package.json dreamteamer.env list.
`;

export function init({ flags = {} } = {}) {
	const root = process.cwd();
	const name = flags.name ?? path.basename(root);
	const dataPath = flags['data-path'] ?? 'data';
	const harnesses = typeof flags.harnesses === 'string' ? flags.harnesses.split(',').map((s) => s.trim()) : ['claude-code'];

	// package.json: create or update — the single manifest
	const pkgPath = path.join(root, 'package.json');
	const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : { name, private: true, version: '0.0.1' };
	pkg.dreamteamer = {
		'data-path': dataPath,
		harnesses,
		'gitignore-runtime-folder': true,
		'workspace-module': name, // workspace-owned system sources live in modules/<name>/ — data and logic stay separated
		'git-modules': {},
		disable: [],
		...pkg.dreamteamer,
	};
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	// folder skeleton — the workspace's own system sources are an inline module
	const wm = pkg.dreamteamer['workspace-module'];
	const systemRoot = wm ? path.join(root, 'modules', wm) : root;
	for (const kind of SKELETON_KINDS) fs.mkdirSync(path.join(systemRoot, 'system', kind), { recursive: true });
	if (wm) {
		const modulePkg = path.join(systemRoot, 'package.json');
		if (!fs.existsSync(modulePkg)) {
			fs.writeFileSync(modulePkg, JSON.stringify({ name: wm, private: true, version: '0.0.1', files: ['system'], dreamteamer: {} }, null, '\t') + '\n');
		}
	}
	fs.mkdirSync(path.join(root, dataPath), { recursive: true });
	fs.mkdirSync(path.join(root, 'state'), { recursive: true });

	// seed user (git identity) + everyone team
	const gitName = tryGit(root, ['config', 'user.name']) ?? 'operator';
	const gitEmail = tryGit(root, ['config', 'user.email']);
	const userId = slugOrHash(gitName); // must satisfy the users collection's own id rule ({{ name | slug }})
	const usersDir = path.join(root, dataPath, 'users');
	const teamsDir = path.join(root, dataPath, 'teams');
	fs.mkdirSync(usersDir, { recursive: true });
	fs.mkdirSync(teamsDir, { recursive: true });
	const userFile = path.join(usersDir, `${userId}.user.yaml`);
	if (!fs.existsSync(userFile)) fs.writeFileSync(userFile, dump({ name: gitName, ...(gitEmail ? { email: gitEmail } : {}) }));
	const teamFile = path.join(teamsDir, 'everyone.team.yaml');
	if (!fs.existsSync(teamFile)) fs.writeFileSync(teamFile, `name: everyone\nmembers: [users/${userId}]\n`);

	// .gitignore + .env.example (append-if-missing, never clobber)
	appendMissing(path.join(root, '.gitignore'), GITIGNORE);
	if (!fs.existsSync(path.join(root, '.env.example'))) fs.writeFileSync(path.join(root, '.env.example'), ENV_EXAMPLE);

	// one init commit (if we're in a git repo)
	try {
		execFileSync('git', ['add', '--all'], { cwd: root });
		execFileSync('git', ['commit', '--quiet', '-m', `dreamteamer: init workspace ${name}`], { cwd: root });
	} catch { console.warn('⚠ not a git repo (or nothing to commit) — init files written, no commit'); }

	console.log(`✔ workspace ${name} initialized — run \`dreamteamer compile\` to materialize the runtime`);
	return 0;
}

// dreamteamer install — restore git_modules/ working clones from the committed lockfile map
export function install({ root, pkg }) {
	const map = pkg.dreamteamer?.['git-modules'] ?? {};
	const names = Object.keys(map);
	if (!names.length) { console.log('✔ no git-modules declared — nothing to restore'); return 0; }
	fs.mkdirSync(path.join(root, 'git_modules'), { recursive: true });
	for (const name of names) {
		const { url, ref = 'main' } = map[name];
		const dest = path.join(root, 'git_modules', name);
		if (fs.existsSync(dest)) {
			const head = tryGit(dest, ['rev-parse', '--abbrev-ref', 'HEAD']);
			const dirty = tryGit(dest, ['status', '--porcelain']);
			if (head !== ref) console.warn(`⚠ git_modules/${name}: HEAD is ${head}, lockfile says ${ref} — not touching it${dirty ? ' (dirty)' : ''}`);
			else console.log(`✔ git_modules/${name} present (${ref})`);
			continue;
		}
		console.log(`… cloning ${url} → git_modules/${name} (${ref})`);
		execFileSync('git', ['clone', '--branch', ref, url, dest], { stdio: 'inherit' });
		buildClone(dest, name);
	}
	return 0;
}

// dreamteamer update [<name>] — pull each lockfile-declared git_modules clone forward
// (ff-only on its recorded ref) and rebuild it. dirty clones are skipped, never touched.
// the caller (cli) runs compile afterwards — a pulled module may change sources.
export function update({ root, pkg }, only) {
	const map = pkg.dreamteamer?.['git-modules'] ?? {};
	if (only && !map[only]) throw new Error(`"${only}" is not in dreamteamer.git-modules (known: ${Object.keys(map).join(', ') || 'none'})`);
	const names = only ? [only] : Object.keys(map);
	if (!names.length) { console.log('✔ no git-modules declared — nothing to update'); return 0; }
	for (const name of names) {
		const { ref = 'main' } = map[name];
		const dest = path.join(root, 'git_modules', name);
		if (!fs.existsSync(dest)) { console.warn(`⚠ git_modules/${name} missing — run \`dreamteamer install\` first; skipped`); continue; }
		if (tryGit(dest, ['status', '--porcelain'])) { console.warn(`⚠ git_modules/${name} is dirty — skipped (commit or stash there, then re-run)`); continue; }
		const before = tryGit(dest, ['rev-parse', '--short', 'HEAD']);
		try {
			execFileSync('git', ['pull', '--ff-only', 'origin', ref], { cwd: dest, stdio: 'inherit' });
		} catch {
			console.warn(`⚠ git_modules/${name}: ff-only pull of origin/${ref} failed (diverged?) — left at ${before}`);
			continue;
		}
		const after = tryGit(dest, ['rev-parse', '--short', 'HEAD']);
		if (before === after) { console.log(`✔ git_modules/${name} already up to date (${after})`); continue; }
		buildClone(dest, name); // deps/dist may have moved with the pull
		console.log(`✔ git_modules/${name} ${before} → ${after}`);
	}
	// dev-clone semantics: these clones SHADOW any node_modules copy of the same module —
	// what just updated is what runs. npm-channel modules are updated via npm, not here.
	console.log('… git_modules clones shadow node_modules copies — the updated clones win');
	for (const m of discoverModules(root, pkg).modules) {
		if (m.channel === 'npm') console.log(`… npm-channel module ${m.name} is not managed here — \`npm update ${m.name}\` to pull it forward`);
	}
	return 0;
}

// a fresh clone with deps or a prepare/build script needs `npm install` to be usable
// (deps land; `prepare` runs on install and builds dist). failure warns, never crashes.
function buildClone(dest, name) {
	let cp;
	try { cp = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')); } catch { return; }
	if (!cp.dependencies && !cp.scripts?.prepare && !cp.scripts?.build) return;
	console.log(`… npm install in git_modules/${name}`);
	const r = spawnSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: dest, stdio: 'inherit' });
	if (r.status !== 0) console.warn(`⚠ npm install failed in git_modules/${name} (exit ${r.status ?? r.error?.message}) — clone may be unbuilt; fix and re-run npm install there`);
}

function tryGit(cwd, args) {
	try { return execFileSync('git', args, { cwd }).toString().trim() || null; } catch { return null; }
}

function appendMissing(file, block) {
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	const missing = block.split('\n').filter((l) => l && !existing.split('\n').includes(l));
	if (missing.length) fs.writeFileSync(file, (existing ? existing.trimEnd() + '\n' : '') + missing.join('\n') + '\n');
}

// dreamteamer install --clone <url> [name] — clone a module for development AND
// record it in the committed lockfile map (story 5.3)
export function installClone(ws, url, name) {
	if (!url) throw new Error('usage: dreamteamer install --clone <git-url> [name]');
	name = name && !name.startsWith('--') ? name : path.basename(url, '.git');
	const dest = path.join(ws.root, 'git_modules', name);
	if (fs.existsSync(dest)) throw new Error(`git_modules/${name} already exists`);
	fs.mkdirSync(path.join(ws.root, 'git_modules'), { recursive: true });
	execFileSync('git', ['clone', url, dest], { stdio: 'inherit' });
	buildClone(dest, name);
	const ref = tryGit(dest, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'main';
	const pkgPath = path.join(ws.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.dreamteamer['git-modules'] = { ...pkg.dreamteamer['git-modules'], [name]: { url, ref } };
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	execFileSync('git', ['add', 'package.json'], { cwd: ws.root });
	execFileSync('git', ['commit', '--quiet', '-m', `dreamteamer: install ${name} (git module)`, '--', 'package.json'], { cwd: ws.root });
	console.log(`✔ git_modules/${name} (ref ${ref})`);
	console.log('✔ package.json dreamteamer.git-modules updated');
	return 0;
}

// ---- attached repos: `repos` records, materialized ON DEMAND ------------------------------
// A `repos` record declares a related git repo and NOTHING about the schema — the other half of
// what git_modules fuses together. Modules stay in package.json because compile can't read records
// until they're restored (no .dreamteamer → no schemas → no readable records); attached repos have
// no such constraint, so they get to be data.

const relPath = (root, p) => path.relative(root, p) || '.';

/**
 * Where a declared repo's working tree lives. Pure — never touches disk, so callers can resolve a
 * path without materializing (that is how `status` reports presence).
 *
 * The engine deliberately does NOT know what `identity` means: hq3 uses it to select a
 * `~/.gitconfig` includeIf folder so the clone commits as the right git user, but that resolution
 * happens entirely outside the engine. Here it is just a path segment.
 */
export function repoPath(ws, fields) {
	if (fields.path) return path.join(ws.root, fields.path);
	const base = ws.pkg.dreamteamer?.['repos-path'] ?? 'projects';
	return fields.identity
		? path.join(ws.root, base, fields.identity, fields.name)
		: path.join(ws.root, base, fields.name);
}

/**
 * dreamteamer repos ensure <id> — materialize ONE declared repo, idempotently.
 * Cheap as a stat when already present, so callers never branch on presence themselves.
 */
export function ensureRepo(ws, id) {
	const { fields } = new Store(ws).read('repos', id);
	return materializeRepo(ws, id, fields);
}

/** dreamteamer repos ensure --all — explicit opt-in (going offline, grepping across all of them). */
export function ensureAllRepos(ws) {
	const out = [];
	for (const { id, fields } of new Store(ws).readAll('repos')) out.push(materializeRepo(ws, id, fields));
	return out;
}

/**
 * Declared repos and whether each is on disk. Presence is OBSERVED, never stored on the record —
 * with lazy materialization "is it here?" is the first question anyone asks, and a stored answer
 * would be wrong the moment someone deletes a folder.
 */
export function listRepos(ws) {
	const out = [];
	for (const { id, fields } of new Store(ws).readAll('repos')) {
		const dest = repoPath(ws, fields);
		out.push({ id, path: relPath(ws.root, dest), present: fs.existsSync(dest) });
	}
	return out;
}

function materializeRepo(ws, id, fields) {
	const dest = repoPath(ws, fields);
	const ref = fields.ref ?? 'main';
	const rp = relPath(ws.root, dest);
	if (fs.existsSync(dest)) {
		// same contract as install(): warn on drift, never force-sync, never touch a dirty tree
		const head = tryGit(dest, ['rev-parse', '--abbrev-ref', 'HEAD']);
		const dirty = tryGit(dest, ['status', '--porcelain']);
		if (head && head !== ref) {
			console.warn(`⚠ ${rp}: HEAD is ${head}, record says ${ref} — not touching it${dirty ? ' (dirty)' : ''}`);
		}
		return { id, path: rp, present: true, cloned: false, ref: head ?? ref };
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	console.log(`… cloning ${fields.url} → ${rp} (${ref})`);
	execFileSync('git', ['clone', '--branch', ref, fields.url, dest], { stdio: 'inherit' });
	// NO buildClone() here, unlike install(): a prototype or app repo is not an npm module and
	// must never have `npm install` run in it as a side effect of being materialized.
	return { id, path: rp, present: true, cloned: true, ref };
}
