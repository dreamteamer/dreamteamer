// `dt prove` — a proof declares behaviour the ENGINE judges, the way a command-binding declares
// gates the engine evaluates. This module owns two things at this point in the slice: the closed
// vocabulary of a proof source, and the ONE enumeration of the artifacts a proof may be about.
//
// WHY VALIDATION LIVES HERE AND IS CALLED BY COMPILE. A proof is uniquely expensive to get wrong,
// because both directions of the mistake are silent. `about: skills/greter` names nothing, so the
// proof proves nothing and reports success. `where: { statuz: { _eq: open } }` narrows to zero rows
// (a non-operator/unknown key fails CLOSED in `filter.js`, by design), so a `count: { _eq: 0 }`
// expectation passes forever and a `_gte: 1` one fails forever — in both cases for a reason no
// output names. So compile refuses a proof it cannot interpret, on exactly the rule the ui-view and
// command-binding filter blocks already follow: the engine validates a value iff the engine
// INTERPRETS it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from './yaml.js';
import { atomicWrite, Store } from './store.js';
import { matchesFilter, unknownOperators, looseEq } from './filter.js';
import { sortRows } from './temporal.js';
import { parseEnvValues, envContext, renderTemplate } from './env-vars.js';
import { parseRef } from './namespace.js';
import { refTargetsOf } from './ref.js';
import { recordResolver } from './record-commands.js';
import { RUNTIME_DIR, runtimeDir, readManifest, engineVersion, loadDescriptors } from './runtime.js';
import { createWorktree, removeWorktree } from './checkout.js';
import { check } from './check.js';

export const PROOF_KINDS = ['gate', 'live'];
export const PROOF_MODES = ['readonly', 'writes'];

/**
 * The verdict of a proof, as a process exit code — a CONTRACT, because the point of `dt prove` is
 * that a script can branch on it without parsing prose.
 *
 * `USAGE` is here for completeness and is deliberately NOT reachable from any proof STATE: "you
 * typed something that is gone" is decided before a proof is selected, and every retired verb
 * already answers 2. `exitFor` is the state → code map.
 */
export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, UNAVAILABLE: 3, NO_FIXTURE: 4, PENDING: 5, VACUOUS: 6 };

/** How many rows one proof's ledger keeps. Per proof, per machine — a ledger answers "what happened
 *  recently", and an unbounded one is a file nobody ever reads the end of. */
export const LEDGER_CAP = 50;

/**
 * ⚠ THE DOT IS LOAD-BEARING, and it is the design bug the spike found. `.dreamteamer/proofs/` is a
 * KIND folder now, and compile wipes every kind folder on every run (`compile.js`, the `rmSync` loop
 * over `[...KINDS, ...DERIVED_KINDS]`) — so a ledger written there is destroyed by the next compile,
 * silently, with no error. A dot-prefixed sibling is UNNAMEABLE by that loop (it matches bare KINDS
 * entries) and invisible to every source enumeration (they all skip dotfiles), and it is already
 * gitignored, because `.dreamteamer/` is the first block of the ignore file `init` writes.
 *
 * The accepted cost, stated rather than discovered: `rm -rf .dreamteamer && dt compile` — the folk
 * recovery for a stale runtime — takes the ledger with it. No engine code does that, and the
 * consequence is RE-PROVING, not data loss: the ledger is per-machine evidence, and what a proof
 * asserts lives in the committed source.
 */
export const LEDGER_DIR = '.proofs';

/**
 * EVERY artifact reference this workspace compiles, per kind — `skills/<id>`, `commands/<id>`,
 * `command-bindings/<id>` and `<module-id>/bin/<file>`.
 *
 * ⚠ ONE function, three callers, on purpose: compile resolves `about` against it, the coverage line
 * takes its denominators from it, and `prove --missing` lists what it holds that no proof names.
 * Three copies of "what counts as an artifact" is three answers to "is this covered".
 *
 * `source` is either what compile has at hand mid-run — the `entries` Map (or an object carrying
 * one) — or a Store, which is what a CLI-time caller has. The two agree by construction: a Store
 * reads the same staged bytes compile wrote, and a module record carries the same `bin` list
 * compile projected onto it.
 *
 * @param {Map|{entries: Map}|import('./store.js').Store} source
 * @returns {{skills: string[], commands: string[], bindings: string[], scripts: string[], all: Set<string>}}
 */
export function artifactRefs(source) {
	const entries = source instanceof Map ? source : source?.entries instanceof Map ? source.entries : null;
	if (entries) return finish(fromEntries(entries));
	if (source && typeof source.readAll === 'function') return finish(fromStore(source));
	throw new Error('artifactRefs needs compile entries (a Map) or a Store');
}

const blank = () => ({ skills: [], commands: [], bindings: [], scripts: [] });

function finish(out) {
	for (const k of Object.keys(out)) out[k].sort();
	out.all = new Set([...out.skills, ...out.commands, ...out.bindings, ...out.scripts]);
	return out;
}

/** From compile's `entries` — runtime path → {sources, bytes}. */
function fromEntries(entries) {
	const out = blank();
	for (const [rt, e] of entries) {
		let m;
		// ⚠ `skills/<id>/SKILL.md` ONLY. A skill is a FOLDER and its `references/*.md` are entries
		// too, so a naive `skills/` prefix count reported twelve skills for the one the engine ships.
		if ((m = /^skills\/([^/]+)\/SKILL\.md$/.exec(rt))) out.skills.push(`skills/${m[1]}`);
		else if ((m = /^commands\/(.+)\.command\.md$/.exec(rt))) out.commands.push(`commands/${m[1]}`);
		else if ((m = /^command-bindings\/(.+)\.command-binding\.yaml$/.exec(rt))) out.bindings.push(`command-bindings/${m[1]}`);
		else if ((m = /^modules\/(.+)\.module\.yaml$/.exec(rt))) {
			let d = {};
			try { d = load(e.bytes.toString('utf8')) ?? {}; } catch { /* unparseable projection: no scripts */ }
			for (const f of d.bin ?? []) out.scripts.push(`${m[1]}/${f}`);
		}
	}
	return out;
}

/** From a Store — the same four collections, read out of the compiled runtime. */
function fromStore(store) {
	const out = blank();
	const has = (c) => store.descriptors?.has?.(c);
	for (const [collection, sink, prefix] of [['skills', out.skills, 'skills/'], ['commands', out.commands, 'commands/'], ['command-bindings', out.bindings, 'command-bindings/']]) {
		if (!has(collection)) continue;
		for (const { id } of store.readAll(collection)) sink.push(`${prefix}${id}`);
	}
	if (has('modules')) {
		for (const { id, fields } of store.readAll('modules')) {
			for (const f of fields?.bin ?? []) out.scripts.push(`${id}/${f}`);
		}
	}
	return out;
}

/** The proof file an artifact's proof would be written to, given the module root that ships it —
 *  what the nudge names, so the reader never has to derive a path from a rule. */
export function proofPathFor(artifactRef, moduleRoot) {
	const id = path.basename(artifactRef).replace(/\.[^.]+$/, '');
	// `.` is the ROOT layout's module root (a workspace with no `workspace-module`): its sources sit
	// at the workspace root, so the path a reader types has no prefix at all — `./proofs/x` would be
	// a path they have to mentally normalize before using it.
	return moduleRoot && moduleRoot !== '.' ? `${moduleRoot}/proofs/${id}.proof.yaml` : `proofs/${id}.proof.yaml`;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────

/** Filter operators whose OPERAND is a literal value of the field, and so can be checked against a
 *  closed enum. `_contains`/`_starts_with` take a fragment, not a value; `_null`/`_empty` take a
 *  boolean; a range operator on an enum field is meaningless but not a typo. */
const ENUM_CHECKED = new Set(['_eq', '_neq', '_in', '_nin']);

/** `count`'s OWN operator set, and the reason it needs one: `_delta` exists on no filter (it is
 *  after-minus-before, which only a proof has two sides of), and the ordering operators that DO
 *  overlap are a strict subset of the filter set — `_contains` on a record count is nonsense. So
 *  neither `KNOWN_OPERATORS` nor `unknownOperators` can judge a count map: run through the filter
 *  walker, `_delta` reads as a typo and `_gtee` reads as fine, which is exactly backwards. */
const COUNT_OPERATORS = ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_delta'];

/** The literal values an operator's operand stands for. ⚠ `_in`/`_nin` accept a COMMA STRING —
 *  `filter.js`'s `toArray` (:100) splits a non-array operand — so `_in: 'open,done'` is a legal
 *  two-value filter, and reading it as one literal reported a false enum violation. Every other
 *  operator takes its operand whole: a comma in an `_eq` is part of the value. */
function literalsFor(op, operand) {
	if (op !== '_in' && op !== '_nin') return [operand];
	return Array.isArray(operand) ? operand : String(operand).split(',').map((x) => x.trim());
}

/**
 * Every way a proof can be wrong, as printable lines — empty means valid.
 *
 * Called by compile (which prefixes each line with the proof's runtime path and fails) and unit-
 * tested in isolation. Deliberately ORDERED and short-circuiting: one mistake produces ONE error,
 * because six errors for one typo sends the reader to the wrong line.
 *
 * @param {object} proof                     the parsed proof source
 * @param {object} ctx
 * @param {Map} ctx.descriptors              collection name → merged descriptor
 * @param {string[]} ctx.declaredVars        the workspace's `dreamteamer.vars`
 * @param {Set<string>} ctx.moduleEnv        every key any module declares in `dreamteamer.env`
 * @param {Set<string>} ctx.artifacts        `artifactRefs(...).all`
 * @returns {string[]}
 */
export function validateProofShape(proof, ctx) {
	const errors = [];
	const p = proof ?? {};
	const descriptors = ctx?.descriptors ?? new Map();
	const artifacts = ctx?.artifacts ?? new Set();

	// ---- about: what this proof is FOR. Unresolvable = a proof about nothing.
	const about = Array.isArray(p.about) ? p.about : [];
	if (!about.length) errors.push('about is required and names at least one artifact');
	for (const ref of about) {
		if (!artifacts.has(String(ref))) {
			errors.push(`about "${ref}" names no artifact — an artifact is skills/<id>, commands/<id>, command-bindings/<id>, or <module>/bin/<file>`);
		}
	}

	// ---- kind, and the two shapes it selects. An unknown kind stops here: judging a proof against
	// the wrong shape's rules produces errors about keys the author never meant to write.
	const kind = p.kind;
	if (!PROOF_KINDS.includes(kind)) {
		errors.push('kind must be gate or live');
		pushTimeout(errors, p);
		return errors;
	}
	const steps = Array.isArray(p.steps) ? p.steps : [];
	if (kind === 'gate') {
		// A gate is a static check: it RUNS things and reads their exit codes. No record to pick, no
		// post-state to judge, and no `perform` — a step that asks a human is not a gate.
		if (p.given !== undefined || p.expect !== undefined || !steps.length || steps.some((s) => !s || s.run === undefined)) {
			errors.push('a gate proof has run steps only and no given or expect');
		}
		// R12 — the descriptor already says `mode` is forbidden on a gate, and nothing enforced it. A
		// gate reads and writes no workspace state, so `mode` there is a key the engine ignores and
		// its author believes something untrue about what will run.
		if (p.mode !== undefined) errors.push('a gate proof takes no mode');
	} else {
		if (!PROOF_MODES.includes(p.mode)) errors.push('a live proof declares mode: readonly | writes');
		const expect = Array.isArray(p.expect) ? p.expect : [];
		if (!steps.length || !expect.length) errors.push('a live proof needs at least one step and one expectation');
		errors.push(...givenErrors(p.given, descriptors));
		errors.push(...expectErrors(expect, p.given, descriptors));
	}

	// ---- requires.env: a key nothing declares is a proof that reports UNAVAILABLE forever.
	for (const name of p.requires?.env ?? []) {
		if ((ctx?.declaredVars ?? []).includes(String(name)) || ctx?.moduleEnv?.has?.(String(name))) continue;
		errors.push(`requires.env "${name}" is not declared — add it to dreamteamer.vars or a module's dreamteamer.env`);
	}

	// ---- unknown filter operators, from every `where` in the proof at once. ONE line, sorted,
	// reusing `filter.js`'s own walker so the engine can never disagree with itself about which
	// operators exist. `count:` is deliberately NOT walked — `_delta` is a proof operator, not a
	// filter one, and this walker would report it as a typo.
	const badOps = new Set();
	for (const where of everyWhere(p)) for (const op of unknownOperators(where)) badOps.add(op);
	if (badOps.size) errors.push(`unknown filter operator(s) ${[...badOps].sort().join(', ')}`);

	pushTimeout(errors, p);
	return errors;
}

function pushTimeout(errors, p) {
	if (p.timeout === undefined) return;
	if (!Number.isInteger(p.timeout) || p.timeout <= 0) errors.push('timeout must be a positive integer of seconds');
}

/** Every `where` map a proof carries, plus the output matchers, which are filter maps too. */
function everyWhere(p) {
	const out = [];
	if (p.given?.where && typeof p.given.where === 'object') out.push(p.given.where);
	for (const e of Array.isArray(p.expect) ? p.expect : []) {
		if (e?.where && typeof e.where === 'object') out.push(e.where);
		if (e?.stdout && typeof e.stdout === 'object') out.push(e.stdout);
		for (const cond of Object.values(e?.stdout_json ?? {})) {
			if (cond && typeof cond === 'object') out.push(cond);
		}
	}
	return out;
}

function givenErrors(given, descriptors) {
	if (given === undefined) return []; // a live proof may judge only steps, paths and collection counts
	const errors = [];
	const collection = String(given?.collection ?? '');
	const d = descriptors.get(collection);
	if (!d) return [`given.collection "${collection}" is not a collection`];

	// R8/§13.1: exactly ONE source for the record — a live filter over the workspace, or a checked-in
	// fixture. Both is ambiguous; neither leaves `{record}` unbound.
	const hasWhere = given?.where !== undefined;
	const hasFixture = given?.fixture !== undefined && given.fixture !== false;
	if (hasWhere === hasFixture) errors.push('given needs exactly one of where or fixture');

	// R14 — a fixture folder holds RECORDS; `pick` is what names the one this proof runs against.
	// Without it there is nothing to bind, and the proof would pick arbitrarily.
	if (hasFixture && given?.pick === undefined) errors.push('a fixture needs pick: <id> naming one of its records');

	if (given?.pick === 'any') {
		errors.push('pick: any is not accepted — a proof names its record or uses a fixture');
	} else if (given?.pick === 'latest' && !d.sort_field) {
		// `latest` means "the collection's own `sort_field`, descending" — with no sort_field there is
		// no ordering to take the head of, and the proof would run against an arbitrary record.
		errors.push(`pick: latest needs a sort_field on ${collection} — name the record (pick: <id>) or use a fixture`);
	}

	if (hasWhere && given.where && typeof given.where === 'object') {
		errors.push(...whereErrors(given.where, collection, descriptors));
	}
	return errors;
}

function expectErrors(expect, given, descriptors) {
	const errors = [];
	for (const [i, e] of expect.entries()) {
		const row = e ?? {};
		const hasCount = 'collection' in row && 'where' in row && 'count' in row;
		const hasRecord = 'record' in row && 'where' in row;
		// `step` is OPTIONAL on the output form (it defaults to the last run step), so the form is
		// recognised by what it ASSERTS, never by the presence of the index.
		const hasStep = 'exit' in row || 'stdout' in row || 'stdout_json' in row;
		const hasPath = 'path' in row && 'exists' in row;
		if ('collection' in row && !descriptors.has(String(row.collection))) {
			errors.push(`expect[${i}].collection "${row.collection}" is not a collection`);
		} else if (!hasCount && !hasRecord && !hasStep && !hasPath) {
			errors.push(`expect[${i}] needs one of: collection+where+count · record+where · step+exit/stdout/stdout_json · path+exists`);
		} else if (row.where && typeof row.where === 'object') {
			// a collection-scope where is judged against THAT collection; a `record:` where against the
			// picked record's own collection, which is `given.collection`.
			const scope = hasCount ? String(row.collection) : String(given?.collection ?? '');
			if (descriptors.has(scope)) errors.push(...whereErrors(row.where, scope, descriptors));
		}
		// R14 — `{record}` is bound by `given`. Without one, the substitution has nothing to render
		// and the proof cannot run; refusing at compile beats an unresolved brace at run time.
		if (hasRecord && given === undefined) errors.push('a record expectation needs a given — nothing binds {record}');
		// MINOR 9 — AN EXPECTATION THAT ASSERTS NOTHING IS THE SILENT GREEN, one layer below the
		// vacuous proof. A `record:` entry with an empty `where` produces ZERO verdict lines, so
		// `verdicts.every(ok)` is vacuously true and the proof PASSES having measured nothing at all.
		// ⚠ Scoped to the forms where the `where` IS the assertion: on a collection entry `count:`
		// carries it, and `{collection, where: {}, count: {_delta: 1}}` — "one more record anywhere in
		// this collection" — is a correct and common proof, so refusing it would be a false refusal.
		// ⚠ R26 — A BARE `where:` IN YAML PARSES TO **null**, NOT TO `{}`. The first version of this
		// guard tested `row.where !== null` to keep `Object.keys(null)` from throwing, which let
		// through the one spelling an author is most likely to type. Measured: the proof compiled
		// clean, judged ZERO conditions, and answered `PASS` — the exact silent green this rule exists
		// to close, reached by the shortest possible route.
		// ⚠ THE GUARD TURNS ON THE SHAPE, not on two enumerated wrong values. `where: done` produces
		// zero verdict lines exactly like `where:` and `where: {}` do — `Object.entries('done')` in
		// the judge yields nothing — so it passed having measured nothing, by the third spelling.
		if (hasRecord && (row.where === null || typeof row.where !== 'object' || !Object.keys(row.where).length)) {
			errors.push(`expect[${i}] where must name at least one condition`);
		}
		if ('count' in row) errors.push(...countErrors(row.count, i));
	}
	return errors;
}

/** R11 — a count map's operators and operands. Its own closed set (see COUNT_OPERATORS), and every
 *  operand an INTEGER: a count is a number of records, so `_gte: 'one'` and `_eq: 1.5` are both
 *  filters that can never be satisfied, silently. A bare scalar is the `_eq` it stands for. */
function countErrors(count, index) {
	const errors = [];
	const isMap = count !== null && typeof count === 'object' && !Array.isArray(count);
	// `count: {}` compares nothing, so the expectation holds for EVERY possible count — the same
	// silent green an empty `where` produces, and no reading of it asserts anything.
	if (isMap && !Object.keys(count).length) return [`expect[${index}] count must name one operator`];
	const pairs = isMap
		? Object.entries(count)
		: [['_eq', count]];
	for (const [op, operand] of pairs) {
		if (!COUNT_OPERATORS.includes(op)) { errors.push(`count operator "${op}" is not one of ${COUNT_OPERATORS.join(' ')}`); continue; }
		if (!Number.isInteger(operand)) errors.push(`count "${op}" compares "${operand}", which is not an integer`);
	}
	return errors;
}

/**
 * A `where` checked against the descriptor of the collection it filters — ONE hop deep.
 *
 * ⚠ The trap this exists for (spike §3c): a non-operator key is a one-hop REFERENCE traversal, not
 * a field-vs-field comparison. `{a: {b: …}}` means "resolve `a` as a `<collection>/<id>` ref and
 * test the target's `b`" — and when `a` is not a reference field, `matchesFilter` narrows to false
 * with no warning at all. So a nested key under a non-reference field is refused BY NAME, with what
 * a nested key actually means, rather than left to fail closed at run time.
 */
function whereErrors(where, collection, descriptors, errors = []) {
	const props = descriptors.get(collection)?.schema?.properties ?? {};
	for (const [key, cond] of Object.entries(where)) {
		if (key === '_and' || key === '_or') {
			for (const c of Array.isArray(cond) ? cond : []) {
				if (c && typeof c === 'object') whereErrors(c, collection, descriptors, errors);
			}
			continue;
		}
		if (key.startsWith('_')) continue; // an operator at filter level — `unknownOperators` owns it
		const prop = props[key];
		if (!prop) {
			errors.push(`where names "${key}", which ${collection} has no field for`);
			continue;
		}
		if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
			enumErrors(errors, key, prop, [cond]); // `{status: 'open'}` is shorthand for `_eq`
			continue;
		}
		const nested = Object.keys(cond).filter((k) => !k.startsWith('_'));
		for (const [op, operand] of Object.entries(cond)) {
			if (ENUM_CHECKED.has(op)) enumErrors(errors, key, prop, literalsFor(op, operand));
		}
		if (!nested.length) continue;
		const targets = refTargetsOf(prop);
		if (!targets) {
			errors.push(`where "${key}" is not a reference field — a nested key hops a reference, it does not compare two fields`);
			continue;
		}
		// ⚠ ONE HOP, AND A SECOND IS REFUSED. `matchesFilter` resolves ONE reference and evaluates the
		// sub-condition against the target record; a THIRD level is treated as another ref traversal,
		// on a value that is by then an ordinary field — so it narrows to false with no warning at
		// all. That is the silent-zero-rows failure this whole validator exists to close, so the
		// refusal is by name and cites the dotted path. (A proof that genuinely needs two hops writes
		// its `expect` against the far collection instead.)
		for (const hop of nested) {
			const sub = cond[hop];
			if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) continue;
			for (const deep of Object.keys(sub).filter((k) => !k.startsWith('_'))) {
				errors.push(`where hops more than one reference (${key}.${hop}.${deep}) — a proof filter hops at most one`);
			}
		}
		// When the reference targets a LIST of collections or '*', any field name is accepted: the
		// value decides which target it resolves to, and that is a run-time fact.
		if (targets === '*' || targets.length !== 1) continue;
		const [target] = targets;
		const targetProps = descriptors.get(target)?.schema?.properties;
		if (!targetProps) continue; // an uninstalled peer target — `check` owns that, not this
		for (const hop of nested) {
			const hopProp = targetProps[hop];
			if (!hopProp) { errors.push(`where names "${hop}", which ${target} has no field for`); continue; }
			const sub = cond[hop];
			if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) { enumErrors(errors, hop, hopProp, [sub]); continue; }
			for (const [op, operand] of Object.entries(sub)) {
				if (ENUM_CHECKED.has(op)) enumErrors(errors, hop, hopProp, literalsFor(op, operand));
			}
		}
	}
	return errors;
}

/** §13.2 — a literal compared against a CLOSED enum must be one of its values. A typo here is the
 *  purest form of the silent failure: the filter is well-formed, the operator is known, and the
 *  result is zero rows forever. */
function enumErrors(errors, field, prop, values) {
	const options = prop?.enum ?? prop?.items?.enum;
	if (!Array.isArray(options) || !options.length) return;
	// ⚠ `looseEq`, NOT `includes`. filter.js compares an operand to a field value with
	// `String(v) === String(o)`, so on a numeric enum the YAML scalar `5` and the string `'5'` are
	// ONE filter at run time — and a strict `includes` here refused a proof that works. A false
	// refusal is worse than the silent pass this check exists to prevent: the author deletes a
	// correct line to make compile go green. The option plays the record-value role, as at run time.
	for (const v of values) {
		if (v == null || options.some((o) => looseEq(o, v))) continue;
		errors.push(`where "${field}" compares "${v}", which is not one of ${field}'s options [${options.join(', ')}]`);
	}
}

// ── the pure core ───────────────────────────────────────────────────────────────────────────────
//
// Four functions with no fs, no store and no subprocess between them: substitution, the ledger's
// cap, the printable verdict, and the state → exit-code map. They are separable from the runner
// because each one is a place a proof can be MISREAD, and a misread proof reports a verdict about
// something other than what its author wrote.

/**
 * Render a proof's `{record}` and `{record.<field>}` braces against the picked record.
 *
 * ⚠ IT RENDERS ONLY WHAT IT OWNS, AND PASSES EVERYTHING ELSE THROUGH (R17). A step is a SHELL
 * STRING, and the shell owns braces too: refusing every unrecognised `{…}` was measured to kill
 * `awk '{print $1}'`, `sed -n '1,3{p}'`, `jq '{a: .b}'` and `mkdir -p x/{a,b}` — four correct steps,
 * for a check whose whole purpose was to catch a typo. A net that refuses correct proofs teaches the
 * author to delete correct lines, which is strictly worse than the typo. So the net moved to compile
 * time and became advisory: `stepWarnings` names an identifier-shaped brace nobody substitutes, and
 * compile prints it as a warning.
 *
 * `${…}` is untouched for the same reason it always was — that bracket belongs to the resolver
 * (`${env:FILES_FOLDER}` in a `path:` expectation) and to the shell (`${HOME}` in a `run:` step).
 *
 * What still THROWS is the one case where passing through would be silently wrong: `{record.<f>}`
 * naming a field the picked record does not carry would otherwise reach the shell as the string
 * "undefined", and `{record}` with no record bound has nothing to be.
 *
 * ⚠ STRICT MODE IS FOR THE VALUES THE ENGINE CONSUMES, NOT THE SHELL — a `path:` expectation and a
 * `record:` selector. The pass-through above is right for a `run:` string precisely because the
 * shell owns braces too; it is exactly wrong for a path, where nothing downstream would ever notice
 * the typo: `path: "{recrod}/out.txt"` becomes a literal directory that does not exist, and the
 * expectation answers `exists false` — a FAIL naming the wrong cause. So those two call sites pass
 * `{ strict: true }` and an identifier-shaped brace nobody substitutes THROWS. The token test is the
 * same `BRACE_TOKEN` the warning net uses, `$`-exemption included: `${env:FILES_FOLDER}` is the
 * resolver's, and a `path:` expectation naming a machine-dependent folder is the form's whole point.
 *
 * @param {string} text
 * @param {{record?: {ref: string, fields: object}}} ctx
 * @param {{strict?: boolean}} [options]
 */
export function substitute(text, ctx, options) {
	if (typeof text !== 'string') return text;
	if (options?.strict) {
		for (const [, dollar, token] of text.matchAll(BRACE_TOKEN)) {
			if (dollar || token === 'record' || token.startsWith('record.')) continue;
			throw new Error(`unknown substitution "{${token}}" in a path — a proof may use {record} and {record.<field>}`);
		}
	}
	return text.replace(/(\$?)\{(record(?:\.([^{}]*))?)\}/g, (whole, dollar, name, field) => {
		if (dollar) return whole;
		const rec = ctx?.record;
		if (!rec) throw new Error(`{${name}} has nothing to bind to — this proof declares no given`);
		if (field === undefined) return String(rec.ref);
		const value = rec.fields?.[field];
		if (value === undefined) throw new Error(`{${name}} — ${rec.ref} has no field "${field}"`);
		return String(value);
	});
}

/** An identifier-shaped brace token: what a static reader can tell apart from shell syntax. `{print}`
 *  matches and `{print $1}` does not, which is the asymmetry that makes the net affordable. */
const BRACE_TOKEN = /(\$?)\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/**
 * Every brace in this proof's steps that NOTHING substitutes — one advisory string per token, for
 * compile to print. Empty means nothing suspicious.
 *
 * ⚠ A WARNING, NEVER AN ERROR, and that is the whole design (R17). The token it flags may be
 * perfectly intentional shell — `awk '{print}'` is the worked example — so the cost of a false
 * positive has to be one line of output rather than a refused proof. And the net can only judge
 * SHAPE: a `$`-prefixed brace is exempt (the resolver's and the shell's), and a token with a space
 * in it is invisible here, which is why the commonest awk one-liner is never flagged.
 */
export function stepWarnings(proof) {
	const out = [];
	for (const [i, step] of (Array.isArray(proof?.steps) ? proof.steps : []).entries()) {
		for (const text of [step?.run, step?.perform]) {
			if (typeof text !== 'string') continue;
			for (const [, dollar, token] of text.matchAll(BRACE_TOKEN)) {
				if (dollar || token === 'record' || token.startsWith('record.')) continue;
				out.push(`step ${i + 1} uses "{${token}}" — only {record} and {record.<field>} are substituted; the rest reaches the shell as written`);
			}
		}
	}
	return out;
}

/**
 * `rows` plus `row`, trimmed to the LAST `cap` entries — a new array, never a mutation.
 *
 * The oldest row is the one that leaves. A ledger is read for what happened recently, so trimming
 * from the other end would make the cap delete exactly the rows anyone wants.
 *
 * ⚠ THE `cap <= 0` GUARD IS NOT DEFENSIVE, IT IS ARITHMETIC. `slice(-0)` is `slice(0)` — the whole
 * array — so a cap of zero silently kept EVERYTHING, which is the opposite of what the number says.
 */
export function applyCap(rows, row, cap = LEDGER_CAP) {
	return cap <= 0 ? [] : [...rows, row].slice(-cap);
}

/** The closed glyph set (R6). An operator with no glyph prints its own NAME: the filter operator set
 *  is open enough (`_regex`, `_starts_with`, `_between`) that a glyph per member would be a second
 *  vocabulary to keep in sync with filter.js, and a symbol nobody can look up is worse than a name. */
const GLYPH = {
	_eq: '=', _neq: '≠', _gte: '≥', _gt: '>', _lte: '≤', _lt: '<',
	_in: '∈', _nin: '∉', _nempty: 'nonempty', _empty: 'empty', _contains: 'contains',
};

/** A count is a NUMBER OF RECORDS and a delta is a DIFFERENCE between two of them; `count 1 = 1`
 *  and `count +1 = +1` say different things, and only the second says which number is a difference. */
const signed = (n) => (Number(n) >= 0 ? `+${Number(n)}` : String(Number(n)));

/** The ACTUAL value: bare when it is a number, JSON-quoted otherwise — a string is where a trailing
 *  space or an empty value hides, and `status  = done` names neither. */
function shown(v) {
	if (typeof v === 'number') return String(v);
	const json = JSON.stringify(v);
	return json === undefined ? String(v) : json; // `undefined` has no JSON form
}

/** The WANTED value, bare: an array renders as the list a reader would type back, and a nested
 *  CONDITION as its JSON. A one-hop reference expectation (`owner: { name: { _eq: Ada } }`) has an
 *  object where every other operator has a scalar, and `String({})` printed `[object Object]` —
 *  a verdict line naming nothing at all. */
const wanted = (v) => {
	if (Array.isArray(v)) return `[${v.join(', ')}]`;
	return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
};

/**
 * One printable line for one expectation — `count 1 ≥ 1 ✔` · `status "open" ∈ [done] ✖`.
 *
 * ⚠ THE ACTUAL VALUE SITS BESIDE THE WANTED ONE, ALWAYS. A line that printed only what was wanted
 * ("expected status done ✖") sends the reader to re-run the proof by hand to learn what it actually
 * was — which is the whole cost `prove` exists to remove.
 *
 * `expectation` is a ONE-ENTRY `{ <field>: <condition> }` map: for a collection count that field is
 * literally `count`, and for a `record:` expectation it is the field the `where` names. A bare
 * operator map (`{ _delta: 1 }`) is a count condition, because that is the only place one appears.
 *
 * ⚠ MORE THAN ONE ENTRY THROWS (R18). A raw `expect` entry carries `collection`, `where` and `count`
 * together, and handed here whole it rendered the FIRST key — `collection 1 = notes ✖`, a verdict
 * line about the wrong thing, marked failed, for a proof that passed. The caller narrows the entry
 * to the one condition being judged; a throw is what makes forgetting visible.
 *
 * The mark comes from `matchesFilter` itself, so the judgement and the rendering can never disagree
 * about whether the line passed. `_delta` is the exception: no filter has it, so it is compared here.
 *
 * ⚠ `resolve` IS NOT OPTIONAL IN PRACTICE, and leaving it out was a wrong verdict rather than a
 * missing feature. A non-operator key under a field is a ONE-HOP REFERENCE traversal, and
 * `matchesFilter` NARROWS with no resolver wired — so `record: '{record}', where: { owner: { name:
 * { _eq: Ada } } }` read ✖ forever, for a proof that held. The collection form always passed
 * `recordResolver(store)`; the record form now does too.
 */
export function verdictLine(expectation, actual, resolve) {
	const entries = Object.entries(expectation ?? {});
	const bare = entries.length > 0 && entries.every(([k]) => k.startsWith('_'));
	if (!bare && entries.length !== 1) throw new Error(`verdictLine takes ONE expectation entry — got ${entries.length ? `keys ${entries.map(([k]) => k).join(', ')}` : 'none'}`);
	const [field, cond] = bare ? ['count', expectation] : entries[0];
	const ops = cond !== null && typeof cond === 'object' && !Array.isArray(cond) ? cond : { _eq: cond };
	const pass = '_delta' in ops ? Number(actual) === Number(ops._delta) : matchesFilter({ [field]: actual }, { [field]: ops }, resolve ?? null);
	const mark = pass ? '✔' : '✖';
	if ('_delta' in ops) return `${field} ${signed(actual)} = ${signed(ops._delta)} ${mark}`;
	const want = Object.entries(ops).map(([op, o]) => `${GLYPH[op] ?? op} ${wanted(o)}`).join(' and ');
	return `${field} ${shown(actual)} ${want} ${mark}`;
}

/** State → exit code. Six states, six codes, and an unknown one THROWS rather than defaulting to a
 *  plausible number — a wrong exit code is a lie a script cannot see through. */
export function exitFor(state) {
	const code = { PASS: EXIT.PASS, FAIL: EXIT.FAIL, UNAVAILABLE: EXIT.UNAVAILABLE, 'NO-FIXTURE': EXIT.NO_FIXTURE, PENDING: EXIT.PENDING, VACUOUS: EXIT.VACUOUS }[state];
	if (code === undefined) throw new Error(`unknown proof state "${state}" — one of PASS, FAIL, UNAVAILABLE, NO-FIXTURE, PENDING, VACUOUS`);
	return code;
}

// ── store-bound: counting, picking, and what a proof needs from the machine ─────────────────────

/**
 * How many records of `collection` a filter keeps — `readAll` + `matchesFilter`, the pattern every
 * existing caller uses (there is no `store.count`, and one directory walk with lazy parsing is what
 * `list` does). The row handed to the filter is `{ ...fields, id }`, exactly as `list` builds it, so
 * `{ id: { _eq: 'a' } }` is a filter a proof may write.
 *
 * ⚠ A `_delta` AFTER-COUNT NEEDS A FRESH `Store`. `readAll` walks `ids()`, which is memoized on
 * (git HEAD, collection dir mtime) with a documented gap — a deep direct edit that adds a record
 * without moving either can serve one stale read. A proof's steps run shell commands that write
 * records and do NOT commit (`auto-commit` is off), so the same Store instance can answer the
 * after-count off the index it built before the steps ran, and the delta reads as 0 with nothing
 * wrong anywhere. The RUNNER constructs a new Store for the after-pass; this function cannot know
 * which side of the steps it is on.
 *
 * `resolve` is the caller's — `recordResolver(store)` when the filter hops a reference, `null` when
 * it does not. A hop with no resolver NARROWS, which is filter.js's documented fail-closed posture.
 */
export function countMatching(store, collection, where, resolve) {
	let n = 0;
	for (const { id, fields } of store.readAll(collection)) {
		if (where && !matchesFilter({ ...fields, id }, where, resolve)) continue;
		n++;
	}
	return n;
}

/**
 * The ONE record a live proof runs against — `{ ref, fields }`, or null when there is none.
 *
 * `null` is a first-class answer, not an error: a `given` that matches nothing is NO-FIXTURE
 * (exit 4), which says the proof did not run rather than that the artifact is broken.
 *
 * `pick: latest` is the head of the matching rows ordered by the collection's own `sort_field`,
 * DESCENDING, through the same `sortRows` every `?sort=` and `--sort` goes through — so a date-time
 * orders by INSTANT across mixed offsets rather than by string. `pick: <id>` reads that id and
 * returns null when it is absent or does not match the `where`.
 *
 * A fixture-backed `given` needs nothing special here: the runner hands this function the SANDBOX's
 * store, where the fixture's records are the collection, and `pick: <id>` names one of them.
 *
 * `override` is `--record <collection>/<id>`, and it REPLACES the selection rather than filtering
 * through it: an operator naming a record is saying which one to use, and re-testing it against the
 * `where` would answer NO-FIXTURE for the record they just typed.
 */
export function pickFixture(store, given, override) {
	const collection = String(given?.collection ?? '');
	if (override) {
		const parsed = parseRef(String(override), store.namespaces);
		if (!parsed) throw new Error(`--record takes a <collection>/<id> reference and got "${override}"`);
		if (collection && parsed.collection !== collection) throw new Error(`--record ${override} is not a record of ${collection}, which is what this proof's given picks from`);
		return readOne(store, parsed.collection, parsed.id);
	}
	const where = given?.where && typeof given.where === 'object' ? given.where : null;
	const resolve = where ? recordResolver(store) : null;
	if (given?.pick !== 'latest') {
		const picked = readOne(store, collection, String(given?.pick ?? ''));
		if (!picked || !where) return picked;
		return matchesFilter(picked.fields, where, resolve) ? picked : null;
	}
	const field = store.descriptor(collection).sort_field;
	// compile refuses `pick: latest` on a collection with no sort_field; a runtime compiled by an
	// older engine could still carry one, and picking an arbitrary record is the failure to avoid.
	if (!field) throw new Error(`pick: latest needs a sort_field on ${collection} — name the record (pick: <id>) or use a fixture`);
	const rows = [];
	for (const { id, fields } of store.readAll(collection)) {
		const row = { ...fields, id };
		if (!where || matchesFilter(row, where, resolve)) rows.push(row);
	}
	sortRows(rows, `-${field}`);
	return rows.length ? { ref: `${collection}/${rows[0].id}`, fields: rows[0] } : null;
}

/** One record as `{ ref, fields }`, or null when it is not there. The id travels IN the fields, the
 *  same row shape the filter sees, so `{record.id}` and a filter on `id` cannot disagree. */
function readOne(store, collection, id) {
	try {
		const { fields } = store.read(collection, id);
		return { ref: `${collection}/${id}`, fields: { ...fields, id } };
	} catch (e) {
		// ⚠ ONLY "no such record" IS NO-FIXTURE. A bare catch here swallowed `unknown collection`
		// too, so a proof whose `given` names a collection this workspace does not have reported
		// exit 4 — "the proof did not run" — instead of the error naming the typo. A parse failure
		// on the record's own file is the same class: a real error, and it must reach the operator.
		if (!String(e?.message ?? '').endsWith(': no such record')) throw e;
		return null;
	}
}

/**
 * What this proof needs from THIS machine — `{ ok, missing: [{ kind, name, fix }] }`.
 *
 * ⚠ NO ENV VALUE IS EVER READ, COMPARED OR PRINTED. `.env` is desktop-only and its values are
 * credentials; the question is whether the machine has the key CONFIGURED, which the key name
 * answers. `parseEnvValues` is used for its names only, and an empty value counts as declared —
 * judging a value would mean holding one.
 *
 * `bin` walks `PATH` with `accessSync(X_OK)` rather than shelling out to `command -v`: a proof's
 * requirement check must not itself run a shell.
 */
export function resolveRequires(ws, requires) {
	const missing = [];
	const names = envKeys(ws.root);
	for (const name of requires?.env ?? []) {
		if (process.env[String(name)] !== undefined || names.has(String(name))) continue;
		missing.push({ kind: 'env', name: String(name), fix: `${name} is not set — add it to .env` });
	}
	for (const name of requires?.bin ?? []) {
		if (onPath(String(name))) continue;
		missing.push({ kind: 'bin', name: String(name), fix: `${name} is not on PATH` });
	}
	return { ok: !missing.length, missing };
}

/** The KEY NAMES this machine's `.env` declares. Absent file → no names, which is the ordinary state
 *  in a cloud session and not an error. */
function envKeys(root) {
	try { return new Set(parseEnvValues(fs.readFileSync(path.join(root, '.env'), 'utf8')).keys()); }
	catch { return new Set(); }
}

/** ⚠ `accessSync(X_OK)` ALONE IS NOT ENOUGH: on a DIRECTORY the execute bit means "searchable", so a
 *  folder named `ffmpeg` anywhere on PATH satisfied `requires: { bin: [ffmpeg] }` and the proof then
 *  died at the step with a shell error instead of reporting UNAVAILABLE with a fix. `statSync`
 *  follows symlinks, which is what most real binaries on PATH are. */
function onPath(name) {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue;
		const file = path.join(dir, name);
		try {
			fs.accessSync(file, fs.constants.X_OK);
			if (fs.statSync(file).isFile()) return true;
		} catch { /* next dir */ }
	}
	return false;
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────
//
// One append-only JSONL file per proof, capped, per machine, gitignored. It answers "when did this
// last pass, on this machine, and against which record" — and it is what makes a `perform` step
// resumable: the PENDING row is where the run stopped.

/** `<root>/.dreamteamer/.proofs/<proof-id>.jsonl` — see LEDGER_DIR for why the dot is load-bearing. */
export function ledgerPath(root, proofId) {
	return path.join(runtimeDir(root), LEDGER_DIR, `${proofId}.jsonl`);
}

/**
 * Every row of one proof's ledger, oldest first. A missing file is `[]`, not an error — a proof that
 * has never run has no history, which is a fact and not a failure.
 *
 * ⚠ A MALFORMED LINE IS SKIPPED WITH A WARNING, never thrown on. This file is per-machine state
 * under a build directory: a killed run or a hand edit can leave a partial line, and refusing to
 * read the ledger would make `prove` unrunnable until someone deleted evidence to get it working.
 * The next `appendLedger` rewrites the file, so the bad line is repaired rather than accumulating.
 */
export function readLedger(root, proofId) {
	let text;
	try { text = fs.readFileSync(ledgerPath(root, proofId), 'utf8'); } catch { return []; }
	const rows = [];
	for (const [i, line] of text.split('\n').entries()) {
		if (!line.trim()) continue;
		try { rows.push(JSON.parse(line)); }
		catch { console.warn(`⚠ ${path.join(RUNTIME_DIR, LEDGER_DIR, `${proofId}.jsonl`)}:${i + 1} is not a JSON row — skipped`); }
	}
	return rows;
}

/** Append one row, capped at the last LEDGER_CAP. A rewrite rather than an `appendFileSync` because
 *  the cap has to drop the oldest row, and the rewrite is what repairs a malformed line.
 *
 *  Through `atomicWrite`, the one writer every record write already goes through: a proof's steps run
 *  arbitrary commands, so a run can be killed mid-write, and a half-written ledger line is exactly
 *  the malformed row `readLedger` has to warn about. Write-to-temp + rename means the file on disk is
 *  always a whole ledger. */
export function appendLedger(root, proofId, row) {
	const file = ledgerPath(root, proofId);
	const rows = applyCap(readLedger(root, proofId), row);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	atomicWrite(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	return rows;
}

/**
 * The PENDING row this proof stopped on for `record` (null for a gate, which pends against no
 * record), or null.
 *
 * ⚠ SUPERSEDING IS WHAT MAKES A RESUME SAFE: only the LAST row for that record counts. Once the
 * same record has a later verdict the earlier PENDING is history, and re-offering it would ask the
 * operator to perform a step they already performed.
 */
export function pendingFor(root, proofId, record) {
	const want = record ?? null;
	const rows = readLedger(root, proofId).filter((r) => (r?.record ?? null) === want);
	const last = rows[rows.length - 1];
	return last?.verdict === 'PENDING' ? last : null;
}

// ── the runner ──────────────────────────────────────────────────────────────────────────────────
//
// ONE verb, six terminal states, and a resume protocol for the one step a machine cannot take.
//
// THE SHAPE, and why it is a straight line rather than a pipeline. Every state below is TERMINAL:
// the run stops there, appends exactly one ledger row, and answers with that state's exit code. So
// the runner reads top to bottom and each guard is the last thing that can happen —
//
//   writes/--keep → resume → pending guard → requires → fixture → snapshot → pre-check
//     → run steps → the first perform → judge
//
// ⚠ AND THE ORDER IS THE CONTRACT, not an implementation detail. Two of these guards exist only
// because they come BEFORE something: the pre-check must run before any step (a proof whose
// expectations already hold reports PASS forever, and the whole point is to catch that before it
// takes an action), and `requires` must run before the fixture (a machine that cannot answer the
// question must never report NO-FIXTURE, which reads as a fact about the workspace's data).
//
// NOTHING HERE CALLS `process.exit`. `proveCommand` returns `{ code }` and `cli.js` exits from it,
// so a proof can be run in-process by a test — which is what makes the exit code assertable at all.

/** Seconds a `run` step may take before it is killed. A number rather than none: a proof's step is
 *  an arbitrary shell command, and an unbounded one hangs a pre-commit hook forever. */
const DEFAULT_TIMEOUT = 120;

/** Flags of `dt prove` that take a VALUE, so the positional scan cannot mistake one for a target —
 *  without this, `dt prove --record notes/b` read `notes/b` as the proof id. */
const VALUE_FLAGS = new Set(['kind', 'record']);

function parseProveArgs(rest) {
	const flags = {};
	const targets = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (!a.startsWith('--')) { targets.push(a); continue; }
		const eq = a.indexOf('=');
		if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
		const name = a.slice(2);
		flags[name] = VALUE_FLAGS.has(name) ? rest[++i] : true;
	}
	return { flags, targets };
}

/**
 * PER-FORM flag refusal, in `install`'s exact words (`cli.js`, the `case 'install':` arm).
 *
 * ⚠ THE VERB-LEVEL ALLOWLIST CANNOT DO THIS. `WORKSPACE_FLAGS.prove` can only say which flags the
 * verb HAS; it cannot know that `--all` is meaningless once a proof is named, and forwarding it
 * silently would run one proof and print a board. Same failure `dt install repos/x --dry-run` had:
 * driven past a flag whose entire meaning is "do nothing".
 *
 * It lives here rather than in `cli.js` because deciding WHICH form was typed means resolving the
 * target against the compiled proofs and artifacts — workspace-layer knowledge. A second copy of
 * that resolution in the surface layer, purely to pick which message to print, is the drift this
 * repo's own comments keep naming.
 */
function refuseStray(rest, form, allowed) {
	const given = [...new Set(rest.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]))];
	const stray = given.filter((f) => !allowed.includes(f));
	if (!stray.length) return;
	throw new Error(`${stray.join(' ')} ${stray.length > 1 ? 'are not flags' : 'is not a flag'} of \`${form}\` — that form takes ${allowed.join(' ')}`);
}

const ONE_FORM = ['--record', '--restart', '--json', '--keep', '--here'];
const MANY_FORM = ['--all', '--kind', '--json', '--external', '--strict'];

/**
 * `dt prove` — the whole verb. Three forms, told apart by what the target NAMES:
 *
 *   `dt prove <proof>`      one proof, the resume protocol, one of six codes
 *   `dt prove <artifact>`   every proof whose `about` names it, board semantics
 *   `dt prove --all`        every proof, board semantics
 *
 * @returns {{code: number}} — NEVER `process.exit`; `cli.js` exits from the code.
 */
export function proveCommand(ws, rest) {
	const { flags, targets } = parseProveArgs(rest);
	const store = new Store(ws);
	const proofs = new Map();
	for (const { id, fields } of store.readAll('proofs')) proofs.set(id, fields);
	const target = targets[0];
	// ⚠ MINOR 6 — AN UNVALIDATED `--kind` IS A SILENT EMPTY BOARD. `--kind gates` (or a bare `--kind`
	// with its value eaten by the next flag) matched no proof, so `--all` answered
	// `proofs: 0 passed · 0 failed · …` at exit 0 — a green run that ran nothing, which is the exact
	// shape of the `--fliter` escape `flags-honoured.test.js` exists for.
	if ('kind' in flags && !PROOF_KINDS.includes(flags.kind)) {
		throw new Error(`--kind takes ${PROOF_KINDS.join(' or ')} — got "${flags.kind}"`);
	}

	if (!target) {
		refuseStray(rest, 'dt prove --all', MANY_FORM);
		if (!flags.all) throw new Error('dt prove needs a proof id, an artifact (skills/<id>, commands/<id>, …), or --all; dt list proofs');
		return proveMany(ws, proofs, flags, () => true);
	}
	if (proofs.has(target)) {
		refuseStray(rest, 'dt prove <proof>', ONE_FORM);
		return proveOne(ws, target, proofs.get(target), flags);
	}
	// the artifact form answers the question a reader of a skill or a command actually has — "what
	// does anybody CLAIM about this thing, and does it hold" — which is what `about` exists for.
	if (artifactRefs(store).all.has(target)) {
		refuseStray(rest, `dt prove ${target}`, ['--kind', '--json', '--external', '--strict']);
		return proveMany(ws, proofs, flags, (p) => (p.about ?? []).map(String).includes(target));
	}
	throw new Error(`dt prove takes a proof id or an artifact (skills/<id>, commands/<id>, …) — got "${target}"; dt list proofs`);
}

/** The last `n` lines of a captured stream — what a step failure PRINTS. Display only: judging on a
 *  tail is R23's defect, not its remedy. */
function lastLines(text, n = 10) {
	return String(text ?? '').replace(/\n+$/, '').split('\n').slice(-n).join('\n');
}

/**
 * ⚠ R23 — A STEP'S STDOUT IS CAPTURED WHOLE, AND JUDGED WHOLE. It used to be kept as a 10-line
 * TAIL, which made every `dt … --json` payload — pretty-printed, and more than ten lines the moment
 * it carries a `steps` array — unparseable, so a `stdout_json` expectation read `undefined` and
 * failed for a reason nothing named. A `stdout: { _contains: … }` over a marker on line 1 of 20 was
 * the same bug the other way up: silently false.
 *
 * 64 KB, and the FIRST 64 KB rather than the last: a JSON payload starts at the beginning, and a
 * truncated one must fail loudly (`stdout is not JSON`) rather than parse to something smaller than
 * what the step actually printed. `stdout_truncated` is always present, because a key that appears
 * only sometimes is worse to read than a `false`.
 */
const STDOUT_CAP = 64 * 1024;

function captured(text) {
	const whole = String(text ?? '');
	return whole.length > STDOUT_CAP
		? { text: whole.slice(0, STDOUT_CAP), truncated: true }
		: { text: whole, truncated: false };
}

/** The first line of a thrown message — what a `failure_reason` carries. A multi-line reason inside
 *  a JSONL row is legal and unreadable, and the first line is the sentence that names the cause. */
const firstLine = (message) => String(message ?? '').split('\n')[0];

/**
 * ONE builder for every ledger row, used by `proveOne`'s `settle` AND by `--all`'s catch — because
 * R24's whole point is that a proof which THREW still gets a row. Two writers of this shape is how
 * one of them ends up missing `machine` or `before`.
 */
function ledgerRow(state, started, over = {}) {
	return {
		when: new Date().toISOString(),
		record: null,
		engine: engineVersion(),
		machine: os.hostname(),
		duration_ms: Date.now() - started,
		failure_reason: null,
		steps: [],
		sandbox: null,
		// `null` = no removal was ATTEMPTED (no sandbox, still PENDING, or kept by `--keep`);
		// `true` = the sandbox is gone; `false` = the removal FAILED and the directory is still
		// there. Always present, because a key that appears only sometimes is worse to read.
		sandbox_removed: null,
		before: {},
		...over,
		verdict: state,
	};
}

/**
 * How much output one `run` step may produce. `spawnSync`'s default `maxBuffer` is 1 MB and it KILLS
 * the child on overflow — which used to arrive as a bare signal and get reported as a timeout. 16 MB
 * because a proof step's stdout is judged whole (R23) and a ledger row keeps 64 KB of it; anything
 * larger belongs in a file the proof asserts with `path:`, which the message says.
 */
const MAX_OUTPUT_MB = 16;

/**
 * What a finished `run` step actually DID — `{ exit, failure_reason }`, with `failure_reason: null`
 * when nothing is wrong. PURE, and lifted out of the loop precisely because the loop cannot be
 * unit-tested and this is where several different events were being reported as one.
 *
 * ⚠ ORDER MATTERS, AND ONLY `error.code` MAY DECIDE A TIMEOUT (R26). The first version read
 * `res.error?.code === 'ETIMEDOUT' || (res.status === null && !!res.signal)` — and that second
 * clause is ALSO true for an ENOBUFS kill (spawnSync kills the child when `maxBuffer` overflows),
 * for the OOM killer, and for any external `kill`. So a step killed by its own output volume
 * reported "timed out after 120s": a cause and a number the operator would go and act on, both
 * invented. A bare signal now says only what is known — WHICH signal — and nothing about why.
 *
 * `index` and `want` extend the ruled `(res, timeoutSeconds)` signature so the whole message is
 * assembled HERE: a reason half-built at the call site is a reason no test can pin.
 */
export function stepOutcome(res, timeoutSeconds, index = 1, want = 0) {
	// a killed step has a null status and a signal — reporting `exit null` would read as success
	const exit = res?.status ?? (res?.signal ? 124 : 1);
	const code = res?.error?.code ?? null;
	const reason = (text) => ({ exit, failure_reason: `step ${index} ${text}` });
	if (code === 'ETIMEDOUT') return reason(`timed out after ${timeoutSeconds}s`);
	if (code === 'ENOBUFS') return reason(`produced more than ${MAX_OUTPUT_MB} MB of output — write it to a file and assert with path:`);
	if (res?.error) return reason(`could not start: ${code ?? res.error.message}`);
	if (res?.signal) return reason(`was killed (${res.signal})`);
	return exit === want ? { exit, failure_reason: null } : reason(`exited ${exit}`);
}

const isDelta = (count) => count !== null && typeof count === 'object' && !Array.isArray(count) && '_delta' in count;

/** An expectation that can be judged against the STORE, and so can be pre-checked before any step
 *  runs. A `step`/`path` one cannot: there is no step result yet, and a path a step will create is
 *  supposed to be absent. */
const isStoreBased = (e) => !!e && (('collection' in e && 'count' in e) || 'record' in e);

/** The 1-based index of the last `run` step — the default a `step:` expectation resolves to, so the
 *  commonest shape ("the command I ran exited 0") needs no index at all. */
function lastRunIndex(proof) {
	const steps = Array.isArray(proof.steps) ? proof.steps : [];
	for (let i = steps.length - 1; i >= 0; i--) if (steps[i]?.run !== undefined) return i + 1;
	return 0;
}

/** The `step:` expectation aimed at step `n`, if any — what decides whether a non-zero exit is a
 *  failure or the thing being asserted. */
function stepExpect(proof, n) {
	for (const e of Array.isArray(proof.expect) ? proof.expect : []) {
		if (!e || !('exit' in e || 'stdout' in e || 'stdout_json' in e)) continue;
		if ((Number.isInteger(e.step) ? e.step : lastRunIndex(proof)) === n) return e;
	}
	return null;
}

/** A dotted path into a parsed JSON value — `stdout_json: { data.count: { _gte: 1 } }`. */
function valueAt(json, dotted) {
	let v = json;
	for (const key of String(dotted).split('.')) v = v == null ? undefined : v[key];
	return v;
}

/**
 * Every expectation, as one machine-readable verdict per CONDITION.
 *
 * ⚠ ONE ENTRY PER LINE, NEVER THE RAW `expect` ROW (R18). A collection form carries `collection`,
 * `where` and `count` together, and `verdictLine` handed it whole rendered the first key —
 * `collection 1 = notes ✖`, a verdict about the wrong thing, marked failed, for a proof that
 * passed. So the row is narrowed here: `{ count: … }` for a collection form, and one line per FIELD
 * for a record form, which is also what makes a two-field expectation legible.
 *
 * `ok` is read back off the rendered line's mark rather than computed a second time — `verdictLine`
 * takes its ✔/✖ from `matchesFilter` itself, and deriving `ok` from anything else would let the
 * printed line and the exit code disagree about the same condition.
 *
 * `storeOnly` is the PRE-CHECK pass: the store-based forms only, judged before any step has run.
 */
function judge(ws, store, proof, id, record, before, stepResults, storeOnly) {
	const verdicts = [];
	const resolve = recordResolver(store);
	const ctx = record ? { record } : {};
	const push = (expectation, actual) => {
		const line = verdictLine(expectation, actual, resolve);
		verdicts.push({ expect: expectation, actual, ok: line.endsWith('✔'), line });
	};
	/** A ✖ that no filter produced — the two states where the QUESTION could not be asked. It carries
	 *  its own `reason`, because a `failure_reason` must not end in a glyph. */
	const fail = (expectation, actual, reason) => {
		verdicts.push({ expect: expectation, actual, ok: false, line: `${reason} ✖`, reason });
	};
	for (const [i, raw] of (Array.isArray(proof.expect) ? proof.expect : []).entries()) {
		const e = raw ?? {};
		if (storeOnly && !isStoreBased(e)) continue;
		if ('collection' in e && 'count' in e) {
			const total = countMatching(store, String(e.collection), e.where, resolve);
			if (!isDelta(e.count)) { push({ count: e.count }, total); continue; }
			// ⚠ R24 — A MISSING BEFORE-COUNT FAILS CLOSED. `before[i] || 0` treated an absent snapshot
			// as zero, so the delta became the ABSOLUTE count and a `_delta: 1` expectation PASSED on
			// a collection that already had records and had had nothing performed against it. That is
			// the silent green this whole verb exists to remove, reachable from a hand-edited or
			// half-written PENDING row, or from a row an older engine wrote.
			if (before === null || typeof before !== 'object' || !(i in before)) {
				fail({ count: e.count }, null, `no before-count in the pending row — re-run dt prove ${id} --restart`);
				continue;
			}
			push({ count: e.count }, total - Number(before[i]));
			continue;
		}
		if ('record' in e) {
			const row = record ? record.fields : {};
			for (const [field, cond] of Object.entries(e.where ?? {})) push({ [field]: cond }, row[field]);
			continue;
		}
		if ('path' in e) {
			// THE ONE RESOLVER (decision 240) — a `path:` expectation renders through the same
			// `${env:…}` renderer `dt resolve` uses, so a proof and the record it is about can never
			// disagree about where a machine's folder is. An undeclared `${env:…}` THROWS out of here,
			// loudly, which is that resolver's contract and not something to soften.
			const rendered = renderTemplate(substitute(String(e.path), ctx, { strict: true }), envContext(ws));
			push({ exists: e.exists }, fs.existsSync(rendered));
			continue;
		}
		const step = stepResults[(Number.isInteger(e.step) ? e.step : lastRunIndex(proof)) - 1];
		if ('exit' in e) push({ exit: e.exit }, step?.exit);
		// R23 — the FULL capture, not the display tail
		if (e.stdout && typeof e.stdout === 'object') push({ stdout: e.stdout }, step?.stdout ?? '');
		if (e.stdout_json && typeof e.stdout_json === 'object') {
			const text = step?.stdout ?? '';
			let parsed;
			try { parsed = JSON.parse(text); }
			catch {
				// ⚠ NEVER A SILENT `undefined`. An unparseable payload used to make every dotted path
				// read undefined, so the line said `a.b undefined = 1 ✖` and sent the reader to look
				// for a missing key in output that was never JSON at all.
				//
				// The head is FLATTENED before it is quoted: this is one verdict line, and 60 raw
				// characters of a multi-line stream puts newlines inside it — a "line" that is four
				// lines long, which is unreadable exactly where the reader is already confused.
				const head = text.trim().replace(/\s+/g, ' ').slice(0, 60);
				fail({ stdout_json: e.stdout_json }, head, `stdout is not JSON (${head})`);
				continue;
			}
			for (const [dotted, cond] of Object.entries(e.stdout_json)) push({ [dotted]: cond }, valueAt(parsed, dotted));
		}
	}
	return verdicts;
}

/** `commands/<id>`'s SOURCE file, when a `perform` text opens with `/<command-id>` and that command
 *  is compiled. The reader of a PERFORM block has to open the command to act on it, and deriving the
 *  path from a rule is exactly what the nudge's root-layout bug was — so it comes off the manifest,
 *  which records what was actually compiled. */
function commandSource(root, performText) {
	const m = /^\/(\S+)/.exec(String(performText ?? ''));
	if (!m) return null;
	const src = readManifest(root)?.entries?.[`commands/${m[1]}.command.md`]?.sources?.[0];
	return src ? (typeof src === 'string' ? src : src.path) : null;
}

/**
 * EVERY non-superseded PENDING row of this proof, one per record — what makes a second run refuse.
 * `pendingFor` answers for one named record; a fresh run does not know the record yet.
 *
 * ⚠ ALL OF THEM, not the last one (MINOR 10). A proof can be pending for several records at once —
 * `--record a`, then a fresh run picking `b` — and a refusal naming only the newest sends the
 * operator round the loop once per pending row, learning about the next one each time.
 */
function allPending(root, proofId) {
	const last = new Map();
	for (const r of readLedger(root, proofId)) last.set(r?.record ?? null, r);
	return [...last.values()].filter((r) => r?.verdict === 'PENDING');
}

// ── the sandbox ─────────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn` with everything it PRINTS captured and handed back, and everything it throws handed back
 * as a value. Two callees need it: `check` reports its findings by printing them rather than
 * returning them, and `removeWorktree` announces itself — and neither is part of a proof's report,
 * while under `--json` a single stray line makes the one object on stdout unparseable.
 *
 * It never throws, because every caller is already in the middle of deciding a verdict.
 */
function captureLog(fn) {
	const lines = [];
	const log = console.log;
	const err = console.error;
	console.log = (...a) => lines.push(a.map(String).join(' '));
	console.error = (...a) => lines.push(a.map(String).join(' '));
	try { return { value: fn(), lines }; }
	catch (e) { return { error: e, lines }; }
	finally { console.log = log; console.error = err; }
}

/** The module root that SHIPS this proof, off the MANIFEST — the same read `commandSource` makes,
 *  and for the same reason: deriving a module root from a file path is the bug the nudge had. */
function proofModuleRoot(root, id) {
	const src = readManifest(root)?.entries?.[`proofs/${id}.proof.yaml`]?.sources?.[0];
	const p = src ? (typeof src === 'string' ? src : src.path) : null;
	return p ? path.dirname(path.dirname(p)) : null;
}

/** `modules/<m>/proofs/fixtures/<id>` — where a fixture proof's records live, absolute. */
function fixtureDir(root, moduleRoot, id) {
	return path.join(root, moduleRoot && moduleRoot !== '.' ? moduleRoot : '', 'proofs', 'fixtures', id);
}

/**
 * Why this sandbox cannot be judged against — one line — or null.
 *
 * ⚠ A FIXTURE IS RECORDS NOBODY VALIDATED. Everything else a proof reads went through the store's
 * validator on its way in; `modules/<m>/proofs/fixtures/` is hand-authored bytes, so it is the ONE
 * input that can be schema-invalid — and a verdict judged against an invalid record measures the
 * wrong thing while reporting it confidently. So the engine's own `check` runs against the sandbox
 * before any step does, and the FIRST violation is what the failure names.
 */
function sandboxUnfit(root, collections) {
	// ⚠ A SANDBOX IS CUT FROM **HEAD**, so a descriptor that is not COMMITTED is not compiled inside
	// it — and `check` cannot see that: an unknown collection has no directory to walk, so the
	// fixture's records are INVISIBLE rather than invalid, and every count below would read zero.
	//
	// ⚠ EVERY collection the proof READS, not only `given`'s (R31). An expect-side one reached
	// `countMatching` as a raw `unknown collection "x"`, which reads as a typo in the proof.
	const known = loadDescriptors(root);
	const absent = [...new Set(collections.filter(Boolean))].find((c) => !known?.has(c));
	if (absent) {
		return `collection "${absent}" is not compiled in the sandbox — commit its descriptor, because a sandbox is cut from HEAD`;
	}
	// `check` takes `{ root }` and reads its descriptors off the compiled runtime — there is no
	// `pkg` to thread, and one passed in would be a parameter nothing reads.
	const { value, lines } = captureLog(() => check({ root }));
	if (value === 0) return null;
	// `check` prints `✖ <file>` and then one indented line per finding — the first one, as ONE line
	const i = lines.findIndex((l) => l.startsWith('✖'));
	if (i === -1) return lines[0] ?? `check exited ${value}`;
	const msg = String(lines[i + 1] ?? '').trim();
	return `${lines[i].replace(/^✖\s*/, '')}${msg ? `: ${msg}` : ''}`;
}

/**
 * ⚠ `force` IS HONEST HERE, AND NOWHERE ELSE IN THIS ENGINE. `removeWorktree` refuses by default
 * because a worktree holds two things the primary cannot see — records written but not committed,
 * and commits not yet landed. A proof sandbox is DISPOSABLE BY DESIGN: it was cut minutes ago from
 * HEAD, it holds nothing but the fixture and whatever the proof wrote onto it, and LANDING any of
 * that is the one outcome a `writes` proof must never produce. Without `force` the refusal would
 * fire on every single run, on exactly the state the sandbox exists to reach.
 */
function removeSandbox(ws, dir) {
	const { error } = captureLog(() => removeWorktree(ws, dir, { force: true }));
	if (!error) return true;
	// ⚠ AND THE FAILURE IS RECORDED, NOT JUST WARNED (R28). A warning on stderr is gone the moment
	// the terminal scrolls, and the row it belongs to is non-PENDING with a `sandbox` set — so
	// nothing would ever revisit the directory. `sandbox_removed: false` is what `dt status` counts.
	console.warn(`⚠ sandbox ${dir} could not be removed: ${firstLine(error.message)} — remove it by hand`);
	return false;
}

/**
 * ONE proof, start to finish. Returns `{ code, state, row, verdicts }`.
 *
 * `flags.silent` suppresses the human output without emitting JSON — what `--all` runs each proof
 * with, so a board is a board rather than forty step transcripts.
 */
function proveOne(ws, id, proof, flags) {
	const started = Date.now();
	const say = flags.silent || flags.json ? () => {} : (line) => console.log(line);
	const timeout = Number.isInteger(proof.timeout) ? proof.timeout : DEFAULT_TIMEOUT;

	/** The throwaway worktree this run is happening in, once there is one — `null` for every readonly
	 *  proof and every `--here` one, which run in the invoking checkout itself. */
	let sandbox = null;
	/** The workspace everything AFTER `requires` runs against: the sandbox when there is one, the
	 *  invoking checkout otherwise. The ledger is the deliberate exception (see `settle`). */
	let tws = ws;
	const enter = (dir) => { sandbox = dir; tws = dir ? { ...ws, root: dir } : ws; };

	/** Append the row this state produces and answer with its code. Every terminal state goes
	 *  through here, so "exactly one row per run" is structural rather than remembered.
	 *
	 *  ⚠ THE LEDGER IS THE INVOKING CHECKOUT'S, ALWAYS — `ws.root`, never `tws.root`. A sandbox is
	 *  deleted the moment the verdict is in, so evidence written inside one would go with it. */
	const settle = (state, over = {}, verdicts = []) => {
		// ⚠ A SANDBOX IS NEVER LEFT BEHIND, except while PENDING (the operator is about to act inside
		// it) or under `--keep` (they asked to look). Every terminal state funnels through here, which
		// is what makes that structural rather than a line remembered at each of the nine exits.
		//
		// ⚠ AND IT HAPPENS BEFORE THE ROW IS BUILT, so the row can say what actually became of the
		// directory (R28) — a removal that failed is a fact about this machine that outlives the run.
		const kept = !!(sandbox && state !== 'PENDING' && flags.keep);
		let removed = null;
		if (kept) say(`kept     ${sandbox}`);
		else if (sandbox && state !== 'PENDING') removed = removeSandbox(ws, sandbox);

		const row = ledgerRow(state, started, { sandbox, sandbox_removed: removed, ...over });
		appendLedger(ws.root, id, row);
		// ⚠ ONE OBJECT ON STDOUT AND NOTHING ELSE. A script parses stdout WHOLE, so a single human
		// line ahead of the object makes `JSON.parse` throw — indistinguishable from a failed run.
		// `kept` rides along rather than living on the row: under `--keep --json` the human `kept`
		// line is suppressed, and "the sandbox is still there ON PURPOSE" would otherwise have to be
		// derived from three fields at once.
		if (flags.json) console.log(JSON.stringify({ ...row, verdicts, kept }, null, 2));
		return { code: exitFor(state), state, row, verdicts };
	};

	/**
	 * ⚠ EVERY PATH THAT JUDGES LEAVES A ROW, EVEN WHEN IT THROWS (MINOR 8, widened by R26). The first
	 * version wrapped only the fresh step-and-judge run — which sits BELOW the resume early-return,
	 * so a throw while judging a `--record` resume (an undeclared `${env:…}` in a `path:`, a typo'd
	 * brace) left the ledger sitting at PENDING with the failed run unrecorded. The operator is then
	 * told to finish a run they have already finished, and the ledger denies it ever happened.
	 *
	 * `over` is built BEFORE the run, and its `steps` is the live array — so a throw halfway through
	 * the loop still records the steps that did complete.
	 */
	const ledgering = (over, run) => {
		try { return run(); }
		catch (e) {
			if (e.ledgered) throw e;
			settle('FAIL', { ...over, failure_reason: firstLine(e.message) });
			throw Object.assign(e, { ledgered: true });
		}
	};

	// ---- 0. WHERE THIS PROOF IS ALLOWED TO WRITE. A `writes` proof mutates records, so it runs in a
	// throwaway detached worktree on its OWN fixtures and the primary store is never touched.
	// `--here` is the documented opt-out, and it says so out loud before anything moves.
	const sandboxed = proof.mode === 'writes' && !flags.here;
	if (proof.mode === 'writes' && flags.here) say(`⚠ --here: writing to THIS checkout's store`);
	if (sandboxed && proof.given?.fixture !== true) {
		// ⚠ COMPILE ALLOWS THE SHAPE, because a `given.where` writes proof is legitimate WITH `--here`
		// — which is exactly why this refusal is at RUN time: it is what protects the real store.
		// ⚠ `unavailable` IS READ BY `--all` (R24): every other throw from a proof is that proof's
		// FAIL, and this is the one exception — the artifact is fine, this INVOCATION cannot answer
		// for it. A message match would have made the distinction a string compare.
		const at = path.relative(ws.root, fixtureDir(ws.root, proofModuleRoot(ws.root, id) ?? '<m>', id));
		throw Object.assign(
			new Error(`${id} is a writes proof with no fixture — it runs only with --here (against a real record in THIS store), or add ${at}/`),
			{ unavailable: true },
		);
	}
	if (flags.keep && !sandboxed) {
		throw new Error(`--keep keeps a writes proof's sandbox — ${id} runs in the workspace, so there is nothing to keep`);
	}

	// ---- 1. RESUME — `--record` names the pending run this invocation is FINISHING, and nothing
	// else. Starting a fresh run instead would discard a pending row the operator is halfway through
	// and re-ask for an action they have already taken.
	const override = typeof flags.record === 'string' ? flags.record : null;
	if (override) {
		const pend = pendingFor(ws.root, id, override);
		if (!pend) throw new Error(`no pending run of ${id} for ${override} — run dt prove ${id} first`);
		return resume(pend);
	}

	// ---- 2. THE PENDING GUARD. A second fresh run while one is outstanding would re-ask for the
	// same action, and the operator would have no way to tell which pending row their eventual
	// verify is judged against. A pending older than the proof's own timeout is STALE — the run it
	// belongs to is gone — so it is cleared, out loud, and recorded as cleared.
	//
	// ⚠ THE REMOVAL IS ATTEMPTED FIRST, AND THE ROW SAYS WHAT HAPPENED TO THE DIRECTORY (R28). Both
	// discards used to append the PENDING row's `sandbox_removed: null` — "no removal was attempted"
	// — about the one row where one certainly was, so `dt status` counted a leaked sandbox as fine
	// and nothing would ever come back for it. `.worktrees/` is gitignored: this is the only record.
	const discard = (row, reason) => {
		const removed = !row.sandbox ? null : fs.existsSync(row.sandbox) ? removeSandbox(ws, row.sandbox) : true;
		appendLedger(ws.root, id, { ...row, when: new Date().toISOString(), verdict: 'FAIL', failure_reason: reason, sandbox_removed: removed });
	};
	const live = [];
	for (const row of allPending(ws.root, id)) {
		const age = Math.round((Date.now() - Date.parse(row.when)) / 1000);
		if (age >= 0 && age <= timeout) { live.push(row); continue; }
		say(`stale pending run of ${id} for ${row.record === null ? '(no record)' : row.record} (${age}s) — cleared`);
		discard(row, 'stale');
	}
	if (live.length && flags.restart) {
		// EVERY live pending is discarded, not just the newest — otherwise `--restart` refuses again
		// on the next one and the flag reads as broken.
		for (const row of live) discard(row, 'restarted');
	} else if (live.length === 1 && live[0].record === null) {
		// a live proof with no `given` pends against no record, so `--record` cannot name it — the
		// bare verb is the only way back, and refusing here would strand the run permanently.
		return resume(live[0]);
	} else if (live.length === 1) {
		throw new Error(`${id} is pending for ${live[0].record} since ${live[0].when} — finish it with dt prove ${id} --record ${live[0].record}, or --restart to discard it`);
	} else if (live.length) {
		throw new Error(`${id} is pending for ${live.length} records — finish each with:\n${live.map((row) => `  dt prove ${id} --record ${row.record}`).join('\n')}\nor --restart to discard them`);
	}

	// ---- 3. REQUIRES, before the fixture: a machine that cannot answer the question must not report
	// NO-FIXTURE, which reads as a fact about the workspace's data rather than about this machine.
	const need = resolveRequires(ws, proof.requires);
	if (!need.ok) {
		say(`UNAVAILABLE  ${id}`);
		for (const m of need.missing) say(`  ${m.fix}`);
		return settle('UNAVAILABLE', { failure_reason: need.missing.map((m) => m.fix).join('; ') });
	}

	// ---- 3b THROUGH 7 ARE ALL WRAPPED, and the wrap starts ABOVE the sandbox (R27), not below the
	// pre-check where it used to. Everything from the fixture copy down can throw: `cpSync` on an
	// unreadable fixture, `pickFixture` on a collection the SANDBOX has no descriptor for, the
	// `_delta` snapshot and the pre-check on an expect-side collection that is compiled in the
	// working tree but not COMMITTED — a sandbox is cut from HEAD, so `countMatching` answers
	// `unknown collection`. Every one of those used to exit 1 with a raw error, NO ledger row, and a
	// leaked `.worktrees/.tmp-*` that nothing would ever come back for.
	//
	// `over` is MUTATED as each phase learns its part and READ at the moment of the throw, so a
	// failure halfway through records what was known by then rather than nothing. Teardown comes free:
	// `ledgering`'s catch goes through `settle`, and `settle` is what removes the sandbox.
	let record = null;
	let ref = null;
	let ctx = {};
	const before = {};
	const steps = [];
	const over = { record: null, steps, before };
	return ledgering(over, phases);

	function phases() {
		// ---- 3b. THE SANDBOX, cut AFTER `requires` (a machine that cannot answer must not pay for a
		// worktree) and BEFORE the fixture, which is picked from INSIDE it. `--temp` means detached and
		// under `.worktrees/.tmp-<rand>/` in the primary root — see `addWorktree` for why not tmpdir.
		if (sandboxed) {
			const src = fixtureDir(ws.root, proofModuleRoot(ws.root, id), id);
			// ⚠ DOT-ENTRIES ARE NOT STRAY FILES. The operator's file manager writes `.DS_Store` into
			// this directory the first time anyone opens it, and refusing the whole proof for it
			// would be a failure nobody can act on — the file comes back.
			const entries = fs.existsSync(src) ? fs.readdirSync(src).filter((e) => !e.startsWith('.')) : [];
			if (!entries.includes('data')) {
				// `given.fixture: true` with no records behind it: the same fact as "matched 0 records",
				// and naming the path is the difference between a fix and a hunt.
				const at = `${path.relative(ws.root, src)}/data/`;
				say(`NO-FIXTURE  ${id} — no fixture records at ${at}`);
				return settle('NO-FIXTURE', { failure_reason: `no fixture records at ${at}` });
			}
			enter(createWorktree(ws, { name: id, temp: true, quiet: true }));
			// ⚠ ONLY `data/` IS ADMITTED (R28). The fixture mirrors the workspace ROOT, so copying the
			// directory whole would let it overwrite anything the checkout carries — `package.json`, a
			// descriptor, `.dreamteamer/` itself. And `sandboxUnfit` runs AFTER the copy, so a fixture
			// could ship the very schema its records are then validated against: a proof that passes
			// because it brought its own rules.
			const stray = entries.find((e) => e !== 'data');
			if (stray) {
				say(`FAIL  ${id} — fixture may contain only data/ — found ${stray}`);
				return settle('FAIL', { failure_reason: `fixture may contain only data/ — found ${stray}` });
			}
			// ⚠ AND `data` HAS TO BE A DIRECTORY. `cpSync(file, dir)` does not refuse — it writes the
			// file OVER the sandbox's `data/`, and the records the proof then reads are whatever
			// survived. A named refusal is the difference between a fix and a mystery verdict.
			if (!fs.statSync(path.join(src, 'data')).isDirectory()) {
				say(`FAIL  ${id} — fixture data/ must be a directory`);
				return settle('FAIL', { failure_reason: 'fixture data/ must be a directory' });
			}
			fs.cpSync(path.join(src, 'data'), path.join(sandbox, 'data'), { recursive: true });
			const unfit = sandboxUnfit(sandbox, [proof.given?.collection, ...(proof.expect ?? []).map((e) => e?.collection)]);
			if (unfit) {
				say(`FAIL  ${id} — fixture does not validate:`);
				say(`  ${unfit}`);
				return settle('FAIL', { failure_reason: `fixture does not validate: ${unfit}` });
			}
		}

		// ---- 4. THE FIXTURE — the ONE record this proof runs against, or none.
		const store = new Store(tws);
		record = proof.given ? pickFixture(store, proof.given, null) : null;
		ref = record ? record.ref : null;
		over.record = ref;
		if (proof.given && !record) {
			say(`NO-FIXTURE  ${id} — given matched 0 records in ${proof.given.collection}`);
			return settle('NO-FIXTURE', { failure_reason: `given matched 0 records in ${proof.given.collection}` });
		}

		// ---- 5. THE `_delta` SNAPSHOT, taken before anything runs. It is also what makes the pre-check
		// below read a delta of 0 rather than the whole collection's size.
		const resolve = recordResolver(store);
		for (const [i, e] of (Array.isArray(proof.expect) ? proof.expect : []).entries()) {
			if (e && 'collection' in e && isDelta(e.count)) before[i] = countMatching(store, String(e.collection), e.where, resolve);
		}

		// ---- 6. THE PRE-CHECK, and it is the most valuable state in the set. A proof whose expectations
		// ALREADY hold reports PASS forever and measures nothing — the silent-green failure `prove` exists
		// to remove. `step`/`path` expectations are not pre-checkable and do not count toward "all", so a
		// proof judged only on those is never vacuous.
		const pre = judge(tws, store, proof, id, record, before, [], true);
		if (pre.length && pre.every((v) => v.ok)) {
			say(`VACUOUS  ${id} — every expectation already holds against ${ref ? ref : 'this workspace'}; a proof that cannot fail is not a proof`);
			return settle('VACUOUS', { record: ref, before, failure_reason: 'every expectation already holds' });
		}

		// ---- 7. THE STEPS, in order, until one fails or one asks for an actor.
		ctx = record ? { record } : {};
		return runSteps();
	}

	/** What a FAIL row for a resumed run carries: the pending row's own record, steps and snapshot,
	 *  because those are the facts of the run being finished — this invocation only judged it. */
	function rowOf(pending) {
		return { record: pending.record ?? null, steps: pending.steps ?? [], before: pending.before ?? {}, sandbox: pending.sandbox ?? null };
	}

	/**
	 * Finish a PENDING run — in the place that run actually happened.
	 *
	 * ⚠ A SANDBOX THAT IS GONE CANNOT BE JUDGED, and falling back to the primary would answer about
	 * records this proof never touched — a confident verdict about the wrong store.
	 */
	function resume(pend) {
		enter(pend.sandbox ?? null);
		if (sandbox && !fs.existsSync(sandbox)) {
			const gone = `sandbox ${sandbox} is gone (removed by hand?)`;
			say(`FAIL  ${id} — ${gone}`);
			enter(null); // there is nothing left to remove, and `settle` would try
			return settle('FAIL', { ...rowOf(pend), failure_reason: gone });
		}
		return ledgering(rowOf(pend), () => verify(pend));
	}

	function runSteps() {
		for (const [i, raw] of (Array.isArray(proof.steps) ? proof.steps : []).entries()) {
			const step = raw ?? {};
			const n = i + 1;
			if (step.perform !== undefined) {
				// ⚠ THE PENDING ROW IS WRITTEN BEFORE THE BLOCK IS PRINTED, so a run killed between the
				// two still leaves a resumable ledger — the operator may already have taken the action.
				const text = substitute(String(step.perform), ctx);
				const out = settle('PENDING', { record: ref, steps, before });
				// ⚠ ABOVE the PERFORM, because "where am I acting" is read BEFORE "what do I do" — and a
				// human who acts in the wrong checkout has written real records this proof will not judge.
				if (sandbox) say(`in       ${sandbox}   (a throwaway worktree — records written here are never landed)`);
				say(`PERFORM  ${text}`);
				const src = commandSource(ws.root, text);
				if (src) say(`source   ${src}`);
				say(`then     dt prove ${id}${record ? ` --record ${record.ref}` : ''}   (the same verb, again)`);
				return out;
			}
			const cmd = substitute(String(step.run ?? ''), ctx);
			say(`RUN ${n}  ${cmd}`);
			const t0 = Date.now();
			const res = spawnSync(cmd, { shell: true, cwd: tws.root, timeout: timeout * 1000, encoding: 'utf8', maxBuffer: MAX_OUTPUT_MB * 1024 * 1024 });
			const ms = Date.now() - t0;
			// MINOR 7 / R26 — the classification is `stepOutcome`, pure and unit-tested: a step killed
			// at the timeout, one killed by its own output volume, one killed from outside, one the
			// shell could not start and one that simply returned non-zero are five different things to
			// go and fix, and every one of them is invisible in an exit code.
			const want = stepExpect(proof, n)?.exit ?? 0;
			const { exit, failure_reason } = stepOutcome(res, timeout, n, want);
			const out = captured(res.stdout);
			say(`  exit ${exit} (${ms} ms)`);
			steps.push({ index: n, kind: 'run', exit, stdout: out.text, stdout_truncated: out.truncated, stdout_tail: lastLines(out.text), stderr_tail: lastLines(res.stderr) });
			if (failure_reason) {
				// ⚠ NOT "the expectations failed": nothing was judged. A verdict line here would be a
				// claim about something no step ever measured, so the failure names the STEP and shows
				// its stderr. An ordinary non-zero exit keeps its `(want N)` form, because there the
				// wanted value is the whole point; every other cause prints its own sentence.
				const plain = failure_reason === `step ${n} exited ${exit}`;
				say(`FAIL at step ${n}  ${id} — ${plain ? `exit ${exit} (want ${want})` : failure_reason.slice(`step ${n} `.length)}`);
				for (const line of lastLines(res.stderr).split('\n')) if (line) say(`  ${line}`);
				return settle('FAIL', { record: ref, steps, before, failure_reason });
			}
		}
		return decide(record, before, steps);
	}

	/**
	 * ⚠ A FRESH `Store`, ALWAYS. `readAll` walks `ids()`, memoized on (git HEAD, collection dir
	 * mtime) with a documented gap — a DEEP write that adds a record without moving the top
	 * directory's mtime serves one stale read. A proof's steps write records and do NOT commit
	 * (`auto-commit` is off), so judging on the instance that took the before-count reads a `_delta`
	 * of 0 with nothing wrong anywhere. This is the ONE place that gap would be a wrong verdict.
	 */
	function decide(rec, snapshot, stepResults) {
		const fresh = new Store(tws);
		const current = rec ? pickFixture(fresh, proof.given, rec.ref) ?? rec : null;
		const currentRef = current ? current.ref : null;
		const verdicts = judge(tws, fresh, proof, id, current, snapshot, stepResults, false);
		for (const v of verdicts) say(`  ${v.line}`);
		const failed = verdicts.find((v) => !v.ok);
		if (!failed) {
			say(`PASS  ${id} (${Date.now() - started} ms)`);
			return settle('PASS', { record: currentRef, steps: stepResults, before: snapshot }, verdicts);
		}
		say(`FAIL  ${id}`);
		// `reason` is set only by the two ✖s no filter produced (a missing before-count, an
		// unparseable stdout), whose LINE ends in a glyph a `failure_reason` must not carry.
		return settle('FAIL', { record: currentRef, steps: stepResults, before: snapshot, failure_reason: failed.reason ?? failed.line }, verdicts);
	}

	/** The resume half: the steps already ran (in an earlier process, and the perform by a human), so
	 *  there is nothing to do but judge — against the `before` the PENDING row carries. */
	function verify(pending) {
		const fresh = new Store(tws);
		const rec = pending.record && proof.given ? pickFixture(fresh, proof.given, pending.record) : null;
		if (pending.record && proof.given && !rec) {
			say(`NO-FIXTURE  ${id} — ${pending.record} is gone`);
			return settle('NO-FIXTURE', { failure_reason: `${pending.record} is gone` });
		}
		return decide(rec, pending.before ?? {}, pending.steps ?? []);
	}
}

/**
 * `--all` and the artifact form — a BOARD, and never a request for an actor (spec §13.3).
 *
 * ⚠ EXIT 5 CAN NEVER COME OUT OF HERE. This is what a pre-commit hook and a CI step run, and "one
 * of your forty proofs would like a human" is not an answer either can act on. So a proof with a
 * `perform` step is LISTED rather than started, and the code reflects only what actually ran.
 *
 * `external: true` is opt-in for the same reason from the other side: a proof needing the network
 * should be invisible to the default run, not red on it.
 */
function proveMany(ws, proofs, flags, select) {
	const tally = { PASS: 0, FAIL: 0, UNAVAILABLE: 0, 'NO-FIXTURE': 0, VACUOUS: 0 };
	const actors = [];
	const rows = [];
	const say = flags.json ? () => {} : (line) => console.log(line);
	for (const [id, proof] of proofs) {
		if (!select(proof, id)) continue;
		if (typeof flags.kind === 'string' && proof.kind !== flags.kind) continue;
		if (proof.external === true && !flags.external) continue;
		if ((Array.isArray(proof.steps) ? proof.steps : []).some((s) => s?.perform !== undefined)) { actors.push(id); continue; }
		const t0 = Date.now();
		let state;
		let reason;
		try {
			// ⚠ R22 — EVERY PROOF RUNS SILENT HERE, ALWAYS. It used to be `silent: !!flags.json`, so a
			// human `--all` printed a full step transcript per proof and the board it exists to be was
			// forty screens down. A transcript is what a SINGLE-proof run is for.
			const out = proveOne(ws, id, proof, { silent: true });
			state = out.state;
			reason = out.row.failure_reason;
		} catch (e) {
			// ⚠ R24 — A THROW IS THAT PROOF'S FAILURE, WITH A ROW. This used to tally any throw as
			// UNAVAILABLE and write nothing: a proof BROKEN in a way that throws (an undeclared
			// `${env:…}` in a `path:`, a typo'd brace) left `--all` GREEN without `--strict` and left
			// no evidence that it had ever been attempted. The ONE exception is the Task-5 seam, which
			// marks itself `unavailable`: there the artifact is fine and the engine is not ready.
			state = e.unavailable ? 'UNAVAILABLE' : 'FAIL';
			reason = firstLine(e.message);
			// `ledgered` means `proveOne` already wrote the row for this throw (MINOR 8) — writing a
			// second one would make the ledger claim the proof ran twice.
			if (!e.ledgered) appendLedger(ws.root, id, ledgerRow(state, t0, { failure_reason: reason }));
		}
		// ONE LINE PER PROOF, and the reason on it: a board whose rows say only PASS/FAIL sends the
		// reader to re-run each red one just to learn what it was.
		say(`${state}  ${id}${reason ? ` — ${reason}` : ''}`);
		rows.push({ proof: id, verdict: state, failure_reason: reason ?? null });
		tally[state] = (tally[state] ?? 0) + 1;
	}
	if (actors.length) {
		say('needs an actor:');
		for (const id of actors) say(`  dt prove ${id}`);
	}
	const summary = `proofs: ${tally.PASS} passed · ${tally.FAIL} failed · ${tally.UNAVAILABLE} unavailable · ${tally['NO-FIXTURE']} no-fixture · ${tally.VACUOUS} vacuous · ${actors.length} need an actor`;
	say(summary);
	// ⚠ `--strict` IS WHAT MAKES UNAVAILABLE FATAL, and it has to be a flag rather than the default:
	// a proof needing a credential is ordinarily unavailable on a cloud session, so failing on it by
	// default would make `--all` red everywhere it matters least.
	const code = tally.FAIL > 0 || (flags.strict && tally.UNAVAILABLE > 0) ? EXIT.FAIL : EXIT.PASS;
	if (flags.json) console.log(JSON.stringify({ summary, ...tally, 'need-an-actor': actors, proofs: rows, code }, null, 2));
	return { code };
}
