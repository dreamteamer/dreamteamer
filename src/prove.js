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
import path from 'node:path';
import { load } from './yaml.js';
import { unknownOperators } from './filter.js';
import { refTargetsOf } from './ref.js';

export const PROOF_KINDS = ['gate', 'live'];
export const PROOF_MODES = ['readonly', 'writes'];

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
	return `${moduleRoot}/proofs/${id}.proof.yaml`;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────

/** Filter operators whose OPERAND is a literal value of the field, and so can be checked against a
 *  closed enum. `_contains`/`_starts_with` take a fragment, not a value; `_null`/`_empty` take a
 *  boolean; a range operator on an enum field is meaningless but not a typo. */
const ENUM_CHECKED = new Set(['_eq', '_neq', '_in', '_nin']);

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
			if (ENUM_CHECKED.has(op)) enumErrors(errors, key, prop, Array.isArray(operand) ? operand : [operand]);
		}
		if (!nested.length) continue;
		const targets = refTargetsOf(prop);
		if (!targets) {
			errors.push(`where "${key}" is not a reference field — a nested key hops a reference, it does not compare two fields`);
			continue;
		}
		// ONE hop, and no further: `filter.js` resolves a ref and evaluates the sub-condition against
		// the target record, which is itself a field condition — so a second nesting level is another
		// hop the evaluator does support, but a proof that needs two is a proof whose `expect` belongs
		// on the other collection. When the reference targets a LIST of collections or '*', any field
		// name is accepted: the value decides which target it resolves to, and that is a run-time fact.
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
				if (ENUM_CHECKED.has(op)) enumErrors(errors, hop, hopProp, Array.isArray(operand) ? operand : [operand]);
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
	for (const v of values) {
		if (v == null || options.includes(v)) continue;
		errors.push(`where "${field}" compares "${v}", which is not one of ${field}'s options [${options.join(', ')}]`);
	}
}
