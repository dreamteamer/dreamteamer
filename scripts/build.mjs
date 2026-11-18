#!/usr/bin/env node
// npm run build — src/*.ts → dist/*.js with tsc, then the hand-written public declarations
// (src/*.d.ts) copied beside the files they describe.
//
// Type errors do NOT fail the build: the sources are not typed yet, and tsc emits regardless
// (noEmitOnError: false). The build fails only when tsc emitted nothing usable — a missing entry
// point is what "it does not run" means, whatever the error count says. `npm run typecheck` lists them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const ENTRIES = ['cli.js', 'api.js', 'records-api.js', 'testing.js', 'update-setup.js'];

fs.rmSync(DIST, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const r = spawnSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
const errors = (r.stdout.match(/error TS\d+/g) ?? []).length;

const missing = ENTRIES.filter((f) => !fs.existsSync(path.join(DIST, f)));
if (missing.length) {
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	console.error(`✖ build emitted no ${missing.join(', ')} under dist/`);
	process.exit(1);
}
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith('.d.ts'))) fs.copyFileSync(path.join(SRC, f), path.join(DIST, f));
const built = fs.readdirSync(DIST).filter((f) => f.endsWith('.js')).length;
console.log(`✔ built ${built} files into dist/${errors ? ` — ${errors} type error(s) ignored (npm run typecheck lists them)` : ''}`);
