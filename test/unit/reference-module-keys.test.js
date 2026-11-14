// The module-keys table in the collections reference is what a session reads to write a module's
// `dreamteamer` block, so its key column names keys and nothing else: each cell is one or more
// backticked keys this engine reads. A sentence in that column (a field that is NOT a key of the
// block, say) belongs under the table, where it cannot be mistaken for a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST_KEYS } from '../../src/extensions.js';

const text = fs.readFileSync(fileURLToPath(new URL('../../skills/using-dreamteamer/references/collections.md', import.meta.url)), 'utf8');

test('every key cell of the module-keys table names keys of the dreamteamer block, in backticks', () => {
	const lines = text.split('\n');
	const head = lines.findIndex((l) => l.startsWith('| module key |'));
	assert.ok(head >= 0, 'the module-keys table is gone');
	const rows = [];
	for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
	assert.ok(rows.length > 5, `only ${rows.length} rows`);
	for (const row of rows) {
		const cell = row.split('|')[1].trim();
		const keys = cell.split(' · ').map((k) => k.trim());
		for (const k of keys) {
			assert.match(k, /^`[a-z_]+`$/, `key cell "${cell}" holds something other than backticked keys`);
			assert.ok(MANIFEST_KEYS.includes(k.slice(1, -1)), `${k} is not a key this engine reads`);
		}
	}
});

test('the module-keys table has a row for each key a module package carries (cr-dt-008: preset, nav; provides legal and ignored)', () => {
	const lines = text.split('\n');
	const head = lines.findIndex((l) => l.startsWith('| module key |'));
	const keys = new Set();
	for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) for (const k of lines[i].split('|')[1].split(' · ')) keys.add(k.trim().slice(1, -1));
	for (const k of ['preset', 'nav', 'provides']) assert.ok(keys.has(k), `no row for \`${k}\``);
	assert.match(text, /\| `provides` \|[^\n]*ignored/);
});
