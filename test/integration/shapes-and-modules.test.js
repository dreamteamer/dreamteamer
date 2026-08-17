// Tier 2 — the two namespace paths nothing exercised, and the folder-shape hole that was argued away.
//
// Both were listed as "coherent by construction, untested", which is the state a bug hides in. Neither
// is exotic: `shape: folder` is an ordinary descriptor option, and `owns-data` is how a module keeps its
// records in its own git repo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, compileQuietly, readFile, tree, git, dt } from '../helpers/ws.js';
import { Store } from '../../src/store.js';

describe('a folder-shape collection under a namespace', () => {
	const FOLDER = {
		id: { generate: '{{ name | slug }}' },
		storage: { shape: 'folder', entry: 'README.md', suffix: 'doc', codec: 'md' },
		schema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' }, body: { type: 'string', 'x-body': true } },
		},
	};

	const ws = () => workspace({
		namespaces: ['health'],
		collections: { 'health/protocols': FOLDER },
	});

	test('records are folders under the namespace, and read back', () => {
		const w = ws();
		w.store.add('health/protocols', { name: 'Intake', body: 'the steps' });
		assert.ok(readFile(w.root, 'data/health/protocols/intake/README.md'));
		assert.equal(w.store.read('health/protocols', 'intake').fields.name, 'Intake');
		assert.equal(w.dt('check').code, 0);
	});

	// ⚠ THE HOLE. `snapshot()` skipped directories, with a comment arguing the case could not occur
	// because the only folder-shape collection was system-stored. True, and the wrong kind of true: it
	// rested on the current set of collections, not on anything enforced. `rm` deleted the folder and the
	// "restore" closure did nothing, so a failed commit meant the record was simply GONE.
	test('rm can be rolled back — the whole folder comes back, not just the entry file', () => {
		const w = ws();
		w.store.add('health/protocols', { name: 'Intake', body: 'the steps' });
		const dir = path.join(w.root, 'data/health/protocols/intake');
		fs.writeFileSync(path.join(dir, 'extra.md'), 'a second file in the record folder\n');

		// The unit `rm` operates on is the whole FOLDER, and that is what must be snapshotted.
		const unit = w.store.recordRoot(w.store.descriptor('health/protocols'), 'intake');
		assert.deepEqual(tree(w.root, 'data/health/protocols/intake').sort(), [
			'data/health/protocols/intake/README.md',
			'data/health/protocols/intake/extra.md',
		]);

		w.store.rm('health/protocols', 'intake');
		assert.equal(fs.existsSync(unit), false, 'the whole folder goes');
		assert.deepEqual(tree(w.root, 'data/health/protocols'), []);
	});

	test('a rollback driven by a failing commit restores every file in the folder', () => {
		// auto-commit ON so `rm` actually commits — then break git so the commit FAILS and the undo runs.
		const w = workspace({
			namespaces: ['health'],
			pkg: { 'auto-commit': true },
			collections: { 'health/protocols': FOLDER },
		});
		w.store.add('health/protocols', { name: 'Intake', body: 'the steps' });
		const dir = path.join(w.root, 'data/health/protocols/intake');
		fs.writeFileSync(path.join(dir, 'extra.md'), 'second file\n');
		git(w.root, ['add', '-A']);
		git(w.root, ['commit', '-qm', 'protocols']);

		// A commit cannot succeed while an index.lock exists — the cheapest honest way to fail step 2
		// after step 1 has already deleted the folder.
		const lock = path.join(w.root, '.git', 'index.lock');
		fs.writeFileSync(lock, '');
		assert.throws(() => w.store.rm('health/protocols', 'intake'), /git commit failed|rolled back/);
		fs.rmSync(lock, { force: true });

		// THE ASSERTION: both files are back, not just the entry.
		assert.deepEqual(tree(w.root, 'data/health/protocols/intake').sort(), [
			'data/health/protocols/intake/README.md',
			'data/health/protocols/intake/extra.md',
		]);
		assert.equal(readFile(w.root, 'data/health/protocols/intake/extra.md'), 'second file\n');
	});
});

describe('a module that owns its data, with a namespaced collection', () => {
	/** A git-channel module with `owns-data`, shipping a namespaced collection. */
	const withModule = () => {
		const w = workspace({ namespaces: ['health'], compile: false });
		const mod = path.join(w.root, 'git_modules', 'clinic');
		fs.mkdirSync(path.join(mod, 'collections', 'health'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({
			name: 'clinic', version: '1.0.0', dreamteamer: { 'owns-data': true },
		}, null, '\t'));
		fs.writeFileSync(path.join(mod, 'collections', 'health', 'doctors.collection.yaml'),
			'name: health/doctors\nstorage: { suffix: doctor }\nid: { generate: "{{ name | slug }}" }\n'
			+ 'schema:\n  type: object\n  required: [name]\n  properties:\n    name: { type: string }\n');
		// owns-data on the git channel requires a real clone, or compile refuses (its records could
		// never be committed — git_modules is gitignored by the workspace)
		git(mod, ['init', '-q']);
		git(mod, ['add', '-A']);
		git(mod, ['commit', '-qm', 'clinic']);
		return { w, mod };
	};

	test('the namespace nests INSIDE the module, and the module owns the repo', () => {
		const { w } = withModule();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		const d = store.descriptor('health/doctors');
		assert.equal(d.storage.path, 'git_modules/clinic/data/health/doctors');
		assert.equal(d.storage.repo, 'git_modules/clinic', 'records belong to the module\'s repo');
		assert.equal(d.storage.base, 'workspace');
	});

	test('a record written through the store lands in the module and commits to ITS repo', () => {
		const { w, mod } = withModule();
		compileQuietly(w.ws);
		const store = new Store(w.ws);
		store.add('health/doctors', { name: 'Dana Levi' });
		assert.ok(readFile(w.root, 'git_modules/clinic/data/health/doctors/dana-levi.doctor.md'));

		// one commit PER REPO: `dt commit` must publish into the module, not the workspace
		const res = dt(w.root, 'commit', '-m', 'add a doctor');
		assert.equal(res.code, 0, res.stdout + res.stderr);
		assert.match(res.stdout, /git_modules\/clinic/);
		assert.equal(git(mod, ['status', '--porcelain', 'data']), '', 'the module repo is clean');
	});

	// A module cannot declare a namespace — the workspace decides how its own data is partitioned —
	// so a module shipping a namespaced collection into a workspace that has not declared it must fail
	// LOUDLY rather than land somewhere surprising.
	test('the workspace must still declare the namespace', () => {
		const { w } = withModule();
		const pkg = JSON.parse(readFile(w.root, 'package.json'));
		delete pkg.dreamteamer.namespaces;
		fs.writeFileSync(path.join(w.root, 'package.json'), JSON.stringify(pkg, null, '\t'));
		assert.throws(() => compileQuietly({ root: w.root, pkg }), /"health" is not declared/);
	});
});
