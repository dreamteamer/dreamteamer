// The skill is what a session reads before it writes a descriptor, so a key, flag or verb the
// descriptor format v2 removed, left in any of its files, teaches a spelling compile refuses. Each
// pattern is one such word; the list is help-v2.test.js's plus the spellings only prose carried.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.md') && files.push(path.join(d, e.name)); };
walk(root);

const V1 = [
	/\bx-[a-z]+/, /\blist_fields\b/, /\bsort_field\b/, /\btitle_template\b/, /collection-templates?\b/, /\bcodec\b/,
	/\bextends\b/, /\btemplates:/, /\bpeerDependencies\b/, /\bworkspace-module\b/, /\bgit-modules\b/, /\bowns-data\b/,
	/\bdata-path\b/, /\bauto-commit\b/, /\blocal-assets\b/, /\bcan-enter\b/, /\bcan-exit\b/, /group: system/,
	/\btarget: (list|item|page|record|collection)\b/, /--options\b/, /--inverse\b/, /--target\b/, /--template\b/,
	/--id-shape\b/, /\bdt move\b/, /\bschema\.properties\b/, /\bid\.(generate|pattern)\b/, /\bformat: (markdown|date)\b/,
	/\bdate-time\b/, /\blast-modified\b/, /\bdreamteamer\.md\b/,
];

test('the skill files are found', () => assert.ok(files.length > 5, `only ${files.length} skill files under ${root}`));

test('no skill file names a key, flag or verb descriptor format v2 removed', () => {
	for (const f of files) {
		const text = fs.readFileSync(f, 'utf8');
		for (const re of V1) assert.doesNotMatch(text, re, `${path.relative(root, f)} still teaches ${re}`);
	}
});
