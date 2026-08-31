// Tier 2 — the PUBLISHED ARTIFACT, not the engine's behaviour. This package goes to npm and the
// repo is public, so a worked example that names a real person is a leak with a version number on
// it: `npm publish` cannot be taken back, and the name reaches every consumer's node_modules.
//
// It happened: the 0.13.2 → 0.13.3 note in UPDATING.md taught a namespaced-reference bug with a
// real person's name and a real record id out of the private vault it was found on. This is the
// guard, and it is derived rather than hardcoded — the pattern comes from `package.json`'s own
// `author`, so nothing here has to restate the name it is looking for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_ROOT } from '../helpers/ws.js';

// Where attribution BELONGS. Everything else is prose, code or a fixture, and a person's name in
// one of those is an example that should have been synthetic.
const ATTRIBUTION = new Set(['LICENSE', 'NOTICE', 'README.md', 'package.json', 'package-lock.json']);
const SCANNED_DIRS = ['src', 'bin', 'skills', 'collections', 'collection-templates', 'agents', 'scripts', 'docs', 'test'];
const SCANNED_FILES = ['UPDATING.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md'];

function* files() {
	for (const f of SCANNED_FILES) {
		const p = path.join(ENGINE_ROOT, f);
		if (fs.existsSync(p)) yield p;
	}
	const walk = (dir) => {
		if (!fs.existsSync(dir)) return;
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.name.startsWith('.') || e.name === 'node_modules') continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(js|mjs|md|yaml|json)$/.test(e.name)) out.push(p);
		}
	};
	const out = [];
	for (const d of SCANNED_DIRS) walk(path.join(ENGINE_ROOT, d));
	yield* out;
}

describe('the published repo carries no personal data', () => {
	test("the author's own name appears only where attribution belongs", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));
		// `Name Surname <email>` → the name words plus the local part of the address. Each is matched
		// on a word boundary and case-insensitively, so a run-together form in a path and a bare given
		// name in prose both count. Words of three characters or fewer are dropped: a short particle
		// ("de", "van") would match ordinary English and make this test noise.
		//
		// ⚠ NOTHING BELOW SPELLS THE NAME, and that is not tidiness — this file is scanned by every
		// other guard the project might grow, and an example written out here would be the leak. It is
		// excluded from its own scan for the same reason the pattern is derived rather than written.
		const author = pkg.author ?? '';
		const words = [
			...author.replace(/<[^>]*>/g, '').split(/\s+/),
			author.match(/<([^@>]+)@/)?.[1] ?? '',
		].map((w) => w.replace(/[^A-Za-z0-9]/g, '')).filter((w) => w.length > 3);
		assert.ok(words.length, `package.json author "${author}" yielded no name to search for — this test would pass vacuously`);
		const pattern = new RegExp(`\\b(${words.join('|')})\\b`, 'i');

		const hits = [];
		for (const file of files()) {
			const rel = path.relative(ENGINE_ROOT, file).split(path.sep).join('/');
			if (ATTRIBUTION.has(rel)) continue;
			const text = fs.readFileSync(file, 'utf8');
			// THIS FILE is the one legitimate exception, and only because it derives the pattern rather
			// than spelling it: excluding it by name is cheaper than a self-referential match.
			if (rel === 'test/integration/repo-hygiene.test.js') continue;
			text.split('\n').forEach((line, i) => {
				if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
			});
		}
		assert.deepEqual(hits, [], `personal data in a public, published repo — replace it with synthetic content:\n${hits.join('\n')}`);
	});
});
