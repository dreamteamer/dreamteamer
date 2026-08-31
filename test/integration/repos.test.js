// Tier 2 — where an attached repo's working tree actually lands.
//
// The whole point of `repos` is a repo the workspace KNOWS about, and the interesting ones live
// outside it — a sibling checkout, a shared projects root, somewhere named by an `.env` key because
// it differs per machine. `path` is how a record says so, and it holds the same `${env:NAME}`
// template every other path-shaped field in a workspace holds. Records carry the template verbatim
// (see resolve.test.js); this is the read side rendering it at the point of need.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace } from '../helpers/ws.js';
import { repoPath, listRepos } from '../../src/init.js';

/** A workspace declaring `vars` and carrying a .env that sets them. */
function withVars(vars, env = {}) {
	const ws = workspace({ pkg: { vars } });
	fs.writeFileSync(path.join(ws.root, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
	return ws;
}

describe('repoPath renders the template a record holds', () => {
	test('an ${env:…} path resolves to the value, outside the workspace', () => {
		const ws = withVars(['REPOS_FOLDER'], { REPOS_FOLDER: '/opt/checkouts' });
		const dest = repoPath(ws.ws, { name: 'acme', path: '${env:REPOS_FOLDER}/acme' });
		assert.equal(dest, '/opt/checkouts/acme');
		assert.ok(!dest.startsWith(ws.root), 'an absolute rendered path must escape the workspace');
	});

	test('a plain relative path still anchors to the workspace root', () => {
		const ws = withVars([]);
		assert.equal(repoPath(ws.ws, { name: 'acme', path: 'vendor/acme' }), path.join(ws.root, 'vendor/acme'));
	});

	test('the repos-path base takes a template too', () => {
		const ws = withVars(['REPOS_FOLDER'], { REPOS_FOLDER: '/opt/checkouts' });
		ws.ws.pkg.dreamteamer['repos-path'] = '${env:REPOS_FOLDER}';
		assert.equal(repoPath(ws.ws, { name: 'acme', identity: 'me' }), '/opt/checkouts/me/acme');
	});

	test('the derived default is unchanged when nothing declares a template', () => {
		const ws = withVars([]);
		assert.equal(repoPath(ws.ws, { name: 'acme', identity: 'me' }), path.join(ws.root, 'projects/me/acme'));
	});
});

describe('it fails loudly rather than inventing a directory', () => {
	test('an undeclared var names dreamteamer.vars', () => {
		const ws = withVars([], { REPOS_FOLDER: '/opt/checkouts' });
		assert.throws(() => repoPath(ws.ws, { name: 'acme', path: '${env:REPOS_FOLDER}/acme' }),
			/not declared in dreamteamer\.vars/);
	});

	test('a declared var with no value on this machine', () => {
		const ws = withVars(['REPOS_FOLDER'], { REPOS_FOLDER: '' });
		assert.throws(() => repoPath(ws.ws, { name: 'acme', path: '${env:REPOS_FOLDER}/acme' }),
			/declared but has no value in \.env/);
	});

	test('listRepos REPORTS the one it cannot resolve instead of taking the whole listing down', () => {
		const ws = withVars(['REPOS_FOLDER'], { REPOS_FOLDER: '/opt/checkouts' });
		ws.store.add('repos', { name: 'here', url: 'https://example.invalid/here.git' });
		ws.store.add('repos', { name: 'there', url: 'https://example.invalid/there.git', path: '${env:NOPE}/there' });
		const rows = listRepos(ws.ws);
		assert.equal(rows.length, 2);
		assert.equal(rows.find((r) => r.id === 'here').unresolved, undefined);
		assert.match(rows.find((r) => r.id === 'there').unresolved, /not declared in dreamteamer\.vars/);
	});
});
