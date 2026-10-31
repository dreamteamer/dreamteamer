// The record-change report (0.42.0) — `dt changes` measures what a turn changed, `dt commit` prints
// the same block for what it published, and the using-dreamteamer skill tells a session to end its
// reply with it. Driven through the real CLI on an HQ workspace with one record layer cloned under
// git_modules/, because the layer is the case the report exists to make visible: a write into a
// layer never shows in the reader's own `git status`.
//
// ⚠ Each assertion is about what was PRINTED for records that were really written, never that a
// flag parsed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, compileQuietly, dt, git, ENGINE_ROOT } from '../helpers/ws.js';
import { reportLine, groupChanges } from '../../src/events.js';

const contacts = simpleCollection({ storage: { suffix: 'contact' } });
const meetings = simpleCollection({ storage: { suffix: 'meeting' } });
const issues = simpleCollection({ storage: { suffix: 'issue' } });

/** An HQ (contacts, meetings, issues) and one project workspace `project-a` (issues) cloned under its
 *  git_modules/ — read whole, as 0.41.0 reads a clone that names its workspace module. Seeded and
 *  committed: two contacts and a meeting in the HQ. */
function hqWithLayer() {
	const hq = workspace({ collections: { contacts, meetings, issues } });
	const proj = workspace({ collections: { issues } });
	const clone = path.join(hq.root, 'git_modules', 'project-a');
	fs.mkdirSync(path.dirname(clone), { recursive: true });
	fs.cpSync(proj.root, clone, { recursive: true, dereference: false, verbatimSymlinks: true });
	const lpkg = JSON.parse(fs.readFileSync(path.join(clone, 'package.json'), 'utf8'));
	lpkg.name = 'project-a';
	fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify(lpkg, null, '\t') + '\n');
	git(clone, ['add', 'package.json']); git(clone, ['commit', '-qm', 'name']);
	compileQuietly({ root: clone, pkg: lpkg });
	const pkgPath = path.join(hq.root, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.dreamteamer.git_modules = { 'project-a': { url: 'x', ref: 'main' } };
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	git(hq.root, ['add', 'package.json']); git(hq.root, ['commit', '-qm', 'layer']);
	hq.ws.pkg = pkg;
	compileQuietly(hq.ws);
	for (const name of ['Dana Oren', 'Harbor Mutual Desk']) assert.equal(dt(hq.root, 'add', 'contacts', '--name', name).code, 0);
	assert.equal(dt(hq.root, 'add', 'meetings', '--name', 'Kickoff').code, 0);
	assert.equal(dt(hq.root, 'commit', '-m', 'seed').code, 0);
	return { hq, clone };
}

/** The CR's walk: one contact added, two set, one meeting removed, one issue added INTO the layer. */
function fiveWrites(hq) {
	for (const args of [
		['add', 'contacts', '--name', 'Sam Diaz'],
		['set', 'contacts/dana-oren', 'notes=Met at the Northwind offsite.'],
		['set', 'contacts/harbor-mutual-desk', 'notes=Renewal due in March.'],
		['rm', 'meetings/kickoff'],
		['add', 'issues', '--name', 'Login times out', '-w', 'project-a'],
	]) {
		const res = dt(hq.root, ...args);
		assert.equal(res.code, 0, `${args.join(' ')}: ${res.stderr}`);
	}
}

/** Wait for the wall clock to tick over a second: `--since <sha>` resolves the sha to its commit DATE
 *  and `--before` is inclusive at second precision, so a commit in the same second reads as the base. */
function nextSecond() {
	const start = Math.floor(Date.now() / 1000);
	while (Math.floor(Date.now() / 1000) === start) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

const LINE = 'records — contacts: 1 created, 2 updated · issues (project-a): 1 created · meetings: 1 deleted';

describe('dt changes — what this turn changed, across the workspace and its layers', () => {
	test('five writes, one of them into a layer: five records, each with ref, path, layer and committed:false', () => {
		const { hq } = hqWithLayer();
		fiveWrites(hq);
		const res = dt(hq.root, 'changes', '--json');
		assert.equal(res.code, 0, res.stderr);
		const out = JSON.parse(res.stdout);
		assert.equal(out.since, 'HEAD');
		assert.deepEqual(out.events.map((e) => [e.ref, e.change, e.path, e.layer, e.committed]), [
			['contacts/dana-oren', 'updated', 'data/contacts/dana-oren.contact.md', null, false],
			['contacts/harbor-mutual-desk', 'updated', 'data/contacts/harbor-mutual-desk.contact.md', null, false],
			['contacts/sam-diaz', 'created', 'data/contacts/sam-diaz.contact.md', null, false],
			['issues/login-times-out', 'created', 'git_modules/project-a/data/issues/login-times-out.issue.md', 'project-a', false],
			['meetings/kickoff', 'deleted', 'data/meetings/kickoff.meeting.md', null, false],
		]);
		assert.equal(out.events.find((e) => e.ref === 'issues/login-times-out').repo, 'git_modules/project-a');
		assert.equal(out.events.find((e) => e.ref === 'contacts/sam-diaz').type, 'item-added', 'the 0.41.0 key is kept for old readers');
		assert.deepEqual(out.collections, [
			{ collection: 'contacts', layer: null, created: 1, updated: 2, deleted: 0 },
			{ collection: 'issues', layer: 'project-a', created: 1, updated: 0, deleted: 0 },
			{ collection: 'meetings', layer: null, created: 0, updated: 0, deleted: 1 },
		]);
	});

	test('the human output opens with the report line, then one row per record with its path, then the count', () => {
		const { hq } = hqWithLayer();
		fiveWrites(hq);
		const res = dt(hq.root, 'changes');
		assert.equal(res.code, 0, res.stderr);
		const lines = res.stdout.trimEnd().split('\n');
		assert.equal(lines[0], LINE);
		assert.match(res.stdout, /^ {2}created {2}contacts\/sam-diaz {2}data\/contacts\/sam-diaz\.contact\.md {2}· uncommitted$/m);
		assert.match(res.stdout, /^ {2}deleted {2}meetings\/kickoff {2}data\/meetings\/kickoff\.meeting\.md {2}· uncommitted$/m);
		assert.match(res.stdout, /^ {2}created {2}issues\/login-times-out {2}git_modules\/project-a\/data\/issues\/login-times-out\.issue\.md {2}· uncommitted · layer project-a$/m);
		assert.equal(lines.length, 7, res.stdout);
		assert.equal(lines[6], '5 record change(s) since HEAD — 5 uncommitted');
		// the line the verb prints IS the pure function's, so the skill's format and the verb cannot drift
		assert.equal(lines[0], reportLine(groupChanges(JSON.parse(dt(hq.root, 'changes', '--json').stdout).events)));
	});

	test('--since <sha>: the commits since then are folded in, each record saying whether it is committed', () => {
		const { hq } = hqWithLayer();
		const base = git(hq.root, ['rev-parse', 'HEAD']);
		nextSecond();
		fiveWrites(hq);
		assert.equal(dt(hq.root, 'commit', 'contacts/sam-diaz', 'meetings/kickoff').code, 0);
		assert.deepEqual(JSON.parse(dt(hq.root, 'changes', '--json').stdout).events.map((e) => e.ref),
			['contacts/dana-oren', 'contacts/harbor-mutual-desk', 'issues/login-times-out'], 'HEAD: what is still uncommitted');
		const res = dt(hq.root, 'changes', '--since', base, '--json');
		assert.equal(res.code, 0, res.stderr);
		assert.deepEqual(JSON.parse(res.stdout).events.map((e) => [e.ref, e.change, e.committed]), [
			['contacts/dana-oren', 'updated', false],
			['contacts/harbor-mutual-desk', 'updated', false],
			['contacts/sam-diaz', 'created', true],
			['issues/login-times-out', 'created', false],
			['meetings/kickoff', 'deleted', true],
		]);
		assert.match(dt(hq.root, 'changes', '--since', base).stdout, /^ {2}created {2}contacts\/sam-diaz {2}data\/contacts\/sam-diaz\.contact\.md {2}· committed$/m);
	});

	test('-w <layer> runs it IN the layer: its own pending record, at its own path', () => {
		const { hq } = hqWithLayer();
		fiveWrites(hq);
		const out = JSON.parse(dt(hq.root, 'changes', '--json', '-w', 'project-a').stdout);
		assert.deepEqual(out.events.map((e) => [e.ref, e.change, e.path, e.repo, e.layer]), [
			['issues/login-times-out', 'created', 'data/issues/login-times-out.issue.md', '.', null],
		]);
	});

	test('nothing written: nothing reported', () => {
		const { hq } = hqWithLayer();
		const res = dt(hq.root, 'changes');
		assert.equal(res.code, 0);
		assert.equal(res.stdout.trim(), '✔ no record changes since HEAD');
		assert.deepEqual(JSON.parse(dt(hq.root, 'changes', '--json').stdout).events, []);
	});

	test('--since with no value is refused rather than read as a ref called "undefined"', () => {
		const { hq } = hqWithLayer();
		const res = dt(hq.root, 'changes', '--since');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr, /--since needs a commit or a date/);
	});
});

describe('dt commit prints the same block for what it published', () => {
	test('one report line and one row per published record, across the workspace and the layer, each with its sha', () => {
		const { hq, clone } = hqWithLayer();
		fiveWrites(hq);
		const res = dt(hq.root, 'commit', '-m', 'the five');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, new RegExp(`^${LINE.replace(/[()]/g, '\\$&')}$`, 'm'));
		const hqSha = git(hq.root, ['rev-parse', '--short', 'HEAD']);
		const layerSha = git(clone, ['rev-parse', '--short', 'HEAD']);
		assert.match(res.stdout, new RegExp(`^ {2}created {2}contacts/sam-diaz {2}data/contacts/sam-diaz\\.contact\\.md {2}· committed ${hqSha}$`, 'm'));
		assert.match(res.stdout, new RegExp(`^ {2}created {2}issues/login-times-out {2}git_modules/project-a/data/issues/login-times-out\\.issue\\.md {2}· committed ${layerSha} · layer project-a$`, 'm'));
		assert.equal((res.stdout.match(/· committed /g) ?? []).length, 5, res.stdout);
		assert.equal(dt(hq.root, 'changes').stdout.trim(), '✔ no record changes since HEAD', 'and nothing is left');
	});

	test('a dry run prints the block too, every row uncommitted', () => {
		const { hq } = hqWithLayer();
		fiveWrites(hq);
		const res = dt(hq.root, 'commit', '--dry-run');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, new RegExp(`^${LINE.replace(/[()]/g, '\\$&')}$`, 'm'));
		assert.equal((res.stdout.match(/· uncommitted/g) ?? []).length, 5, res.stdout);
	});
});

describe('the rule a session follows — in the skill, and one sentence in the harness block', () => {
	const skill = fs.readFileSync(path.join(ENGINE_ROOT, 'skills', 'using-dreamteamer', 'SKILL.md'), 'utf8');
	const section = skill.slice(skill.indexOf('## a reply that wrote records ends with the record report'));

	test('the skill carries the rule and the format', () => {
		assert.ok(skill.includes('## a reply that wrote records ends with the record report'), 'the section exists');
		const body = section.slice(0, section.indexOf('\n## ', 4));
		for (const must of [
			'dt changes',                                   // measured, not recalled
			'--since',                                      // a turn that committed midway
			'records — contacts: 1 created, 2 updated',     // the line, as the verb prints it
			'(git_modules/project-a/data/issues/',          // a layer write's link is still a workspace path
			'issues (project-a)',                           // a layer write names the layer
			'[contacts/sam-diaz](data/contacts/sam-diaz.contact.md)', // a record is a link to its file
			'meetings/kickoff (deleted)',                   // a deleted record is its ref, unlinked
			'nothing written, nothing appended',
			'measured, not attributed',                     // review r1-03: the verb cannot say whose; rows left out are counted, never dropped silently
			'pending rows left out',
		]) assert.ok(body.includes(must), `the section says ${must}`);
	});

	test('the compiled CLAUDE.md repeats the rule in one sentence and points at the skill', () => {
		const { hq } = hqWithLayer();
		const claude = fs.readFileSync(path.join(hq.root, 'CLAUDE.md'), 'utf8');
		assert.match(claude, /a reply that wrote records ends with the record report `dt changes` prints — the format is in the skill/);
	});
});
