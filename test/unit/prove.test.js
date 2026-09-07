// Tier 1 — `validateProofShape`: what a proof may say, decided from the descriptors alone.
//
// WHY THIS IS THE FIRST THING WRITTEN. A proof is the one source kind whose whole job is to be RUN
// later, which makes a typo in it uniquely expensive — and SILENT in both directions. `about:
// skills/greter` is a proof that proves nothing about anything and never says so. `where: { statuz:
// { _eq: open } }` is a filter that narrows to zero rows, so a `count: { _eq: 0 }` expectation
// PASSES forever and a `_gte: 1` one FAILS forever, in both cases for a reason no output names. So
// every one of these strings is a contract: compile prints it verbatim, prefixed with the proof's
// runtime path, and the wording has to be enough to fix the file without reading the engine.
//
// Pure by construction: a hand-built `descriptors` Map, a hand-built artifact Set, no fs, no git,
// no compile. `notes` carries the interesting shapes (a closed enum, an outbound reference, a
// `sort_field`); `people` is the hop target and deliberately has NO `sort_field`, which is what
// makes `pick: latest` invalid there.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateProofShape, PROOF_KINDS, PROOF_MODES } from '../../src/prove.js';

const descriptors = new Map([
	['notes', {
		name: 'notes',
		sort_field: 'name',
		schema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				status: { type: 'string', enum: ['open', 'done'] },
				owner: { type: 'string', 'x-reference': 'people' },
			},
		},
	}],
	['people', {
		name: 'people',
		schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
	}],
]);

const ctx = {
	descriptors,
	declaredVars: ['FILES_FOLDER'],
	moduleEnv: new Set(['API_KEY']),
	artifacts: new Set(['skills/a', 'commands/b', 'command-bindings/c', 'hr/bin/check.mjs']),
};

/** A valid gate proof, plus whatever the test is about. */
const gate = (extra = {}) => ({ name: 'g', about: ['skills/a'], kind: 'gate', steps: [{ run: 'true' }], ...extra });

/** A valid live proof, plus whatever the test is about. Named record (not `pick: latest`) so a
 *  test about something else never trips the sort_field rule. */
const live = (extra = {}) => ({
	name: 'l',
	about: ['commands/b'],
	kind: 'live',
	mode: 'readonly',
	given: { collection: 'notes', where: { status: { _eq: 'open' } }, pick: 'a-note' },
	steps: [{ run: 'echo hi' }],
	expect: [{ collection: 'notes', where: { status: { _eq: 'done' } }, count: { _gte: 1 } }],
	...extra,
});

/** The one error a proof is expected to produce — and NOTHING else. A test that accepts "contains"
 *  would pass on a validator that fires six errors for one mistake, which is the failure mode this
 *  suite exists to prevent: an operator fixing the wrong line. */
const only = (proof, message) => assert.deepEqual(validateProofShape(proof, ctx), [message]);

describe('the vocabulary is closed and named once', () => {
	test('PROOF_KINDS and PROOF_MODES are the two enums the descriptor declares', () => {
		assert.deepEqual(PROOF_KINDS, ['gate', 'live']);
		assert.deepEqual(PROOF_MODES, ['readonly', 'writes']);
	});
});

describe('validateProofShape — a valid proof is silent', () => {
	test('a valid gate returns no errors', () => {
		assert.deepEqual(validateProofShape(gate(), ctx), []);
	});

	test('a valid live proof returns no errors', () => {
		assert.deepEqual(validateProofShape(live(), ctx), []);
	});

	test('every artifact form is accepted — skill, command, binding, module script', () => {
		assert.deepEqual(validateProofShape(gate({ about: ['skills/a', 'commands/b', 'command-bindings/c', 'hr/bin/check.mjs'] }), ctx), []);
	});

	test('a declared env key is accepted from dreamteamer.vars OR a module dreamteamer.env', () => {
		assert.deepEqual(validateProofShape(gate({ requires: { env: ['FILES_FOLDER', 'API_KEY'], bin: ['git'] } }), ctx), []);
	});

	test('a one-hop reference condition is accepted — owner is an x-reference, name is a field of people', () => {
		assert.deepEqual(validateProofShape(live({ given: { collection: 'notes', where: { owner: { name: { _eq: 'Dana' } } }, pick: 'a-note' } }), ctx), []);
	});

	test('pick: latest is accepted when the collection declares a sort_field', () => {
		assert.deepEqual(validateProofShape(live({ given: { collection: 'notes', where: {}, pick: 'latest' } }), ctx), []);
	});

	test('a fixture-backed given is accepted, and every other expect form with it', () => {
		assert.deepEqual(validateProofShape(live({
			given: { collection: 'notes', fixture: true, pick: 'a-note' },
			expect: [
				{ record: '{record}', where: { status: { _eq: 'done' } } },
				{ step: 1, exit: 0 },
				{ path: '${env:FILES_FOLDER}/out.txt', exists: true },
			],
			timeout: 60,
		}), ctx), []);
	});
});

describe('validateProofShape — about', () => {
	test('a missing about is refused', () => {
		const proof = gate();
		delete proof.about;
		only(proof, 'about is required and names at least one artifact');
	});

	test('an empty about is refused the same way', () => {
		only(gate({ about: [] }), 'about is required and names at least one artifact');
	});

	test('an about naming no artifact is refused, with the four forms spelled out', () => {
		only(gate({ about: ['skills/greter'] }), 'about "skills/greter" names no artifact — an artifact is skills/<id>, commands/<id>, command-bindings/<id>, or <module>/bin/<file>');
	});
});

describe('validateProofShape — kind, gate and live', () => {
	test('an unknown kind is refused, and nothing else is judged', () => {
		only(gate({ kind: 'smoke' }), 'kind must be gate or live');
	});

	test('a gate carrying expect is refused', () => {
		only(gate({ expect: [{ collection: 'notes', where: {}, count: { _gte: 1 } }] }), 'a gate proof has run steps only and no given or expect');
	});

	test('a gate carrying given is refused', () => {
		only(gate({ given: { collection: 'notes', where: {} } }), 'a gate proof has run steps only and no given or expect');
	});

	test('a gate whose step is a perform is refused — a gate runs, it does not ask', () => {
		only(gate({ steps: [{ perform: 'summarize-meeting' }] }), 'a gate proof has run steps only and no given or expect');
	});

	test('a live proof with no mode is refused', () => {
		const proof = live();
		delete proof.mode;
		only(proof, 'a live proof declares mode: readonly | writes');
	});

	test('a live proof with an unknown mode is refused the same way', () => {
		only(live({ mode: 'read-only' }), 'a live proof declares mode: readonly | writes');
	});

	test('a live proof with no expectation is refused', () => {
		only(live({ expect: [] }), 'a live proof needs at least one step and one expectation');
	});

	test('a live proof with no steps is refused the same way', () => {
		only(live({ steps: [] }), 'a live proof needs at least one step and one expectation');
	});
});

describe('validateProofShape — given', () => {
	test('given.collection must name a collection', () => {
		only(live({ given: { collection: 'ghosts', where: {}, pick: 'a-note' } }), 'given.collection "ghosts" is not a collection');
	});

	test('a missing given.collection is the same error, naming the empty value', () => {
		only(live({ given: { where: {}, pick: 'a-note' } }), 'given.collection "" is not a collection');
	});

	test('both where and fixture is refused', () => {
		only(live({ given: { collection: 'notes', where: {}, fixture: true, pick: 'a-note' } }), 'given needs exactly one of where or fixture');
	});

	test('neither where nor fixture is refused', () => {
		only(live({ given: { collection: 'notes', pick: 'a-note' } }), 'given needs exactly one of where or fixture');
	});

	test('pick: latest needs a sort_field on the collection it picks from', () => {
		only(live({ given: { collection: 'people', where: { name: { _eq: 'Dana' } }, pick: 'latest' } }), 'pick: latest needs a sort_field on people — name the record (pick: <id>) or use a fixture');
	});

	test('pick: any is refused outright — a proof names its record', () => {
		only(live({ given: { collection: 'notes', where: {}, pick: 'any' } }), 'pick: any is not accepted — a proof names its record or uses a fixture');
	});
});

describe('validateProofShape — a where is checked against the descriptor', () => {
	test('a field the collection does not have is refused', () => {
		only(live({ given: { collection: 'notes', where: { statuz: { _eq: 'open' } }, pick: 'a-note' } }), 'where names "statuz", which notes has no field for');
	});

	test('the same check runs over an expect where, against THAT collection', () => {
		only(live({ expect: [{ collection: 'people', where: { statuz: { _eq: 'open' } }, count: { _gte: 1 } }] }), 'where names "statuz", which people has no field for');
	});

	// ⚠ THE TRAP the spike measured (§3c): a non-operator key is a one-hop REFERENCE traversal, not a
	// field-vs-field comparison. `{name: {status: …}}` reads as "resolve `name` as a ref and test its
	// `status`", and because `name` is not a ref it narrows to false with no warning at all.
	test('a nested key under a non-reference field is refused, saying what a nested key means', () => {
		only(live({ given: { collection: 'notes', where: { name: { status: { _eq: 'open' } } }, pick: 'a-note' } }), 'where "name" is not a reference field — a nested key hops a reference, it does not compare two fields');
	});

	test('a one-hop key the TARGET collection has no field for is refused, naming the target', () => {
		only(live({ given: { collection: 'notes', where: { owner: { employer: { _eq: 'Acme' } } }, pick: 'a-note' } }), 'where names "employer", which people has no field for');
	});

	test('an _eq literal outside a closed enum is refused, listing the options', () => {
		only(live({ given: { collection: 'notes', where: { status: { _eq: 'archived' } }, pick: 'a-note' } }), 'where "status" compares "archived", which is not one of status\'s options [open, done]');
	});

	test('the bare shorthand for _eq is checked against the enum too', () => {
		only(live({ given: { collection: 'notes', where: { status: 'archived' }, pick: 'a-note' } }), 'where "status" compares "archived", which is not one of status\'s options [open, done]');
	});

	test('_in is checked member by member', () => {
		only(live({ given: { collection: 'notes', where: { status: { _in: ['open', 'archived'] } }, pick: 'a-note' } }), 'where "status" compares "archived", which is not one of status\'s options [open, done]');
	});

	test('_neq and _nin are checked as well — a typo there narrows just as silently', () => {
		only(live({ given: { collection: 'notes', where: { status: { _neq: 'closed' } }, pick: 'a-note' } }), 'where "status" compares "closed", which is not one of status\'s options [open, done]');
	});

	test('an unknown filter operator is refused, reusing the filter module\'s own walker', () => {
		only(live({ given: { collection: 'notes', where: { status: { _nq: 'open' } }, pick: 'a-note' } }), 'unknown filter operator(s) _nq');
	});

	test('unknown operators from every where in the proof are reported once, sorted', () => {
		only(live({
			given: { collection: 'notes', where: { status: { _nq: 'open' } }, pick: 'a-note' },
			expect: [{ collection: 'notes', where: { name: { _bogus: 'x' } }, count: { _gte: 1 } }],
		}), 'unknown filter operator(s) _bogus, _nq');
	});
});

describe('validateProofShape — requires, expect and timeout', () => {
	test('an undeclared env key is refused, naming both places it could be declared', () => {
		only(gate({ requires: { env: ['OPENAI_KEY'] } }), 'requires.env "OPENAI_KEY" is not declared — add it to dreamteamer.vars or a module\'s dreamteamer.env');
	});

	test('expect[i].collection must name a collection, and the index is in the message', () => {
		only(live({ expect: [{ collection: 'ghosts', where: {}, count: { _gte: 1 } }] }), 'expect[0].collection "ghosts" is not a collection');
	});

	test('an expectation matching no known form is refused, listing every form', () => {
		only(live({ expect: [{ nonsense: true }] }), 'expect[0] needs one of: collection+where+count · record+where · step+exit/stdout/stdout_json · path+exists');
	});

	test('the index is the offending one, not the first', () => {
		only(live({
			expect: [{ collection: 'notes', where: {}, count: { _gte: 1 } }, { nonsense: true }],
		}), 'expect[1] needs one of: collection+where+count · record+where · step+exit/stdout/stdout_json · path+exists');
	});

	test('a zero timeout is refused', () => {
		only(gate({ timeout: 0 }), 'timeout must be a positive integer of seconds');
	});

	test('a fractional timeout is refused', () => {
		only(gate({ timeout: 1.5 }), 'timeout must be a positive integer of seconds');
	});

	test('a non-numeric timeout is refused', () => {
		only(gate({ timeout: '60' }), 'timeout must be a positive integer of seconds');
	});
});
