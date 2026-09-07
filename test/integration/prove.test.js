// test/integration/prove.test.js — tier 2: `proofs`, the eighth source kind.
//
// This file only pins what Task 1 of the `dt prove` slice actually built: a new STAGED kind,
// generic for free (list/get/set/rm/rename), refused as hand-authored on `add`, and the one design
// bug the spike found — the ledger directory has to be dot-prefixed because compile wipes every
// kind folder on every run. Nothing here proves a proof's own semantics (`kind`/`mode`/`expect`
// cross-field rules) — that is Task 2's `validateProofShape`, tested where it is written.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, readFile } from '../helpers/ws.js';
import { dump } from '../../src/yaml.js';

/** Write a minimal proof source at `modules/default/proofs/<id>.proof.yaml`. `about` is allowed to
 *  reference nothing yet — Task 1 does not validate it. */
function writeProof(root, id, fields = {}) {
	const file = path.join(root, 'modules', 'default', 'proofs', `${id}.proof.yaml`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, dump({ name: id, about: ['skills/reviewing-roles'], kind: 'gate', ...fields }));
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
		const res = ws.dt('set', 'proofs/skill-loads', 'kind=live');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const src = readFile(ws.root, 'modules/default/proofs/skill-loads.proof.yaml');
		assert.match(src, /kind: live/);
		// self-commits, like every system write (policy stated once in `dt help`) — assert the
		// commit actually landed, not just that the printed line CLAIMS it did.
		assert.match(res.stdout, /✔ committed in the workspace/);
		assert.match(ws.git(['log', '-1', '--format=%s']), /proofs set skill-loads kind/);
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
			given: { collection: 'notes', where: {}, pick: 'latest' },
			steps: [{ run: 'true' }],
			expect: [{ collection: 'notes', where: {}, count: { _gte: 0 } }],
		});
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.doesNotMatch(res.stdout + res.stderr, /given\.collection/);
		assert.doesNotMatch(res.stdout + res.stderr, /notes/);
	});

	// ⚠ MINOR 7 — pinning the ajv ENUM as a gate, and nothing more. `kind` is a closed enum on the
	// descriptor, so an invalid value is a schema violation `check` catches — but compile only
	// STAGES a proof (never validates its semantics), so an invalid `kind` still compiles clean.
	// The two together are the whole point: staging is unconditional, and the gate is `check`, not
	// `compile` — exactly the split Task 1 owes and Task 2's `validateProofShape` builds on top of.
	test('an invalid kind stages clean through compile and is caught by check', () => {
		const ws = workspace();
		writeProof(ws.root, 'bad-kind', { kind: 'nope' });
		assert.equal(ws.dt('compile').code, 0, 'compile stages sources — it does not validate proof semantics');
		const res = ws.dt('check');
		assert.notEqual(res.code, 0, 'check runs ajv over every runtime-stored record, including proofs');
		assert.match(res.stdout + res.stderr, /field kind: "nope" not in enum/);
	});
});
