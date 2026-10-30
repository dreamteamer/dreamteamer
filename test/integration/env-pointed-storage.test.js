// Tier 2 — an env-pointed root: `storage.path: ${env:NAME}/…` keeps a collection's records in a
// per-machine folder outside the workspace.
//
// The defect this pins: a template in `storage.path` compiled, and every verb wrote into and read
// from a LITERAL folder named `${env:NAME}` inside the workspace, each reporting ✔. So the central
// assertions are about WHERE the file is — under the rendered folder, and not under the literal one
// — and that an unrenderable template refuses rather than creating anything.
//
// Invented names and throwaway folders only; nothing here reads the machine's own .env.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspace, writeModule, compileError, tree, dt } from '../helpers/ws.js';

const NOTES = {
	description: 'A scratch note kept on this machine only.',
	ids: { from: '{{ name | slug }}' },
	storage: { path: '${env:NOTES_ANNEX}/notes', suffix: 'note' },
	fields: {
		name: { type: 'string', required: true },
		notes: { type: 'markdown', body: true },
	},
};

const LITERAL = '${env:NOTES_ANNEX}';

/** A folder OUTSIDE the workspace, as the operator's .env would name one. */
function annex() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-annex-'));
	process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
	return fs.realpathSync(dir);
}

describe('an env-pointed storage.path renders per machine', () => {
	test('compile renders the root; add writes under the rendered folder and NOT under a literal one; list, get and check read it', () => {
		const dir = annex();
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: NOTES }, compile: false });
		fs.writeFileSync(path.join(ws.root, '.env'), `NOTES_ANNEX=${dir}\n`);
		const run = (...a) => dt(ws.root, ...a);

		const compiled = run('compile');
		assert.equal(compiled.code, 0, compiled.stderr);

		const added = run('add', 'notes', '--name', 'first thought');
		assert.equal(added.code, 0, added.stderr);
		const expected = path.join(dir, 'notes', 'first-thought.note.md');
		assert.ok(fs.existsSync(expected), `record missing at ${expected}\n${added.stdout}`);
		assert.match(added.stdout, /first-thought\.note\.md/);
		// the defect: a literal folder named after the template, inside the workspace
		assert.ok(!fs.existsSync(path.join(ws.root, LITERAL)), 'a literal ${env:…} folder was created inside the workspace');
		assert.ok(!tree(ws.root).some((p) => p.includes('${env')), 'a literal ${env:…} path appeared in the workspace tree');

		const listed = run('list', 'notes');
		assert.equal(listed.code, 0, listed.stderr);
		assert.match(listed.stdout, /first-thought/);

		const got = run('get', 'notes/first-thought');
		assert.equal(got.code, 0, got.stderr);
		assert.match(got.stdout, /first thought/);

		// where it is read from: the rendered folder, and NO repo — it is never committed
		const located = JSON.parse(run('get', 'notes/first-thought', '--json').stdout);
		assert.equal(located.$file, expected);
		assert.equal(located.$repo, null);
		assert.deepEqual(JSON.parse(run('list', 'notes', '--json').stdout).map((r) => r.$repo), [null]);
		const set = run('set', 'notes/first-thought', 'name=first thought, edited');
		assert.equal(set.code, 0, set.stderr);
		assert.match(set.stdout, /updated — outside every git repo here, never committed/);

		const checked = run('check');
		assert.equal(checked.code, 0, `${checked.stdout}\n${checked.stderr}`);
		assert.match(checked.stdout, /0 violations/);
	});

	test('the folder is outside the workspace repo: git sees nothing, and dt commit says so instead of failing', () => {
		const dir = annex();
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: NOTES }, compile: false });
		fs.writeFileSync(path.join(ws.root, '.env'), `NOTES_ANNEX=${dir}\n`);
		const run = (...a) => dt(ws.root, ...a);
		assert.equal(run('compile').code, 0);
		assert.equal(run('add', 'notes', '--name', 'kept here').code, 0);

		// nothing of it in the workspace repo — not as a record, not as a literal folder
		assert.equal(ws.git(['status', '--porcelain', '-uall', '--', 'data']), '');
		assert.ok(!ws.git(['status', '--porcelain', '-uall']).includes('${env'));

		const unscoped = run('commit');
		assert.equal(unscoped.code, 0, unscoped.stderr);
		assert.match(unscoped.stdout, /notes: .* is outside every git repo here .*never committed/);

		const scoped = run('commit', 'notes/kept-here');
		assert.equal(scoped.code, 0, scoped.stderr);
		assert.match(scoped.stdout, /notes: .* outside every git repo here/);
		assert.doesNotMatch(scoped.stderr, /no such record/);

		// a mistyped id is still a mistyped id, not "outside"
		const typo = run('commit', 'notes/never-written');
		assert.equal(typo.code, 1);
		assert.match(typo.stderr, /no such record/);
	});

	test('dt status names the rendered folder on the collection\'s line', () => {
		const dir = annex();
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: NOTES }, compile: false });
		fs.writeFileSync(path.join(ws.root, '.env'), `NOTES_ANNEX=${dir}\n`);
		const run = (...a) => dt(ws.root, ...a);
		assert.equal(run('compile').code, 0);
		const status = run('status');
		assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
		assert.match(status.stdout, /^storage:$/m);
		const line = status.stdout.split('\n').find((l) => /^\s+notes\s/.test(l));
		assert.ok(line, `no notes line in:\n${status.stdout}`);
		assert.ok(line.includes(path.join(dir, 'notes')), `rendered folder not named: ${line}`);
		assert.ok(line.includes('${env:NOTES_ANNEX}/notes'), `template not shown beside it: ${line}`);
		assert.match(line, /outside every repo here/);
	});

	test('a template rendering INSIDE the workspace is an ordinary root: workspace-relative, committed like any other', () => {
		const inside = { ...NOTES, storage: { path: '${workspaceFolder}/state/notes', suffix: 'note' } };
		const ws = workspace({ pkg: { vars: [] }, collections: { notes: inside }, compile: false });
		const run = (...a) => dt(ws.root, ...a);
		assert.equal(run('compile').code, 0);
		assert.equal(run('add', 'notes', '--name', 'local').code, 0);
		assert.ok(fs.existsSync(path.join(ws.root, 'state', 'notes', 'local.note.md')));
		const committed = run('commit', 'notes/local');
		assert.equal(committed.code, 0, committed.stderr);
		assert.match(committed.stdout, /✔ workspace/);
		assert.equal(ws.git(['status', '--porcelain', '-uall', '--', 'state']), '');
	});
});

describe('an env-pointed storage.path that cannot render', () => {
	test('an UNSET var: compile warns naming the collection and the var; add, list and get refuse naming both; no literal folder is created', () => {
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: NOTES }, compile: false });
		fs.writeFileSync(path.join(ws.root, '.env'), 'UNRELATED=1\n');
		const run = (...a) => dt(ws.root, ...a);

		const compiled = run('compile');
		assert.equal(compiled.code, 0, compiled.stderr);
		assert.match(compiled.stderr, /collection notes: storage\.path \$\{env:NOTES_ANNEX\}\/notes cannot render/);
		assert.match(compiled.stderr, /NOTES_ANNEX/);

		for (const args of [['add', 'notes', '--name', 'nope'], ['list', 'notes'], ['get', 'notes/nope']]) {
			const res = run(...args);
			assert.equal(res.code, 1, `${args.join(' ')} should refuse:\n${res.stdout}`);
			assert.match(res.stderr, /collection "notes"/, args.join(' '));
			assert.match(res.stderr, /NOTES_ANNEX/, args.join(' '));
		}
		assert.ok(!fs.existsSync(path.join(ws.root, LITERAL)), 'a literal ${env:…} folder was created');
		assert.ok(!tree(ws.root).some((p) => p.includes('${env')));

		// the collection is unread here, said once, and not a violation: the check gate stays green
		// on a machine that does not have the folder, the way an uninstalled layer does
		const checked = run('check');
		assert.equal(checked.code, 0, `${checked.stdout}\n${checked.stderr}`);
		assert.match(checked.stdout, /collection notes: .*NOTES_ANNEX.* not read on this machine/);

		const status = run('status');
		assert.equal(status.code, 0);
		assert.match(status.stdout, /notes\s+✖ \$\{env:NOTES_ANNEX\}\/notes — .*NOTES_ANNEX/);
	});

	test('an EMPTY var refuses exactly like an unset one', () => {
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: NOTES }, compile: false });
		fs.writeFileSync(path.join(ws.root, '.env'), 'NOTES_ANNEX=\n');
		const run = (...a) => dt(ws.root, ...a);
		assert.equal(run('compile').code, 0);
		const res = run('add', 'notes', '--name', 'nope');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /collection "notes".*NOTES_ANNEX.*no value/);
		assert.ok(!fs.existsSync(path.join(ws.root, LITERAL)));
	});

	test('no .env at all: same refusal, same message', () => {
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: NOTES }, compile: false });
		const run = (...a) => dt(ws.root, ...a);
		assert.equal(run('compile').code, 0);
		const res = run('list', 'notes');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /collection "notes".*NOTES_ANNEX/);
	});
});

describe('declaring the var', () => {
	test('a var no dreamteamer.vars declares warns at compile, naming the collection and the var, and still renders', () => {
		const dir = annex();
		const ws = workspace({ pkg: { vars: [] }, collections: { notes: NOTES }, compile: false });
		fs.writeFileSync(path.join(ws.root, '.env'), `NOTES_ANNEX=${dir}\n`);
		const run = (...a) => dt(ws.root, ...a);
		const compiled = run('compile');
		assert.equal(compiled.code, 0, compiled.stderr);
		assert.match(compiled.stderr, /collection notes: storage\.path reads \$\{env:NOTES_ANNEX\}, which no dreamteamer\.vars declares/);
		assert.equal(run('add', 'notes', '--name', 'anyway').code, 0);
		assert.ok(fs.existsSync(path.join(dir, 'notes', 'anyway.note.md')));
	});

	test('a module that ships the collection and declares the var in its own dreamteamer.vars compiles without the warning', () => {
		const dir = annex();
		const ws = workspace({ pkg: { vars: [] }, compile: false });
		writeModule(ws.root, 'scratch', { description: 'Per-machine scratch.', collections: { jots: { ...NOTES, storage: { path: '${env:NOTES_ANNEX}/jots', suffix: 'jot' } } } });
		const pkgFile = path.join(ws.root, 'modules', 'scratch', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
		pkg.dreamteamer.vars = ['NOTES_ANNEX'];
		fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, '\t') + '\n');
		fs.writeFileSync(path.join(ws.root, '.env'), `NOTES_ANNEX=${dir}\n`);
		const run = (...a) => dt(ws.root, ...a);
		const compiled = run('compile');
		assert.equal(compiled.code, 0, compiled.stderr);
		assert.doesNotMatch(compiled.stderr, /which no dreamteamer\.vars declares/);
		assert.equal(run('add', 'jots', '--name', 'shipped').code, 0);
		assert.ok(fs.existsSync(path.join(dir, 'jots', 'shipped.jot.md')));
	});
});

describe('what an env-pointed root cannot combine with', () => {
	test('storage.owner: module is refused — the records are per machine, not a clone\'s', () => {
		const ws = workspace({ pkg: { vars: ['NOTES_ANNEX'] }, collections: { notes: { ...NOTES, storage: { ...NOTES.storage, owner: 'module' } } }, compile: false });
		const err = compileError(ws.ws);
		assert.ok(err, 'compiled');
		assert.match(err, /collection "notes": storage\.path .* is a template/);
		assert.match(err, /storage\.owner: module/);
	});

	test('a variable the renderer does not know is refused rather than left as a literal folder', () => {
		const ws = workspace({ pkg: { vars: [] }, collections: { notes: { ...NOTES, storage: { path: '${NOTES_ANNEX}/notes', suffix: 'note' } } }, compile: false });
		const err = compileError(ws.ws);
		assert.ok(err, 'compiled');
		assert.match(err, /still holds/);
	});
});
