#!/usr/bin/env node
// build — src/*.ts → dist/*.js for the npm package (run by `prepack`, so `npm pack` and `npm publish`
// can never ship a stale or missing build). A checkout never needs this: bin/dreamteamer.js runs the
// source directly. The declarations are the hand-written contract (src/api.d.ts, src/records-api.d.ts),
// copied beside the build rather than generated, because the contract is what consumers pin.
import { rmSync, readdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const src = fileURLToPath(new URL('../src/', import.meta.url));

rmSync(dist, { recursive: true, force: true });
execFileSync(fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url)), ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
for (const f of readdirSync(src).filter((n) => n.endsWith('.d.ts'))) copyFileSync(src + f, dist + f);
