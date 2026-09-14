// A WRITE THAT LANDS IN THE WRONG WORKSPACE SUCCEEDS.
//
// This file exists because of a measured asymmetry in how harnesses load a workspace. Pointed at
// several workspaces at once, a harness loads skills, commands and agents as the UNION of all of
// them, but loads the workspace INSTRUCTIONS — the compiled block naming the collections — from the
// PRIMARY directory only. Across every session on record for one such machine: zero instruction
// blocks from the secondary workspaces, against one in every session for the primary.
//
// The consequence is not a crash. Most collection NAMES are shared between two workspaces while the
// FIELDS under them are not, so a write aimed at one and issued in the other passes validation and
// reports success. Nothing in the output said which workspace it landed in.
//
// Two behaviours are pinned here:
//
//   1. `--vault <path>` targets another workspace ATOMICALLY — it resolves the target's schema,
//      and it does not leave the working directory behind it the way a `cd` does
//   2. every record write NAMES the workspace it landed in, so a misfile is visible on the next
//      line of output rather than never
// ⚠ Each assertion is about the BEHAVIOUR. That `--vault` parses would have passed against a build
// that ignored it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, dtIn, ENGINE_ROOT } from '../helpers/ws.js';

/** Two workspaces whose same-named collection disagrees about what `status` may hold. */
function twoWorkspaces() {
	const enumOf = (v) => ({
		...simpleCollection(),
		schema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' }, status: { type: 'string', enum: [v] } },
		},
	});
	return {
		here: workspace({ collections: { widgets: enumOf('here-only') } }),
		there: workspace({ collections: { widgets: enumOf('there-only') } }),
	};
}

describe('--vault targets another workspace without moving the caller', () => {
	test('the record lands in the TARGET and never in the invoking workspace', () => {
		const { here, there } = twoWorkspaces();

		const res = dtIn(here.root, '--vault', there.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'there-only');
		assert.equal(res.code, 0, `expected the write to succeed:\n${res.stderr}`);

		assert.ok(fs.existsSync(path.join(there.root, 'data/widgets/gearbox.widget.md')), 'the record should be in the target workspace');
		assert.ok(!fs.existsSync(path.join(here.root, 'data/widgets/gearbox.widget.md')), 'the record must NOT be in the invoking workspace');
	});

	test('the TARGET schema validates — a value legal there and illegal here is accepted', () => {
		const { here, there } = twoWorkspaces();
		const res = dtIn(here.root, '--vault', there.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'there-only');
		assert.equal(res.code, 0, `the target's enum should have been applied, not the caller's:\n${res.stderr}`);
	});

	test('the CALLER schema is not consulted — a value legal here and illegal there is REFUSED', () => {
		const { here, there } = twoWorkspaces();
		const res = dtIn(here.root, '--vault', there.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'here-only');
		assert.notEqual(res.code, 0, 'a value the TARGET forbids must be rejected before disk');
		assert.ok(!fs.existsSync(path.join(there.root, 'data/widgets/gearbox.widget.md')), 'nothing may be written by a rejected command');
	});

	test('a relative --vault resolves against the INVOKING directory, not the target', () => {
		const { here, there } = twoWorkspaces();
		const rel = path.relative(here.root, there.root);
		const res = dtIn(here.root, '--vault', rel, 'add', 'widgets', '--name', 'Gearbox', '--status', 'there-only');
		assert.equal(res.code, 0, `a relative path should resolve from where it was typed:\n${res.stderr}`);
		assert.ok(fs.existsSync(path.join(there.root, 'data/widgets/gearbox.widget.md')));
	});

	test('the flag is consumed — the next bare command still resolves to the caller', () => {
		const { here, there } = twoWorkspaces();
		assert.equal(dtIn(here.root, '--vault', there.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'there-only').code, 0);

		// The effect of --vault must not outlive its own command. That is the whole difference
		// between it and a `cd`, whose effect silently steers whatever runs next.
		const after = dtIn(here.root, 'add', 'widgets', '--name', 'Flywheel', '--status', 'here-only');
		assert.equal(after.code, 0, `the caller's own schema should apply again:\n${after.stderr}`);
		assert.ok(fs.existsSync(path.join(here.root, 'data/widgets/flywheel.widget.md')), 'the follow-up write belongs to the caller');
	});

	test('--vault with no path, and --vault at a directory that is not there, both refuse', () => {
		const { here } = twoWorkspaces();

		const bare = dtIn(here.root, '--vault');
		assert.notEqual(bare.code, 0, '--vault with no argument must refuse');
		assert.match(bare.stderr, /--vault needs a path/);

		const missing = dtIn(here.root, '--vault', path.join(here.root, 'no-such-workspace'), 'list', 'widgets');
		assert.notEqual(missing.code, 0, '--vault at a missing directory must refuse');
		assert.match(missing.stderr, /no such directory/);
	});
});

describe('every record write names the workspace it landed in', () => {
	test('add prints the workspace beside the path', () => {
		const { here, there } = twoWorkspaces();
		const res = dtIn(here.root, '--vault', there.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'there-only');
		assert.ok(res.stdout.includes(there.ws.pkg.name), `the confirmation should name the target workspace, got: ${JSON.stringify(res.stdout)}`);
		assert.ok(res.stdout.includes('data/widgets/gearbox.widget.md'), 'and still name the path');
	});

	test('set names it too', () => {
		const { here } = twoWorkspaces();
		assert.equal(dtIn(here.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'here-only').code, 0);
		const res = dtIn(here.root, 'set', 'widgets/gearbox', 'name=Gearbox II');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(res.stdout.includes(here.ws.pkg.name), `set should name the workspace, got: ${JSON.stringify(res.stdout)}`);
	});

	test('--json is unchanged — the name is for the human line only', () => {
		const { here } = twoWorkspaces();
		const res = dtIn(here.root, 'add', 'widgets', '--name', 'Gearbox', '--status', 'here-only', '--json');
		assert.equal(res.code, 0, res.stderr);
		const parsed = JSON.parse(res.stdout);
		assert.equal(parsed.id, 'gearbox', 'the JSON payload keeps its shape for scripts');
	});
});

// ── the dev-clone re-entry ────────────────────────────────────────────────────────────────────
//
// bin/dreamteamer.js RE-IMPORTS ITSELF when the workspace carries a git_modules/dreamteamer clone,
// so --vault is seen TWICE by the same parsing code. It is spliced out of process.argv, not merely
// out of the slice handed to run(), for exactly that reason — left in place, the second pass would
// resolve the path again with the working directory ALREADY MOVED.
//
// ⚠ THE FIXTURE HAS TO RUN FROM A SUBDIRECTORY. Two sibling workspaces make double-application
// accidentally idempotent: `../ws-B` resolved from ws-A and then again from ws-B lands on ws-B both
// times, so the bug hides. One level deeper, `../../ws-B` resolves correctly the first time and off
// the end of the tree the second — which is the difference this test is here to see.

/** A second engine whose realpath differs from this one, so the self-shadow guard re-enters. */
function fakeEngine(at) {
	fs.mkdirSync(path.join(at, 'bin'), { recursive: true });
	fs.copyFileSync(path.join(ENGINE_ROOT, 'bin/dreamteamer.js'), path.join(at, 'bin/dreamteamer.js'));
	for (const link of ['src', 'node_modules', 'package.json']) {
		fs.symlinkSync(path.join(ENGINE_ROOT, link), path.join(at, link));
	}
	return at;
}

describe('--vault survives the dev-clone re-entry', () => {
	test('a relative --vault from a subdirectory resolves ONCE, with a git_modules clone present', () => {
		const here = workspace({ collections: { widgets: simpleCollection() } });
		const there = workspace({ collections: { widgets: simpleCollection() } });
		assert.equal(dtIn(there.root, 'add', 'widgets', '--name', 'Gearbox').code, 0);

		// the target carries a dev clone, so running against it re-enters bin/dreamteamer.js
		fs.mkdirSync(path.join(there.root, 'git_modules'), { recursive: true });
		fs.symlinkSync(fakeEngine(path.join(there.root, '.engine-copy')), path.join(there.root, 'git_modules/dreamteamer'));

		const from = path.join(here.root, 'data');
		fs.mkdirSync(from, { recursive: true });
		const rel = path.relative(from, there.root); // ../../ws-XXXX — wrong on a second application

		const res = dtIn(from, '--vault', rel, 'list', 'widgets');
		assert.equal(res.code, 0, `the flag was applied twice, or the clone broke the walk:\n${res.stderr}`);
		assert.match(res.stdout, /gearbox/, "the target's own record should come back");
		assert.doesNotMatch(res.stderr, /no such directory/, 'a second application would resolve off the end of the tree');
	});

	test('the re-entry actually happened — otherwise the test above proves nothing', () => {
		const there = workspace({ collections: { widgets: simpleCollection() } });
		fs.mkdirSync(path.join(there.root, 'git_modules'), { recursive: true });
		fs.symlinkSync(fakeEngine(path.join(there.root, '.engine-copy')), path.join(there.root, 'git_modules/dreamteamer'));

		const res = dtIn(there.root, 'list', 'widgets');
		assert.match(res.stderr, /git_modules\/dreamteamer dev clone/, 'the fixture must exercise the shadow path, not bypass it');
	});
});
