import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SKILL.md's "two acts, one map" table is the ONLY route to a reference file — nothing else links
// them, so a row naming a file that does not exist sends a session to a dead end, and a reference
// nobody names is unreachable prose that still costs its lines against the prose budget. This test
// is that map held to the directory, both directions.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillDir = path.join(root, 'skills/using-dreamteamer');
const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');

const named = new Set([...skill.matchAll(/`references\/([a-z0-9-]+\.md)`/g)].map((m) => m[1]));
const onDisk = new Set(fs.readdirSync(path.join(skillDir, 'references')).filter((f) => f.endsWith('.md')));

// ⚠ Both loops below pass VACUOUSLY on an empty set — the exact way skill-verb-map.test.js once
// half-died when a regex stopped matching. Assert both sides are populated before comparing them.
test('the map and the references directory are both non-empty', () => {
	assert.ok(named.size > 5, `SKILL.md names only ${named.size} references — the map regex has drifted`);
	assert.ok(onDisk.size > 5, `only ${onDisk.size} reference files found — wrong directory?`);
});

test('every reference SKILL.md names exists on disk', () => {
	for (const f of named) {
		assert.ok(onDisk.has(f), `SKILL.md names references/${f} — no such file`);
	}
});

test('every reference file is named in SKILL.md', () => {
	for (const f of onDisk) {
		assert.ok(named.has(f), `references/${f} exists but SKILL.md's map never points at it`);
	}
});
