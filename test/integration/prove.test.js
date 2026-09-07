// test/integration/prove.test.js — tier 2: `proofs`, the eighth source kind.
//
// THE ONE tier-2 file for the whole `dt prove` slice (each tier-2 file costs ~2s of fixture build,
// so this one grows rather than splitting). Two blocks so far:
//
//   `the proofs kind`        — Task 1: a new STAGED kind, generic for free (list/get/set/rm/rename),
//                              refused as hand-authored on `add`, and the design bug the spike found
//                              (the ledger dir must be dot-prefixed, because compile wipes every kind
//                              folder on every run).
//   `compile validates proofs` — Task 2: every proof checked against the descriptors, one coverage
//                              line on every compile, one nudge per new artifact with no proof.
//
// A proof's own semantics are unit-tested where they are written (`test/unit/prove.test.js`); what
// this file proves is that compile actually CALLS that judgement and refuses on it.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspace, readFile, compileError, simpleCollection, writeCollection, dt } from '../helpers/ws.js';
import { USAGE, WORKSPACE_FLAGS } from '../../src/cli.js';
import {
	artifactRefs, PROOF_KINDS, PROOF_MODES,
	countMatching, pickFixture, resolveRequires,
	ledgerPath, readLedger, appendLedger, pendingFor, LEDGER_CAP, LEDGER_DIR,
} from '../../src/prove.js';
import { readManifest } from '../../src/runtime.js';
import { recordResolver } from '../../src/record-commands.js';
import { removeWorktree } from '../../src/checkout.js';
import { findWorkspace } from '../../src/workspace.js';

/** compile's `entries` Map, reconstructed from what compile WROTE — the manifest names every entry
 *  by its runtime-relative path, and the bytes are on disk beside it. Lets a test drive
 *  `artifactRefs`'s compile-side path from outside compile, which is the only way to assert that
 *  both of its inputs answer the same thing. */
function runtimeEntries(root) {
	const manifest = readManifest(root);
	return new Map(Object.entries(manifest.entries).map(([rt, e]) => [rt, {
		sources: e.sources,
		bytes: fs.readFileSync(path.join(root, '.dreamteamer', rt)),
	}]));
}
import { dump, load } from '../../src/yaml.js';
import { Store } from '../../src/store.js';

/** Write a minimal proof source at `modules/default/proofs/<id>.proof.yaml`.
 *
 *  ⚠ `about` names `skills/using-dreamteamer` — the one skill EVERY fixture has, shipped by the
 *  engine through `node_modules/dreamteamer`. It used to name an invented skill, which was fine
 *  while compile only STAGED a proof; from Task 2 on, compile resolves every `about` against the
 *  artifacts it actually compiled, so an invented one is a compile failure. */
function writeProof(root, id, fields = {}) {
	const file = path.join(root, 'modules', 'default', 'proofs', `${id}.proof.yaml`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// a gate with no `steps` proves nothing, and compile says so from Task 2 on — so the default
	// carries the cheapest step there is.
	fs.writeFileSync(file, dump({ name: id, about: ['skills/using-dreamteamer'], kind: 'gate', steps: [{ run: 'true' }], ...fields }));
	return file;
}

describe('the proofs kind', () => {
	test('compile stages it, counted in the summary line', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /1 proofs/);
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', 'proofs', 'skill-loads.proof.yaml')));
	});

	test('list and get read it back through the store, for free', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		assert.equal(ws.dt('compile').code, 0);

		const listed = ws.dt('list', 'proofs');
		assert.equal(listed.code, 0, listed.stderr);
		assert.match(listed.stdout, /skill-loads/);

		const got = ws.dt('get', 'proofs/skill-loads', '--json');
		assert.equal(got.code, 0, got.stderr);
		assert.equal(JSON.parse(got.stdout).kind, 'gate');
	});

	test('add is refused as hand-authored, naming the exact file to write', () => {
		const ws = workspace();
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('add', 'proofs', '--name', 'x');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /a proof is hand-authored/);
		assert.match(res.stderr, /modules\/default\/proofs\/x\.proof\.yaml/);
	});

	test('set writes the frontmatter and self-commits, like every system write', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('set', 'proofs/skill-loads', 'description=The skill loads on the trigger.');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const src = readFile(ws.root, 'modules/default/proofs/skill-loads.proof.yaml');
		assert.match(src, /description: The skill loads on the trigger\./);
		// self-commits, like every system write (policy stated once in `dt help`) — assert the
		// commit actually landed, not just that the printed line CLAIMS it did.
		assert.match(res.stdout, /✔ committed in the workspace/);
		assert.match(ws.git(['log', '-1', '--format=%s']), /proofs set skill-loads description/);
	});

	// ⚠ A SYSTEM WRITE IS GATED BY A REAL COMPILE, and from Task 2 on that compile judges a proof's
	// semantics — so `kind=live` on its own is REFUSED, because a live proof owes a `mode` and an
	// `expect` that this one-key write cannot supply. The refusal rolls the source back: a proof that
	// says `live` and carries neither is the "fails forever for a reason nothing names" shape the
	// validation exists to prevent, and half-writing it would leave the workspace uncompilable.
	test('set is refused when the result would be an invalid proof, and the source is rolled back', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('set', 'proofs/skill-loads', 'kind=live');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /a live proof declares mode: readonly \| writes/);
		assert.match(readFile(ws.root, 'modules/default/proofs/skill-loads.proof.yaml'), /kind: gate/);
	});

	// ⚠ THE DESIGN-BUG REGRESSION — the whole reason the plan carries a §2. Every `dt compile`
	// wipes `.dreamteamer/<kind>/` for every entry of KINDS, and `proofs` is now one of them. A
	// ledger written INSIDE that folder is destroyed on the very next compile, silently, with no
	// error. The fix is a dot-prefixed SIBLING directory (`.proofs/`), which the wipe loop can never
	// name because it only ever matches bare KINDS entries and every source enumeration skips
	// dotfiles. The contrast row proves it is the dot, not luck: `proofs/x.jsonl` (no dot) is
	// wiped by the SAME compile call that leaves `.proofs/x.jsonl` untouched.
	test('the ledger dir survives compile because it is dot-prefixed — proofs/ (no dot) does not', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		assert.equal(ws.dt('compile').code, 0);

		const runtime = path.join(ws.root, '.dreamteamer');
		const survivor = path.join(runtime, '.proofs', 'x.jsonl');
		const casualty = path.join(runtime, 'proofs', 'x.jsonl');
		const row = '{"when":"2026-09-07T00:00:00+00:00","verdict":"PASS"}\n';
		fs.mkdirSync(path.dirname(survivor), { recursive: true });
		fs.writeFileSync(survivor, row);
		fs.mkdirSync(path.dirname(casualty), { recursive: true });
		fs.writeFileSync(casualty, row);

		assert.equal(ws.dt('compile').code, 0);

		assert.equal(fs.readFileSync(survivor, 'utf8'), row, '.dreamteamer/.proofs/ must survive compile untouched');
		assert.equal(fs.existsSync(casualty), false, '.dreamteamer/proofs/ is a KIND folder — compile wipes it every run');
	});

	test('check does not flag the dot-prefixed ledger as an unrecognized file', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		assert.equal(ws.dt('compile').code, 0);
		const ledgerDir = path.join(ws.root, '.dreamteamer', '.proofs');
		fs.mkdirSync(ledgerDir, { recursive: true });
		fs.writeFileSync(path.join(ledgerDir, 'x.jsonl'), '{"when":"2026-09-07T00:00:00+00:00","verdict":"PASS"}\n');

		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.doesNotMatch(res.stdout + res.stderr, /unrecognized file/);
	});

	test('the compiled CLAUDE.md names proofs/ as a source to write', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		assert.equal(ws.dt('compile').code, 0);
		const claude = readFile(ws.root, 'CLAUDE.md');
		const sourcesBlock = /sources \(write\):[\s\S]*?\(see manifest for channels\)/.exec(claude)?.[0];
		assert.ok(sourcesBlock, 'CLAUDE.md should carry a "sources (write):" paragraph');
		assert.match(sourcesBlock, /`proofs\/`/);
	});

	// ⚠ R8: `given.collection` is a PLAIN collection NAME, never an `x-reference`. `notes` (not
	// `collections/notes`) is the documented form — with an x-reference the ajv schema would want a
	// `<collection>/<id>` shape and `dt check`'s x-reference resolution (parseRef, which returns null
	// for a slashless value) would flag the documented spelling as unresolvable. This is a `live`
	// proof rather than a `gate` one purely to exercise `given` at all; Task 1 does not validate its
	// cross-field rules (exactly one of where/fixture, pick: latest needing a sort_field, …).
	test('given.collection is a bare collection name, not a reference — compiles and check is silent about it', () => {
		const ws = workspace();
		writeProof(ws.root, 'live-proof', {
			kind: 'live',
			mode: 'readonly',
			// a NAMED record, not `pick: latest` — `notes` declares no `sort_field`, and from Task 2
			// on compile refuses `latest` on a collection that cannot be ordered.
			given: { collection: 'notes', where: {}, pick: 'a-note' },
			steps: [{ run: 'true' }],
			expect: [{ collection: 'notes', where: {}, count: { _gte: 0 } }],
		});
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.doesNotMatch(res.stdout + res.stderr, /given\.collection/);
		assert.doesNotMatch(res.stdout + res.stderr, /notes/);
	});

	// ⚠ THE SPLIT MOVED IN TASK 2, and this test is where it is pinned. Task 1 staged a proof
	// unconditionally and left every semantic judgement to `check`'s ajv pass, so an invalid `kind`
	// compiled clean. Compile now validates what it INTERPRETS — the same posture as a ui-view
	// filter — so `kind` fails at compile, and ajv remains the gate for what compile does not
	// interpret (a wrong TYPE on a key whose meaning the engine never reads).
	test('an invalid kind now FAILS compile, and ajv still gates what compile does not interpret', () => {
		const ws = workspace();
		writeProof(ws.root, 'bad-kind', { kind: 'nope' });
		const compiled = ws.dt('compile');
		assert.equal(compiled.code, 1, 'compile validates a proof\'s vocabulary now');
		assert.match(compiled.stderr, /proofs\/bad-kind\.proof\.yaml: kind must be gate or live/);

		// `external` is a boolean the engine reads only when SELECTING proofs to run — compile does
		// not interpret it, so ajv is still the gate that catches a wrong type there.
		const ws2 = workspace();
		writeProof(ws2.root, 'bad-external', { external: 'yes' });
		assert.equal(ws2.dt('compile').code, 0, 'compile judges vocabulary, not every JSON type');
		const res = ws2.dt('check');
		assert.notEqual(res.code, 0, 'check runs ajv over every runtime-stored record, including proofs');
		assert.match(res.stdout + res.stderr, /field external: "yes" must be boolean/);
	});

	// ⚠ THE ENUM PIN THAT SURVIVED THE MOVE. While compile ignored a proof's semantics, `kind` was
	// pinned by an ajv test on an invalid value; now compile refuses that value before anything is
	// staged, so ajv can never see it and the old assertion is unreachable. What is worth pinning is
	// the thing that can actually drift: the descriptor's closed enums and the code constants that
	// name the same vocabulary. Widen one without the other and this fails.
	test('the descriptor\'s kind and mode enums ARE the code constants', () => {
		const ws = workspace();
		const d = new Store(ws.ws).descriptors.get('proofs');
		assert.deepEqual(d.schema.properties.kind.enum, PROOF_KINDS);
		assert.deepEqual(d.schema.properties.mode.enum, PROOF_MODES);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Task 2 — compile VALIDATES every proof against the descriptors, COUNTS coverage on every run,
// and NUDGES once per new artifact that has no proof.
//
// The three failures this block exists to prevent, all of them silent before it:
//   1. `about: skills/greter` — a proof that proves nothing about anything, and never says so.
//   2. `where: { statuz: … }` — a filter that narrows to zero rows, so a `count` expectation
//      passes or fails forever for a reason no output names.
//   3. a command or script that nobody ever wrote a proof for — invisible until someone asks.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('compile validates proofs', () => {
	// ⚠ THE COVERAGE LINE IS PINNED EXACTLY, not matched loosely. The whole value of the line is
	// that the denominators are the artifacts this workspace actually compiled — a regex that
	// tolerated `skills 0/0` would pass on a broken enumerator counting nothing. What the base
	// fixture ships, measured: ONE skill (`using-dreamteamer`, from node_modules/dreamteamer) and
	// ONE module script (that package's `bin/dreamteamer.js`); no commands, no bindings. The two
	// lines differ in exactly one place — the skill numerator — which is the whole assertion.
	const COVERED = 'proofs: 1 declared · commands 0/0 · skills 1/1 · scripts 0/1 · bindings 0/0';
	const UNCOVERED = 'proofs: 0 declared · commands 0/0 · skills 0/1 · scripts 0/1 · bindings 0/0';

	test('an about that names no artifact FAILS compile, listing the four forms', () => {
		const ws = workspace({ compile: false });
		writeProof(ws.root, 'skill-loads', { about: ['skills/greter'] });
		const err = compileError(ws.ws);
		assert.match(err ?? '', /proofs\/skill-loads\.proof\.yaml: about "skills\/greter" names no artifact/);
		assert.match(err ?? '', /an artifact is skills\/<id>, commands\/<id>, command-bindings\/<id>, or <module>\/bin\/<file>/);
	});

	test('a missing about FAILS compile', () => {
		const ws = workspace({ compile: false });
		const file = path.join(ws.root, 'modules', 'default', 'proofs', 'no-about.proof.yaml');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, dump({ name: 'no-about', kind: 'gate', steps: [{ run: 'true' }] }));
		assert.match(compileError(ws.ws) ?? '', /proofs\/no-about\.proof\.yaml: about is required and names at least one artifact/);
	});

	test('a where naming a field the collection does not have FAILS compile', () => {
		const ws = workspace({ compile: false });
		writeProof(ws.root, 'note-lives', {
			kind: 'live',
			mode: 'readonly',
			given: { collection: 'notes', where: { titel: { _eq: 'x' } }, pick: 'a-note' },
			steps: [{ run: 'true' }],
			expect: [{ collection: 'notes', where: {}, count: { _gte: 1 } }],
		});
		assert.match(compileError(ws.ws) ?? '', /proofs\/note-lives\.proof\.yaml: where names "titel", which notes has no field for/);
	});

	test('an undeclared requires.env key FAILS compile, naming both places it can be declared', () => {
		const ws = workspace({ compile: false });
		writeProof(ws.root, 'needs-key', { requires: { env: ['SOME_TOKEN'] } });
		assert.match(compileError(ws.ws) ?? '', /requires\.env "SOME_TOKEN" is not declared — add it to dreamteamer\.vars or a module's dreamteamer\.env/);
	});

	test('a declared var satisfies requires.env', () => {
		const ws = workspace({ compile: false, pkg: { vars: ['SOME_TOKEN'] } });
		writeProof(ws.root, 'needs-key', { requires: { env: ['SOME_TOKEN'] } });
		assert.equal(compileError(ws.ws), null);
	});

	// ⚠ R17 — A BRACE TYPO IS A WARNING HERE, NOT A REFUSAL, and this is where the net lives now.
	// It used to be `substitute` throwing at RUN time on any brace it did not own, which killed
	// `awk '{print $1}'` in a step. Static, advisory, and named: compile prints the token, the proof
	// compiles, and a proof that really did mean the shell keeps working.
	test('a brace nobody substitutes is WARNED about at compile, and the proof still compiles', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads', { steps: [{ run: 'echo {recrod}' }] });
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(
			(res.stdout + res.stderr).includes('⚠ proofs/skill-loads.proof.yaml: step 1 uses "{recrod}" — only {record} and {record.<field>} are substituted; the rest reaches the shell as written'),
			res.stdout + res.stderr,
		);
	});

	test("awk '{print $1}' in a run step compiles with no warning at all", () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads', { steps: [{ run: "awk '{print $1}' f" }] });
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.doesNotMatch(res.stdout + res.stderr, /only \{record\} and \{record\.<field>\} are substituted/);
	});

	test('a valid proof compiles, and the coverage line names every artifact kind', () => {
		const ws = workspace();
		writeProof(ws.root, 'skill-loads');
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(res.stdout.split('\n').includes(COVERED), res.stdout);
	});

	test('the coverage line prints on EVERY compile, including one with no proofs at all', () => {
		const ws = workspace();
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(res.stdout.split('\n').includes(UNCOVERED), res.stdout);
	});

	// ⚠ ONE nudge per NEW artifact, and only once. 44 warnings on the day a workspace adopts proofs
	// is the noise that gets every nudge ignored — so "new" means "absent from the PREVIOUS
	// manifest", and a first-ever compile (no previous manifest) nudges nothing.
	test('a new command with no proof is nudged once, and the second compile is silent about it', () => {
		const ws = workspace();
		const dir = path.join(ws.root, 'modules', 'default', 'commands');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'hello.command.md'), '---\nname: hello\ndescription: Say hello.\n---\n\nSay hello.\n');

		const first = ws.dt('compile');
		assert.equal(first.code, 0, first.stdout + first.stderr);
		assert.ok(first.stdout.includes('no proof yet for commands/hello — modules/default/proofs/hello.proof.yaml (see using-dreamteamer › proofs)'), first.stdout);

		const second = ws.dt('compile');
		assert.equal(second.code, 0, second.stdout + second.stderr);
		assert.doesNotMatch(second.stdout, /no proof yet for commands\/hello/);
		// still COUNTED, though — an artifact stops being new, it does not stop being uncovered
		assert.ok(second.stdout.includes('commands 0/1'), second.stdout);
	});

	test('a new command that HAS a proof is not nudged at all', () => {
		const ws = workspace();
		const dir = path.join(ws.root, 'modules', 'default', 'commands');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'hello.command.md'), '---\nname: hello\ndescription: Say hello.\n---\n\nSay hello.\n');
		writeProof(ws.root, 'hello-runs', { about: ['commands/hello'] });

		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.doesNotMatch(res.stdout, /no proof yet/);
		assert.ok(res.stdout.includes('commands 1/1'), res.stdout);
	});

	test('`add skills` ends with the nudge naming the proof file to write', () => {
		const ws = workspace();
		const res = ws.dt('add', 'skills', '--name', 'greeter', '--description', 'x');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(
			res.stdout.trim().split('\n').pop(),
			'no proof yet — modules/default/proofs/greeter.proof.yaml (see using-dreamteamer › proofs)',
			res.stdout,
		);
	});

	// ⚠ TWO CALLERS, ONE ANSWER. compile reads `artifactRefs` off its in-flight `entries`; a CLI-time
	// caller (`prove --missing`) has only a Store. If the two enumerations ever disagree, "covered"
	// means one thing at compile and another at run time — so the agreement is asserted, not assumed.
	test('artifactRefs answers the same from a Store as it does from compile entries', () => {
		const ws = workspace();
		const dir = path.join(ws.root, 'modules', 'default', 'commands');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'hello.command.md'), '---\nname: hello\ndescription: Say hello.\n---\n\nSay hello.\n');
		assert.equal(ws.dt('compile').code, 0);

		// BOTH inputs, actually invoked — comparing one of them to a literal would leave the
		// agreement asserted in a comment and nowhere else.
		const fromEntries = artifactRefs(runtimeEntries(ws.root));
		const fromStore = artifactRefs(new Store(ws.ws));
		assert.deepEqual(fromEntries, fromStore);

		// and the shape both agree ON, so a matched pair of wrong answers cannot pass
		assert.deepEqual(fromEntries.skills, ['skills/using-dreamteamer'], 'a skill is its FOLDER, not its references/*.md');
		assert.deepEqual(fromEntries.commands, ['commands/hello']);
		assert.deepEqual(fromEntries.bindings, []);
		assert.deepEqual(fromEntries.scripts, ['dreamteamer/bin/dreamteamer.js'], 'a module script is <module-id>/bin/<file>');
		assert.equal(fromEntries.all.size, 3);
	});

	// ⚠ THE ROOT LAYOUT, which every path-slicing derivation gets wrong. With no `workspace-module`
	// the workspace's own sources sit at the ROOT (compile.js:619), so a command's source path is
	// `commands/hello.command.md` — no module segment to cut at. Slicing produced
	// `commands/hello.command.m/proofs/hello.proof.yaml`, a path that exists nowhere, in the one
	// message whose entire job is to name a path the reader can type.
	test('the nudge names the right path in a ROOT-layout workspace, where there is no module segment', () => {
		const ws = workspace();
		const pkgPath = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		delete pkg.dreamteamer['workspace-module'];
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		fs.mkdirSync(path.join(ws.root, 'commands'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'commands', 'hello.command.md'), '---\nname: hello\ndescription: Say hello.\n---\n\nSay hello.\n');

		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(res.stdout.includes('no proof yet for commands/hello — proofs/hello.proof.yaml (see using-dreamteamer › proofs)'), res.stdout);
		assert.doesNotMatch(res.stdout, /command\.m\/proofs|package\.json\/proofs|SKILL\.md\/proofs/);
	});

	test('`add skills` names the right path in a ROOT-layout workspace too', () => {
		const ws = workspace();
		const pkgPath = path.join(ws.root, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		delete pkg.dreamteamer['workspace-module'];
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		assert.equal(ws.dt('compile').code, 0);

		const res = ws.dt('add', 'skills', '--name', 'greeter', '--description', 'x');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.equal(
			res.stdout.trim().split('\n').pop(),
			'no proof yet — proofs/greeter.proof.yaml (see using-dreamteamer › proofs)',
			res.stdout,
		);
	});

	// a MODULE's script, in the layout where the module is not the workspace module: the root comes
	// off the module record's own `path`, so a nested or oddly-named module root is exact.
	test('a new module\'s script is nudged with that module\'s own root', () => {
		const ws = workspace();
		const mod = path.join(ws.root, 'modules', 'ops');
		fs.mkdirSync(path.join(mod, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'ops', private: true, version: '0.0.1', dreamteamer: { description: 'Operational scripts.' } }, null, '\t') + '\n');
		fs.writeFileSync(path.join(mod, 'bin', 'sweep.mjs'), '#!/usr/bin/env node\n');

		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(res.stdout.includes('no proof yet for ops/bin/sweep.mjs — modules/ops/proofs/sweep.proof.yaml (see using-dreamteamer › proofs)'), res.stdout);
	});

	test('the orientation block every session reads tells it to run `dreamteamer prove`', () => {
		const ws = workspace();
		assert.equal(ws.dt('compile').code, 0);
		const claude = readFile(ws.root, 'CLAUDE.md');
		assert.match(claude, /run `dreamteamer prove <artifact>` and quote its result/);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Task 3 — the store-bound helpers and the ledger. Tier 2 because every one of them needs either a
// compiled runtime (a descriptor, a `sort_field`, records on disk) or the filesystem itself; the
// four PURE functions the runner is built out of are pinned in test/unit/prove.test.js.
//
// ONE fixture shape for the whole block: `notes` with a `sort_field` (so `pick: latest` has an
// ordering to take the head of) and two records, `a` and `b`. `people` is here empty, because
// "zero" is the count a filter machinery gets wrong in the interesting way — an empty walk must
// answer 0, not throw and not read as unfiltered.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const NOTES = simpleCollection({
	sort_field: 'name',
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			status: { type: 'string', enum: ['open', 'done'] },
			// the hop target, so a `where` that RESOLVES a reference is expressible against this
			// fixture — the resolver path is the one countMatching argument nothing else exercises
			owner: { type: 'string', 'x-reference': 'people' },
			notes: { type: 'string', format: 'markdown', 'x-body': true },
		},
	},
});

const notesWorkspace = () => workspace({
	collections: { notes: NOTES, people: simpleCollection() },
	records: { notes: [{ name: 'a' }, { name: 'b' }] },
});

describe('prove helpers against a store', () => {
	test('countMatching counts the rows a filter keeps', () => {
		const { store } = notesWorkspace();
		assert.equal(countMatching(store, 'notes', { name: { _eq: 'a' } }, null), 1);
	});

	test('countMatching with no filter counts the whole collection', () => {
		const { store } = notesWorkspace();
		assert.equal(countMatching(store, 'notes', null, null), 2);
	});

	// ⚠ ZERO IS AN ANSWER, not an error. A `count: { _eq: 0 }` expectation over a collection nothing
	// has ever written to is the ordinary shape of "this command creates the first one", and a walk
	// that threw on a missing directory would turn it into a crash.
	test('an empty collection counts 0 rather than throwing', () => {
		const { store } = notesWorkspace();
		assert.equal(countMatching(store, 'people', {}, null), 0);
	});

	test('a filter that matches nothing counts 0', () => {
		const { store } = notesWorkspace();
		assert.equal(countMatching(store, 'notes', { status: { _eq: 'done' } }, null), 0);
	});

	// The record id is part of what a filter may test — `{ id: { _eq: 'a' } }` is how a proof asserts
	// that a named record exists — so the row handed to matchesFilter is `{ ...fields, id }`, exactly
	// what `list` builds.
	test('the id is filterable, because the row carries it like a list row does', () => {
		const { store } = notesWorkspace();
		assert.equal(countMatching(store, 'notes', { id: { _eq: 'b' } }, null), 1);
	});

	// ⚠ THE RESOLVER ARGUMENT IS LOAD-BEARING AND WAS UNEXERCISED. A `where` whose key is not an
	// operator is a one-hop relational condition, and `filter.js` NARROWS when no resolver is wired —
	// so a proof hopping `owner.name` with a null resolve counts 0 forever, with nothing wrong
	// anywhere. Both sides are asserted here so the runner cannot drop the argument silently.
	test('a where that hops a reference counts through the resolver, and narrows without one', () => {
		const { store } = workspace({
			collections: { notes: NOTES, people: simpleCollection() },
			records: { people: [{ name: 'Ada' }], notes: [{ name: 'a', owner: 'people/ada' }, { name: 'b' }] },
		});
		const where = { owner: { name: { _eq: 'Ada' } } };
		assert.equal(countMatching(store, 'notes', where, recordResolver(store)), 1);
		assert.equal(countMatching(store, 'notes', where, null), 0, 'a hop with no resolver NARROWS');
	});

	test('pickFixture with pick: latest takes the head of the sort_field, DESCENDING', () => {
		const { store } = notesWorkspace();
		const picked = pickFixture(store, { collection: 'notes', where: {}, pick: 'latest' });
		assert.equal(picked.ref, 'notes/b');
		assert.equal(picked.fields.name, 'b');
	});

	test('pickFixture with pick: <id> reads that record', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: {}, pick: 'a' }).ref, 'notes/a');
	});

	// NO-FIXTURE (exit 4) rather than a crash: a live proof whose `given` matches nothing is not a
	// failure of the artifact, and the runner has a distinct code for exactly that.
	test('pickFixture returns null for an id that is not there', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: {}, pick: 'zz' }), null);
	});

	// ⚠ NULL MEANS "NO FIXTURE", NOT "NO SUCH COLLECTION". A bare catch around `store.read` made
	// both answer null, so a proof naming a collection this workspace does not have reported
	// NO-FIXTURE (exit 4, "the proof did not run") instead of the error that names the typo.
	test('a given naming a collection that does not exist THROWS rather than reading as no-fixture', () => {
		const { store } = notesWorkspace();
		assert.throws(() => pickFixture(store, { collection: 'ghosts', where: {}, pick: 'x' }), /unknown collection "ghosts"/);
	});

	test('pickFixture returns null when the named record does not match the given where', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: { name: { _eq: 'b' } }, pick: 'a' }), null);
	});

	test('pick: latest respects the where — it is the head of the MATCHING rows', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: { name: { _eq: 'a' } }, pick: 'latest' }).ref, 'notes/a');
	});

	test('pick: latest over a where that matches nothing is null', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: { status: { _eq: 'done' } }, pick: 'latest' }), null);
	});

	// The picked record's own fields are what `{record.<field>}` substitutes from, and `id` is one of
	// them — the same row shape the filter sees, so a proof cannot find a field in one and not the other.
	test('the picked record carries its id among its fields', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: {}, pick: 'a' }).fields.id, 'a');
	});

	// --record OVERRIDES the picker rather than filtering through it: an operator who names a record
	// is telling the runner which one to use, and re-testing it against `given.where` would answer
	// NO-FIXTURE for the record they just typed.
	test('an override names the record outright, past the where', () => {
		const { store } = notesWorkspace();
		const picked = pickFixture(store, { collection: 'notes', where: { name: { _eq: 'b' } }, pick: 'latest' }, 'notes/a');
		assert.equal(picked.ref, 'notes/a');
	});

	test('an override for a record that is not there is null', () => {
		const { store } = notesWorkspace();
		assert.equal(pickFixture(store, { collection: 'notes', where: {}, pick: 'latest' }, 'notes/zz'), null);
	});

	test('an override that is not a <collection>/<id> ref is refused, naming the shape', () => {
		const { store } = notesWorkspace();
		assert.throws(() => pickFixture(store, { collection: 'notes', where: {}, pick: 'latest' }, 'a'), /--record takes a <collection>\/<id> reference/);
	});

	test('an override naming a DIFFERENT collection than the given is refused', () => {
		const { store } = notesWorkspace();
		assert.throws(() => pickFixture(store, { collection: 'notes', where: {}, pick: 'latest' }, 'people/x'), /--record people\/x is not a record of notes/);
	});

	test('resolveRequires is satisfied by a binary that is on PATH', () => {
		const { ws } = notesWorkspace();
		assert.deepEqual(resolveRequires(ws, { bin: ['node'] }), { ok: true, missing: [] });
	});

	test('a binary that is not on PATH is missing, with the fix that names PATH', () => {
		const { ws } = notesWorkspace();
		const res = resolveRequires(ws, { bin: ['definitely-not-a-binary-xyz'] });
		assert.equal(res.ok, false);
		assert.deepEqual(res.missing, [{ kind: 'bin', name: 'definitely-not-a-binary-xyz', fix: 'definitely-not-a-binary-xyz is not on PATH' }]);
	});

	// ⚠ `accessSync(X_OK)` SUCCEEDS ON A DIRECTORY — the execute bit on a directory means
	// "searchable". Without the isFile() test, a folder called `ffmpeg` anywhere on PATH satisfied
	// `requires: { bin: [ffmpeg] }`, and the proof then failed at the step with a shell error
	// instead of reporting UNAVAILABLE with a fix.
	test('a DIRECTORY on PATH named like the tool does not satisfy the requirement', () => {
		const { ws, root } = notesWorkspace();
		const dir = path.join(root, 'fake-bin');
		fs.mkdirSync(path.join(dir, 'prove-fake-tool'), { recursive: true });
		const previous = process.env.PATH;
		process.env.PATH = `${dir}${path.delimiter}${previous}`;
		try {
			const res = resolveRequires(ws, { bin: ['prove-fake-tool'] });
			assert.equal(res.ok, false);
			assert.deepEqual(res.missing, [{ kind: 'bin', name: 'prove-fake-tool', fix: 'prove-fake-tool is not on PATH' }]);
		} finally {
			process.env.PATH = previous;
		}
	});

	test('an unset env var is missing, with the fix that names .env', () => {
		const { ws } = notesWorkspace();
		const res = resolveRequires(ws, { env: ['PROVE_TEST_UNSET_VAR'] });
		assert.equal(res.ok, false);
		assert.deepEqual(res.missing, [{ kind: 'env', name: 'PROVE_TEST_UNSET_VAR', fix: 'PROVE_TEST_UNSET_VAR is not set — add it to .env' }]);
	});

	// ⚠ A KEY IN `.env` SATISFIES IT, and the value is never read. `.env` is desktop-only and its
	// values are credentials: the requirement is "this machine has it configured", which the KEY
	// answers, and parsing for names only is what keeps a secret out of every code path here.
	test('a key declared in .env satisfies the requirement, and nothing reads its value', () => {
		const { ws, root } = notesWorkspace();
		fs.writeFileSync(path.join(root, '.env'), 'PROVE_TEST_ENV_KEY=a-value-nothing-should-print\n');
		assert.deepEqual(resolveRequires(ws, { env: ['PROVE_TEST_ENV_KEY'] }), { ok: true, missing: [] });
	});

	test('a var exported into the process satisfies it too', () => {
		const { ws } = notesWorkspace();
		process.env.PROVE_TEST_PROCESS_VAR = 'x';
		try {
			assert.deepEqual(resolveRequires(ws, { env: ['PROVE_TEST_PROCESS_VAR'] }), { ok: true, missing: [] });
		} finally {
			delete process.env.PROVE_TEST_PROCESS_VAR;
		}
	});

	test('no requires at all is satisfied', () => {
		const { ws } = notesWorkspace();
		assert.deepEqual(resolveRequires(ws, undefined), { ok: true, missing: [] });
	});

	test('every missing requirement is reported, env before bin', () => {
		const { ws } = notesWorkspace();
		const res = resolveRequires(ws, { env: ['PROVE_TEST_UNSET_VAR'], bin: ['definitely-not-a-binary-xyz'] });
		assert.deepEqual(res.missing.map((m) => m.kind), ['env', 'bin']);
	});

	// ⚠ THE PATH ASSERTION, and the whole reason the plan carries a §2: `.dreamteamer/proofs/` is a
	// KIND folder that every compile wipes. The dot is what makes the ledger survive.
	test('the ledger lives under .dreamteamer/.proofs/, never .dreamteamer/proofs/', () => {
		const { root } = notesWorkspace();
		assert.equal(LEDGER_DIR, '.proofs');
		assert.equal(ledgerPath(root, 'skill-loads'), path.join(root, '.dreamteamer', '.proofs', 'skill-loads.jsonl'));
		assert.doesNotMatch(ledgerPath(root, 'skill-loads'), /\.dreamteamer[\\/]proofs[\\/]/);
	});

	test('readLedger on a proof that has never run is empty, not an error', () => {
		const { root } = notesWorkspace();
		assert.deepEqual(readLedger(root, 'never-run'), []);
	});

	test('appendLedger creates the directory on the first row and reads back what it wrote', () => {
		const { root } = notesWorkspace();
		assert.equal(fs.existsSync(path.join(root, '.dreamteamer', '.proofs')), false);
		appendLedger(root, 'skill-loads', { when: '2026-09-07T10:00:00+03:00', verdict: 'PASS', record: null });
		const rows = readLedger(root, 'skill-loads');
		assert.equal(rows.length, 1);
		assert.equal(rows[0].verdict, 'PASS');
	});

	test('one line per row — the file is JSONL, not a JSON array', () => {
		const { root } = notesWorkspace();
		appendLedger(root, 'skill-loads', { verdict: 'PASS', record: null });
		appendLedger(root, 'skill-loads', { verdict: 'FAIL', record: null });
		const text = fs.readFileSync(ledgerPath(root, 'skill-loads'), 'utf8');
		assert.equal(text.trimEnd().split('\n').length, 2);
	});

	// 51 appends, because the cap is only interesting at the boundary: the 51st row must land and the
	// FIRST one must be the row that leaves.
	test('the 51st row caps the file at 50 — the oldest goes, the newest stays', () => {
		const { root } = notesWorkspace();
		for (let i = 1; i <= LEDGER_CAP + 1; i++) appendLedger(root, 'skill-loads', { verdict: 'PASS', record: null, seq: i });
		const rows = readLedger(root, 'skill-loads');
		assert.equal(rows.length, LEDGER_CAP);
		assert.equal(rows[0].seq, 2, 'the first row is the one dropped');
		assert.equal(rows[rows.length - 1].seq, LEDGER_CAP + 1, 'the newest row is last');
	});

	// ⚠ A HAND-EDITED OR HALF-WRITTEN LINE MUST NOT BLIND THE WHOLE LEDGER. This file is per-machine
	// state under a build directory: a killed run or an editor can leave a partial line, and throwing
	// on it would make `prove` unrunnable until someone deleted evidence to get it working again.
	test('a malformed line is skipped with a warning naming its line number, and the rest read', () => {
		const { root } = notesWorkspace();
		const file = ledgerPath(root, 'skill-loads');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{"verdict":"PASS","record":null}\n{not json\n{"verdict":"FAIL","record":null}\n');
		const warnings = [];
		const warn = console.warn;
		console.warn = (...a) => warnings.push(a.join(' '));
		let rows;
		try { rows = readLedger(root, 'skill-loads'); } finally { console.warn = warn; }
		assert.deepEqual(rows.map((r) => r.verdict), ['PASS', 'FAIL']);
		assert.equal(warnings.length, 1, warnings.join('\n'));
		assert.match(warnings[0], /\.dreamteamer\/\.proofs\/skill-loads\.jsonl:2/);
	});

	test('the next append rewrites the file without the malformed line', () => {
		const { root } = notesWorkspace();
		const file = ledgerPath(root, 'skill-loads');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{"verdict":"PASS","record":null}\n{not json\n');
		const warn = console.warn;
		console.warn = () => {};
		try { appendLedger(root, 'skill-loads', { verdict: 'FAIL', record: null }); } finally { console.warn = warn; }
		assert.equal(fs.readFileSync(file, 'utf8'), '{"verdict":"PASS","record":null}\n{"verdict":"FAIL","record":null}\n');
	});

	test('pendingFor returns the PENDING row for that record', () => {
		const { root } = notesWorkspace();
		appendLedger(root, 'skill-loads', { verdict: 'PENDING', record: 'notes/a', failure_reason: null });
		const row = pendingFor(root, 'skill-loads', 'notes/a');
		assert.equal(row.verdict, 'PENDING');
		assert.equal(row.record, 'notes/a');
	});

	// ⚠ SUPERSEDING is what makes a resume safe: once the same record has a later verdict, the earlier
	// PENDING is history, and re-offering it would ask the operator to perform a step twice.
	test('a later row for the same record supersedes the PENDING', () => {
		const { root } = notesWorkspace();
		appendLedger(root, 'skill-loads', { verdict: 'PENDING', record: 'notes/a' });
		appendLedger(root, 'skill-loads', { verdict: 'PASS', record: 'notes/a' });
		assert.equal(pendingFor(root, 'skill-loads', 'notes/a'), null);
	});

	test('a later row for a DIFFERENT record supersedes nothing', () => {
		const { root } = notesWorkspace();
		appendLedger(root, 'skill-loads', { verdict: 'PENDING', record: 'notes/a' });
		appendLedger(root, 'skill-loads', { verdict: 'PASS', record: 'notes/b' });
		assert.equal(pendingFor(root, 'skill-loads', 'notes/a').verdict, 'PENDING');
	});

	test('a gate proof pends against no record at all, and null is that record', () => {
		const { root } = notesWorkspace();
		appendLedger(root, 'skill-loads', { verdict: 'PENDING', record: null });
		assert.equal(pendingFor(root, 'skill-loads', null).verdict, 'PENDING');
		assert.equal(pendingFor(root, 'skill-loads', 'notes/a'), null);
	});

	test('pendingFor on a ledger that does not exist is null', () => {
		const { root } = notesWorkspace();
		assert.equal(pendingFor(root, 'never-run', null), null);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Task 4 — THE RUNNER. `proveCommand` plus the `case 'prove':` arm: one verb, six exit codes, and a
// resume protocol for the one step a machine cannot take.
//
// ⚠ EVERY ASSERTION HERE GOES THROUGH `ws.dt(...)`, i.e. the real binary in a real workspace, and
// asserts the EXIT CODE first. The code is the contract — `dt prove` exists so a script can branch
// without parsing prose — and an in-process call to `proveCommand` would assert the return value of
// a function while leaving the CLI's own translation of it (the one thing 0.19.0 shipped broken)
// unexercised.
//
// The fixture is deliberately ONE shape for the whole block: a `notes` collection with a closed
// `status` enum and a `sort_field`, a real `close-note` command source (so the PERFORM block has a
// source path to name), a decoy `.env` value (so "no output prints a credential" is assertable),
// and six proofs covering the six states.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const PROVE_NOTES = simpleCollection({
	sort_field: 'name',
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			status: { type: 'string', enum: ['open', 'done'], default: 'open' },
			// the hop target: a `record:` expectation over a REFERENCE is the one shape that needs a
			// resolver, and `verdictLine` used to judge with none — so it narrowed to ✖ forever
			owner: { type: 'string', 'x-reference': 'people' },
			notes: { type: 'string', format: 'markdown', 'x-body': true },
		},
	},
});

/** A value no `dt prove` output may ever contain. `.env` holds credentials, and `requires.env` is
 *  checked by KEY — so the UNAVAILABLE report is the one place a value could leak. */
const DECOY = 'decoy-value-nothing-should-print';

const PROOFS = {
	'gate-passes': { kind: 'gate', steps: [{ run: "node -e 'process.exit(0)'" }] },
	'gate-fails': { kind: 'gate', steps: [{ run: "node -e 'process.exit(3)'" }] },
	// declared in `dreamteamer.vars` (so compile accepts the proof) and absent from `.env` (so the
	// machine cannot satisfy it) — the UNAVAILABLE state, which is NOT a failure of the artifact.
	'needs-a-var': { kind: 'gate', requires: { env: ['PROVE_TEST_VAR'] }, steps: [{ run: 'true' }] },
	'note-gets-closed': {
		kind: 'live',
		mode: 'readonly',
		about: ['commands/close-note'],
		given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'latest' },
		steps: [{ perform: '/close-note {record}' }],
		expect: [{ record: '{record}', where: { status: { _eq: 'done' } } }],
	},
	'counts-a-new-note': {
		kind: 'live',
		mode: 'readonly',
		about: ['commands/close-note'],
		given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'latest' },
		steps: [{ perform: 'add a note' }],
		expect: [{ collection: 'notes', where: {}, count: { _delta: 1 } }],
	},
	// every expectation already holds BEFORE the step runs — so the proof cannot fail, and a proof
	// that cannot fail is not a proof.
	'already-true': {
		kind: 'live',
		mode: 'readonly',
		given: { collection: 'notes', where: {}, pick: 'latest' },
		steps: [{ perform: 'do nothing' }],
		expect: [{ record: '{record}', where: { name: { _nempty: true } } }],
	},
};

/** The fixture, compiled, with every proof above on disk.
 *  `records` overrides the two default notes (both `open`, so `pick: latest` is `notes/b`). */
function proveWorkspace(opts = {}) {
	const ws = workspace({
		// PROVE_TEST_VAR is declared and NEVER given a value (the UNAVAILABLE state); PROVE_FIX_DIR is
		// declared AND valued, so a `path:` expectation has a real machine-dependent folder to render.
		pkg: { vars: ['PROVE_TEST_VAR', 'PROVE_FIX_DIR'] },
		collections: { notes: PROVE_NOTES, people: simpleCollection() },
		records: { people: opts.people ?? [], notes: opts.notes ?? [{ name: 'a' }, { name: 'b' }] },
	});
	const cmdDir = path.join(ws.root, 'modules', 'default', 'commands');
	fs.mkdirSync(cmdDir, { recursive: true });
	fs.writeFileSync(path.join(cmdDir, 'close-note.command.md'), '---\nname: close-note\ndescription: Close one note.\n---\n\nSet the note\'s status to done.\n');
	// ⚠ THE VALUE GOES IN THE WORKSPACE'S `.env`, not `process.env`: `envContext(ws)` — the ONE
	// resolver `dt resolve` uses — reads `.env` for values and package.json for what is DECLARED, so
	// exporting the var into the test process would render nothing and prove nothing.
	fs.writeFileSync(ws.root + '/.env', `PROVE_DECOY_KEY=${DECOY}\nPROVE_FIX_DIR=${path.join(ws.root, 'made')}\n`);
	for (const [id, fields] of Object.entries({ ...PROOFS, ...(opts.proofs ?? {}) })) {
		writeProof(ws.root, id, { about: ['skills/using-dreamteamer'], ...fields });
	}
	const compiled = ws.dt('compile');
	assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
	return ws;
}

const tail = (root, id) => {
	const rows = readLedger(root, id);
	return rows[rows.length - 1] ?? null;
};

describe('dt prove — a gate, and what the ledger records about it', () => {
	test('a gate whose step exits 0 PASSES at code 0, and the ledger row names this machine', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'gate-passes');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /^PASS  gate-passes/m);

		const rows = readLedger(ws.root, 'gate-passes');
		assert.equal(rows.length, 1, JSON.stringify(rows));
		assert.equal(rows[0].verdict, 'PASS');
		// ⚠ THE LEDGER IS PER-MACHINE EVIDENCE, so the machine is part of the row. A row with no
		// `machine` cannot answer "did this ever pass HERE", which is the only question it exists for.
		assert.equal(rows[0].machine, os.hostname());
		assert.equal(rows[0].record, null, 'a gate pends and passes against no record');
		assert.equal(typeof rows[0].duration_ms, 'number');
		assert.equal(rows[0].failure_reason, null);
		assert.equal(rows[0].sandbox, null);
		assert.equal(rows[0].steps.length, 1);
		assert.equal(rows[0].steps[0].exit, 0);
	});

	// ⚠ A NON-ZERO STEP EXIT IS NOT "the expectations failed" — the proof never got as far as judging
	// anything, and a verdict line about an expectation would be a claim nothing measured. So the
	// failure names the STEP, and `failure_reason` carries the exit code a script can branch on.
	test('a gate whose step exits non-zero FAILS at the step, naming the step and the code', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'gate-fails');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /FAIL at step 1/);
		assert.equal(tail(ws.root, 'gate-fails').failure_reason, 'step 1 exited 3');
	});

	test('the step line reports the command and its exit with a duration', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'gate-passes');
		assert.match(res.stdout, /^RUN 1  node -e 'process\.exit\(0\)'$/m);
		assert.match(res.stdout, /^ {2}exit 0 \(\d+ ms\)$/m);
	});

	// ⚠ UNAVAILABLE IS NOT FAIL, and the distinction is the whole reason for a third code: "this
	// machine cannot answer the question" must never read as "the artifact is broken".
	test('a requirement this machine cannot meet is UNAVAILABLE at code 3, with the fix', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'needs-a-var');
		assert.equal(res.code, 3, res.stdout + res.stderr);
		assert.match(res.stdout, /UNAVAILABLE/);
		assert.match(res.stdout, /PROVE_TEST_VAR is not set/);
		assert.equal(tail(ws.root, 'needs-a-var').verdict, 'UNAVAILABLE');
	});

	// The one place a credential could reach stdout: `.env` is read to decide whether a KEY is
	// configured, and a report that printed the pair would put a secret in a terminal and a CI log.
	test('the UNAVAILABLE report never prints a value out of .env', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'needs-a-var');
		assert.ok(!(res.stdout + res.stderr).includes(DECOY), 'a .env VALUE reached the output');
	});

	// ⚠ THE LEDGER LIVES BESIDE THE KIND FOLDER, NEVER INSIDE IT — compile wipes `.dreamteamer/proofs/`
	// on every run, so a row written there is destroyed silently. Asserted from the RUNNER's side here:
	// the file the runner actually created is the dot-prefixed one, and the kind folder holds sources only.
	test('the runner writes its ledger to .dreamteamer/.proofs/, and the kind folder stays sources-only', () => {
		const ws = proveWorkspace();
		assert.equal(ws.dt('prove', 'gate-passes').code, 0);
		assert.ok(fs.existsSync(path.join(ws.root, '.dreamteamer', '.proofs', 'gate-passes.jsonl')));
		const staged = fs.readdirSync(path.join(ws.root, '.dreamteamer', 'proofs'));
		assert.deepEqual(staged.filter((f) => !f.endsWith('.proof.yaml')), [], staged.join(', '));
	});

	// --json is for a script, and a script parses stdout WHOLE. One warning line ahead of the object
	// makes `JSON.parse` throw, which is indistinguishable from the run having failed.
	test('--json prints ONE object on stdout and nothing else', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'gate-passes', '--json');
		assert.equal(res.code, 0, res.stderr);
		const row = JSON.parse(res.stdout);
		assert.equal(row.verdict, 'PASS');
		assert.ok(Array.isArray(row.verdicts));
		assert.doesNotMatch(res.stdout, /^RUN /m, 'the human step lines leaked into the JSON stream');
	});
});

describe('dt prove — a live proof, the fixture and the pre-check', () => {
	// exit 4, not 1: a `given` that matches nothing says the proof DID NOT RUN. Reporting FAIL there
	// would put an artifact on a red list for a state of the workspace's data.
	test('a given that matches no record is NO-FIXTURE at code 4, naming the collection', () => {
		const ws = proveWorkspace({ notes: [] });
		const res = ws.dt('prove', 'note-gets-closed');
		assert.equal(res.code, 4, res.stdout + res.stderr);
		assert.match(res.stdout, /NO-FIXTURE/);
		assert.match(res.stdout, /given matched 0 records in notes/);
		assert.equal(tail(ws.root, 'note-gets-closed').verdict, 'NO-FIXTURE');
	});

	// ⚠ THE MOST VALUABLE STATE IN THE WHOLE SET. A proof whose expectations already hold before its
	// step runs reports PASS forever and measures nothing — the silent-green failure `prove` exists to
	// remove. So it is refused with its own code, BEFORE any step is taken.
	test('a proof whose expectations already hold is VACUOUS at code 6, before any step runs', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'already-true');
		assert.equal(res.code, 6, res.stdout + res.stderr);
		assert.match(res.stdout, /VACUOUS/);
		assert.match(res.stdout, /a proof that cannot fail is not a proof/);
		assert.doesNotMatch(res.stdout, /PERFORM/, 'the pre-check must run BEFORE the steps');
		assert.equal(tail(ws.root, 'already-true').verdict, 'VACUOUS');
	});
});

describe('dt prove — the resume protocol around a perform step', () => {
	test('the first perform step stops the run at code 5 and prints the three-line block', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'note-gets-closed');
		assert.equal(res.code, 5, res.stdout + res.stderr);
		// the substituted command, the SOURCE FILE it lives in, and the same verb to type next —
		// nothing else, because this block is read by an agent that has to act on it.
		assert.match(res.stdout, /^PERFORM  \/close-note notes\/b$/m);
		assert.match(res.stdout, /^source   modules\/default\/commands\/close-note\.command\.md$/m);
		assert.match(res.stdout, /^then     dt prove note-gets-closed --record notes\/b {3}\(the same verb, again\)$/m);

		const row = tail(ws.root, 'note-gets-closed');
		assert.equal(row.verdict, 'PENDING');
		assert.equal(row.record, 'notes/b');
		assert.equal(row.sandbox, null);
	});

	// ⚠ THE VERDICT LINE CARRIES THE ACTUAL VALUE. "expected status done ✖" sends the reader back to
	// re-run the proof by hand to learn what it actually was, which is the entire cost `prove` removes.
	test('resuming before the action was taken FAILS at code 1, with the actual value beside the wanted one', () => {
		const ws = proveWorkspace();
		assert.equal(ws.dt('prove', 'note-gets-closed').code, 5);
		const res = ws.dt('prove', 'note-gets-closed', '--record', 'notes/b');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /status "open" = done ✖/);
		assert.match(res.stdout, /^FAIL {2}note-gets-closed$/m);
		assert.equal(tail(ws.root, 'note-gets-closed').failure_reason, 'status "open" = done ✖');
	});

	test('resuming after the action was taken PASSES at code 0', () => {
		const ws = proveWorkspace();
		assert.equal(ws.dt('prove', 'note-gets-closed').code, 5);
		// the earlier FAIL supersedes the pending row, so a fresh one is needed before the verify
		assert.equal(ws.dt('prove', 'note-gets-closed', '--record', 'notes/b').code, 1);
		assert.equal(ws.dt('prove', 'note-gets-closed').code, 5);

		// the ACTION, taken by hand — a record write, which does not commit
		const set = ws.dt('set', 'notes/b', 'status=done');
		assert.equal(set.code, 0, set.stdout + set.stderr);

		const res = ws.dt('prove', 'note-gets-closed', '--record', 'notes/b');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /status "done" = done ✔/);
		assert.match(res.stdout, /^PASS  note-gets-closed \(\d+ ms\)$/m);
	});

	// A resume with nothing to resume is an ERROR, not a fresh run: silently starting over would
	// discard a pending row the operator is halfway through, and re-ask for an action already taken.
	test('--record with no pending run for that record is refused, naming the command to run first', () => {
		const ws = proveWorkspace();
		assert.equal(ws.dt('prove', 'note-gets-closed').code, 5);
		const res = ws.dt('prove', 'note-gets-closed', '--record', 'notes/a');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /no pending run of note-gets-closed for notes\/a — run dt prove note-gets-closed first/);
	});

	// ⚠ A SECOND RUN WHILE ONE IS PENDING IS REFUSED, because the second run would re-ask for the
	// action the first is still waiting on — and the operator would have no way to tell which pending
	// row their eventual verify is judged against.
	test('a second run while one is pending is refused, and --restart discards it explicitly', () => {
		const ws = proveWorkspace();
		assert.equal(ws.dt('prove', 'note-gets-closed').code, 5);

		const second = ws.dt('prove', 'note-gets-closed');
		assert.equal(second.code, 1, second.stdout + second.stderr);
		assert.match(second.stderr, /note-gets-closed is pending for notes\/b since /);
		assert.match(second.stderr, /--restart to discard it/);

		const restarted = ws.dt('prove', 'note-gets-closed', '--restart');
		assert.equal(restarted.code, 5, restarted.stdout + restarted.stderr);
		// the discard is RECORDED, not silent: the ledger shows why the first attempt ended
		const verdicts = readLedger(ws.root, 'note-gets-closed').map((r) => `${r.verdict}:${r.failure_reason ?? ''}`);
		assert.deepEqual(verdicts, ['PENDING:', 'FAIL:restarted', 'PENDING:']);
	});
});

describe('dt prove — _delta is judged against a FRESH store', () => {
	// ⚠ THE TRAP, REPRODUCED. `Store.ids()` memoizes on (git HEAD, collection dir mtime), with a
	// documented gap: a DEEP write that adds a record without moving the TOP directory's mtime serves
	// one stale read. A proof's steps write records and do not commit, so a runner that reused its
	// before-count Store for the after-count would read a delta of 0 with nothing wrong anywhere.
	test('the same Store instance serves a stale count after a deep write; a fresh one does not', () => {
		const { ws, root } = proveWorkspace();
		// `sub/` is created FIRST, so the later write into it moves only ITS mtime, not data/notes'
		const sub = path.join(root, 'data', 'notes', 'sub');
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, 'x.note.md'), '---\nname: x\nstatus: open\n---\n');

		const stale = new Store(ws);
		assert.equal(countMatching(stale, 'notes', {}, null), 3, 'the before-count, which memoizes the index');

		fs.writeFileSync(path.join(sub, 'y.note.md'), '---\nname: y\nstatus: open\n---\n');
		assert.equal(countMatching(stale, 'notes', {}, null), 3, 'the SAME Store still serves the memoized index — this IS the trap');
		assert.equal(countMatching(new Store(ws), 'notes', {}, null), 4, 'a FRESH Store walks disk');
	});

	// The behavioural half: the trap above, driven through the RUNNER in ONE process. A step writes a
	// record deep, and `_delta: 1` must still be +1 — which it can only be if the after-count came off
	// a Store constructed after the steps.
	test('a run step that writes deep is still counted — the runner rebuilds its Store to judge', () => {
		const ws = proveWorkspace({
			proofs: {
				'counts-a-deep-note': {
					kind: 'live',
					mode: 'readonly',
					given: { collection: 'notes', where: {}, pick: 'latest' },
					steps: [{ run: "printf '%s\\n' '---' 'name: y' 'status: open' '---' > data/notes/sub/y.note.md" }],
					expect: [{ collection: 'notes', where: {}, count: { _delta: 1 } }],
				},
			},
		});
		const sub = path.join(ws.root, 'data', 'notes', 'sub');
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, 'x.note.md'), '---\nname: x\nstatus: open\n---\n');

		const res = ws.dt('prove', 'counts-a-deep-note');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /count \+1 = \+1 ✔/);
	});

	// The cross-process half of the same expectation: the before-count is snapshotted into the PENDING
	// row, and the verify subtracts it from a count taken in a whole new process.
	test('the before-count is carried in the PENDING row and the delta measured against it', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'counts-a-new-note');
		assert.equal(res.code, 5, res.stdout + res.stderr);
		assert.deepEqual(tail(ws.root, 'counts-a-new-note').before, { 0: 2 });

		assert.equal(ws.dt('add', 'notes', '--name', 'c').code, 0);
		const verified = ws.dt('prove', 'counts-a-new-note', '--record', 'notes/b');
		assert.equal(verified.code, 0, verified.stdout + verified.stderr);
		assert.match(verified.stdout, /count \+1 = \+1 ✔/);
	});
});

describe('dt prove --all — a board, and never a request for an actor', () => {
	// ⚠ EXIT 5 CAN NEVER COME OUT OF `--all` (spec §13.3). `--all` is what a pre-commit hook and a CI
	// step run, and "one of your 40 proofs would like a human" is not an answer either can act on. So
	// a perform proof is LISTED rather than started, and the code only reflects what actually ran.
	// ⚠ R22 — ONE LINE PER PROOF, AND THE REASON ON IT. `--all` used to run each proof at full
	// volume, so the board it exists to be was forty step transcripts deep; and a board whose rows
	// said only PASS/FAIL sends the reader to re-run every red one just to learn what it was.
	test('--all runs every machine-runnable proof, one line each, lists the rest, and never exits 5', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', '--all');
		assert.equal(res.code, 1, res.stdout + res.stderr); // gate-fails
		assert.match(res.stdout, /proofs: \d+ passed · 1 failed · 1 unavailable/);
		assert.match(res.stdout, /^proofs: 1 passed · 1 failed · 1 unavailable · 0 no-fixture · 0 vacuous · 3 need an actor$/m);
		assert.match(res.stdout, /^needs an actor:$/m);
		assert.match(res.stdout, /^ {2}dt prove note-gets-closed$/m);
		assert.doesNotMatch(res.stdout, /^PERFORM /m, '--all must not start a perform step');

		// the per-proof board rows, exactly — a PASS carries no reason, everything else does
		assert.match(res.stdout, /^PASS  gate-passes$/m);
		assert.match(res.stdout, /^FAIL  gate-fails — step 1 exited 3$/m);
		assert.match(res.stdout, /^UNAVAILABLE  needs-a-var — PROVE_TEST_VAR is not set — add it to \.env$/m);
		// and NO step transcript: that is what a single-proof run is for
		assert.doesNotMatch(res.stdout, /^RUN /m, '--all is quiet per proof');
		assert.doesNotMatch(res.stdout, /^ {2}exit \d+ \(/m);
	});

	test('--kind gate selects only gates, so nothing needs an actor', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', '--all', '--kind', 'gate');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^proofs: 1 passed · 1 failed · 1 unavailable · 0 no-fixture · 0 vacuous · 0 need an actor$/m);
		assert.doesNotMatch(res.stdout, /note-gets-closed/);
	});

	// ⚠ `--strict` IS WHAT MAKES "unavailable" FATAL, and it has to be a flag rather than the default:
	// UNAVAILABLE is the ordinary state of a proof that needs a credential on a machine that has none,
	// so failing on it by default would make `--all` red on every cloud session.
	test('--strict makes an UNAVAILABLE fatal, where a bare --all is green without it', () => {
		const ws = proveWorkspace();
		// fix the one failing gate, so `unavailable` is the only thing left that could be fatal
		writeProof(ws.root, 'gate-fails', { about: ['skills/using-dreamteamer'], kind: 'gate', steps: [{ run: "node -e 'process.exit(0)'" }] });
		assert.equal(ws.dt('compile').code, 0);

		const lenient = ws.dt('prove', '--all');
		assert.equal(lenient.code, 0, lenient.stdout + lenient.stderr);
		assert.match(lenient.stdout, /^proofs: 2 passed · 0 failed · 1 unavailable · 0 no-fixture · 0 vacuous · 3 need an actor$/m);

		const strict = ws.dt('prove', '--all', '--strict');
		assert.equal(strict.code, 1, strict.stdout + strict.stderr);
	});

	// ⚠ `external: true` IS OPT-IN, so a proof that needs the network is invisible to the default run
	// rather than red on it. Counted only when asked for.
	test('an external proof is skipped by --all and included by --external', () => {
		const ws = proveWorkspace({
			proofs: { 'reaches-out': { kind: 'gate', external: true, steps: [{ run: "node -e 'process.exit(0)'" }] } },
		});
		const bare = ws.dt('prove', '--all', '--kind', 'gate');
		assert.match(bare.stdout, /^proofs: 1 passed · 1 failed · 1 unavailable · 0 no-fixture · 0 vacuous · 0 need an actor$/m);
		assert.doesNotMatch(bare.stdout, /reaches-out/);

		const withExternal = ws.dt('prove', '--all', '--kind', 'gate', '--external');
		assert.match(withExternal.stdout, /^proofs: 2 passed · 1 failed · 1 unavailable · 0 no-fixture · 0 vacuous · 0 need an actor$/m);
	});

	// The artifact form: "prove everything anybody claims about this command" — the question a reader
	// of a skill or a command actually has, and the one `about` exists to make answerable.
	test('dt prove <artifact-ref> selects every proof whose about names it, with --all semantics', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'commands/close-note');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /^ {2}dt prove note-gets-closed$/m);
		assert.match(res.stdout, /^proofs: 0 passed · 0 failed · 0 unavailable · 0 no-fixture · 0 vacuous · 2 need an actor$/m);
		assert.doesNotMatch(res.stdout, /gate-passes/);
	});
});

describe('dt prove — the usage surface', () => {
	// ⚠ A BARE POSITIONAL THAT NAMES NOTHING must not be answered as a fresh run of nothing. `install`
	// set the precedent: a stale invocation fails loudly and names both real forms.
	test('a target that is neither a proof nor an artifact is refused, naming both forms', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'nope');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /takes a proof id or an artifact \(skills\/<id>, commands\/<id>, …\) — got "nope"/);
		assert.match(res.stderr, /dt list proofs/);
	});

	// PER-FORM refusal: the verb-level allowlist can say which flags `prove` HAS, never that `--all`
	// is meaningless once a proof is named. Forwarding it silently would run one proof and report a board.
	test('a flag of the wrong form is refused, naming the form and what it takes', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'gate-passes', '--all');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /--all is not a flag of `dt prove <proof>`/);
	});

	test('an unknown flag is refused by the verb-level allowlist', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', '--bogus');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /unknown flag "--bogus" on `dt prove`/);
	});

	test('every flag `dt prove` accepts is documented in `dt help`', () => {
		const documented = new Set([...USAGE.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
		const undocumented = WORKSPACE_FLAGS.prove.filter((f) => !documented.has(f));
		assert.deepEqual(undocumented, [], `dt prove accepts these and dt help never names them: ${undocumented.join(', ')}`);
	});

	// A `writes` proof runs in a sandbox on its OWN fixtures — so one with a `given.where` (a filter
	// over the REAL store) has nothing to run against but this checkout, and says so rather than
	// writing to it. The sandbox itself is covered in `writes proofs are sandboxed`, below.
	test('a writes proof without --here refuses rather than writing to the live workspace', () => {
		const ws = proveWorkspace({
			proofs: {
				'writes-a-note': {
					kind: 'live',
					mode: 'writes',
					given: { collection: 'notes', where: {}, pick: 'latest' },
					steps: [{ run: 'true' }],
					expect: [{ collection: 'notes', where: {}, count: { _delta: 1 } }],
				},
			},
		});
		const res = ws.dt('prove', 'writes-a-note');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /writes-a-note is a writes proof with no fixture — it runs only with --here/);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Fix round 1 — the four expectation FORMS end to end, and the three ways a verdict could be a lie:
// a `_delta` judged against a missing snapshot, a `stdout` judged on a 10-line tail, and a proof
// that threw and left no evidence it was ever attempted.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** A step printing pretty JSON over more than ten lines — which is EVERY `dt … --json` payload, and
 *  the exact shape the old 10-line tail made unparseable. `String.fromCharCode(10)` rather than a
 *  `\n` escape, so the YAML round-trip through `dump` cannot change what the shell receives. */
const JSON_STEP = "node -e \"console.log(JSON.stringify({a:{b:1},pad:Array.from({length:20},(_,i)=>i)},null,2))\"";
const MARKER_STEP = "node -e \"console.log('HEAD-MARKER'); console.log(Array.from({length:25},(_,i)=>'filler '+i).join(String.fromCharCode(10)))\"";
const LIVE = { kind: 'live', mode: 'readonly' };

describe('dt prove — the step expectation form', () => {
	// ⚠ A `step:` EXPECTATION MAY WANT A NON-ZERO EXIT. A proof that a guard REFUSES is the commonest
	// gate there is, and the step loop must not read the refusal as its own failure.
	test('a step expectation that wants exit 3 PASSES on a step that exits 3', () => {
		const ws = proveWorkspace({
			proofs: { 'wants-three': { ...LIVE, steps: [{ run: "node -e 'process.exit(3)'" }], expect: [{ step: 1, exit: 3 }] } },
		});
		const res = ws.dt('prove', 'wants-three');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /exit 3 = 3 ✔/);
		assert.match(res.stdout, /^PASS  wants-three \(\d+ ms\)$/m);
	});

	test('the same step with exit: 0 expected FAILS at the step, naming it', () => {
		const ws = proveWorkspace({
			proofs: { 'wants-zero': { ...LIVE, steps: [{ run: "node -e 'process.exit(3)'" }], expect: [{ step: 1, exit: 0 }] } },
		});
		const res = ws.dt('prove', 'wants-zero');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^FAIL at step 1  wants-zero — exit 3 \(want 0\)$/m);
		assert.equal(tail(ws.root, 'wants-zero').failure_reason, 'step 1 exited 3');
	});

	// ⚠ R23 — THE WHOLE STDOUT, NOT A TEN-LINE TAIL. Judging on a tail made every pretty-printed JSON
	// payload unparseable, so `stdout_json` read `undefined` and failed for a reason nothing named.
	test('stdout_json parses a 20-line pretty JSON payload', () => {
		const ws = proveWorkspace({
			proofs: { 'json-payload': { ...LIVE, steps: [{ run: JSON_STEP }], expect: [{ step: 1, stdout_json: { 'a.b': { _eq: 1 } } }] } },
		});
		const res = ws.dt('prove', 'json-payload');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /a\.b 1 = 1 ✔/);
		// the full capture is what the LEDGER keeps, so a resume judges the same bytes
		const row = tail(ws.root, 'json-payload');
		assert.equal(row.steps[0].stdout_truncated, false);
		assert.deepEqual(JSON.parse(row.steps[0].stdout).a, { b: 1 });
		assert.ok(row.steps[0].stdout.split('\n').length > 10, 'the payload must exceed the display tail');
	});

	// the same bug the other way up: a marker on line 1 of 26 was silently false against the tail
	test('stdout _contains sees a marker on the FIRST line of a 26-line stream', () => {
		const ws = proveWorkspace({
			proofs: { 'head-marker': { ...LIVE, steps: [{ run: MARKER_STEP }], expect: [{ step: 1, stdout: { _contains: 'HEAD-MARKER' } }] } },
		});
		const res = ws.dt('prove', 'head-marker');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /✔/);
		assert.doesNotMatch(res.stdout, /✖/);
	});

	// ⚠ NEVER A SILENT `undefined`. An unparseable payload used to make every dotted path read
	// undefined, so the line said `a.b undefined = 1 ✖` and sent the reader hunting for a missing key
	// in output that was never JSON at all.
	test('a non-JSON payload says so, with the first 60 characters of what it actually was', () => {
		const ws = proveWorkspace({
			proofs: { 'not-json': { ...LIVE, steps: [{ run: 'echo not-json-at-all' }], expect: [{ step: 1, stdout_json: { 'a.b': { _eq: 1 } } }] } },
		});
		const res = ws.dt('prove', 'not-json');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /stdout is not JSON \(not-json-at-all\) ✖/);
		assert.equal(tail(ws.root, 'not-json').failure_reason, 'stdout is not JSON (not-json-at-all)');
	});
});

describe('dt prove — the path expectation form, through the ONE resolver', () => {
	// decision 240: a `path:` renders through the same `${env:…}` renderer `dt resolve` uses, so a
	// proof and the record it is about can never disagree about where a machine's folder is.
	const MAKES = { ...LIVE, steps: [{ run: 'mkdir -p made && touch made/made.txt' }] };

	test('a path the step created exists — the ${env:…} template renders per machine', () => {
		const ws = proveWorkspace({
			proofs: { 'makes-a-file': { ...MAKES, expect: [{ path: '${env:PROVE_FIX_DIR}/made.txt', exists: true }] } },
		});
		const res = ws.dt('prove', 'makes-a-file');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /exists true = true ✔/);
		assert.ok(fs.existsSync(path.join(ws.root, 'made', 'made.txt')), 'the step really wrote it');
	});

	test('exists: false on the same path FAILS, with the actual beside the wanted', () => {
		const ws = proveWorkspace({
			proofs: { 'makes-no-file': { ...MAKES, expect: [{ path: '${env:PROVE_FIX_DIR}/made.txt', exists: false }] } },
		});
		const res = ws.dt('prove', 'makes-no-file');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /exists true = false ✖/);
	});

	// ⚠ THE RESOLVER'S REFUSAL IS LOUD AND STAYS LOUD (decision 240). An undeclared key renders to
	// nothing silently in any hand-rolled substituter, producing a plausible path that exists nowhere
	// — so `renderTemplate` throws, and `prove` must not soften it into `exists false`.
	test('an UNDECLARED ${env:…} in a path is the resolver\'s own loud error, and still leaves a row', () => {
		const ws = proveWorkspace({
			proofs: { 'bad-var': { ...LIVE, steps: [{ run: 'true' }], expect: [{ path: '${env:NOPE}/x', exists: true }] } },
		});
		const res = ws.dt('prove', 'bad-var');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /\$\{env:NOPE\}: "NOPE" is not declared in dreamteamer\.vars/);
		// MINOR 8 — a throw past the steps used to leave NO ledger row at all, i.e. a run the ledger
		// denies ever happened
		const row = tail(ws.root, 'bad-var');
		assert.equal(row.verdict, 'FAIL');
		assert.match(row.failure_reason, /is not declared in dreamteamer\.vars/);
	});
});

describe('dt prove — a _delta with no snapshot fails CLOSED', () => {
	// ⚠ R24, AND IT WAS A FAIL-OPEN. `before[i] || 0` treated a missing snapshot as zero, so the
	// delta became the ABSOLUTE count — and with ONE note in the collection and `_delta: 1` wanted,
	// the proof reported `count +1 = +1 ✔` and PASSED with nothing performed against it. Exactly one
	// note is what makes this test bite; two would have failed for the wrong reason.
	test('a hand-written PENDING row lacking `before` is a FAIL naming the fix, not a PASS', () => {
		const ws = proveWorkspace({ notes: [{ name: 'a' }] });
		appendLedger(ws.root, 'counts-a-new-note', {
			when: new Date().toISOString(),
			verdict: 'PENDING',
			record: 'notes/a',
			engine: '0.0.0',
			machine: 'somewhere-else',
			duration_ms: 1,
			failure_reason: null,
			steps: [],
			sandbox: null,
		});
		const res = ws.dt('prove', 'counts-a-new-note', '--record', 'notes/a');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /no before-count in the pending row — re-run dt prove counts-a-new-note --restart ✖/);
		assert.equal(
			tail(ws.root, 'counts-a-new-note').failure_reason,
			'no before-count in the pending row — re-run dt prove counts-a-new-note --restart',
			'a failure_reason must not end in a glyph',
		);
	});
});

describe('dt prove — a record expectation resolves one reference hop', () => {
	// ⚠ `verdictLine` JUDGED WITH NO RESOLVER, so a non-operator key under a field — which is a ONE-HOP
	// REFERENCE traversal, not a field comparison — narrowed to ✖ forever. The collection form always
	// passed `recordResolver(store)`; this is the record form catching up.
	const OWNED = {
		...LIVE,
		given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'latest' },
		steps: [{ perform: 'set the owner' }],
		expect: [{ record: '{record}', where: { owner: { name: { _eq: 'Ada' } } } }],
	};

	test('the hop resolves through the fresh store, so the expectation can actually be met', () => {
		const ws = proveWorkspace({ people: [{ name: 'Ada' }], proofs: { 'owner-is-ada': OWNED } });
		// unowned before the action, so the pre-check cannot call it vacuous
		assert.equal(ws.dt('prove', 'owner-is-ada').code, 5);
		const set = ws.dt('set', 'notes/b', 'owner=people/ada');
		assert.equal(set.code, 0, set.stdout + set.stderr);

		const res = ws.dt('prove', 'owner-is-ada', '--record', 'notes/b');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /^PASS  owner-is-ada \(\d+ ms\)$/m);
	});

	test('a hop to the WRONG value still fails, so the resolver did not just widen everything', () => {
		const ws = proveWorkspace({ people: [{ name: 'Ada' }, { name: 'Bea' }], proofs: { 'owner-is-ada': OWNED } });
		assert.equal(ws.dt('prove', 'owner-is-ada').code, 5);
		assert.equal(ws.dt('set', 'notes/b', 'owner=people/bea').code, 0);
		const res = ws.dt('prove', 'owner-is-ada', '--record', 'notes/b');
		assert.equal(res.code, 1, res.stdout + res.stderr);
	});
});

describe('dt prove — a step that never ran is not a step that returned non-zero', () => {
	// ⚠ MINOR 7 — THREE DIFFERENT FAILURES WERE ALL `exited 124`. Node reports a timeout as
	// `status: null · signal: SIGTERM · error.code ETIMEDOUT` (measured), which the exit-code
	// flattening turned into a plausible number naming the wrong thing to go and fix.
	test('a step killed at the timeout says so, with the proof\'s own timeout in seconds', () => {
		const ws = proveWorkspace({ proofs: { 'times-out': { kind: 'gate', timeout: 1, steps: [{ run: 'sleep 3' }] } } });
		const res = ws.dt('prove', 'times-out');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^FAIL at step 1  times-out — timed out after 1s$/m);
		assert.equal(tail(ws.root, 'times-out').failure_reason, 'step 1 timed out after 1s');
	});
});

describe('dt prove --all — a broken proof is FAILED, with a row (R24)', () => {
	// ⚠ IT USED TO BE COUNTED UNAVAILABLE AND LEFT NO ROW: a proof broken in a way that THROWS left
	// `--all` green without `--strict`, and left no evidence it had ever been attempted.
	test('a proof whose path names an undeclared var is counted failed and exits 1', () => {
		const ws = proveWorkspace({
			proofs: { 'bad-var': { ...LIVE, steps: [{ run: 'true' }], expect: [{ path: '${env:NOPE}/x', exists: true }] } },
		});
		const res = ws.dt('prove', '--all', '--kind', 'live');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^FAIL  bad-var — .*is not declared in dreamteamer\.vars/m);
		assert.match(res.stdout, /· 1 failed · /);
		assert.equal(tail(ws.root, 'bad-var').verdict, 'FAIL');
	});

	// the ONE exception, and it is the only one: the artifact is fine and this INVOCATION cannot
	// answer for it — a `writes` proof with no fixture runs only against a real store, with --here
	test('a writes proof --all cannot run stays UNAVAILABLE, and still writes a row', () => {
		const ws = proveWorkspace({
			proofs: {
				'writes-a-note': {
					kind: 'live',
					mode: 'writes',
					steps: [{ run: 'true' }],
					expect: [{ collection: 'notes', where: {}, count: { _delta: 1 } }],
				},
			},
		});
		const res = ws.dt('prove', '--all', '--kind', 'live');
		assert.match(res.stdout, /^UNAVAILABLE  writes-a-note — writes-a-note is a writes proof with no fixture — it runs only with --here .*$/m);
		assert.equal(tail(ws.root, 'writes-a-note').verdict, 'UNAVAILABLE');
		// unavailable is not fatal without --strict, so this run is green on that proof alone
		assert.equal(ws.dt('prove', 'writes-a-note', '--json').code, 1, 'a single-proof run still refuses');
	});
});

describe('dt prove — --kind is validated, and every pending record is named', () => {
	// ⚠ MINOR 6 — AN UNVALIDATED `--kind` IS A SILENT EMPTY BOARD: `--kind gates` matched no proof, so
	// `--all` answered `0 passed · 0 failed` at exit 0 — a green run that ran nothing.
	test('a typo\'d --kind is refused rather than matching no proof at exit 0', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', '--all', '--kind', 'gates');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /--kind takes gate or live — got "gates"/);
	});

	test('a --kind with no value at all is refused too', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', '--all', '--kind');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /--kind takes gate or live/);
	});

	test('the artifact form takes --kind as well', () => {
		const ws = proveWorkspace();
		const res = ws.dt('prove', 'commands/close-note', '--kind', 'live');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /^ {2}dt prove note-gets-closed$/m);
	});

	// ⚠ MINOR 10 — a refusal naming only the NEWEST pending row sends the operator round the loop once
	// per pending record, learning about the next one each time. Two pendings at once is what a second
	// session leaves behind.
	test('when several records are pending, the refusal lists every one and --restart discards all', () => {
		const ws = proveWorkspace();
		assert.equal(ws.dt('prove', 'note-gets-closed').code, 5); // PENDING notes/b
		appendLedger(ws.root, 'note-gets-closed', {
			when: new Date().toISOString(), verdict: 'PENDING', record: 'notes/a', before: {}, steps: [], failure_reason: null,
		});

		const res = ws.dt('prove', 'note-gets-closed');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /note-gets-closed is pending for 2 records — finish each with:/);
		assert.match(res.stderr, /^ {2}dt prove note-gets-closed --record notes\/b$/m);
		assert.match(res.stderr, /^ {2}dt prove note-gets-closed --record notes\/a$/m);
		assert.match(res.stderr, /or --restart to discard them/);

		assert.equal(ws.dt('prove', 'note-gets-closed', '--restart').code, 5);
		const discarded = readLedger(ws.root, 'note-gets-closed').filter((r) => r.failure_reason === 'restarted');
		assert.equal(discarded.length, 2, 'a --restart that discards only one refuses again on the next');
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Fix round 2 — the two routes a verdict could still vanish down: a `where:` typed the shortest way,
// and a throw on the RESUME half of the protocol.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('dt prove — a bare `where:` is caught at compile (R26)', () => {
	// ⚠ THE SPELLING AN AUTHOR IS MOST LIKELY TO TYPE. `where:` with nothing after it parses to
	// **null**, not to `{}`, and the first version of the MINOR-9 guard skipped null to keep
	// `Object.keys` from throwing — so the shortest route to a proof that measures nothing was the one
	// route it did not close. Measured before the fix: compiled clean, judged zero conditions,
	// `dt prove nothing --record notes/b` → exit 0, `PASS  nothing`, not one verdict line.
	test('a record expectation whose where is bare fails compile, naming the entry', () => {
		const ws = workspace({ collections: { notes: PROVE_NOTES, people: simpleCollection() }, compile: false });
		writeProof(ws.root, 'nothing', {
			about: ['skills/using-dreamteamer'],
			kind: 'live',
			mode: 'readonly',
			given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'latest' },
			steps: [{ perform: 'do a thing' }],
			expect: [{ record: '{record}', where: null }],
		});
		assert.match(compileError(ws.ws) ?? '', /proofs\/nothing\.proof\.yaml: expect\[0\] where must name at least one condition/);
	});

	// and the false refusal it must not become: on a COLLECTION entry the `count` is the assertion
	test('a bare where on a collection count still compiles', () => {
		const ws = workspace({ collections: { notes: PROVE_NOTES, people: simpleCollection() }, compile: false });
		writeProof(ws.root, 'counts-anything', {
			about: ['skills/using-dreamteamer'],
			kind: 'live',
			mode: 'readonly',
			steps: [{ run: 'true' }],
			expect: [{ collection: 'notes', where: null, count: { _gte: 0 } }],
		});
		assert.equal(compileError(ws.ws), null);
	});
});

describe('dt prove — a throw while judging a RESUME still leaves a row (MINOR B)', () => {
	// ⚠ THE FIRST WRAP SAT BELOW THE RESUME EARLY-RETURN. A throw while judging a `--record` resume
	// left the ledger at PENDING with the failed run unrecorded — so the operator is told to finish a
	// run they have already finished, and the ledger denies it ever happened. Both halves of the
	// protocol write a row now, not just the half that runs steps.
	const BAD_RESUME = {
		kind: 'live',
		mode: 'readonly',
		given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'latest' },
		steps: [{ perform: 'do a thing' }],
		expect: [{ path: '${env:NOPE}/x', exists: true }],
	};

	test('the resume exits 1 and the ledger\'s last row is a FAIL naming the resolver\'s error', () => {
		const ws = proveWorkspace({ proofs: { 'bad-var-resume': BAD_RESUME } });
		assert.equal(ws.dt('prove', 'bad-var-resume').code, 5);
		assert.equal(tail(ws.root, 'bad-var-resume').verdict, 'PENDING');

		const res = ws.dt('prove', 'bad-var-resume', '--record', 'notes/b');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /\$\{env:NOPE\}: "NOPE" is not declared in dreamteamer\.vars/);

		const row = tail(ws.root, 'bad-var-resume');
		assert.equal(row.verdict, 'FAIL', 'the ledger was left sitting at PENDING');
		assert.match(row.failure_reason, /is not declared in dreamteamer\.vars/);
		// the pending row's own facts travel onto the FAIL row: this invocation only JUDGED that run
		assert.equal(row.record, 'notes/b');
	});

	// the same throw must not produce TWO rows when `--all` catches it after proveOne already wrote one
	test('exactly one row per run — the wrap and --all\'s catch do not both write', () => {
		const ws = proveWorkspace({
			proofs: { 'bad-var': { kind: 'live', mode: 'readonly', steps: [{ run: 'true' }], expect: [{ path: '${env:NOPE}/x', exists: true }] } },
		});
		assert.equal(ws.dt('prove', '--all', '--kind', 'live').code, 1);
		const rows = readLedger(ws.root, 'bad-var');
		assert.equal(rows.length, 1, JSON.stringify(rows.map((r) => r.verdict)));
		assert.equal(rows[0].verdict, 'FAIL');
	});
});

describe('dt prove — a step may print more than spawnSync\'s 1 MB default', () => {
	// ⚠ THE WIRING, NOT THE CLASSIFIER. `stepOutcome` is unit-tested on a literal ENOBUFS result;
	// this pins that the step spawn actually raises the threshold. 2 MB rather than 16 is deliberate:
	// it crosses the DEFAULT in milliseconds, and a step big enough to cross the new limit would cost
	// seconds to prove a number.
	test('2 MB of stdout runs to completion, and the LEDGER still caps at 64 KB', () => {
		const ws = proveWorkspace({
			proofs: {
				'big-output': {
					kind: 'live',
					mode: 'readonly',
					steps: [{ run: 'node -e "process.stdout.write(\'x\'.repeat(2 * 1024 * 1024))"' }],
					expect: [{ step: 1, exit: 0 }],
				},
			},
		});
		const res = ws.dt('prove', 'big-output');
		assert.equal(res.code, 0, res.stdout + res.stderr);

		const row = tail(ws.root, 'big-output');
		assert.equal(row.steps[0].exit, 0, 'the default 1 MB maxBuffer KILLS this step');
		// only the kill threshold moved — what a ledger row keeps is still 64 KB, marked as truncated
		assert.equal(row.steps[0].stdout_truncated, true);
		assert.equal(row.steps[0].stdout.length, 64 * 1024);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Task 5 — a `writes` proof runs in a throwaway detached worktree, on its OWN fixture records.
//
// ⚠ THE PRIMARY STORE IS THE THING BEING PROTECTED. A `writes` proof asks a human (or a step) to
// mutate a record and then judges the mutation — so run in the live workspace it would leave real
// records behind, which is the one outcome a proof must never produce. Every assertion below is
// ultimately about the same sentence: `fx-open` exists in the sandbox and NOWHERE else.
//
// The ledger is the other half. It belongs to the INVOKING checkout, never to the sandbox: a sandbox
// is deleted the moment the verdict is in, and evidence written inside it would go with it.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const SANDBOX_PROOF = 'note-gets-closed-in-sandbox';
/** Byte-for-byte what `store.add` writes for this fixture's `notes` — pinned, and re-derived by the
 *  first test from the COMPILED descriptor so a change to the storage default breaks here loudly
 *  rather than silently writing a file the sandbox's `check` would never look at. */
const FX_OPEN = '---\nname: fx-open\nstatus: open\n---\n';
const FX_PATH = 'data/notes/fx-open.note.md';

const SANDBOX_PROOF_SOURCE = {
	kind: 'live',
	mode: 'writes',
	about: ['commands/close-note'],
	given: { collection: 'notes', fixture: true, pick: 'fx-open' },
	steps: [{ perform: '/close-note {record}' }],
	expect: [{ record: '{record}', where: { status: { _eq: 'done' } } }],
};

/** A `writes` proof that needs no human at all: its `run` step does the writing, so the whole run
 *  — pick, mutate, judge — happens inside the sandbox in ONE process. The engine is reached by a
 *  RELATIVE path on purpose: it resolves only from a cwd that has `node_modules/dreamteamer`, which
 *  is what makes "the step ran in the sandbox" an assertion rather than a hope. */
const STEP_WRITES = 'note-closed-by-a-step';
const STEP_WRITES_SOURCE = {
	...SANDBOX_PROOF_SOURCE,
	steps: [
		{ run: 'node node_modules/dreamteamer/bin/dreamteamer.js set {record} status=done' },
		{ run: 'touch made-in-the-sandbox.txt' },
	],
	expect: [
		{ record: '{record}', where: { status: { _eq: 'done' } } },
		// ⚠ `${workspaceFolder}` HAS TO RENDER THE SANDBOX. A `path:` expectation goes through the ONE
		// resolver, and a resolver handed the invoking checkout would look for the step's own artefact
		// in a directory the step never ran in — ✖ for a proof that held, every time.
		{ path: '${workspaceFolder}/made-in-the-sandbox.txt', exists: true },
	],
};

/**
 * `proveWorkspace` plus a `writes` proof, its fixture directory, and a COMMIT.
 *
 * ⚠ THE COMMIT IS LOAD-BEARING, not tidiness. A sandbox is a DETACHED worktree cut from `HEAD`, so
 * a descriptor, a module or a proof that lives only in the working tree does not exist inside it.
 * That is also how a real workspace ships a proof — a committed source — and it is precisely what
 * the fixture-copy step exists to bridge for the RECORDS, which are deliberately not committed
 * anywhere: `data/notes/fx-open.note.md` must never appear in the primary's store.
 */
function sandboxWorkspace({ fixtureBody = FX_OPEN, proofs = {}, fixturesFor = [SANDBOX_PROOF] } = {}) {
	const ws = proveWorkspace({
		notes: [], // the primary holds NO notes: fx-open may only ever exist inside a sandbox
		proofs: { [SANDBOX_PROOF]: SANDBOX_PROOF_SOURCE, ...proofs },
	});
	for (const id of fixturesFor) {
		const dir = path.join(ws.root, 'modules', 'default', 'proofs', 'fixtures', id, path.dirname(FX_PATH));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, path.basename(FX_PATH)), fixtureBody);
	}
	ws.git(['add', '-A']);
	ws.git(['commit', '-qm', 'fixture: the sandboxed proof and its fixture records']);
	return ws;
}

/** The sandbox a PENDING run is waiting in, off the printed block — the same string the operator
 *  reads, so a test can never assert against a path the run did not actually print. */
function sandboxOf(stdout) {
	const m = /^in {7}(.+?) {3}\(a throwaway worktree/m.exec(stdout);
	assert.ok(m, `no "in" line in:\n${stdout}`);
	return m[1];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `removeWorktree` reports on stdout and these calls are IN-PROCESS — held so the suite's own
 *  output stays a line of dots (the same affordance `worktrees.test.js` uses). */
function quietly(fn) {
	const log = console.log;
	console.log = () => {};
	try { return fn(); } finally { console.log = log; }
}

describe('writes proofs are sandboxed', () => {
	test('a writes proof pends inside a throwaway worktree, and the primary store never sees the fixture', () => {
		const ws = sandboxWorkspace();
		// the pinned path is the COMPILED path — assert it rather than trusting the default
		const d = load(readFile(ws.root, '.dreamteamer/collections/notes.collection.yaml'));
		assert.equal(path.join(d.storage.path, `fx-open.${d.storage.suffix}.md`), FX_PATH);

		const res = ws.dt('prove', SANDBOX_PROOF);
		assert.equal(res.code, 5, res.stdout + res.stderr);
		const sandbox = sandboxOf(res.stdout);
		assert.ok(sandbox.startsWith(path.join(ws.root, '.worktrees', '.tmp-')), sandbox);
		// the `in` line is ABOVE the PERFORM block, because "where am I acting" is read first
		assert.ok(res.stdout.indexOf('\nin ') < res.stdout.indexOf('\nPERFORM'), res.stdout);
		assert.equal(fs.readFileSync(path.join(sandbox, FX_PATH), 'utf8'), FX_OPEN);
		assert.equal(readFile(ws.root, FX_PATH), null, 'THE PRIMARY STORE WAS WRITTEN TO');

		const row = tail(ws.root, SANDBOX_PROOF);
		assert.equal(row.verdict, 'PENDING');
		assert.equal(row.record, 'notes/fx-open');
		assert.equal(row.sandbox, sandbox, 'a PENDING row that does not name its sandbox cannot be resumed');
		// ⚠ THE LEDGER IS THE INVOKING CHECKOUT'S. Evidence written inside a sandbox is deleted with it.
		assert.ok(!fs.existsSync(path.join(sandbox, '.dreamteamer', LEDGER_DIR)), 'the sandbox kept a ledger of its own');

		ws.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open'); // tidy the sandbox away
	});

	// ⚠ COMPILE USED TO STAGE THE FIXTURE AS A PROOF. `proofs/fixtures/` sits under the `proofs`
	// kind directory, and every kind's nested folders are staged recursively — so the first fixture
	// ever written made the whole module uncompilable: `data/notes/fx-open.note.md: expected a
	// single document in the stream, but found more`, on a file that is a RECORD, not a proof.
	test('a proof fixture directory is records, and compile does not read it as a proof', () => {
		const ws = proveWorkspace();
		const dir = path.join(ws.root, 'modules', 'default', 'proofs', 'fixtures', 'note-gets-closed', 'data', 'notes');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'fx-open.note.md'), FX_OPEN);
		const res = ws.dt('compile');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.deepEqual(Object.keys(readManifest(ws.root).entries).filter((k) => k.includes('fixtures')), []);
	});

	// ⚠ AND THE OTHER HALF OF THE SAME RULE. Skipping the fixture in the STAGER alone left the
	// staleness scan reporting every fixture file "(new, uncompiled)" on every single command — a
	// permanent `⚠ .dreamteamer is stale` that no compile could ever clear.
	test('a fixture directory does not leave the workspace permanently stale', () => {
		const ws = sandboxWorkspace();
		const res = ws.dt('list', 'proofs');
		assert.equal(res.code, 0, res.stderr);
		assert.doesNotMatch(res.stderr, /stale/);
	});

	test('the resume judges the SANDBOX store, passes, and the sandbox is gone — registration and all', () => {
		const ws = sandboxWorkspace();
		const sandbox = sandboxOf(ws.dt('prove', SANDBOX_PROOF).stdout);

		// the agent's PERFORM, done where the proof asked for it
		const set = dt(sandbox, 'set', 'notes/fx-open', 'status=done');
		assert.equal(set.code, 0, set.stdout + set.stderr);

		const done = ws.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open');
		assert.equal(done.code, 0, done.stdout + done.stderr);
		assert.match(done.stdout, new RegExp(`^PASS  ${SANDBOX_PROOF} \\(\\d+ ms\\)$`, 'm'));
		assert.match(done.stdout, /status "done" = done ✔/);
		assert.ok(!fs.existsSync(sandbox), 'the sandbox outlived its verdict');
		// a directory removed by hand leaves git still listing the worktree — this is the other half
		assert.ok(!ws.git(['worktree', 'list']).includes(sandbox), 'git still registers the sandbox');
		assert.equal(readFile(ws.root, FX_PATH), null, 'the PASS landed the fixture in the primary');
		assert.equal(tail(ws.root, SANDBOX_PROOF).verdict, 'PASS');
		assert.equal(tail(ws.root, SANDBOX_PROOF).sandbox_removed, true);
	});

	// ⚠ THE HALF WITH NO HUMAN IN IT, and the only shape that reaches the judge on a FRESH run with
	// a sandbox in play. Two things are only assertable here: the step's `cwd` (the engine is named
	// by a relative path, so it resolves nowhere but the sandbox) and the verdict's own store — judged
	// against the primary, `pickFixture` finds nothing and FALLS BACK to the record picked before the
	// step ran, which is a confident PASS read off a stale copy.
	test('a writes proof whose STEP does the writing passes with no actor, in the sandbox and only there', () => {
		const ws = sandboxWorkspace({ proofs: { [STEP_WRITES]: STEP_WRITES_SOURCE }, fixturesFor: [SANDBOX_PROOF, STEP_WRITES] });
		const res = ws.dt('prove', STEP_WRITES);
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /status "done" = done ✔/);
		assert.match(res.stdout, /exists true = true ✔/);
		assert.equal(readFile(ws.root, FX_PATH), null, 'THE PRIMARY STORE WAS WRITTEN TO');
		assert.ok(!fs.existsSync(path.join(ws.root, 'made-in-the-sandbox.txt')), 'the step wrote into the PRIMARY');

		const row = tail(ws.root, STEP_WRITES);
		assert.equal(row.verdict, 'PASS');
		// the row keeps WHERE it ran even though the place is gone — that is the evidence
		assert.ok(row.sandbox.startsWith(path.join(ws.root, '.worktrees', '.tmp-')), row.sandbox);
		assert.ok(!fs.existsSync(row.sandbox), 'the sandbox outlived its verdict');
		assert.deepEqual(fs.readdirSync(path.join(ws.root, '.worktrees')).filter((n) => n.startsWith('.tmp-')), []);
	});

	test('--keep leaves the sandbox behind and says where it is', () => {
		const ws = sandboxWorkspace();
		const sandbox = sandboxOf(ws.dt('prove', SANDBOX_PROOF).stdout);
		assert.equal(dt(sandbox, 'set', 'notes/fx-open', 'status=done').code, 0);

		const done = ws.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open', '--keep');
		assert.equal(done.code, 0, done.stdout + done.stderr);
		assert.match(done.stdout, new RegExp(`^kept     ${esc(sandbox)}$`, 'm'));
		assert.ok(fs.existsSync(sandbox), '--keep kept nothing');
		assert.equal(tail(ws.root, SANDBOX_PROOF).sandbox_removed, null, 'nothing was attempted, so nothing failed');

		quietly(() => removeWorktree(findWorkspace(ws.root), sandbox, { force: true }));
		assert.ok(!fs.existsSync(sandbox));
	});

	// ⚠ THE FIXTURE IS RECORDS NOBODY VALIDATED. It is hand-authored under `modules/<m>/proofs/
	// fixtures/`, never written through the store — so it is the one input to a proof that can be
	// schema-invalid, and every verdict judged against it would be measuring the wrong thing.
	test('a fixture that does not validate fails before any step, and leaves no sandbox behind', () => {
		const ws = sandboxWorkspace({ fixtureBody: '---\nname: fx-open\nstatus: nope\n---\n' });
		const res = ws.dt('prove', SANDBOX_PROOF);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, new RegExp(`^FAIL  ${SANDBOX_PROOF} — fixture does not validate:$`, 'm'));
		assert.match(res.stdout, /^ {2}data\/notes\/fx-open\.note\.md: field status: "nope" not in enum \[open, done\]$/m);
		assert.doesNotMatch(res.stdout, /^PERFORM/m, 'a step ran against an invalid fixture');
		assert.deepEqual(fs.readdirSync(path.join(ws.root, '.worktrees')).filter((n) => n.startsWith('.tmp-')), []);
		assert.equal(tail(ws.root, SANDBOX_PROOF).verdict, 'FAIL');
	});

	test('a sandbox removed by hand is named at resume rather than judged against the primary', () => {
		const ws = sandboxWorkspace();
		const sandbox = sandboxOf(ws.dt('prove', SANDBOX_PROOF).stdout);
		removeWorktree(findWorkspace(ws.root), sandbox, { force: true });

		const res = ws.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, new RegExp(`^FAIL  ${SANDBOX_PROOF} — sandbox ${esc(sandbox)} is gone \\(removed by hand\\?\\)$`, 'm'));
		assert.equal(tail(ws.root, SANDBOX_PROOF).verdict, 'FAIL');
	});

	// ⚠ R31 — THE DIAGNOSIS COVERS EVERY COLLECTION THE PROOF READS, not only `given`'s. A sandbox
	// is cut from HEAD, so a collection compiled in the working tree but never COMMITTED does not
	// exist inside it — and an EXPECT-side one reached `countMatching` as a raw `unknown collection
	// "ghosts"`, which reads as a typo in the proof rather than as "commit its descriptor". The row
	// and the teardown are the R27 half of the same test: this window sits INSIDE `ledgering`, so a
	// failure here leaves a ledger row and no `.worktrees/.tmp-*` behind.
	test('an expect-side collection missing from the sandbox is diagnosed, with a row and no sandbox left', () => {
		const ws = sandboxWorkspace();
		writeCollection(ws.root, 'ghosts', simpleCollection());
		writeProof(ws.root, 'haunts', {
			...SANDBOX_PROOF_SOURCE,
			steps: [{ run: 'true' }],
			expect: [{ collection: 'ghosts', where: {}, count: { _delta: 1 } }],
		});
		const fx = path.join(ws.root, 'modules', 'default', 'proofs', 'fixtures', 'haunts', path.dirname(FX_PATH));
		fs.mkdirSync(fx, { recursive: true });
		fs.writeFileSync(path.join(fx, path.basename(FX_PATH)), FX_OPEN);
		const compiled = ws.dt('compile'); // COMPILED, deliberately NOT committed
		assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);

		const res = ws.dt('prove', 'haunts');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^ {2}collection "ghosts" is not compiled in the sandbox — commit its descriptor, because a sandbox is cut from HEAD$/m);
		assert.doesNotMatch(res.stdout, /^PERFORM/m, 'a step ran against a sandbox that cannot be judged');
		const row = tail(ws.root, 'haunts');
		assert.equal(row.verdict, 'FAIL', 'a run with no row is a run the ledger denies happened');
		assert.match(row.failure_reason, /ghosts/);
		assert.equal(row.sandbox_removed, true);
		assert.deepEqual(fs.readdirSync(path.join(ws.root, '.worktrees')).filter((n) => n.startsWith('.tmp-')), []);
	});

	// ⚠ THE FIXTURE MIRRORS THE WORKSPACE ROOT, so a copy of the directory WHOLE would let it
	// overwrite anything the checkout carries — and `sandboxUnfit` runs after the copy, so a fixture
	// could ship the very schema its own records are then validated against.
	test('a fixture may contain only data/, and anything else is named and refused', () => {
		const ws = sandboxWorkspace();
		fs.writeFileSync(path.join(ws.root, 'modules', 'default', 'proofs', 'fixtures', SANDBOX_PROOF, 'package.json'), '{"name":"sneaky"}\n');
		const res = ws.dt('prove', SANDBOX_PROOF);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, new RegExp(`^FAIL  ${SANDBOX_PROOF} — fixture may contain only data/ — found package\\.json$`, 'm'));
		assert.equal(tail(ws.root, SANDBOX_PROOF).verdict, 'FAIL');
		assert.deepEqual(fs.readdirSync(path.join(ws.root, '.worktrees')).filter((n) => n.startsWith('.tmp-')), []);
		assert.match(readFile(ws.root, 'package.json'), /dreamteamer/, "the checkout's own package.json");
	});

	// ⚠ A WARNING ON STDERR IS GONE WHEN THE TERMINAL SCROLLS, and the row it belongs to is
	// non-PENDING with a `sandbox` set — so nothing would ever come back for the directory.
	test('a sandbox that could not be removed says so ON THE ROW, not only on stderr', () => {
		const ws = sandboxWorkspace();
		const sandbox = sandboxOf(ws.dt('prove', SANDBOX_PROOF).stdout);
		assert.equal(dt(sandbox, 'set', 'notes/fx-open', 'status=done').code, 0);
		// a REAL failure rather than a simulated one: `git worktree remove --force` refuses a locked tree
		ws.git(['worktree', 'lock', sandbox]);

		const done = ws.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open');
		assert.equal(done.code, 0, done.stdout + done.stderr);
		assert.match(done.stderr, /could not be removed/);
		const row = tail(ws.root, SANDBOX_PROOF);
		assert.equal(row.verdict, 'PASS', 'the VERDICT is about the artifact, not about the housekeeping');
		assert.equal(row.sandbox_removed, false);
		assert.ok(fs.existsSync(sandbox));

		ws.git(['worktree', 'unlock', sandbox]);
		quietly(() => removeWorktree(findWorkspace(ws.root), sandbox, { force: true }));
	});

	test('--keep under --json says so IN the object — the human line is suppressed there', () => {
		const ws = sandboxWorkspace();
		const sandbox = sandboxOf(ws.dt('prove', SANDBOX_PROOF).stdout);
		assert.equal(dt(sandbox, 'set', 'notes/fx-open', 'status=done').code, 0);

		const done = ws.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open', '--keep', '--json');
		assert.equal(done.code, 0, done.stdout + done.stderr);
		const out = JSON.parse(done.stdout);
		assert.equal(out.verdict, 'PASS');
		assert.equal(out.sandbox, sandbox);
		assert.equal(out.kept, true, 'a --json consumer cannot see the `kept` line');
		assert.equal(out.sandbox_removed, null);
		assert.ok(fs.existsSync(sandbox));

		quietly(() => removeWorktree(findWorkspace(ws.root), sandbox, { force: true }));
	});

	// ⚠ COMPILE ALLOWS THE SHAPE, because `--here` is a legitimate use of it. The runtime refusal is
	// what protects the real store, and it is `unavailable`-marked so `--all` counts it rather than
	// reporting the artifact broken.
	test('a writes proof with no fixture refuses at run time, and names both ways forward', () => {
		const ws = proveWorkspace({
			proofs: {
				'writes-in-place': {
					kind: 'live',
					mode: 'writes',
					given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'latest' },
					steps: [{ perform: 'close it' }],
					expect: [{ record: '{record}', where: { status: { _eq: 'done' } } }],
				},
			},
		});
		const res = ws.dt('prove', 'writes-in-place');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stderr, /writes-in-place is a writes proof with no fixture — it runs only with --here/);
		assert.match(res.stderr, /modules\/default\/proofs\/fixtures\/writes-in-place\//);
		assert.equal(readLedger(ws.root, 'writes-in-place').length, 0, 'nothing ran, so nothing is claimed');

		// --here is the documented way in, and it says so BEFORE it writes anything
		const here = ws.dt('prove', 'writes-in-place', '--here');
		assert.equal(here.code, 5, here.stdout + here.stderr);
		assert.match(here.stdout, /^⚠ --here: writing to THIS checkout's store$/m);
		assert.doesNotMatch(here.stdout, /^in {7}/m, '--here has no sandbox to name');
		assert.equal(tail(ws.root, 'writes-in-place').sandbox, null);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE READ SURFACES (Task 6). A proof's record says what it ASSERTS; everything an operator
// actually asks about one — can it run HERE, what did it last answer, what has no proof at all —
// is a fact about this machine, not about the repo. So it is computed at READ time from
// `requires`, the store and the ledger, and never written onto the source (R1: a derived key on a
// staged kind lands in every harness's copy of the file). Nothing below writes a byte.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** A live proof whose `given` matches NOTHING in this fixture (no note is `done`) — the third
 *  availability, and the one that is a fact about the DATA rather than about the machine. */
const WANTS_A_CLOSED_NOTE = {
	kind: 'live',
	mode: 'readonly',
	given: { collection: 'notes', where: { status: { _eq: 'done' } }, pick: 'latest' },
	steps: [{ perform: 'reopen it' }],
	expect: [{ record: '{record}', where: { status: { _eq: 'open' } } }],
};

/** The fixture every read-surface test reads: seven proofs, a SECOND command nothing proves, and
 *  three ledgers left in three different states. Read-only afterwards, so the block builds it once. */
function readSurfaceWorkspace() {
	const ws = proveWorkspace({ proofs: { 'wants-a-closed-note': WANTS_A_CLOSED_NOTE } });
	fs.writeFileSync(
		path.join(ws.root, 'modules', 'default', 'commands', 'open-note.command.md'),
		'---\nname: open-note\ndescription: Open one note.\n---\n\nSet the note\'s status to open.\n',
	);
	const compiled = ws.dt('compile');
	assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
	assert.equal(ws.dt('prove', 'gate-passes').code, 0);
	assert.equal(ws.dt('prove', 'gate-fails').code, 1);
	assert.equal(ws.dt('prove', 'needs-a-var').code, 3);
	return ws;
}

/** The UTC day a ledger row written during this test run carries — `when` is `toISOString()`, so
 *  the column is the UTC date and a local one would be a different day for eight hours of every day. */
const TODAY = new Date().toISOString().slice(0, 10);

/** One printed row of `dt list proofs`, by id. */
const rowFor = (stdout, id) => stdout.split('\n').find((l) => l.startsWith(`${id}  `));

describe('proof read surfaces', () => {
	let ws;
	before(() => { ws = readSurfaceWorkspace(); });

	// ⚠ THE TWO COLUMNS NO RECORD CARRIES, pinned as WHOLE lines. A loose regex for `available`
	// would pass on a listing that printed the word for every proof including the one this machine
	// cannot run — which is the exact question the column exists to answer.
	test('list proofs appends the computed availability and the tail of the ledger', () => {
		const res = ws.dt('list', 'proofs');
		assert.equal(res.code, 0, res.stderr);

		assert.equal(rowFor(res.stdout, 'gate-passes'), `gate-passes  gate-passes  gate  skills/using-dreamteamer  -  available  PASS ${TODAY}`);
		assert.equal(rowFor(res.stdout, 'gate-fails'), `gate-fails  gate-fails  gate  skills/using-dreamteamer  -  available  FAIL ${TODAY}`);
		// UNAVAILABLE is not a failure of the artifact — the column names the FIX, and the ledger
		// still records that the question was asked here
		assert.equal(rowFor(res.stdout, 'needs-a-var'), `needs-a-var  needs-a-var  gate  skills/using-dreamteamer  -  unavailable (PROVE_TEST_VAR is not set — add it to .env)  UNAVAILABLE ${TODAY}`);
		// never run HERE: the ledger is per-machine and gitignored, so "never" is the honest answer
		assert.equal(rowFor(res.stdout, 'already-true'), 'already-true  already-true  live  skills/using-dreamteamer  -  available  never');
		// a live `where` is a question about the DATA, and the only way to answer it is to ask it
		assert.equal(rowFor(res.stdout, 'note-gets-closed'), 'note-gets-closed  note-gets-closed  live  commands/close-note  -  available  never');
		assert.equal(rowFor(res.stdout, 'wants-a-closed-note'), 'wants-a-closed-note  wants-a-closed-note  live  skills/using-dreamteamer  -  no-fixture  never');

		// ⚠ `.env` HOLDS CREDENTIALS and `requires.env` is checked by KEY. The availability column is
		// the one place a value could reach stdout.
		assert.doesNotMatch(res.stdout, new RegExp(DECOY));
	});

	test('the picked record rides on the last column, so two runs of one proof are told apart', () => {
		const res = ws.dt('list', 'proofs');
		// a gate pends and passes against no record, so there is nothing to name
		assert.doesNotMatch(rowFor(res.stdout, 'gate-passes'), /\[/);
	});

	test('--json carries both as fields — availability a string, last an object or null', () => {
		const res = ws.dt('list', 'proofs', '--json');
		assert.equal(res.code, 0, res.stderr);
		const rows = JSON.parse(res.stdout);
		const by = Object.fromEntries(rows.map((r) => [r.id, r]));
		assert.equal(by['gate-passes'].availability, 'available');
		assert.deepEqual(by['gate-passes'].last, { verdict: 'PASS', when: TODAY, record: null });
		assert.equal(by['needs-a-var'].availability, 'unavailable (PROVE_TEST_VAR is not set — add it to .env)');
		assert.equal(by['wants-a-closed-note'].availability, 'no-fixture');
		assert.equal(by['already-true'].last, null, 'a proof that never ran here has no tail, and null says so');
	});

	// the generic narrowing is REUSED, not re-implemented — a second copy is how `--sort` ends up
	// working on one collection and not on another
	test('--filter and --sort still narrow and order the rows they always did', () => {
		const res = ws.dt('list', 'proofs', '--filter', 'kind=gate', '--sort', '-name');
		assert.equal(res.code, 0, res.stderr);
		const ids = res.stdout.trim().split('\n').map((l) => l.split('  ')[0]);
		assert.deepEqual(ids, ['needs-a-var', 'gate-passes', 'gate-fails']);
	});

	// ⚠ THE OTHER HALF OF COMPILE'S COVERAGE LINE. The line says `commands 1/2`; this says WHICH one.
	test('--missing names every artifact no proof is about, and not the ones that have one', () => {
		const res = ws.dt('list', 'proofs', '--missing');
		assert.equal(res.code, 0, res.stderr);
		const lines = res.stdout.trim().split('\n');
		assert.ok(lines.includes('commands/open-note'), res.stdout);
		assert.ok(!lines.includes('commands/close-note'), 'an artifact WITH a proof was listed as missing one');
		assert.ok(!lines.includes('skills/using-dreamteamer'), res.stdout);
		// the module-script form, which is the one an `about` can name and a folder listing cannot
		assert.ok(lines.some((l) => /^dreamteamer\/bin\//.test(l)), res.stdout);
	});

	test('--missing --json is an array of strings, grouped in the coverage line\'s own order', () => {
		const res = ws.dt('list', 'proofs', '--missing', '--json');
		assert.equal(res.code, 0, res.stderr);
		const missing = JSON.parse(res.stdout);
		assert.ok(Array.isArray(missing) && missing.every((m) => typeof m === 'string'), res.stdout);
		assert.deepEqual(missing, ['commands/open-note', 'dreamteamer/bin/dreamteamer.js']);
	});

	// a flag that narrows PROOFS cannot narrow ARTIFACTS — accepting it silently would answer a
	// question nobody asked, at exit 0, which is the one failure a narrowing verb must not have
	// ⚠ R38 — THE REFUSAL NAMES THE FLAG THAT CAUSED IT. "it takes no filter" sent the reader looking
	// for a `--filter` when what they had typed was `--sort`, and a refusal you have to guess the
	// cause of is one round trip longer than one that says it.
	test('--missing with a narrowing flag is refused, and the refusal names the flag actually passed', () => {
		const filtered = ws.dt('list', 'proofs', '--missing', '--filter', 'kind=gate');
		assert.equal(filtered.code, 1, filtered.stdout);
		assert.match(filtered.stderr, /--missing lists artifacts, not proofs — drop --filter/);

		const sorted = ws.dt('list', 'proofs', '--missing', '--sort', 'name');
		assert.equal(sorted.code, 1, sorted.stdout);
		assert.match(sorted.stderr, /--missing lists artifacts, not proofs — drop --sort/);
		assert.doesNotMatch(sorted.stderr, /--filter/, 'the refusal named a flag nobody typed');
	});

	// ⚠ COMPUTED, NEVER STORED (R1). Compile writes a staged kind's bytes to the runtime verbatim and
	// the Claude adapter copies a command's bytes into `.claude/commands/` — a derived `proofs:`
	// frontmatter key would land in every harness's copy of the file.
	test('get <artifact> ends with the proofs that are about it, and the bytes are untouched', () => {
		const before = readFile(ws.root, 'modules/default/commands/close-note.command.md');
		const res = ws.dt('get', 'commands/close-note');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stdout.trim().split('\n').at(-1), 'proofs: counts-a-new-note, note-gets-closed');
		assert.equal(readFile(ws.root, 'modules/default/commands/close-note.command.md'), before, 'the join was WRITTEN');
		assert.doesNotMatch(readFile(ws.root, '.dreamteamer/commands/close-note.command.md'), /^proofs:/m);
	});

	// ⚠ R38 — A SOMETIMES-KEY IS WORSE TO CONSUME THAN AN EMPTY ONE. `proofs` used to be omitted when
	// an artifact had none, so a script could not tell "nothing is about this" from "this engine does
	// not compute the join at all", and every consumer needed a `?? []` it had no reason to expect.
	// The HUMAN form still says nothing, because a printed `proofs:` with no ids is noise.
	test('get <artifact> --json ALWAYS carries a proofs key — empty when nothing is about it', () => {
		const proven = ws.dt('get', 'commands/close-note', '--json');
		assert.equal(proven.code, 0, proven.stderr);
		assert.deepEqual(JSON.parse(proven.stdout).proofs, ['counts-a-new-note', 'note-gets-closed']);

		const bare = ws.dt('get', 'commands/open-note', '--json');
		assert.equal(bare.code, 0, bare.stderr);
		assert.deepEqual(JSON.parse(bare.stdout).proofs, [], 'the key vanished for an unproven artifact');
		assert.doesNotMatch(ws.dt('get', 'commands/open-note').stdout, /^proofs:/m);

		// and a collection that is not an artifact kind grows no such key at all
		assert.ok(!('proofs' in JSON.parse(ws.dt('get', 'notes/a', '--json').stdout)), 'a note claimed a proofs join');
	});

	test('get proofs/<id> answers the same two questions the listing does', () => {
		const res = ws.dt('get', 'proofs/needs-a-var');
		assert.equal(res.code, 0, res.stderr);
		const lines = res.stdout.trim().split('\n');
		assert.equal(lines.at(-2), 'availability: unavailable (PROVE_TEST_VAR is not set — add it to .env)');
		assert.equal(lines.at(-1), `last: UNAVAILABLE ${TODAY}`);
		assert.doesNotMatch(res.stdout, new RegExp(DECOY));
	});

	// ⚠ THE TAIL PER PROOF, not every row — a proof that failed on Monday and passed on Tuesday is
	// passing. The ledger is gitignored and per-machine, so this whole line is about THIS machine.
	test('status counts the ledger tails, and --strict makes a FAIL fatal', () => {
		const res = ws.dt('status');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(
			res.stdout.split('\n').includes('proofs: 7 declared · 1 passed · 1 failed · 1 unavailable · 4 never'),
			res.stdout,
		);
		// the line sits with the other per-checkout facts, above the entry count
		assert.ok(res.stdout.indexOf('\nproofs:') > res.stdout.indexOf('\nworktrees:'), res.stdout);
		assert.ok(res.stdout.indexOf('\nproofs:') < res.stdout.indexOf('\nentries:'), res.stdout);

		const strict = ws.dt('status', '--strict');
		assert.equal(strict.code, 1, strict.stdout + strict.stderr);
		assert.match(strict.stdout, /^✖ 1 proof\(s\) FAILED on this machine — dt list proofs$/m);
		// status is the command you run when things are already wrong: it prints EVERYTHING first
		assert.match(strict.stdout, /^✔ \.dreamteamer is fresh$/m);
		assert.ok(strict.stdout.split('\n').includes('proofs: 7 declared · 1 passed · 1 failed · 1 unavailable · 4 never'));
	});

	// ⚠ R38 — THE FLAG GATE ACCEPTS THE `=` FORM AND THE READER DID NOT. `dt status --strict=true`
	// passed the unknown-flag check (which splits on `=`) and then read as "no --strict at all", so a
	// FAILING proof exited 0 — a CI step written that way is green forever, for a reason nothing prints.
	test('status --strict=true is the same flag as --strict, not a flag nobody honoured', () => {
		const res = ws.dt('status', '--strict=true');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^✖ 1 proof\(s\) FAILED on this machine — dt list proofs$/m);
	});

	// ⚠ R46 — AND `--strict=false` IS OFF. `'false'` is a truthy string, so the first fix (match by
	// flag NAME) turned the `=` form on WHATEVER followed it — a CI step that had deliberately
	// disarmed the gate started failing, which is the same defect pointing the other way.
	test('status --strict=false is OFF — the value after the = is read, not just the name', () => {
		const res = ws.dt('status', '--strict=false');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		// the LINE still prints: status reports everything and gates last
		assert.ok(res.stdout.split('\n').some((l) => l.startsWith('proofs: 7 declared')), res.stdout);
		assert.doesNotMatch(res.stdout, /FAILED on this machine/);

		for (const off of ['--strict=0', '--strict=no', '--strict=off']) {
			assert.equal(ws.dt('status', off).code, 0, `${off} armed the gate`);
		}
	});

	// the same reader, on the verb that parses its own arguments — ONE implementation, so the two can
	// never disagree about what was typed. The fixture overrides `gate-fails` to pass, so the only
	// thing standing between this board and exit 0 is the UNAVAILABLE that `--strict` governs.
	test('prove --all --strict=false does not make an unavailable proof fatal', () => {
		const clean = proveWorkspace({ proofs: { 'gate-fails': { kind: 'gate', steps: [{ run: 'true' }] } } });

		const armed = clean.dt('prove', '--all', '--strict');
		assert.equal(armed.code, 1, armed.stdout + armed.stderr);
		assert.match(armed.stdout, /1 unavailable/);

		const off = clean.dt('prove', '--all', '--strict=false');
		assert.equal(off.code, 0, off.stdout + off.stderr);
		assert.match(off.stdout, /1 unavailable/);

		// and the bare flag is unchanged — a boolean that reads its value must still read its absence
		assert.equal(clean.dt('prove', '--all').code, 0);
	});

	test('status --bogus is refused, and the refusal names --strict', () => {
		const res = ws.dt('status', '--bogus');
		assert.equal(res.code, 1, res.stdout);
		assert.match(res.stderr, /unknown flag "--bogus" on `dt status`/);
		assert.match(res.stderr, /--strict/);
	});

	test('a workspace where every proof last passed exits 0 under --strict', () => {
		const clean = proveWorkspace();
		assert.equal(clean.dt('prove', 'gate-passes').code, 0);
		const res = clean.dt('status', '--strict');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(res.stdout.split('\n').includes('proofs: 6 declared · 1 passed · 0 failed · 0 unavailable · 5 never'), res.stdout);
	});

	// a verdict that is neither pass, fail, unavailable nor never still has to be COUNTED — a
	// summary whose numbers do not add up to the declared count is worse than no summary
	test('a PENDING tail is counted in the `other` segment, which appears only when it is not zero', () => {
		const pending = proveWorkspace();
		assert.equal(pending.dt('prove', 'note-gets-closed').code, 5);
		const res = pending.dt('status');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.ok(res.stdout.split('\n').includes('proofs: 6 declared · 0 passed · 0 failed · 0 unavailable · 5 never · 1 other'), res.stdout);
	});

	// ⚠ R28 — A KEPT SANDBOX IS A DIRECTORY NOTHING WILL COME BACK FOR. `.worktrees/` is gitignored,
	// so it accumulates in silence; the ledger is the only thing that knows the directory exists.
	test('status names the sandboxes a run left behind on purpose', () => {
		const kept = sandboxWorkspace();
		const sandbox = sandboxOf(kept.dt('prove', SANDBOX_PROOF).stdout);
		assert.equal(dt(sandbox, 'set', 'notes/fx-open', 'status=done').code, 0);
		assert.equal(kept.dt('prove', SANDBOX_PROOF, '--record', 'notes/fx-open', '--keep').code, 0);

		const res = kept.dt('status');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /^ {2}sandboxes left behind: 1 — dt list worktrees$/m);

		quietly(() => removeWorktree(findWorkspace(kept.root), sandbox, { force: true }));
		// and the line goes away when the directory does — a count nothing can clear is a lie
		assert.doesNotMatch(kept.dt('status').stdout, /sandboxes left behind/);
	});

	// ⚠ R38 — THE PROBE TURNED ON `given.where`, NOT ON "there is a record to pick". Compile refuses a
	// `given` carrying neither `where` nor `fixture`, so the only way here is a runtime written by an
	// engine that did not — which is exactly the case a read surface must survive: it printed
	// `available` for a proof whose record is not there, and `dt prove` then exited 4. The column now
	// asks the same question the runner does, for EVERY live proof that does not bring its own record.
	test('availability probes every live proof that is not a fixture, not only the ones with a where', () => {
		const legacy = proveWorkspace();
		fs.writeFileSync(
			path.join(legacy.root, '.dreamteamer', 'proofs', 'picks-a-ghost.proof.yaml'),
			dump({
				name: 'picks-a-ghost',
				about: ['skills/using-dreamteamer'],
				kind: 'live',
				mode: 'readonly',
				given: { collection: 'notes', pick: 'ghost' },
				steps: [{ perform: 'reopen it' }],
				expect: [{ record: '{record}', where: { status: { _eq: 'open' } } }],
			}),
		);
		assert.equal(rowFor(legacy.dt('list', 'proofs').stdout, 'picks-a-ghost').endsWith('  no-fixture  never'), true,
			legacy.dt('list', 'proofs').stdout);
		// and the column agrees with what the runner actually answers
		assert.equal(legacy.dt('prove', 'picks-a-ghost').code, 4);
	});

	// ⚠ R38 — ONE `.env` READ PER LISTING, NOT ONE PER PROOF. `resolveRequires` parsed the file itself
	// on every call, so `dt list proofs` re-read and re-parsed it once per row. The names are now a
	// parameter, which is also what makes "the file was not consulted" assertable at all.
	test('resolveRequires takes the .env key names as a parameter, so a listing parses the file once', () => {
		const ws = proveWorkspace();
		const injected = resolveRequires({ root: ws.root }, { env: ['NOT_IN_THE_FILE'] }, new Set(['NOT_IN_THE_FILE']));
		assert.deepEqual(injected, { ok: true, missing: [] }, 'the injected names were ignored and the file was read');
		// and the default still reads the file, so no caller has to know the seam exists
		const read = resolveRequires({ root: ws.root }, { env: ['NOT_IN_THE_FILE'] });
		assert.equal(read.ok, false);
		assert.equal(read.missing[0].fix, 'NOT_IN_THE_FILE is not set — add it to .env');
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// R45 — A FILTER'S LITERALS ARE SUBSTITUTED BEFORE THE FILTER RUNS.
//
// The defect the prose exposed: `expect: [{ collection: notes, where: { owner: { _eq: '{record}' } },
// count: … }]` — "running this left a note owned by the person I picked", which is the shape the
// spec's own worked example uses — reached `matchesFilter` as the LITERAL eight characters
// `{record}`. It matched nothing, in all three places a filter is evaluated: the `_delta` snapshot,
// the pre-check, and the after-pass. So the canonical live proof could not work at all, and what it
// printed was a confident count of zero.
//
// Three tests, one per evaluation site, and each one FAILS with the substitution removed.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** ada owns TWO notes, bob owns one, and the collection holds three — so the same filter, bound to
 *  two different picked records, has to answer two different numbers, and NEITHER of them is the
 *  zero an unsubstituted `{record}` matches or the three an absent filter would. That asymmetry is
 *  the whole assertion. */
function ownerWorkspace(proofs) {
	return proveWorkspace({
		people: [{ name: 'Ada' }, { name: 'Bob' }],
		notes: [{ name: 'a', owner: 'people/ada' }, { name: 'b', owner: 'people/bob' }, { name: 'c', owner: 'people/ada' }],
		proofs,
	});
}

/** `given` picks one person by id; the expectation counts the notes that point BACK at them. */
const ownerProof = (pick, count) => ({
	kind: 'live',
	mode: 'readonly',
	given: { collection: 'people', where: { name: { _nempty: true } }, pick },
	steps: [count._delta === undefined ? { run: 'true' } : { perform: 'add a note owned by {record}' }],
	expect: [{ collection: 'notes', where: { owner: { _eq: '{record}' } }, count }],
});

describe('dt prove — a {record} literal inside a where is the picked record (R45)', () => {
	// ⚠ THE SNAPSHOT AND THE AFTER-COUNT MUST RENDER THE SAME FILTER. A before-count taken on the raw
	// filter and an after-count on the rendered one are counts of two DIFFERENT questions, and their
	// difference is a number with no meaning — worse than either being wrong, because it looks like a
	// measurement. Unsubstituted, both sides count zero and the delta reads 0 for a proof that held.
	test('a _delta over a {record} filter counts only the picked record\'s notes, before and after', () => {
		const ws = ownerWorkspace({ 'notes-land-on-the-picked-person': ownerProof('ada', { _delta: 1 }) });

		const first = ws.dt('prove', 'notes-land-on-the-picked-person');
		assert.equal(first.code, 5, first.stdout + first.stderr);
		assert.match(first.stdout, /^PERFORM {2}add a note owned by people\/ada$/m);
		// ada's TWO notes — not the zero a literal `{record}` matches, and not the three the
		// collection holds
		assert.deepEqual(tail(ws.root, 'notes-land-on-the-picked-person').before, { 0: 2 });

		assert.equal(ws.dt('add', 'notes', '--name', 'd', '--owner', 'people/ada').code, 0);
		const done = ws.dt('prove', 'notes-land-on-the-picked-person', '--record', 'people/ada');
		assert.equal(done.code, 0, done.stdout + done.stderr);
		assert.match(done.stdout, /^ {2}count \+1 = \+1 ✔$/m);
	});

	// ⚠ THE FAIL SIDE HAS TO NAME A NUMBER ONLY THE RENDERED FILTER PRODUCES. bob owns ONE of the
	// three notes: an unsubstituted `{record}` would print `count 0`, and a missing filter `count 3`
	// — so the line below is wrong under either defect, which is what makes it a test rather than a
	// restatement.
	test('the count is the picked record\'s own — not zero, and not the whole collection', () => {
		const ws = ownerWorkspace({ 'owns-at-least-two': ownerProof('bob', { _gte: 2 }) });
		const res = ws.dt('prove', 'owns-at-least-two');
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, /^ {2}count 1 ≥ 2 ✖$/m);
	});

	// ⚠ THE PRE-CHECK EVALUATES THE SAME FILTER, and this is the test that pins it. For ada the
	// expectation ALREADY holds, so the proof is VACUOUS and no step ever runs — which is only
	// reachable if the pre-check rendered `{record}` too. Unsubstituted it counts zero, decides the
	// expectation does not hold, runs the step and answers FAIL.
	test('the PRE-CHECK renders it too — an already-true {record} count is VACUOUS, not FAIL', () => {
		const ws = ownerWorkspace({ 'someone-owns-a-note': ownerProof('ada', { _gte: 1 }) });
		const res = ws.dt('prove', 'someone-owns-a-note');
		assert.equal(res.code, 6, res.stdout + res.stderr);
		assert.match(res.stdout, /^VACUOUS {2}someone-owns-a-note — every expectation already holds against people\/ada/m);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The four the sandbox's own review round left open. Each one is a way a run could report something
// that is not true — a discard that claims nothing was attempted, a fixture refused for a file the
// operator's Finder wrote, a `data` that is not a directory, and a diagnosis that names only half
// the collections a proof actually reads.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('discarding, enumerating and diagnosing a sandbox', () => {
	// ⚠ THE DISCARDED ROW USED TO INHERIT THE PENDING ROW'S `sandbox_removed: null`, which reads as
	// "no removal was attempted" — about the one row where a removal certainly was. Nothing would
	// ever come back for the directory, and `dt status` counted it as fine.
	test('--restart removes the sandbox FIRST and records what actually happened to it', () => {
		const ws = sandboxWorkspace();
		const sandbox = sandboxOf(ws.dt('prove', SANDBOX_PROOF).stdout);
		assert.ok(fs.existsSync(sandbox));

		const again = ws.dt('prove', SANDBOX_PROOF, '--restart');
		assert.equal(again.code, 5, again.stdout + again.stderr);

		const rows = readLedger(ws.root, SANDBOX_PROOF);
		assert.equal(rows.length, 3, JSON.stringify(rows.map((r) => r.verdict)));
		assert.equal(rows[1].verdict, 'FAIL');
		assert.equal(rows[1].failure_reason, 'restarted');
		assert.equal(rows[1].sandbox, sandbox);
		assert.equal(rows[1].sandbox_removed, true, 'the discarded row claims no removal was attempted');
		assert.ok(!fs.existsSync(sandbox), 'the discarded sandbox is still on disk');
		// and the restart really did start over, in a NEW sandbox
		assert.notEqual(rows[2].sandbox, sandbox);
	});

	// ⚠ THE OPERATOR'S FILE MANAGER WRITES INTO THIS DIRECTORY. `.DS_Store` appears the first time
	// anyone opens the fixture folder in Finder, and refusing the whole proof for it would be a
	// failure nobody could act on — the file comes back.
	test('a dot-entry in the fixture directory is not a stray file', () => {
		const ws = sandboxWorkspace();
		fs.writeFileSync(path.join(ws.root, 'modules', 'default', 'proofs', 'fixtures', SANDBOX_PROOF, '.DS_Store'), 'finder\n');
		const res = ws.dt('prove', SANDBOX_PROOF);
		assert.equal(res.code, 5, res.stdout + res.stderr);
		assert.doesNotMatch(res.stdout, /may contain only data/);
	});

	test('a fixture whose data is a FILE says so, rather than copying it over the sandbox', () => {
		const ws = sandboxWorkspace({ fixturesFor: [] });
		const dir = path.join(ws.root, 'modules', 'default', 'proofs', 'fixtures', SANDBOX_PROOF);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'data'), 'not a directory\n');

		const res = ws.dt('prove', SANDBOX_PROOF);
		assert.equal(res.code, 1, res.stdout + res.stderr);
		assert.match(res.stdout, new RegExp(`^FAIL  ${SANDBOX_PROOF} — fixture data/ must be a directory$`, 'm'));
		assert.equal(tail(ws.root, SANDBOX_PROOF).verdict, 'FAIL');
		assert.deepEqual(fs.readdirSync(path.join(ws.root, '.worktrees')).filter((n) => n.startsWith('.tmp-')), []);
	});
});
