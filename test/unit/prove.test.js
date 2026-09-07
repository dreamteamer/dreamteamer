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
import { validateProofShape, PROOF_KINDS, PROOF_MODES, substitute, stepWarnings, applyCap, verdictLine, exitFor, EXIT, LEDGER_CAP } from '../../src/prove.js';

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
		// `manager` exists so a TWO-hop filter is expressible: `owner.manager.name` is one hop past
		// what the evaluator resolves, and has to be refused rather than left to narrow to false.
		schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, manager: { type: 'string', 'x-reference': 'people' } } },
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

	test('every count operator in the closed set is accepted, _delta included', () => {
		for (const op of ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_delta']) {
			assert.deepEqual(validateProofShape(live({ expect: [{ collection: 'notes', where: {}, count: { [op]: 1 } }] }), ctx), [], op);
		}
	});

	test('a bare integer count is accepted — it is shorthand for _eq', () => {
		assert.deepEqual(validateProofShape(live({ expect: [{ collection: 'notes', where: {}, count: 1 }] }), ctx), []);
	});

	test('_in accepts the comma-string spelling filter.js itself accepts', () => {
		// `toArray` (filter.js:100) splits a non-array operand on commas, so `_in: 'open,done'` is a
		// LEGAL two-value filter — reading it as one literal reported a false enum violation.
		assert.deepEqual(validateProofShape(live({ given: { collection: 'notes', where: { status: { _in: 'open,done' } }, pick: 'a-note' } }), ctx), []);
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

describe('validateProofShape — the fix-round-1 rulings', () => {
	// R12 — `mode` is meaningless on a gate (there is no workspace state to read or write), and the
	// descriptor already says "forbidden on a gate". A key the engine ignores is a key whose author
	// believes something untrue about what will run.
	test('a gate carrying mode is refused', () => {
		only(gate({ mode: 'readonly' }), 'a gate proof takes no mode');
	});

	// R11 — `count` has its OWN operator set: the filter operators that order integers, plus
	// `_delta`, which no filter has. So neither `KNOWN_OPERATORS` nor `unknownOperators` can judge
	// it — `_delta` would read as a typo there, and a real typo (`_gtee`) reads as fine.
	test('a count operator outside the closed set is refused, listing the set', () => {
		only(live({ expect: [{ collection: 'notes', where: {}, count: { _gtee: 1 } }] }), 'count operator "_gtee" is not one of _eq _neq _gt _gte _lt _lte _delta');
	});

	test('a filter operator that is not a COUNT operator is refused too', () => {
		only(live({ expect: [{ collection: 'notes', where: {}, count: { _contains: 1 } }] }), 'count operator "_contains" is not one of _eq _neq _gt _gte _lt _lte _delta');
	});

	test('a non-integer count operand is refused', () => {
		only(live({ expect: [{ collection: 'notes', where: {}, count: { _gte: 'one' } }] }), 'count "_gte" compares "one", which is not an integer');
	});

	test('a fractional count operand is refused — half a record does not exist', () => {
		only(live({ expect: [{ collection: 'notes', where: {}, count: { _eq: 1.5 } }] }), 'count "_eq" compares "1.5", which is not an integer');
	});

	test('a bare non-integer count is refused as the _eq it stands for', () => {
		only(live({ expect: [{ collection: 'notes', where: {}, count: 'many' }] }), 'count "_eq" compares "many", which is not an integer');
	});

	// ⚠ TWO HOPS ARE REFUSED, not silently accepted. `matchesFilter` resolves ONE reference and
	// evaluates the sub-condition against the target record; a second nesting level is treated as
	// another ref traversal on a value that is a plain field, which narrows to false with no
	// warning. Exactly the silent-zero-rows failure the whole validator exists to close.
	test('a two-hop where is refused, naming the dotted path', () => {
		only(live({ given: { collection: 'notes', where: { owner: { manager: { name: { _eq: 'Dana' } } } }, pick: 'a-note' } }), 'where hops more than one reference (owner.manager.name) — a proof filter hops at most one');
	});

	test('a second hop over a NON-reference target field is refused the same way', () => {
		only(live({ given: { collection: 'notes', where: { owner: { name: { first: { _eq: 'Dana' } } } }, pick: 'a-note' } }), 'where hops more than one reference (owner.name.first) — a proof filter hops at most one');
	});

	// R14 — `{record}` is bound by `given`. A `record:` expectation without one is a proof that
	// cannot run, and the failure would surface at run time as an unresolved substitution.
	test('a record expectation with no given is refused', () => {
		const proof = live({ expect: [{ record: '{record}', where: { status: { _eq: 'done' } } }] });
		delete proof.given;
		only(proof, 'a record expectation needs a given — nothing binds {record}');
	});

	test('a fixture with no pick is refused — a fixture folder holds records, not A record', () => {
		only(live({ given: { collection: 'notes', fixture: true } }), 'a fixture needs pick: <id> naming one of its records');
	});

	test('_in still enum-checks each member of a comma string', () => {
		only(live({ given: { collection: 'notes', where: { status: { _in: 'open,archived' } }, pick: 'a-note' } }), 'where "status" compares "archived", which is not one of status\'s options [open, done]');
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Task 3 — the PURE core the runner is built out of. Everything below runs against literals: no
// store, no fs, no subprocess, which is the whole reason these four functions are separable from
// the runner at all.
//
// Every string in this block is a CONTRACT. `verdictLine` is what an operator reads to decide
// whether a proof's verdict is believable, and a line that prints only the WANTED value ("expected
// status done ✖") sends them to re-run the proof by hand to find out what it actually was. So the
// actual sits beside the wanted on every line, and the glyph set is closed and pinned here.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('substitute — {record} and {record.<field>}, and nothing else', () => {
	const bound = { record: { ref: 'notes/a', fields: { id: 'a', name: 'Ada', status: 'open', revision: 3 } } };

	test('{record} renders the ref', () => {
		assert.equal(substitute('dt get {record}', bound), 'dt get notes/a');
	});

	test('{record.<field>} renders the value', () => {
		assert.equal(substitute('echo {record.name}', bound), 'echo Ada');
	});

	test('a numeric field renders bare, as its String form', () => {
		assert.equal(substitute('r={record.revision}', bound), 'r=3');
	});

	test('several substitutions in one string are all rendered', () => {
		assert.equal(substitute('{record} {record.status} {record.name}', bound), 'notes/a open Ada');
	});

	// ⚠ `${env:X}` is the RESOLVER's bracket, not this one — a proof's `path:` expectation is rendered
	// per machine by `dt resolve`, and a shell step may legitimately carry `${HOME}`. A `{…}` matcher
	// that did not exempt a `$`-prefixed brace would throw on both.
	test('${env:X} is left untouched — that bracket belongs to the resolver', () => {
		assert.equal(substitute('ls ${env:FILES_FOLDER}/out', bound), 'ls ${env:FILES_FOLDER}/out');
	});

	test('a $-prefixed shell brace is left untouched too', () => {
		assert.equal(substitute('echo ${HOME}', bound), 'echo ${HOME}');
	});

	// ⚠ R17 — A RUN STEP IS A SHELL STRING, AND THE SHELL OWNS BRACES TOO. Throwing on every
	// unrecognised `{…}` was measured to kill four correct steps — `awk '{print $1}'`,
	// `sed -n '1,3{p}'`, `jq '{a: .b}'` and `mkdir -p x/{a,b}` — for a check that exists to catch a
	// typo. So this function renders what it OWNS and passes everything else through untouched; the
	// typo net is `stepWarnings`, printed by compile, where a false positive costs a warning line
	// instead of a refused proof.
	test('an unknown brace passes through untouched — the shell owns braces too', () => {
		assert.equal(substitute('echo {nope}', bound), 'echo {nope}');
	});

	test('the four measured shell shapes survive: awk, sed, jq and brace expansion', () => {
		assert.equal(substitute("awk '{print $1}' f", bound), "awk '{print $1}' f");
		assert.equal(substitute("sed -n '1,3{p}' f", bound), "sed -n '1,3{p}' f");
		assert.equal(substitute("jq '{a: .b}' f", bound), "jq '{a: .b}' f");
		assert.equal(substitute('mkdir -p x/{a,b}', bound), 'mkdir -p x/{a,b}');
	});

	test('a passed-through brace beside a real one leaves only the real one rendered', () => {
		assert.equal(substitute("awk '{print $1}' {record}", bound), "awk '{print $1}' notes/a");
	});

	// A field the picked record does not carry would otherwise render as the STRING "undefined" into
	// a shell command — the silent-wrong-command failure, one layer down from the silent-zero-rows one
	// the validator exists to close.
	test('a field the picked record does not carry throws, naming the field', () => {
		assert.throws(() => substitute('echo {record.missing}', bound), /^Error: \{record\.missing\} — notes\/a has no field "missing"$/);
	});

	test('{record} with nothing bound throws rather than rendering "undefined"', () => {
		assert.throws(() => substitute('dt get {record}', {}), /^Error: \{record\} has nothing to bind to — this proof declares no given$/);
	});

	test('a string with no braces comes back untouched', () => {
		assert.equal(substitute('npm test', bound), 'npm test');
	});
});

// ⚠ R20 — A PATH IS NOT A SHELL STRING, so the pass-through that saves `awk '{print}'` is exactly
// wrong for a `path:` or `record:` value. Nothing downstream of those two would ever notice a
// typo'd `{recrod}`: `path: "{recrod}/out.txt"` becomes a literal directory name that does not
// exist, and the expectation answers `exists false` — a FAIL that names the wrong cause. So the two
// values the ENGINE consumes (rather than the shell) are substituted in STRICT mode, where an
// identifier-shaped brace nobody substitutes throws.
describe('substitute — strict mode, for the values the engine consumes rather than the shell', () => {
	const bound = { record: { ref: 'notes/a', fields: { id: 'a', name: 'Ada', status: 'open' } } };
	const strict = { strict: true };

	test('the two it owns still render, exactly as in lenient mode', () => {
		assert.equal(substitute('{record}', bound, strict), 'notes/a');
		assert.equal(substitute('out/{record.name}.txt', bound, strict), 'out/Ada.txt');
	});

	test('an identifier-shaped brace nobody substitutes THROWS, naming what a proof may use', () => {
		assert.throws(
			() => substitute('{recrod}/out.txt', bound, strict),
			/^Error: unknown substitution "\{recrod\}" in a path — a proof may use \{record\} and \{record\.<field>\}$/,
		);
	});

	test('the SAME string passes through untouched in lenient mode — the modes really differ', () => {
		assert.equal(substitute('{recrod}/out.txt', bound), '{recrod}/out.txt');
	});

	// The resolver's own bracket must survive strict mode, or no `path:` expectation could name a
	// machine-dependent folder at all — which is the whole point of the form.
	test('${env:X} and ${HOME} survive strict mode — the $ brace is not ours', () => {
		assert.equal(substitute('${env:FILES_FOLDER}/out', bound, strict), '${env:FILES_FOLDER}/out');
		assert.equal(substitute('${HOME}/out', bound, strict), '${HOME}/out');
	});

	// The same asymmetry `stepWarnings` accepts: only an IDENTIFIER-shaped token is judgeable, so a
	// brace with a space in it is invisible here too. Stated as a test so it is a decision.
	test('a non-identifier brace is invisible to strict mode, as it is to the warning net', () => {
		assert.equal(substitute('{a b}/out', bound, strict), '{a b}/out');
	});

	test('a missing field still throws in strict mode, with the same message', () => {
		assert.throws(() => substitute('{record.missing}', bound, strict), /has no field "missing"/);
	});
});

describe('applyCap — the ledger is append-only and bounded', () => {
	const rows = (n) => Array.from({ length: n }, (_, i) => ({ i }));

	test('the cap is 50', () => {
		assert.equal(LEDGER_CAP, 50);
	});

	// ⚠ THE FIRST row is dropped and the NEW one is last: a ledger is read for "what happened
	// recently", so trimming the newest would make the cap delete the only rows anyone wants.
	test('50 rows plus one stays 50 — the oldest drops, the new row is last', () => {
		const out = applyCap(rows(50), { i: 'new' });
		assert.equal(out.length, 50);
		assert.deepEqual(out[0], { i: 1 }, 'the FIRST row is the one dropped');
		assert.deepEqual(out[49], { i: 'new' }, 'the appended row is LAST');
	});

	test('under the cap nothing is dropped', () => {
		assert.deepEqual(applyCap(rows(3), { i: 'new' }), [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 'new' }]);
	});

	test('it returns a NEW array and never mutates the one it was given', () => {
		const before = rows(2);
		const out = applyCap(before, { i: 'new' });
		assert.equal(before.length, 2);
		assert.notEqual(out, before);
	});

	test('an explicit cap overrides the default', () => {
		assert.deepEqual(applyCap(rows(3), { i: 'new' }, 2), [{ i: 2 }, { i: 'new' }]);
	});

	// ⚠ `slice(-0)` IS `slice(0)` — the whole array. A cap of zero has to keep NOTHING, and without
	// the guard it silently disables the cap instead, which is the opposite of what the number says.
	test('a cap of 0 keeps nothing — never everything', () => {
		assert.deepEqual(applyCap(rows(2), { i: 'new' }, 0), []);
	});

	test('a negative cap keeps nothing too', () => {
		assert.deepEqual(applyCap(rows(2), { i: 'new' }, -1), []);
	});
});

describe('verdictLine — the actual value beside the wanted one, always', () => {
	test('a satisfied count reads count <actual> ≥ <wanted> ✔', () => {
		assert.equal(verdictLine({ count: { _gte: 1 } }, 1), 'count 1 ≥ 1 ✔');
	});

	test('an unsatisfied count prints the SAME line with ✖ — the actual is what makes it readable', () => {
		assert.equal(verdictLine({ count: { _gte: 1 } }, 0), 'count 0 ≥ 1 ✖');
	});

	// ⚠ `_delta` is the one operator no filter has (after-minus-before is something only a proof has
	// two sides of), and the SIGN is always printed: `count 1 = 1` and `count +1 = +1` say different
	// things, and only the second one says which of the two numbers is a difference.
	test('_delta prints both numbers signed', () => {
		assert.equal(verdictLine({ count: { _delta: 1 } }, 1), 'count +1 = +1 ✔');
	});

	test('a zero delta still shows its sign', () => {
		assert.equal(verdictLine({ count: { _delta: 0 } }, 0), 'count +0 = +0 ✔');
	});

	test('a negative delta keeps its own sign and fails against a positive want', () => {
		assert.equal(verdictLine({ count: { _delta: 1 } }, -2), 'count -2 = +1 ✖');
	});

	test('a bare operator map is the count condition it can only be', () => {
		assert.equal(verdictLine({ _delta: 1 }, 1), 'count +1 = +1 ✔');
	});

	// The record form: the FIELD is the key, and the actual is JSON-quoted because a string value is
	// where a trailing space or an empty string hides.
	test('a record-field line quotes the actual string and prints the wanted bare', () => {
		assert.equal(verdictLine({ status: { _in: ['done'] } }, 'open'), 'status "open" ∈ [done] ✖');
	});

	test('the _eq line is the one R6 names', () => {
		assert.equal(verdictLine({ status: { _eq: 'done' } }, 'open'), 'status "open" = done ✖');
	});

	test('the bare shorthand for _eq renders the same line', () => {
		assert.equal(verdictLine({ status: 'done' }, 'open'), 'status "open" = done ✖');
	});

	test('every glyph in the closed set, one line each', () => {
		assert.equal(verdictLine({ status: { _neq: 'done' } }, 'open'), 'status "open" ≠ done ✔');
		assert.equal(verdictLine({ count: { _gt: 1 } }, 2), 'count 2 > 1 ✔');
		assert.equal(verdictLine({ count: { _lte: 1 } }, 1), 'count 1 ≤ 1 ✔');
		assert.equal(verdictLine({ count: { _lt: 1 } }, 0), 'count 0 < 1 ✔');
		assert.equal(verdictLine({ status: { _nin: ['done'] } }, 'open'), 'status "open" ∉ [done] ✔');
		assert.equal(verdictLine({ status: { _nempty: true } }, 'open'), 'status "open" nonempty true ✔');
		assert.equal(verdictLine({ status: { _empty: true } }, ''), 'status "" empty true ✔');
		assert.equal(verdictLine({ status: { _contains: 'pen' } }, 'open'), 'status "open" contains pen ✔');
	});

	// An operator with no glyph prints its own NAME rather than a symbol nobody can look up — the
	// filter operator set is open enough (`_regex`, `_starts_with`, `_between`) that inventing a
	// glyph per member would be a second vocabulary to keep in sync with filter.js.
	test('an operator outside the glyph table prints its own name', () => {
		assert.equal(verdictLine({ status: { _starts_with: 'op' } }, 'open'), 'status "open" _starts_with op ✔');
	});

	test('two operators on one field are both rendered', () => {
		assert.equal(verdictLine({ count: { _gte: 1, _lte: 3 } }, 2), 'count 2 ≥ 1 and ≤ 3 ✔');
	});

	test('an absent actual prints as undefined rather than as an empty gap', () => {
		assert.equal(verdictLine({ status: { _eq: 'done' } }, undefined), 'status undefined = done ✖');
	});

	// ⚠ R18 — ONE ENTRY, and anything else THROWS. A raw `expect` entry carries `collection`, `where`
	// and `count` together; handed here whole it silently rendered the FIRST key —
	// `collection 1 = notes ✖` — a verdict line about the wrong thing, marked failed, for a proof
	// that passed. A caller has to narrow the entry to the one condition being judged, and a throw is
	// the only answer that makes forgetting visible.
	test('a multi-entry expectation throws rather than rendering its first key', () => {
		assert.throws(
			() => verdictLine({ collection: 'notes', where: { status: { _eq: 'done' } }, count: { _gte: 1 } }, 1),
			/^Error: verdictLine takes ONE expectation entry — got keys collection, where, count$/,
		);
	});

	test('an empty expectation throws, saying it got none', () => {
		assert.throws(() => verdictLine({}, 1), /^Error: verdictLine takes ONE expectation entry — got none$/);
	});
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// `stepWarnings` — where the typo net went (R17).
//
// `substitute` used to be the net, and it caught shell syntax: `awk '{print $1}'` in a `run:` step
// died as "unknown substitution". A net that refuses correct proofs teaches the author to delete
// correct lines, which is worse than the typo it was hunting — so the net moved to COMPILE and
// became a WARNING. It judges the one thing a static reader can judge: a brace token that LOOKS like
// an identifier and is not one of the two names a proof may use.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('stepWarnings — the typo net is a compile WARNING, never an error', () => {
	const proof = (...steps) => ({ name: 'p', about: ['skills/a'], kind: 'gate', steps });
	const warned = (token, step = 1) => `step ${step} uses "{${token}}" — only {record} and {record.<field>} are substituted; the rest reaches the shell as written`;

	test("a typo'd {recrod} is warned about, naming the step and what IS substituted", () => {
		assert.deepEqual(stepWarnings(proof({ run: 'echo {recrod}' })), [warned('recrod')]);
	});

	test('{record} and {record.<field>} are never warned about', () => {
		assert.deepEqual(stepWarnings(proof({ run: 'dt get {record}' }, { run: 'echo {record.name}' })), []);
	});

	// ⚠ THE SPACE IS THE WHOLE POINT. `{print $1}` is not identifier-shaped, so the most common awk
	// one-liner earns nothing; `{print}` is, so it earns a warning it does not deserve. That
	// asymmetry is deliberate and cheap: the false positive is one line of stdout, and the proof
	// still compiles and still runs.
	test("awk '{print $1}' earns no warning — it is not identifier-shaped", () => {
		assert.deepEqual(stepWarnings(proof({ run: "awk '{print $1}' f" })), []);
	});

	test("awk '{print}' DOES earn one — identifier-shaped is all a static net can judge", () => {
		assert.deepEqual(stepWarnings(proof({ run: "awk '{print}' f" })), [warned('print')]);
	});

	test('a perform step is netted too, and the step number counts across both kinds', () => {
		assert.deepEqual(stepWarnings(proof({ run: 'true' }, { perform: 'open {recrod}' })), [warned('recrod', 2)]);
	});

	// `${…}` is the resolver's bracket and the shell's, exempted here for the same reason
	// `substitute` exempts it — warning on `${HOME}` is how a warning channel gets ignored.
	test('a $-prefixed brace earns no warning', () => {
		assert.deepEqual(stepWarnings(proof({ run: 'ls ${HOME} ${env:FILES_FOLDER}' })), []);
	});

	test('every offending token in one step is reported', () => {
		assert.deepEqual(stepWarnings(proof({ run: 'echo {recrod} {noep}' })), [warned('recrod'), warned('noep')]);
	});

	test('a proof with no steps warns nothing', () => {
		assert.deepEqual(stepWarnings({ name: 'p' }), []);
	});
});

describe('exitFor — the six states and their codes are a contract', () => {
	test('the codes are the ones the CLI documents', () => {
		assert.deepEqual(EXIT, { PASS: 0, FAIL: 1, USAGE: 2, UNAVAILABLE: 3, NO_FIXTURE: 4, PENDING: 5, VACUOUS: 6 });
	});

	test('each state maps to its code', () => {
		assert.equal(exitFor('PASS'), 0);
		assert.equal(exitFor('FAIL'), 1);
		assert.equal(exitFor('UNAVAILABLE'), 3);
		assert.equal(exitFor('NO-FIXTURE'), 4);
		assert.equal(exitFor('PENDING'), 5);
		assert.equal(exitFor('VACUOUS'), 6);
	});

	// 2 is USAGE and is deliberately NOT reachable from a state: "you typed something that is gone"
	// is decided by the CLI before a proof is ever selected, and every retired verb already answers 2.
	test('USAGE is not a proof state — no state maps to 2', () => {
		for (const s of ['PASS', 'FAIL', 'UNAVAILABLE', 'NO-FIXTURE', 'PENDING', 'VACUOUS']) {
			assert.notEqual(exitFor(s), EXIT.USAGE, s);
		}
	});

	test('an unknown state throws rather than defaulting to a plausible code', () => {
		assert.throws(() => exitFor('nope'), /^Error: unknown proof state "nope" — one of PASS, FAIL, UNAVAILABLE, NO-FIXTURE, PENDING, VACUOUS$/);
	});
});

// ⚠ CARRIED MINOR from Task 2's review, fixed here because Task 3 owns this file: the enum check
// compared with a strict `includes`, while `filter.js` compares with `looseEq` (`String(v) ===
// String(o)`). So on a NUMERIC enum the YAML scalar `5` and the string `'5'` are the same filter at
// run time and were two different things to the validator — a false refusal of a proof that works,
// which is worse than the silent pass it was written to prevent: the author deletes a correct line.
describe('validateProofShape — a numeric enum is compared the way filter.js compares it', () => {
	const numeric = new Map([['gauges', {
		name: 'gauges',
		schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, level: { type: 'number', enum: [5, 10] } } },
	}]]);
	const nctx = { descriptors: numeric, declaredVars: [], moduleEnv: new Set(), artifacts: new Set(['skills/a']) };
	const proof = (where) => ({
		name: 'l', about: ['skills/a'], kind: 'live', mode: 'readonly',
		given: { collection: 'gauges', where, pick: 'a-gauge' },
		steps: [{ run: 'true' }],
		expect: [{ collection: 'gauges', where: {}, count: { _gte: 1 } }],
	});

	test('a string literal against a numeric enum member is accepted', () => {
		assert.deepEqual(validateProofShape(proof({ level: { _eq: '5' } }), nctx), []);
	});

	test('the number itself is accepted', () => {
		assert.deepEqual(validateProofShape(proof({ level: { _eq: 5 } }), nctx), []);
	});

	test('_in over a comma string of numeric members is accepted', () => {
		assert.deepEqual(validateProofShape(proof({ level: { _in: '5,10' } }), nctx), []);
	});

	test('a value outside the enum is still refused, listing the options', () => {
		assert.deepEqual(validateProofShape(proof({ level: { _eq: 7 } }), nctx), ['where "level" compares "7", which is not one of level\'s options [5, 10]']);
	});
});
