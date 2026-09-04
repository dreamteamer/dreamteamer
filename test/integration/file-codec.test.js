// Tier 2 — `codec: file`: a record whose bytes ARE the file.
//
// The thing under test is a boundary, not a format. Every other codec answers "what fields does this
// text carry"; this one answers "which file is this record, and what may it be". So the assertions
// cluster on the edges where an opaque record differs from a parsed one: the extension is not
// derivable from the id, there is nothing to validate, `set` has no meaning, and a folder full of
// arbitrary files must still tell a stray from a record.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspace, writeCollection, compileQuietly, compileError } from '../helpers/ws.js';

/** `check` reports to stdout and answers with an exit code, so it is driven the way the operator
 *  drives it — through the CLI — and asserted on what it actually says. */
const checkOut = (ws) => { const r = ws.dt('check'); return r.stdout + r.stderr; };

const FILES = {
	description: 'Opaque files, one per record.',
	storage: { path: 'data/files', codec: 'file', shape: 'file', suffix: 'bin', max_bytes: 1024, extensions: ['svg', 'png'] },
	id: { pattern: '^[a-z0-9][a-z0-9/._-]*$' },
};

const base = (extra = {}) => workspace({ collections: { files: FILES, ...extra } });

/** Put a file into the collection directly — the fixture for READ-side tests, which must not
 *  depend on the write verb they are meant to be independent of. */
function place(ws, rel, contents) {
	const p = path.join(ws.root, 'data/files', rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, contents);
	return p;
}

/** A source file to import from, outside the workspace. */
function source(name, contents) {
	const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-src-')), name);
	fs.writeFileSync(p, contents);
	return p;
}

describe('read', () => {
	test('fields are derived from the file — there is no frontmatter to parse', () => {
		const ws = base();
		place(ws, 'icons/star.bin.svg', '<svg/>');
		const { fields, file } = ws.store.read('files', 'icons/star');
		assert.equal(fields.ext, 'svg');
		assert.equal(fields.bytes, 6);
		assert.ok(file.endsWith('icons/star.bin.svg'));
	});

	test('bytes are never decoded as text — a PNG survives a read', () => {
		const ws = base();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		place(ws, 'logos/acme.bin.png', png);
		assert.equal(ws.store.read('files', 'logos/acme').fields.bytes, 8);
		assert.deepEqual([...fs.readFileSync(path.join(ws.root, 'data/files/logos/acme.bin.png'))], [...png]);
	});

	test('the id index finds records at any depth, whatever the extension', () => {
		const ws = base();
		place(ws, 'icons/star.bin.svg', '<svg/>');
		place(ws, 'logos/acme.bin.png', 'x');
		place(ws, 'notes.txt', 'not a record');
		assert.deepEqual([...ws.store.ids('files').keys()].sort(), ['icons/star', 'logos/acme']);
	});
});

describe('check', () => {
	test('a file record is not a stray, but a non-record file still is', () => {
		const ws = base();
		place(ws, 'icons/star.bin.svg', '<svg/>');
		place(ws, 'README.md', '#');
		const out = checkOut(ws);
		assert.doesNotMatch(out, /star\.bin\.svg — unrecognized/);
		assert.match(out, /data\/files\/README\.md — unrecognized file/);
	});

	test('a file over max_bytes is a finding that names both numbers', () => {
		const ws = base();
		place(ws, 'icons/big.bin.svg', 'x'.repeat(2000));
		const out = checkOut(ws);
		assert.match(out, /2000 bytes/);
		assert.match(out, /1024/);
	});

	test('an extension outside the allow-list is a finding that names the allowed ones', () => {
		const ws = base();
		place(ws, 'icons/doc.bin.pdf', 'x');
		const out = checkOut(ws);
		assert.match(out, /\.pdf/);
		assert.match(out, /svg, png/);
	});

	// One id, one file: two extensions under the same id is ambiguous, and silently picking one is
	// how a replaced logo keeps rendering as its predecessor.
	test('the same id under two extensions is a duplicate-id finding', () => {
		const ws = base();
		place(ws, 'icons/star.bin.svg', '<svg/>');
		place(ws, 'icons/star.bin.png', 'x');
		assert.match(checkOut(ws), /icons\/star.*twice/s);
	});
});

describe('add --from', () => {
	test('copies the bytes and names the file by the SOURCE extension', () => {
		const ws = base();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const r = ws.dt('add', 'files', 'logos/acme', '--from', source('x.png', png));
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual([...fs.readFileSync(path.join(ws.root, 'data/files/logos/acme.bin.png'))], [...png]);
	});

	test('refuses an existing id unless --force, and --force removes the old extension', () => {
		const ws = base();
		ws.dt('add', 'files', 'logos/acme', '--from', source('x.png', 'x'));
		assert.match(ws.dt('add', 'files', 'logos/acme', '--from', source('y.png', 'y')).stderr, /already exists/);
		assert.equal(ws.dt('add', 'files', 'logos/acme', '--from', source('y.svg', '<svg/>'), '--force').code, 0);
		assert.ok(fs.existsSync(path.join(ws.root, 'data/files/logos/acme.bin.svg')));
		assert.ok(!fs.existsSync(path.join(ws.root, 'data/files/logos/acme.bin.png')), 'one id is one file');
	});

	test('refuses an oversize file, a disallowed extension and a bad id — writing nothing', () => {
		const ws = base();
		assert.match(ws.dt('add', 'files', 'a/big', '--from', source('b.svg', 'x'.repeat(2000))).stderr, /max_bytes/);
		assert.match(ws.dt('add', 'files', 'a/doc', '--from', source('c.pdf', 'x')).stderr, /\.pdf/);
		assert.match(ws.dt('add', 'files', 'A/BAD', '--from', source('d.svg', '<svg/>')).stderr, /pattern/);
		assert.deepEqual([...ws.store.ids('files').keys()], []);
	});

	test('add without --from on a file collection names the flag', () => {
		const ws = base();
		assert.match(ws.dt('add', 'files', 'a/x').stderr, /--from/);
	});

	test('--from on a NON-file collection is refused rather than silently ignored', () => {
		const ws = workspace({ collections: { files: FILES, notes: { id: { generate: '{{ name | slug }}' }, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } });
		assert.match(ws.dt('add', 'notes', '--name', 'x', '--from', source('e.svg', '<svg/>')).stderr, /--from/);
	});
});

describe('the other verbs', () => {
	test('set refuses, and says how to replace the file instead', () => {
		const ws = base();
		ws.dt('add', 'files', 'logos/acme', '--from', source('x.svg', '<svg/>'));
		const r = ws.dt('set', 'files/logos/acme', 'ext=png');
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /file record/);
		assert.match(r.stderr, /--from/);
	});

	// `dt commit` composes its subject from the git status letter, and `M` reads as `set` — the one
	// verb the store REFUSES on a file record, whose own error says to use `add --force` instead.
	// So a replacement was published under the name of the thing that cannot be done to it.
	test('a forced replacement commits as "replace", not as the "set" a file record refuses', () => {
		const ws = base();
		ws.dt('add', 'files', 'logos/acme', '--from', source('x.svg', '<svg/>'));
		assert.equal(ws.dt('commit', '-m', 'seed').code, 0);
		ws.dt('add', 'files', 'logos/acme', '--from', source('y.svg', '<svg viewBox="0 0 2 2"/>'), '--force');
		const out = ws.dt('commit', '--dry-run').stdout;
		assert.match(out, /files replace logos\/acme/);
		assert.doesNotMatch(out, /files set/);
	});

	test('rm removes the one file whatever its extension', () => {
		const ws = base();
		ws.dt('add', 'files', 'logos/acme', '--from', source('x.svg', '<svg/>'));
		assert.equal(ws.dt('rm', 'files/logos/acme').code, 0);
		assert.ok(!fs.existsSync(path.join(ws.root, 'data/files/logos/acme.bin.svg')));
	});

	test('a reference to a file record resolves like any other reference', () => {
		const ws = workspace({
			collections: {
				files: FILES,
				companies: {
					id: { generate: '{{ name | slug }}' },
					schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, logo: { type: 'string', 'x-reference': 'files' } } },
				},
			},
		});
		ws.dt('add', 'files', 'logos/acme', '--from', source('x.svg', '<svg/>'));
		ws.store.add('companies', { name: 'Acme', logo: 'files/logos/acme' });
		assert.match(checkOut(ws), /✔ 0 violations/);
		// …and rm protects it like any other referenced record, leaving a dangling reference only
		// when forced — the SAME generic rules, with nothing about files special-cased into them.
		assert.match(ws.dt('rm', 'files/logos/acme').stderr, /referenced by/);
		ws.dt('rm', 'files/logos/acme', '--force');
		assert.match(checkOut(ws), /dangling reference "files\/logos\/acme"/);
	});
});

describe('rename-collection', () => {
	// A re-suffix must keep each file's OWN extension: an opaque record's extension is part of what
	// it IS, and renaming `.svg` into the collection's "one" extension would corrupt every record.
	test('re-suffixes opaque records without touching their extensions', () => {
		// `suffix: pic` is `singular('pics')`, which is what makes the rename re-derive it as `image`.
		const ws = workspace({ collections: { pics: { description: 'x', storage: { codec: 'file', suffix: 'pic' }, id: { pattern: '^[a-z/-]+$' } } } });
		ws.dt('add', 'pics', 'a/star', '--from', source('x.svg', '<svg/>'));
		ws.dt('add', 'pics', 'a/acme', '--from', source('y.png', 'p'));
		const res = ws.dt('rename', 'collections/pics', 'images');
		assert.equal(res.code, 0, res.stderr);
		assert.ok(fs.existsSync(path.join(ws.root, 'data/images/a/star.image.svg')), 'svg kept its extension');
		assert.ok(fs.existsSync(path.join(ws.root, 'data/images/a/acme.image.png')), 'png kept its extension');
		assert.equal(ws.dt('check').code, 0);
	});
});

describe('compile', () => {
	test('refuses folder shape — a file codec is one file', () => {
		const ws = workspace({ compile: false, collections: { files: FILES } });
		writeCollection(ws.root, 'bad', { storage: { path: 'data/bad', codec: 'file', shape: 'folder', suffix: 'b', entry: 'MAIN' } });
		assert.match(compileError(ws.ws) ?? '', /one file/);
	});

	test('warns that a declared schema is ignored', () => {
		const ws = workspace({ compile: false, collections: { files: FILES } });
		writeCollection(ws.root, 'schemad', {
			storage: { path: 'data/schemad', codec: 'file', shape: 'file', suffix: 's' },
			schema: { type: 'object', properties: { a: { type: 'string' } } },
		});
		assert.match(compileQuietly(ws.ws).warnings.join('\n'), /ignored/);
	});
});
