// Tier 1 — the accessors every reader asks about a compiled descriptor (src/descriptor.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../src/descriptor.js';

const visits = {
	name: 'health/visits',
	record_title: '{{ reason }}',
	storage: { under: { parent: 'patient', subfolder: 'visits' } },
	ids: { from: '{{ date }}--{{ patient | basename }}' },
	display: { nav: { icon: 'pulse' }, list: { columns: ['reason'] } },
	compiled: {
		defaults: { title: 'Visits', singular: 'health/visit', storage: { path: 'data/health/visits', format: 'md', shape: 'file', suffix: 'visit' }, display: { list: { layout: 'table' } } },
		module: 'clinic', repo: '.', runtime: false, under_collection: 'health/patients', mirrors: ['prescriptions'], overlaid_by: ['billing'], unresolved_peers: ['finance/income-events'],
		fields: {
			id: { type: 'string', virtual: true },
			created: { type: 'datetime', derived: true },
			last_modified: { type: 'datetime', virtual: true },
			reason: { type: 'string', required: true },
			patient: { type: 'health/patients', required: true },
			referral: { type: ['health/referrals', 'health/lab-orders'] },
			evidence: { type: 'reference', many: true },
			related: { type: 'health/visits', many: true, soft: true },
			prescriptions: { type: 'health/prescriptions', many: true, mirror_of: 'visit' },
			position: { type: 'position' },
			notes: { type: 'markdown', body: true },
		},
		json_schema: { type: 'object', required: ['reason', 'patient'], properties: {} },
	},
};

describe('descriptor accessors', () => {
	test('fields, stored fields, body, position, required', () => {
		assert.equal(Object.keys(D.fieldsOf(visits)).length, 11);
		assert.deepEqual(Object.keys(D.storedFieldsOf(visits)).includes('id'), false);
		assert.equal(D.bodyFieldOf(visits), 'notes');
		assert.equal(D.positionFieldOf(visits), 'position');
		assert.deepEqual(D.requiredOf(visits), ['reason', 'patient']);
	});
	test('targetsOf: scalar, collection, union, polymorphic', () => {
		const f = D.fieldsOf(visits);
		assert.equal(D.targetsOf(f.reason), null);
		assert.equal(D.targetsOf(f.position), null);
		assert.deepEqual(D.targetsOf(f.patient), ['health/patients']);
		assert.deepEqual(D.targetsOf(f.referral), ['health/referrals', 'health/lab-orders']);
		assert.equal(D.targetsOf(f.evidence), '*');
		assert.equal(D.isSoft(f.related), true);
		assert.equal(D.mirrorOf(f.prescriptions), 'visit');
	});
	test('labels and ids: authored over defaults', () => {
		assert.equal(D.titleOf(visits), 'Visits');
		assert.equal(D.singularOf(visits), 'health/visit');
		assert.equal(D.recordTitleOf(visits), '{{ reason }}');
		assert.deepEqual(D.idsOf(visits), { from: '{{ date }}--{{ patient | basename }}' });
	});
	test('storage resolved, under carries the parent collection', () => {
		assert.deepEqual(D.storageOf(visits), { path: 'data/health/visits', format: 'md', shape: 'file', suffix: 'visit', repo: '.', runtime: false, under: { parent: 'patient', subfolder: 'visits', collection: 'health/patients', id: 'independent' } });
		assert.equal(D.isRuntime(visits), false);
		assert.equal(D.isBinary(visits), false);
	});
	test('display merges authored over defaults per sub-block', () => {
		assert.deepEqual(D.displayOf(visits), { nav: { icon: 'pulse' }, list: { layout: 'table', columns: ['reason'] } });
	});
	test('compiled facts', () => {
		assert.equal(D.moduleOf(visits), 'clinic');
		assert.deepEqual(D.overlaidByOf(visits), ['billing']);
		assert.deepEqual(D.unresolvedPeersOf(visits), ['finance/income-events']);
		assert.deepEqual(D.mirrorsOf(visits), ['prescriptions']);
	});
	test('an empty or absent descriptor answers safely', () => {
		assert.deepEqual(D.fieldsOf(undefined), {});
		assert.equal(D.bodyFieldOf({}), undefined);
		assert.equal(D.storageOf({}).format, 'md');
	});
});
