// `dt check`'s nav pass (cr-dt-008, design §3 rule 5): nav.yaml is read against the compiled collections and
// namespaces, and what resolves to nothing or is named twice is a ⚠ line — never a violation, so a hand-edited
// nav never turns a workspace red. And the one writer, on disk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection } from '../helpers/ws.js';
import { readNavDoc, writeNavDoc, NavDocError } from '../../src/nav.js';

const fixture = () => workspace({ collections: { alphas: simpleCollection(), betas: simpleCollection() } });

describe('dt check — the nav pass', () => {
	test('an unknown collection and a name listed twice are warnings; the exit code is unchanged', () => {
		const ws = fixture();
		fs.writeFileSync(path.join(ws.root, 'nav.yaml'), 'tree:\n  - alphas\n  - ghost\n  - folder: Work\n    items: [alphas, betas]\n');
		const r = ws.dt('check');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /⚠ nav\.yaml — unknown collection "ghost"/);
		assert.match(r.stdout, /⚠ nav\.yaml — "alphas" is listed twice/);
	});
	test('without nav.yaml no nav line is printed', () => {
		const ws = fixture();
		const r = ws.dt('check');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stdout, /nav\.yaml/);
	});
	test('a nav.yaml that is not a mapping is a warning naming why', () => {
		const ws = fixture();
		fs.writeFileSync(path.join(ws.root, 'nav.yaml'), '- alphas\n');
		const r = ws.dt('check');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /⚠ nav\.yaml — nav\.yaml is not a mapping/);
	});
	test('writeNavDoc then readNavDoc round-trips on disk and leaves no temp file', () => {
		const ws = fixture();
		const doc = { tree: [{ folder: 'Work', icon: 'rocket', items: ['alphas', { collection: 'betas', icon: 'star' }] }], hidden: ['ghost'] };
		writeNavDoc(ws.root, doc);
		assert.deepEqual(readNavDoc(ws.root), doc);
		assert.deepEqual(fs.readdirSync(ws.root).filter((f) => f.startsWith('nav.yaml')), ['nav.yaml']);
	});
	test('readNavDoc is null without the file, and a NavDocError for one it cannot read', () => {
		const ws = fixture();
		assert.equal(readNavDoc(ws.root), null);
		fs.mkdirSync(path.join(ws.root, 'nav.yaml'));
		assert.throws(() => readNavDoc(ws.root), NavDocError);
	});
});
