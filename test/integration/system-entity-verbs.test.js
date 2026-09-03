// Tier 2 — §3.1's TABLE, row by row: the record verbs applied to every system collection.
//
// Decision 241 (2026-08-22) grouped schema ops deliberately "so meta-writes are visibly a different
// act". That grouping is what made system entities second-class: each operation had to be
// individually invented, so there was no add-module, no rm-module, no rename-field and no way to
// name a target module. Design-06 had said the opposite — "knowhow entities are collections too …
// so the studio and CLI list and manage them uniformly" — and this restores that intent.
//
// The policy difference survives the spelling collapse and is stated ONCE, in help and in the
// skill: a SYSTEM write self-commits, a RECORD write does not. An uncompilable or unpublished
// schema is not a state a workspace should sit in.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoModuleWorkspace, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

describe('skills — add scaffolds the minimum that compiles', () => {
	test('add skills --name --description writes SKILL.md with frontmatter and an empty body', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'skills', '--name', 'reviewing-roles',
			'--description', 'Use when a role needs a second read before it is posted.');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const md = readFile(ws.root, 'modules/default/skills/reviewing-roles/SKILL.md');
		assert.ok(md, 'a skill is a FOLDER, and SKILL.md is the entity file');
		const fm = load(/^---\n([\s\S]*?)\n---/.exec(md)[1]);
		assert.equal(fm.name, 'reviewing-roles');
		assert.equal(fm.description, 'Use when a role needs a second read before it is posted.');
		assert.equal(ws.dt('compile').code, 0);
		assert.match(ws.dt('list', 'skills').stdout, /reviewing-roles/);
	});

	test('--module puts it in that module', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'skills', '--name', 'reviewing-roles', '--description', 'x', '--module', 'hr').code, 0);
		assert.ok(readFile(ws.root, 'modules/hr/skills/reviewing-roles/SKILL.md'));
	});

	test('--description is REQUIRED — an undescribed skill is undiscoverable', () => {
		const ws = twoModuleWorkspace();
		const res = ws.dt('add', 'skills', '--name', 'reviewing-roles');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--description is required/);
		assert.match(res.stderr, /says WHEN to load/);
		assert.equal(fs.existsSync(path.join(ws.root, 'modules/default/skills/reviewing-roles')), false);
	});

	test('set edits the frontmatter and leaves the body alone', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'skills', '--name', 'reviewing-roles', '--description', 'x').code, 0);
		const file = path.join(ws.root, 'modules/default/skills/reviewing-roles/SKILL.md');
		fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n## How\n\nRead it twice.\n`);
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('set', 'skills/reviewing-roles', 'description=Use when a role needs a second read.').code, 0);
		const md = readFile(ws.root, 'modules/default/skills/reviewing-roles/SKILL.md');
		assert.match(md, /description: Use when a role needs a second read\./);
		assert.match(md, /Read it twice\./, 'the body is the author\'s, not the verb\'s');
	});

	test('rename moves the folder and the frontmatter name together', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'skills', '--name', 'reviewing-roles', '--description', 'x').code, 0);
		assert.equal(ws.dt('rename', 'skills/reviewing-roles', 'reviewing-postings').code, 0);
		assert.equal(readFile(ws.root, 'modules/default/skills/reviewing-roles/SKILL.md'), null);
		const md = readFile(ws.root, 'modules/default/skills/reviewing-postings/SKILL.md');
		assert.match(md, /name: reviewing-postings/, 'the id is the folder AND the frontmatter name — one identity');
		assert.equal(ws.dt('compile').code, 0);
	});

	test('rm removes the whole folder', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'skills', '--name', 'reviewing-roles', '--description', 'x').code, 0);
		assert.equal(ws.dt('rm', 'skills/reviewing-roles').code, 0);
		assert.equal(fs.existsSync(path.join(ws.root, 'modules/default/skills/reviewing-roles')), false);
	});

	test('an AGENT declaring the skill blocks its removal, by name', () => {
		const ws = twoModuleWorkspace();
		assert.equal(ws.dt('add', 'skills', '--name', 'reviewing-roles', '--description', 'x').code, 0);
		fs.mkdirSync(path.join(ws.root, 'modules/default/agents'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/default/agents/recruiter.agent.md'),
			'---\nname: recruiter\ndescription: Fills roles.\nskills: [skills/reviewing-roles]\n---\n\nDo it.\n');
		assert.equal(ws.dt('compile').code, 0);
		const res = ws.dt('rm', 'skills/reviewing-roles');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /references unknown skill/, 'compile is the gate, and its sentence names the agent file');
		assert.ok(readFile(ws.root, 'modules/default/skills/reviewing-roles/SKILL.md'));
	});
});

describe('the hand-authored kinds — add is refused WITH THE PATH', () => {
	for (const kind of ['agents', 'commands', 'command-bindings', 'collection-templates']) {
		test(`add ${kind} names the file to write`, () => {
			const ws = twoModuleWorkspace();
			const res = ws.dt('add', kind, '--name', 'thing');
			assert.equal(res.code, 1);
			// `an agent`, `a command` — the article follows the noun rather than being hardcoded
			assert.match(res.stderr, new RegExp(`an? ${kind.replace(/s$/, '')} is hand-authored`));
			assert.match(res.stderr, /modules\/default\//);
			assert.match(res.stderr, /dreamteamer compile/);
		});
	}

	test('set edits an agent\'s frontmatter', () => {
		const ws = twoModuleWorkspace();
		fs.mkdirSync(path.join(ws.root, 'modules/default/agents'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/default/agents/recruiter.agent.md'),
			'---\nname: recruiter\ndescription: Fills roles.\n---\n\nDo it.\n');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('set', 'agents/recruiter', 'description=Fills open roles end to end.').code, 0);
		const md = readFile(ws.root, 'modules/default/agents/recruiter.agent.md');
		assert.match(md, /description: Fills open roles end to end\./);
		assert.match(md, /Do it\./);
	});

	test('rm and rename work on a command', () => {
		const ws = twoModuleWorkspace();
		fs.mkdirSync(path.join(ws.root, 'modules/default/commands'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'modules/default/commands/enrich.command.md'),
			'---\nname: enrich\ndescription: Fill a person in.\n---\n\nDo the thing.\n');
		assert.equal(ws.dt('compile').code, 0);
		assert.equal(ws.dt('rename', 'commands/enrich', 'complete').code, 0);
		assert.ok(readFile(ws.root, 'modules/default/commands/complete.command.md'));
		assert.equal(ws.dt('rm', 'commands/complete').code, 0);
		assert.equal(readFile(ws.root, 'modules/default/commands/complete.command.md'), null);
	});

	test('an npm-shipped entity is refused with `disable` as the remedy', () => {
		const ws = twoModuleWorkspace();
		// `using-dreamteamer` ships from node_modules/dreamteamer
		const res = ws.dt('rm', 'skills/using-dreamteamer');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /node_modules/);
		assert.match(res.stderr, /dreamteamer\.disable/);
	});
});

describe('revert is refused on every system kind, with the git spelling', () => {
	for (const ref of ['collections/people', 'modules/core', 'skills/using-dreamteamer']) {
		test(`revert ${ref}`, () => {
			const ws = twoModuleWorkspace();
			const res = ws.dt('revert', ref, '--hash', 'HEAD');
			assert.equal(res.code, 1);
			assert.match(res.stderr, /its source is in git/);
			assert.match(res.stderr, /git checkout <sha> --/);
			assert.match(res.stderr, /dreamteamer compile/);
		});
	}
});

describe('the two policies, spelled the same', () => {
	test('a SYSTEM write self-commits; a RECORD write does not', () => {
		const ws = twoModuleWorkspace();
		const before = ws.git(['rev-parse', 'HEAD']);
		assert.equal(ws.dt('add', 'collections', '--name', 'grades').code, 0);
		assert.notEqual(ws.git(['rev-parse', 'HEAD']), before, 'the schema write committed itself');

		const after = ws.git(['rev-parse', 'HEAD']);
		assert.equal(ws.dt('add', 'grades', '--name', 'Band 4').code, 0);
		assert.equal(ws.git(['rev-parse', 'HEAD']), after, 'the record write did not — dt commit publishes it');
		// -uall, because porcelain collapses a wholly-untracked tree to `?? data/`
		assert.match(ws.git(['status', '--porcelain', '-uall']), /data\/grades\/band-4/);
	});

	test('help states the difference once', () => {
		const ws = twoModuleWorkspace();
		const out = ws.dt('help').stdout;
		assert.match(out, /a SYSTEM write commits itself/);
		assert.match(out, /a RECORD write does not/);
	});
});
