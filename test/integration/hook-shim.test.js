// test/integration/hook-shim.test.js — the ONE file in this repo that is not JavaScript, tested as
// what it actually is: a POSIX `sh` script run with no environment at all.
//
// ⚠ MEASURED, NOT REASONED (spec §15). A harness hook is `sh -c`, and `sh` reads NO startup file —
// not `.zshenv`, not `.bash_profile`, not `.bashrc`. On the machine where this was found:
//
//     env -i zsh -c 'command -v node'   →  ~/.nvm/versions/node/<v>/bin/node
//     env -i sh  -c 'command -v node'   →  NOT FOUND
//
// So the first live worktree spawn ran a session-start hook that could not find `node`, could not
// find `npm`, and said nothing about it — a fresh worktree has no `node_modules`, so there is no
// in-tree engine to fall back to either. The failure was total and silent. No profile edit can fix
// it (`bash -c` and `sh -c` were both measured ✖ after one was applied), and a profile is
// per-machine and outside the repo anyway, so the resolution has to travel WITH the workspace.
//
// Hence: every assertion below runs the shim under `env -i` with a PATH this file controls. A test
// that inherited the runner's PATH would pass on a developer's machine for the one reason the shim
// exists to not depend on.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ENGINE_ROOT } from '../helpers/ws.js';

const SHIM = path.join(ENGINE_ROOT, 'bin', 'dt-hook.sh');
const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).version;

// The line the operator sees in the session's context when nothing resolves. It is a CONTRACT: it
// is the only output of a hook that has failed, so it has to name the fix rather than the symptom.
const NOT_FOUND = '✖ dreamteamer hook: node not found — set DREAMTEAMER_NODE=/path/to/node in the harness environment, or install node under ~/.nvm, /opt/homebrew or /usr/local';

// The two absolute fallbacks are properties of the MACHINE, so what "no node anywhere" means here
// is machine-dependent — and asserting the failure unconditionally would be a test that passes for
// the wrong reason on a Homebrew box. Read them, then assert whichever outcome is correct.
const ABSOLUTE_FALLBACKS = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].filter((p) => fs.existsSync(p));
// A node on the bare PATH this file grants would win at `command -v`, before either later step is
// reached — so the steps below it cannot be observed on such a machine.
const ON_BARE_PATH = fs.existsSync('/usr/bin/node') || fs.existsSync('/bin/node');

/** Run the shim with an environment built from nothing. `sh` and the utilities the resolver uses
 *  (`ls`, `sort`, `tail`, `dirname`) come from /usr/bin and /bin; nothing else is on PATH. */
function shim(env, ...args) {
	// ⚠ AN EXPLICIT cwd, ALWAYS. A cwd-less spawn runs in the ENGINE CHECKOUT, and some verbs write
	// there and self-commit — one `init` with no cwd turned this repo into a workspace and swept
	// every uncommitted file into a commit titled "init workspace". os.tmpdir() is nobody's repo.
	const r = spawnSync('env', ['-i', 'PATH=/usr/bin:/bin', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
		'sh', SHIM, ...args], { encoding: 'utf8', cwd: os.tmpdir() });
	return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dt-shim-'));

/** A fake `node` that answers with its own marker — enough to prove WHICH candidate the resolver
 *  chose without caring what it was asked to run. */
function fakeNode(dir, marker) {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'node');
	fs.writeFileSync(p, `#!/bin/sh\necho "${marker}"\n`);
	fs.chmodSync(p, 0o755);
	return p;
}

describe('bin/dt-hook.sh resolves node where a hook has no PATH', () => {
	test('$DREAMTEAMER_NODE wins, and the engine actually runs', () => {
		const r = shim({ HOME: os.homedir(), DREAMTEAMER_NODE: process.execPath }, '--version');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), `dreamteamer@${VERSION}`);
	});

	// ⚠ `sort -V`, NOT `sort`. Lexicographically v9.9.9 sorts AFTER v10.10.0, so a plain sort hands
	// a hook the oldest nvm install on the disk — which is exactly the one whose node_modules the
	// operator has not looked at for a year.
	test('the HIGHEST ~/.nvm version wins — version order, not lexicographic', (t) => {
		if (ON_BARE_PATH) return t.skip('node is on /usr/bin or /bin here — `command -v` wins before nvm is reached');
		const home = tmp();
		fakeNode(path.join(home, '.nvm/versions/node/v9.9.9/bin'), 'chose-9.9.9');
		fakeNode(path.join(home, '.nvm/versions/node/v10.10.0/bin'), 'chose-10.10.0');
		const r = shim({ HOME: home }, '--version');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), 'chose-10.10.0');
	});

	test('$DREAMTEAMER_NODE is preferred over an nvm install', (t) => {
		if (ON_BARE_PATH) return t.skip('node is on /usr/bin or /bin here');
		const home = tmp();
		fakeNode(path.join(home, '.nvm/versions/node/v99.0.0/bin'), 'chose-nvm');
		const explicit = fakeNode(path.join(tmp(), 'bin'), 'chose-explicit');
		const r = shim({ HOME: home, DREAMTEAMER_NODE: explicit }, '--version');
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), 'chose-explicit');
	});

	// ⚠ IT FAILS ON STDOUT, and that is the whole design. A hook's stderr is nobody's problem — it
	// goes to a log the session never reads — while its stdout is added to the session's context.
	// A silent hook failure is what §15 measured; this line is the fix.
	test('nothing resolves → exit 1 and the exact line, on STDOUT', (t) => {
		if (ON_BARE_PATH) return t.skip('node is on /usr/bin or /bin here — nothing can be made to not resolve');
		const r = shim({ HOME: path.join(tmp(), 'no-such-home') }, '--version');
		if (ABSOLUTE_FALLBACKS.length) {
			// This machine HAS node at an absolute fallback, so resolving is the correct answer and
			// the failure line is unreachable here. The literal is still pinned below.
			assert.equal(r.code, 0, r.stderr);
			assert.equal(r.stdout.trim(), `dreamteamer@${VERSION}`);
			return;
		}
		assert.equal(r.code, 1, `it found a node it should not have:\n${r.stdout}`);
		assert.equal(r.stdout.trim(), NOT_FOUND);
		assert.equal(r.stderr.trim(), '', 'the failure must not go to a log nobody reads');
	});

	// The literal, pinned whatever this machine happens to have installed — the assertion above is
	// conditional and this one never is.
	test('the failure line in the script is the contract, byte for byte', () => {
		assert.ok(fs.readFileSync(SHIM, 'utf8').includes(NOT_FOUND), 'the failure line drifted from the contract');
	});

	// ⚠ RESOLVING npm ABSOLUTELY IS ONLY HALF THE JOB, and the other half was found by walking this
	// flow rather than by reading it. npm's own shebang is `#!/usr/bin/env node`, so the npm the
	// engine resolves beside `process.execPath` was spawned successfully and then died at exit 127
	// with `env: node: No such file or directory` — the interpreter lookup, one level below the one
	// the shim fixes. So the whole chain is walked here, end to end, in the environment a hook
	// actually gets: shim → engine → npm → npm's own node.
	test('the npm step survives a hook environment — the whole chain, under env -i', (t) => {
		if (!fs.existsSync(process.execPath)) return t.skip('no node to point at');
		const dir = tmp();
		spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
		const init = spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js'), 'init'], { cwd: dir, encoding: 'utf8' });
		assert.equal(init.status, 0, init.stderr + init.stdout);

		const r = spawnSync('env', ['-i', 'PATH=/usr/bin:/bin', `HOME=${os.homedir()}`, 'sh', SHIM, 'install'],
			{ cwd: dir, encoding: 'utf8' });
		const out = (r.stdout ?? '') + (r.stderr ?? '');
		assert.doesNotMatch(out, /env: node: No such file/, 'npm could not find its own interpreter');
		assert.doesNotMatch(out, /engine failed \(exit 127\)/, out);
		assert.match(out, /engine: npm/, out);
		assert.equal(r.status, 0, out);
	});

	test('the shim ships in the npm tarball', () => {
		const files = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).files;
		assert.ok(files.includes('bin') || files.includes('bin/dt-hook.sh'), 'bin/dt-hook.sh is not published');
	});
});
