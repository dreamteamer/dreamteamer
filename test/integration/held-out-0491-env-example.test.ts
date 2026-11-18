// Held-out (0.49.1, rnd/tests/dreamteamer/held-out-0491-env-example): after `dt compile`, .env.example
// attributes each key to the packages that declare it NOW — a key two packages declared and one let go,
// a module's `dreamteamer.vars` request, an engine block whose value the operator filled in, a CRLF file
// and a file with no trailing newline — and a workspace that declares nothing is never rewritten. Through
// the real binary, synthetic inline modules only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeModule, patchModulePkg, readFile, dt } from '../helpers/ws.ts';

const HEADER = '# secrets for skills and modules go here (copy to .env; .env is never committed).\n# modules declare the env keys they require in their package.json dreamteamer.env list.\n';
const compile = (root) => { const r = dt(root, 'compile'); assert.equal(r.code, 0, r.stderr + r.stdout); return r; };
const example = (root) => readFile(root, '.env.example');
/** A workspace with inline modules `ids`, each given the `dreamteamer` keys in `decl[id]`. */
function withModules(decl, pkg = {}) {
	const w = workspace({ pkg });
	for (const [id, keys] of Object.entries(decl)) { writeModule(w.root, id); patchModulePkg(w.root, id, keys); }
	return w;
}
/** The comment line directly above `KEY=` (line endings stripped), or null. */
const commentAbove = (text, key) => {
	const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
	const i = lines.findIndex((l) => l.startsWith(`${key}=`));
	return i > 0 ? lines[i - 1] : null;
};

describe('held-out 0.49.1 — .env.example follows what the installed packages declare', () => {
	test('a key two packages declared, one of which lets go: re-attributed to the one left, never dropped', () => {
		const w = withModules({ alpha: { env: ['HX_SHARED'] }, beta: { env: ['HX_SHARED'] } });
		compile(w.root);
		assert.match(commentAbove(example(w.root), 'HX_SHARED'), /^# declared by (alpha, beta|beta, alpha)$/);
		patchModulePkg(w.root, 'beta', { env: [] });
		const r = compile(w.root);
		const text = example(w.root);
		assert.equal(commentAbove(text, 'HX_SHARED'), '# declared by alpha');
		assert.equal((text.match(/^HX_SHARED=/gm) ?? []).length, 1, 'kept, once');
		assert.match(r.stdout, /re-attributes HX_SHARED/);
		assert.doesNotMatch(r.stdout, /drops HX_SHARED/);
	});

	test('a dreamteamer.vars key a module requests is kept and re-attributed like an env key', () => {
		const w = withModules({ gamma: { vars: ['HX_FOLDER'] }, delta: {} }, { vars: ['HX_FOLDER'] });
		compile(w.root);
		assert.equal(commentAbove(example(w.root), 'HX_FOLDER'), '# declared by gamma');
		patchModulePkg(w.root, 'gamma', { vars: [] });
		patchModulePkg(w.root, 'delta', { vars: ['HX_FOLDER'] });
		const r = compile(w.root);
		const text = example(w.root);
		assert.equal(commentAbove(text, 'HX_FOLDER'), '# declared by delta');
		assert.equal((text.match(/^HX_FOLDER=/gm) ?? []).length, 1);
		assert.match(r.stdout, /re-attributes HX_FOLDER/);
	});

	test('an engine block whose value line the operator filled in moves: the comment follows, the value line is kept', () => {
		const w = withModules({ alpha: { env: ['HX_MOVED'] }, beta: {} });
		compile(w.root);
		const file = path.join(w.root, '.env.example');
		fs.writeFileSync(file, example(w.root).replace(/^HX_MOVED=$/m, 'HX_MOVED=https://example.invalid/hook'));
		patchModulePkg(w.root, 'alpha', { env: [] });
		patchModulePkg(w.root, 'beta', { env: ['HX_MOVED'] });
		compile(w.root);
		const text = example(w.root);
		assert.match(text, /^# declared by beta\nHX_MOVED=https:\/\/example\.invalid\/hook$/m);
		assert.equal((text.match(/HX_MOVED=/g) ?? []).length, 1);
	});

	test('CRLF line endings: every operator line kept byte for byte, the engine block still re-attributed', () => {
		const w = withModules({ alpha: {}, beta: { env: ['HX_MOVED'] } });
		const ops = '# my own note\r\nMY_KEY=1\r\n';
		const crlfHeader = HEADER.replace(/\n/g, '\r\n');
		fs.writeFileSync(path.join(w.root, '.env.example'), `${crlfHeader}\r\n${ops}\r\n# declared by alpha\r\nHX_MOVED=\r\n`);
		compile(w.root);
		const text = example(w.root);
		assert.ok(text.startsWith(crlfHeader), JSON.stringify(text));
		assert.ok(text.includes(ops), JSON.stringify(text));
		assert.equal(commentAbove(text, 'HX_MOVED'), '# declared by beta', JSON.stringify(text));
		assert.equal((text.match(/HX_MOVED=/g) ?? []).length, 1);
	});

	test('no trailing newline: the operator\'s last line is kept, the engine block re-attributed', () => {
		const w = withModules({ alpha: {}, beta: { env: ['HX_MOVED'] } });
		fs.writeFileSync(path.join(w.root, '.env.example'), `${HEADER}\n# declared by alpha\nHX_MOVED=\n\n# my own note\nMY_KEY=1`);
		compile(w.root);
		const text = example(w.root);
		assert.ok(text.startsWith(HEADER));
		assert.match(text, /\n# my own note\nMY_KEY=1(\n|$)/);
		assert.equal(commentAbove(text, 'HX_MOVED'), '# declared by beta');
	});

	test('a workspace that declares no keys: the file is not rewritten, whether it holds only the header or an operator block too', () => {
		for (const body of [HEADER, `${HEADER}\n# my own note\nMY_KEY=1\n`]) {
			const w = workspace();
			const file = path.join(w.root, '.env.example');
			fs.writeFileSync(file, body);
			const old = new Date('2001-02-03T04:05:06Z');
			fs.utimesSync(file, old, old);
			compile(w.root);
			assert.equal(readFile(w.root, '.env.example'), body);
			assert.equal(fs.statSync(file).mtimeMs, old.getTime(), 'not written at all');
		}
	});
});
