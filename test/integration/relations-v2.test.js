// Tier 2 — relations in descriptor v2: declared once, on the mirror (`mirror_of`), with cardinality
// read off the owner's reference. Invented names only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, writeCollection, writeModule, compileError, compileQuietly, dt, WS_MODULE } from '../helpers/ws.js';

const body = { notes: { type: 'markdown', body: true } };
const doctors = (extra = {}) => ({ description: 'A doctor.', ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, ...extra, ...body } });
const visits = (extra = {}) => ({ description: 'A visit.', ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, ...extra, ...body } });

function ws(colls, opts = {}) {
	const w = workspace({ compile: false, ...opts });
	for (const [n, d] of Object.entries(colls)) writeCollection(w.root, n, d);
	return w;
}

describe('cardinality from the owner', () => {
	test('a many mirror of a scalar reference is many-to-one and is maintained', () => {
		const w = ws({ doctors: doctors({ visits: { type: 'visits', many: true, mirror_of: 'doctor' } }), visits: visits({ doctor: { type: 'doctors' } }) });
		assert.equal(compileError(w.ws), null);
		dt(w.root, 'add', 'doctors', '--name', 'Cohen');
		assert.equal(dt(w.root, 'add', 'visits', '--name', 'First', '--doctor', 'doctors/cohen').code, 0);
		assert.deepEqual(JSON.parse(dt(w.root, 'get', 'doctors/cohen', '--json').stdout).visits, ['visits/first']);
		assert.equal(dt(w.root, 'check').code, 0);
	});
	test('a scalar mirror requires the owner reference to be unique', () => {
		const w = ws({ doctors: doctors({ visit: { type: 'visits', mirror_of: 'doctor' } }), visits: visits({ doctor: { type: 'doctors' } }) });
		assert.match(compileError(w.ws), /SCALAR mirror, so visits\.doctor must be a unique scalar reference/);
	});
	test('a unique owner gives a one-to-one with a scalar mirror; a second claim is refused', () => {
		const w = ws({ doctors: doctors({ visit: { type: 'visits', mirror_of: 'doctor' } }), visits: visits({ doctor: { type: 'doctors', unique: true } }) });
		assert.equal(compileError(w.ws), null);
		dt(w.root, 'add', 'doctors', '--name', 'Cohen');
		assert.equal(dt(w.root, 'add', 'visits', '--name', 'First', '--doctor', 'doctors/cohen').code, 0);
		const second = dt(w.root, 'add', 'visits', '--name', 'Second', '--doctor', 'doctors/cohen');
		assert.notEqual(second.code, 0);
	});
	test('a many mirror of a unique reference is refused', () => {
		const w = ws({ doctors: doctors({ visits: { type: 'visits', many: true, mirror_of: 'doctor' } }), visits: visits({ doctor: { type: 'doctors', unique: true } }) });
		assert.match(compileError(w.ws), /visits\.doctor is unique.*make doctors\.visits scalar/);
	});
	test('a many owner gives many-to-many', () => {
		const w = ws({ doctors: doctors({ visits: { type: 'visits', many: true, mirror_of: 'doctors' } }), visits: visits({ doctors: { type: 'doctors', many: true } }) });
		assert.equal(compileError(w.ws), null);
		dt(w.root, 'add', 'doctors', '--name', 'Cohen');
		dt(w.root, 'add', 'doctors', '--name', 'Levi');
		assert.equal(dt(w.root, 'add', 'visits', '--name', 'Joint', '--doctors', 'doctors/cohen', '--doctors', 'doctors/levi').code, 0);
		assert.deepEqual(JSON.parse(dt(w.root, 'get', 'doctors/levi', '--json').stdout).visits, ['visits/joint']);
	});
});

describe('what a mirror needs', () => {
	test('the owner field must exist and point back', () => {
		assert.match(compileError(ws({ doctors: doctors({ visits: { type: 'visits', many: true, mirror_of: 'nope' } }), visits: visits() }).ws), /visits has no field "nope"/);
		assert.match(compileError(ws({ doctors: doctors({ visits: { type: 'visits', many: true, mirror_of: 'name' } }), visits: visits() }).ws), /does not reference doctors/);
	});
	test('an md target without a body cannot hold a mirror', () => {
		const w = ws({ doctors: { description: 'A doctor.', ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string' }, visits: { type: 'visits', many: true, mirror_of: 'doctor' } } }, visits: visits({ doctor: { type: 'doctors' } }) });
		assert.match(compileError(w.ws), /declares no body field/);
	});
	test('a union owner whose targets each declare the mirror compiles with no warning and maintains both', () => {
		const w = ws({
			doctors: doctors({ cases: { type: 'visits', many: true, mirror_of: 'about' } }),
			nurses: { ...doctors({ cases: { type: 'visits', many: true, mirror_of: 'about' } }), description: 'A nurse.' },
			visits: visits({ about: { type: ['doctors', 'nurses'] } }),
		});
		const out = compileQuietly(w.ws);
		assert.deepEqual(out.warnings.filter((x) => /declared on both sides|relation/.test(x)), []);
		dt(w.root, 'add', 'doctors', '--name', 'Cohen');
		dt(w.root, 'add', 'nurses', '--name', 'Dana');
		dt(w.root, 'add', 'visits', '--name', 'A', '--about', 'doctors/cohen');
		dt(w.root, 'add', 'visits', '--name', 'B', '--about', 'nurses/dana');
		assert.deepEqual(JSON.parse(dt(w.root, 'get', 'doctors/cohen', '--json').stdout).cases, ['visits/a']);
		assert.deepEqual(JSON.parse(dt(w.root, 'get', 'nurses/dana', '--json').stdout).cases, ['visits/b']);
		assert.equal(dt(w.root, 'check').code, 0);
	});
});

describe('a mirror across modules is an overlay', () => {
	test('declared by an overlay in the owner\'s module, compiled and maintained', () => {
		const w = ws({ doctors: doctors() });
		writeModule(w.root, 'clinic', { dependencies: [WS_MODULE], collections: {
			visits: visits({ doctor: { type: 'doctors' } }),
			doctors: { overlay: true, fields: { visits: { type: 'visits', many: true, mirror_of: 'doctor' } } },
		} });
		assert.equal(compileError(w.ws), null);
		dt(w.root, 'add', 'doctors', '--name', 'Cohen');
		assert.equal(dt(w.root, 'add', 'visits', '--name', 'First', '--doctor', 'doctors/cohen').code, 0);
		assert.deepEqual(JSON.parse(dt(w.root, 'get', 'doctors/cohen', '--json').stdout).visits, ['visits/first']);
	});
	test('an overlay of a peer nobody installed is inert, and the workspace is not stale', () => {
		const w = ws({ visits: visits() });
		writeModule(w.root, 'billing', { peerDependencies: ['claims'], collections: { claims: { overlay: true, fields: { visit: { type: 'string' } } } } });
		assert.equal(compileError(w.ws), null);
		const status = dt(w.root, 'status');
		assert.doesNotMatch(status.stdout + status.stderr, /stale|differ/);
	});
});
