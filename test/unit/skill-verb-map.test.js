import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The SKILL.md "verb names, as a map" block promises it cannot drift from the dispatch.
// This test IS that promise: both directions, verb names only (flags stay help's job).
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = fs.readFileSync(path.join(root, 'src/cli.js'), 'utf8');
const skill = fs.readFileSync(path.join(root, 'skills/using-dreamteamer/SKILL.md'), 'utf8');

const dispatch = new Set([...cli.matchAll(/case '([a-z-]+)'/g)].map((m) => m[1]));
// `init` runs before workspace resolution, so it is an if, not a case — assert it exists.
assert.match(cli, /cmd === 'init'/);
dispatch.add('init');
// ⚠ THERE IS NO SEPARATE SCHEMA-OP TABLE ANY MORE. `SCHEMA_OPS`/`SCHEMA_FIELD_OPS` went with the
// `schema` grammar in 0.19.0 — system entities take the record verbs, and every field verb is a
// `case` — so `dispatch` alone is the authority. Left in place, both regexes would have matched
// nothing and this file would have PASSED VACUOUSLY in one direction while failing in the other.

const block = skill.match(/the verb names, as a map[\s\S]*?\n\n## /);
assert.ok(block, 'SKILL.md carries the verb map block');
const mapped = new Set([...block[0].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));

test('every verb SKILL.md names exists in the dispatch', () => {
	for (const v of mapped) {
		assert.ok(dispatch.has(v), `SKILL.md names "${v}" — not in cli.js dispatch`);
	}
});
test('every dispatch verb is named in SKILL.md', () => {
	for (const v of dispatch) assert.ok(mapped.has(v), `dispatch verb "${v}" missing from SKILL.md map`);
});
