// `dt fmt` — the opt-in canonical formatter for descriptor and mixin SOURCES (design rule 4, §10:
// "canonical top-level order, block style, comments preserved, `fields` order untouched, idempotent").
//
// Every assertion runs the real CLI on a hand-commented fixture, because what a formatter can get
// wrong is exactly what a schema-level check cannot see: the order of keys, the style of a node, and
// the comments around both.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, readFile, WS_MODULE } from '../helpers/ws.js';
import { load, commentCount } from '../../src/yaml.js';

const SRC = `modules/${WS_MODULE}/collections/widgets.collection.yaml`;
const MIXIN = `modules/${WS_MODULE}/mixins/stamped.mixin.yaml`;
// Top-level keys out of canonical order, flow mappings at three depths, a flow sequence of scalars,
// a hand-folded description, fields in a deliberately non-alphabetical order with their own keys
// out of FIELD order, and a comment in every position a comment can sit.
const WIDGETS = `# Widgets are the parts a kit is assembled from.

# the fields come first in this file on purpose
fields:
  # zeta first: it is the form's first input
  zeta: { required: true, type: string }
  alpha:
    enum: [small, large]   # two sizes only
    type: string
  notes: { type: markdown, body: true }
# what the list shows
display:
  list: { columns: [zeta, alpha] }
description: >
  The parts a kit is
  assembled from.
name: widgets   # the collection
ids: { from: '{{ zeta | slug }}' }
`;
const STAMPED = `name: stamped
fields:
  # who stamped it
  stamp: { type: string }
description: A stamp.
`;

function fixture() {
	const w = workspace();
	const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(w.root, rel)), { recursive: true }); fs.writeFileSync(path.join(w.root, rel), text); };
	put(SRC, WIDGETS);
	put(MIXIN, STAMPED);
	w.git(['add', '-A']);
	w.git(['commit', '-qm', 'fixture: widgets']);
	return { ...w, put };
}
const comments = (text) => text.split('\n').filter((l) => l.trimStart().startsWith('#') || / #/.test(l)).map((l) => l.slice(l.indexOf('#')).trim()).sort();

describe('dt fmt', () => {
	test('block style, canonical top-level order, fields and their keys untouched, every comment kept, committed', () => {
		const w = fixture();
		const res = w.dt('fmt');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		const out = readFile(w.root, SRC);
		assert.match(res.stdout, new RegExp(`✔ ${SRC.replace(/\//g, '\\/').replace(/\./g, '\\.')}`));
		assert.match(res.stdout, /2 source\(s\) formatted/);
		// block style: no flow MAPPING survives anywhere; a flow sequence of scalars is kept
		assert.doesNotMatch(out, /:\s*\{/, out);
		assert.match(out, /enum: \[small, large\]/);
		assert.match(out, /columns: \[zeta, alpha\]/);
		// canonical top-level order
		assert.deepEqual(Object.keys(load(out)), ['name', 'description', 'ids', 'fields', 'display']);
		// fields keep their form order, and a field keeps its own key order
		assert.deepEqual(Object.keys(load(out).fields), ['zeta', 'alpha', 'notes']);
		assert.deepEqual(Object.keys(load(out).fields.zeta), ['required', 'type']);
		assert.deepEqual(Object.keys(load(out).fields.alpha), ['enum', 'type']);
		// same value, every comment, the header still on top, the hand-folded scalar verbatim
		assert.deepEqual(load(out), load(WIDGETS));
		assert.deepEqual(comments(out), comments(WIDGETS));
		assert.equal(commentCount(out), commentCount(WIDGETS));
		assert.ok(out.startsWith('# Widgets are the parts a kit is assembled from.\n'), out);
		assert.match(out, /description: >\n {2}The parts a kit is\n {2}assembled from\.\n/);
		assert.match(out, /# zeta first: it is the form's first input\n {2}zeta:/);
		// the mixin is formatted too
		assert.doesNotMatch(readFile(w.root, MIXIN), /:\s*\{/);
		assert.deepEqual(Object.keys(load(readFile(w.root, MIXIN))), ['name', 'description', 'fields']);
		// a source write commits itself, pathspec-scoped
		assert.match(w.git(['log', '-1', '--format=%s']), /^dreamteamer: fmt 2 descriptor source\(s\)$/);
		assert.equal(w.git(['status', '--porcelain', '--', SRC, MIXIN]), '');
	});

	test('idempotent: a second run changes nothing and commits nothing', () => {
		const w = fixture();
		assert.equal(w.dt('fmt').code, 0);
		const once = readFile(w.root, SRC);
		const head = w.git(['rev-parse', 'HEAD']);
		const res = w.dt('fmt');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /0 source\(s\) formatted, \d+ already canonical/);
		assert.equal(readFile(w.root, SRC), once);
		assert.equal(w.git(['rev-parse', 'HEAD']), head);
	});

	test('--dry-run lists the files it would change and writes nothing', () => {
		const w = fixture();
		const head = w.git(['rev-parse', 'HEAD']);
		const res = w.dt('fmt', '--dry-run');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, new RegExp(`→ ${SRC.replace(/\./g, '\\.')}`));
		assert.match(res.stdout, /2 source\(s\) would change \(dry run/);
		assert.equal(readFile(w.root, SRC), WIDGETS);
		assert.equal(w.git(['rev-parse', 'HEAD']), head);
	});

	test('a named collection formats only its own sources', () => {
		const w = fixture();
		const res = w.dt('fmt', 'widgets');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.notEqual(readFile(w.root, SRC), WIDGETS);
		assert.equal(readFile(w.root, MIXIN), STAMPED);
		assert.match(res.stdout, /1 source\(s\) formatted/);
	});

	test('a v1 source is refused naming the converter, and nothing is written', () => {
		const w = fixture();
		const v1 = `modules/${WS_MODULE}/collections/legacy.collection.yaml`;
		w.put(v1, 'name: legacy\nschema:\n  properties:\n    name: { type: string }\n');
		const res = w.dt('fmt');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr, /legacy\.collection\.yaml/);
		assert.match(res.stderr, /migrate-descriptors-v2\.mjs/);
		assert.equal(readFile(w.root, SRC), WIDGETS);
	});

	test('a source under git_modules/ is skipped, said so, and left alone', () => {
		const w = fixture();
		const ext = 'git_modules/ext';
		w.put(`${ext}/package.json`, JSON.stringify({ name: 'ext', version: '0.0.1', dreamteamer: {} }));
		const gadgets = 'name: gadgets\nids: { from: \'{{ name | slug }}\' }\nfields:\n  name: { type: string }\n  notes: { type: markdown, body: true }\n';
		w.put(`${ext}/collections/gadgets.collection.yaml`, gadgets);
		const res = w.dt('fmt');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /skipped 1 source\(s\) under git_modules\/ and \d+ under node_modules\//);
		assert.equal(readFile(w.root, `${ext}/collections/gadgets.collection.yaml`), gadgets);
	});
});
