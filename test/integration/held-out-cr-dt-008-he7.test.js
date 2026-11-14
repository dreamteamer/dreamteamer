// rnd/tests/dreamteamer/heldout-dt008-e-check-on-a-nav-yaml-that-is-not-a-mapping — held-out, written by the
// test stage (with the record's round-2 amendment: (c) an empty file is an empty document and needs no
// warning; dt check exits 0 in every case; (h) a directory still prints one "⚠ nav.yaml — " line).
// dt check names a malformed nav.yaml in one line and never throws; compile never reads it; dt list
// works; dt install over it never rewrites it and never leaves package.json changed after a refusal.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { offline, registry, run, out, readFile, git, noStack, snapshot } from './held-out-cr-dt-008-lib.js';

const CASES = {
	a: { text: '- fixas\n- fixcs\n', says: /not a mapping/ },
	b: { text: 'just text', says: /not a mapping/ },
	c: { text: '', says: null },
	d: { text: 'tree: [fixas\n  hidden: {', says: /not valid YAML|could not be read|unreadable/i, line: true },
	e: { text: 'tree: fixas', says: /tree must be a list/ },
	f: { text: 'tree:\n  - 42\n  - { folder: 7, items: fixas }\n  - { collection: fixas, items: [fixcs] }\nhidden: fixas', says: /must be a list|not a collection, a folder or a namespace|neither/ },
	g: { text: 'tree: [fixas, ghost, fixas, { namespace: nope }]\nhidden: [fixcs, fixcs]', says: null },
	h: { dir: true, says: /nav\.yaml/ },
};
const VALID = 'tree:\n  - fixas\n  - fixcs\n';

let REG, BASE;
before(() => {
	REG = registry();
	const ws = offline();
	for (const spec of ['@fix/a@1.0.0', '@fix/c@1.0.0']) {
		const r = run(ws.root, ['install', spec, '--from', REG]);
		if (r.code !== 0) throw new Error(out(r));
	}
	fs.writeFileSync(path.join(ws.root, 'nav.yaml'), VALID);
	git(ws.root, ['add', 'nav.yaml']);
	git(ws.root, ['commit', '-qm', 'valid nav']);
	BASE = ws.root;
});
/** A copy of the prepared workspace per case — "restoring the file between cases", and the install too. */
const copyOf = (label) => {
	const root = path.join(path.dirname(BASE), `${path.basename(BASE)}-${label}`);
	fs.cpSync(BASE, root, { recursive: true, dereference: false, verbatimSymlinks: true });
	return root;
};
const navLines = (text) => text.split('\n').filter((l) => l.startsWith('⚠ nav.yaml — '));
const violations = (text) => text.split('\n').filter((l) => /violation/.test(l)).join('\n');
const scrub = (text, root) => text.split(root).join('<root>');

describe('held-out he7 — a nav.yaml that is not the documented mapping', () => {
	let valid;
	before(() => {
		const root = copyOf('valid');
		valid = { check: run(root, ['check']), compile: run(root, ['compile']), root };
	});

	test('the valid case: check prints no nav line', () => {
		assert.equal(valid.check.code, 0, out(valid.check));
		assert.deepEqual(navLines(valid.check.stdout + valid.check.stderr), []);
		assert.equal(valid.compile.code, 0, out(valid.compile));
	});

	for (const [label, c] of Object.entries(CASES)) {
		test(`(${label}) ${c.dir ? 'nav.yaml is a directory' : JSON.stringify(c.text)}`, () => {
			const root = copyOf(label);
			const file = path.join(root, 'nav.yaml');
			fs.rmSync(file);
			if (c.dir) { fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'x'), 'x'); } else fs.writeFileSync(file, c.text);

			// dt check
			const ch = run(root, ['check']);
			const chAll = ch.stdout + ch.stderr;
			assert.equal(ch.code, 0, `check exits 0 in every case: ${out(ch)}`);
			assert.ok(noStack(chAll), `no stack trace, no TypeError: ${out(ch)}`);
			assert.equal(violations(chAll), violations(valid.check.stdout + valid.check.stderr), 'the record violations count is unaffected');
			const lines = navLines(chAll);
			if (c.says) {
				assert.ok(lines.length >= 1, `at least one "⚠ nav.yaml — " line: ${out(ch)}`);
				assert.ok(lines.some((l) => c.says.test(l)), `says what is wrong: ${lines.join(' | ')}`);
				if (c.line) assert.ok(lines.some((l) => /line \d+|\(\d+:\d+\)|\d+:\d+/.test(l)), `the yaml error and its line: ${lines.join(' | ')}`);
			}
			if (label === 'g') {
				const about = (name) => lines.filter((l) => l.includes(`"${name}"`));
				assert.equal(about('ghost').length, 1, lines.join('\n'));
				assert.match(about('ghost')[0], /unknown collection/);
				assert.equal(about('nope').length, 1, lines.join('\n'));
				assert.match(about('nope')[0], /unknown namespace/);
				assert.equal(about('fixas').length, 1, lines.join('\n'));
				assert.match(about('fixas')[0], /twice/);
				assert.equal(about('fixcs').length, 1, lines.join('\n'));
				assert.match(about('fixcs')[0], /twice/);
				assert.equal(lines.length, 4, `exactly those four: ${lines.join('\n')}`);
			}

			// dt compile never reads nav.yaml
			const co = run(root, ['compile']);
			assert.equal(co.code, 0, out(co));
			assert.equal(scrub(co.stdout, root), scrub(valid.compile.stdout, valid.root), 'identical output to the valid case');
			assert.equal(scrub(co.stderr, root), scrub(valid.compile.stderr, valid.root));

			// dt list fixas
			const li = run(root, ['list', 'fixas']);
			assert.equal(li.code, 0, out(li));
			assert.ok(noStack(li.stdout + li.stderr), out(li));

			// dt install @fix/d over it — (a)-(f)
			if (!'abcdef'.includes(label)) return;
			const navBefore = readFile(root, 'nav.yaml');
			const snap = snapshot(root);
			const r = run(root, ['install', '@fix/d@1.0.0', '--from', REG]);
			const all = r.stdout + r.stderr;
			assert.ok(noStack(all), `no uncaught exception: ${out(r)}`);
			assert.equal(readFile(root, 'nav.yaml'), navBefore, 'the operator\'s file is never rewritten');
			if (r.code === 0) {
				// merged nothing: @fix/d ships no fragment
				assert.equal(readFile(root, 'nav.yaml'), navBefore);
			} else {
				assert.equal(r.code, 1, out(r));
				const after = snapshot(root);
				assert.equal(after.pkg, snap.pkg, 'package.json unchanged after a non-zero exit');
				assert.equal(after.lock, snap.lock, 'package-lock.json unchanged after a non-zero exit');
				assert.ok(r.stderr.includes('nav.yaml'), `the refusal names nav.yaml: ${out(r)}`);
				assert.doesNotMatch(r.stdout, /▶ npm/, `refuses before npm writes: ${out(r)}`);
			}
		});
	}
});
