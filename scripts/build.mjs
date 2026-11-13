#!/usr/bin/env node
// build — src/*.ts → dist/*.js for the npm package (run by `prepack`, so `npm pack` and `npm publish`
// can never ship a stale or missing build). A checkout never needs this: bin/dreamteamer.js runs the
// source directly. The declarations (dist/*.d.ts) are generated from the source's annotations and
// src/types.ts; test/types/consumer.ts (`node scripts/contract.mjs`) is the contract they are held to.
import { rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

rmSync(dist, { recursive: true, force: true });
execFileSync(fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url)), ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

// tsc rewrites `./x.ts` to `./x.js` in the JavaScript it emits but NOT in the declarations, and a
// consumer compiling with an older TypeScript cannot resolve a `.ts` specifier inside a .d.ts. Same
// rewrite, same rule: a relative specifier only.
for (const f of readdirSync(dist).filter((n) => n.endsWith('.d.ts'))) {
	const text = readFileSync(dist + f, 'utf8');
	const out = text.replace(/((?:from\s+|import\(\s*)['"]\.\.?\/[\w./-]+)\.ts(['"])/g, '$1.js$2');
	if (out !== text) writeFileSync(dist + f, out);
}
