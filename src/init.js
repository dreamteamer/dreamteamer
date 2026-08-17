// dreamteamer init — write the workspace skeleton into the current directory.
// non-interactive: flags override sensible defaults (RAD phase; prompts later).
// never compiles — compile is always explicit.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { discoverModules, KINDS } from './compile.js';
import { Store } from './store.js';

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
const QUIET = ['ignore', 'pipe', 'ignore'];


const SKELETON_KINDS = ['collections', 'skills', 'agents', 'commands', 'ui-views'];

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

// A brand-new workspace with no collections gives a user nothing to run, and makes `compile` warn
// that the module `init` just created "contributed no recognised sources" — a warning about its own
// output, which reads as a broken install. One starter collection answers both. `notes` is
// deliberately the most generic thing a workspace can hold.
const STARTER_COLLECTION = `name: notes
storage:
  path: data/notes
  codec: md
  shape: file
  suffix: note
id:
  generate: '{{ created | date }}--{{ title | slug }}'
  pattern: ^\\d{4}-\\d{2}-\\d{2}--[a-z0-9-]+$
schema:
  type: object
  required:
    - title
  properties:
    title:
      type: string
      description: What this note is called.
    body:
      type: string
      format: markdown
      x-body: true
      description: The note itself.
icon: sticky_note_2
title: Notes
title_template: '{{ title }}'
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
		// The workspace's own sources live in `modules/default/`, and the folder is named for its ROLE,
		// not for the vault. It used to be named after the workspace, and that name went stale twice in
		// one repo (`hq3` → `gk`, decision 213 reversed by 224) — each rename rewriting every path that
		// RESOLVES while the historical documents deliberately kept the old spelling, so a stale-looking
		// `modules/hq3` was correct in prose and a bug in a path. A role name cannot go stale.
		//
		// `default` is deliberately the same word `RESERVED_NAMESPACES` holds (namespace.js): this module
		// owns the DEFAULT-namespace collections, and the default namespace is the empty prefix. The one
		// misreading it invites — `default/tasks` — is a compile error whose message states the rule.
		// Override with `--workspace-module <name>` if a workspace wants its own spelling.
		'workspace-module': flags['workspace-module'] ?? 'default',
		'git-modules': {},
		disable: [],
		...pkg.dreamteamer,
	};
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	// folder skeleton — the workspace's own sources are an inline module, kinds FLAT at its root
	const wm = pkg.dreamteamer['workspace-module'];
	const systemRoot = wm ? path.join(root, 'modules', wm) : root;
	for (const kind of SKELETON_KINDS) fs.mkdirSync(path.join(systemRoot, kind), { recursive: true });
	if (wm) {
		const modulePkg = path.join(systemRoot, 'package.json');
		if (!fs.existsSync(modulePkg)) {
			// `files` is the npm publish surface: every kind a module can ship, since a new one here
			// is an engine change that would otherwise silently stop being packaged.
			fs.writeFileSync(modulePkg, JSON.stringify({ name: wm, private: true, version: '0.0.1', files: [...KINDS], dreamteamer: {} }, null, '\t') + '\n');
		}
	}
	// one starter collection, so `compile` has something to report instead of warning about the
	// empty module it just made, and so a fresh workspace has something to run.
	const starter = path.join(systemRoot, 'collections', 'notes.collection.yaml');
	if (!fs.existsSync(starter)) fs.writeFileSync(starter, STARTER_COLLECTION);
	fs.mkdirSync(path.join(root, dataPath), { recursive: true });
	fs.mkdirSync(path.join(root, 'state'), { recursive: true });

	// NO user record is seeded, and there is no `users` collection — both removed from core in 0.8.0.
	// It failed the "does the ENGINE read it?" test on a circular justification: `users` was core
	// because `@me` resolved against it, and `@me` existed because `users` was core. Nothing else in
	// the compiler, the store or `check` ever read a user record. One record per workspace, whose only
	// job was to restate `git config user.name` in a file that then had to AGREE with it — and when it
	// disagreed the symptom was an empty inbox with no error (decision 99b), a trap that now cannot
	// happen because there is nothing to disagree with.
	//
	// A workspace that needs people as records ships its own collection (a module's `contacts` already
	// does), and reads the operator from git where it needs one. `teams` went the same way 2026-07-31.

	// .gitignore + .env.example (append-if-missing, never clobber)
	appendMissing(path.join(root, '.gitignore'), GITIGNORE);
	if (!fs.existsSync(path.join(root, '.env.example'))) fs.writeFileSync(path.join(root, '.env.example'), ENV_EXAMPLE);

	// one init commit (if we're in a git repo)
	try {
		// stdio ignored on purpose: this whole block is best-effort, and execFileSync forwards the
		// child's stderr to ours by default — so a plain `dreamteamer init` in a non-git folder
		// printed git's raw "fatal: not a git repository" above our own handled warning.
		execFileSync('git', ['add', '--all'], { cwd: root, stdio: 'ignore' });
		execFileSync('git', ['commit', '--quiet', '-m', `dreamteamer: init workspace ${name}`], { cwd: root, stdio: 'ignore' });
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
	const unreachable = [];
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
		try {
			execFileSync('git', ['clone', '--branch', ref, url, dest], { stdio: 'inherit' });
		} catch {
			// one unreachable clone must not abandon the rest. the lockfile is a map of PRIVATE
			// repos as often as public ones, so "the current credentials cannot see this one" is
			// ordinary — a fresh machine, a collaborator, a cloud sandbox. aborting there left a
			// half-restored workspace and named only the first failure.
			fs.rmSync(dest, { recursive: true, force: true }); // git leaves the partial dir behind
			unreachable.push(name);
			console.warn(`⚠ git_modules/${name}: clone failed — skipped (${url})`);
			continue;
		}
		buildClone(dest, name);
	}
	// non-zero, because the workspace is NOT what the lockfile describes: modules are missing and
	// `check` will report references into them as unknown collections.
	if (unreachable.length) console.error(`✖ ${unreachable.length} module(s) could not be cloned: ${unreachable.join(', ')}`);
	return unreachable.length ? 1 : 0;
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
	try { return execFileSync('git', args, { cwd, stdio: QUIET }).toString().trim() || null; } catch { return null; }
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
 * The engine deliberately does NOT know what `identity` means: a workspace may use it to select a
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
