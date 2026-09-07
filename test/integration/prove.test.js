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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, readFile, compileError } from '../helpers/ws.js';
import { artifactRefs } from '../../src/prove.js';
import { dump } from '../../src/yaml.js';
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
		assert.match(res.stdout + res.stderr, /external/);
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

		const refs = artifactRefs(new Store(ws.ws));
		assert.deepEqual(refs.skills, ['skills/using-dreamteamer'], 'a skill is its FOLDER, not its references/*.md');
		assert.deepEqual(refs.commands, ['commands/hello']);
		assert.deepEqual(refs.bindings, []);
		assert.deepEqual(refs.scripts, ['dreamteamer/bin/dreamteamer.js'], 'a module script is <module-id>/bin/<file>');
		assert.equal(refs.all.size, 3);
	});

	test('the orientation block every session reads tells it to run `dreamteamer prove`', () => {
		const ws = workspace();
		assert.equal(ws.dt('compile').code, 0);
		const claude = readFile(ws.root, 'CLAUDE.md');
		assert.match(claude, /run `dreamteamer prove <artifact>` and quote its result/);
	});
});
