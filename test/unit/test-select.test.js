// The --changed selection behind `npm run verify:fast` (scripts/test-select.mjs). Each rule here is a
// promise about which tier-2 files a working-tree change runs — and the smoke fallback is the promise
// that a src/ edit never quietly runs tier 1 alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTests, SMOKE } from '../../scripts/test-select.mjs';

const I = (name) => `test/integration/${name}.test.js`;
const suite = new Map([
	[I('compile'), "import { dump } from '../../src/yaml.js';"],
	[I('records'), ''],
	[I('relations-store'), ''],
	[I('store-index'), ''],
	[I('namespaces-by-module'), ''],
	[I('public-api'), "const api = await import('../../src/api.js');"],
	[I('repo-hygiene'), "readFile(root, 'UPDATING.md')"],
	[I('restore'), ''],
	[I('first-run'), "readFile(root, 'package.json'); readFile(root, 'CLAUDE.md')"],
]);
const run = (changed, failed) => selectTests({ changed, integration: suite, failed });

test('a changed tier-2 file runs itself', () => {
	assert.deepEqual(run([I('store-index')]).files, [I('store-index')]);
});

test('a src module selects the files carrying its stem as a whole word', () => {
	assert.deepEqual(run(['src/store.js']).files, [I('relations-store'), I('store-index')]);
	assert.deepEqual(run(['src/namespace.js']).files, [I('namespaces-by-module')], 'the plural counts');
	assert.ok(!run(['src/store.js']).files.includes(I('restore')), '"restore" contains "store" but does not name it');
});

test('a file that names the changed path is selected — src, docs or descriptors alike', () => {
	assert.deepEqual(run(['src/api.js']).files, [I('public-api')]);
	assert.deepEqual(run(['UPDATING.md']).files, [I('repo-hygiene')]);
});

test('a src change nothing names runs the smoke pair, and says why', () => {
	const r = run(['src/semver.js']);
	assert.deepEqual(r.files, [...SMOKE].sort());
	assert.deepEqual(r.unmatched, ['src/semver.js']);
	assert.match(r.reasons.get(SMOKE[0]), /nothing names src\/semver\.js/);
});

test('a docs-only change nothing names runs no tier-2 file', () => {
	assert.deepEqual(run(['README.md']).files, []);
});

test('the shared fixture builder selects everything', () => {
	const r = run(['test/helpers/ws.js']);
	assert.equal(r.all, true);
	assert.equal(r.files.length, suite.size);
});

test('last run\'s failures always come along, and tier-1 edits add nothing', () => {
	assert.deepEqual(run(['test/unit/filter.test.js'], [I('records'), 'test/integration/gone.test.js']).files, [I('records')]);
});

test('a root file every fixture also has is not "mentioned" by a test reading the fixture\'s copy', () => {
	assert.deepEqual(run(['CLAUDE.md', 'README.md']).files, [], 'prose at the root runs tier 1 only');
	const r = run(['package.json']);
	assert.deepEqual(r.files, [...SMOKE].sort(), 'the engine manifest still runs the smoke pair');
	assert.ok(!r.files.includes(I('first-run')));
});
