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
import path from 'node:path';
import { load } from './yaml.js';
import { matchesFilter, unknownOperators, looseEq } from './filter.js';
import { sortRows } from './temporal.js';
import { parseEnvValues } from './env-vars.js';
import { parseRef } from './namespace.js';
import { refTargetsOf } from './ref.js';
import { recordResolver } from './record-commands.js';
import { RUNTIME_DIR, runtimeDir } from './runtime.js';

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
		if ('count' in row) errors.push(...countErrors(row.count));
	}
	return errors;
}

/** R11 — a count map's operators and operands. Its own closed set (see COUNT_OPERATORS), and every
 *  operand an INTEGER: a count is a number of records, so `_gte: 'one'` and `_eq: 1.5` are both
 *  filters that can never be satisfied, silently. A bare scalar is the `_eq` it stands for. */
function countErrors(count) {
	const errors = [];
	const pairs = count !== null && typeof count === 'object' && !Array.isArray(count)
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
 * ⚠ `${…}` IS LEFT ALONE. That bracket belongs to the resolver (`${env:FILES_FOLDER}` in a `path:`
 * expectation, rendered per machine) and to the shell (`${HOME}` in a `run:` step). A `{…}` matcher
 * that did not exempt a `$`-prefixed brace would throw on both, on proofs that are correct.
 *
 * Everything else in braces THROWS rather than rendering. An unbound `{recrod.name}` would otherwise
 * reach the shell as the literal text and a missing field as the string "undefined" — the same
 * silent-wrong class the compile-time validator exists to close, one layer down.
 *
 * @param {string} text
 * @param {{record?: {ref: string, fields: object}}} ctx
 */
export function substitute(text, ctx) {
	if (typeof text !== 'string') return text;
	return text.replace(/(\$?)\{([^{}]*)\}/g, (whole, dollar, name) => {
		if (dollar) return whole;
		const rec = ctx?.record;
		const field = /^record\.(.+)$/.exec(name)?.[1];
		if (name !== 'record' && !field) throw new Error(`unknown substitution "{${name}}" — a proof may use {record} and {record.<field>}`);
		if (!rec) throw new Error(`{${name}} has nothing to bind to — this proof declares no given`);
		if (!field) return String(rec.ref);
		const value = rec.fields?.[field];
		if (value === undefined) throw new Error(`{${name}} — ${rec.ref} has no field "${field}"`);
		return String(value);
	});
}

/**
 * `rows` plus `row`, trimmed to the LAST `cap` entries — a new array, never a mutation.
 *
 * The oldest row is the one that leaves. A ledger is read for what happened recently, so trimming
 * from the other end would make the cap delete exactly the rows anyone wants.
 */
export function applyCap(rows, row, cap = LEDGER_CAP) {
	return [...rows, row].slice(-cap);
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

/** The WANTED value, bare: an array renders as the list a reader would type back. */
const wanted = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));

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
 * The mark comes from `matchesFilter` itself, so the judgement and the rendering can never disagree
 * about whether the line passed. `_delta` is the exception: no filter has it, so it is compared here.
 */
export function verdictLine(expectation, actual) {
	const entries = Object.entries(expectation ?? {});
	const bare = entries.length > 0 && entries.every(([k]) => k.startsWith('_'));
	const [field, cond] = bare ? ['count', expectation] : (entries[0] ?? ['count', null]);
	const ops = cond !== null && typeof cond === 'object' && !Array.isArray(cond) ? cond : { _eq: cond };
	const pass = '_delta' in ops ? Number(actual) === Number(ops._delta) : matchesFilter({ [field]: actual }, { [field]: ops }, null);
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
	} catch { return null; } // no such record — NO-FIXTURE, not a crash
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

function onPath(name) {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue;
		try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { /* next dir */ }
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
 *  the cap has to drop the oldest row, and the rewrite is what repairs a malformed line. */
export function appendLedger(root, proofId, row) {
	const file = ledgerPath(root, proofId);
	const rows = applyCap(readLedger(root, proofId), row);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
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
