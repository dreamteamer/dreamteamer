// The `setup` contribution — extension API 1, setup version 1.
//
// A module that needs something from the person (a folder, a token, a download, a sign-in) declares
// HOW through a list of units, and the engine drives every unit the same way: `dt install` fills the
// unit's inputs and applies its safe actions, `dt setup` resumes and verifies, `dt status` folds its
// checks into one line. The engine never learns a module's name — a unit is addressed by its `id`,
// identical whether its module is installed alone or composed into a bigger package.
//
//   setup: [{
//     id: 'meetings', version: 1,
//     inputs: [{ id, title?, env?, kind: 'string'|'path'|'rows'|'secret-path', required?, default?, prompt?, rows?: { columns } }],
//     inspect(ctx)                 → { checks: [{ id, status, title, detail?, fix?, evidence? }] }
//     plan(ctx, inputs)            → { checks, actions: [{ id, title, effects: [{ kind, detail }], preview?, expect?, runBy?, kind? }], needs: [inputId] }
//     apply(ctx, action, inputs)   → { ok, changed: [paths], message? }
//   }]
//
// This file is the validator and nothing else: pure, no fs, so the contract is testable without a
// workspace. `src/setup.js` runs the units.
export const SETUP_VERSION = 1;
export const INPUT_KINDS = ['string', 'path', 'rows', 'secret-path'];
export const CHECK_STATUSES = ['ready', 'configured', 'unverified', 'missing', 'blocked'];
export const EFFECT_KINDS = ['workspace-files', 'download', 'network', 'machine', 'account'];

const UNIT_ID = /^[a-z][a-z0-9-]*$/;
const INPUT_ID = /^[a-z][a-z0-9_]*$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

const kindOf = (v) => (Array.isArray(v) ? 'a list' : v === null ? 'null' : typeof v === 'object' ? 'an object' : typeof v);

/**
 * Validate one package's `setup` contribution. Returns the units with their defaults filled and the
 * package name stamped as `module`, or the refusals — every one naming the unit and the field, so a
 * module author reads the message and fixes the one line.
 * `declared` is the package's `dreamteamer.env` and `dreamteamer.vars`: an input that names an env
 * key must also be declared there, so a variable is declared in exactly one place.
 */
export function validateSetup(name, value, { env = [], vars = [] } = {}) {
	if (value === undefined || value === null) return { units: [], errors: [] };
	if (!Array.isArray(value)) return { units: [], errors: [`extension ${name}: setup must be a list of units (got ${kindOf(value)})`] };
	const declared = new Set([...(env ?? []), ...(vars ?? [])]);
	const errors = [];
	const units = [];
	const seen = new Set();
	for (const u of value) {
		if (!u || typeof u !== 'object' || Array.isArray(u)) { errors.push(`extension ${name}: a setup unit must be an object (got ${kindOf(u)})`); continue; }
		if (typeof u.id !== 'string' || !UNIT_ID.test(u.id)) { errors.push(`extension ${name}: a setup unit id is a lowercase slug (got ${JSON.stringify(u.id)})`); continue; }
		if (seen.has(u.id)) { errors.push(`extension ${name}: setup unit "${u.id}" is declared twice`); continue; }
		seen.add(u.id);
		if (u.version !== SETUP_VERSION) { errors.push(`unit ${u.id} declares setup version ${u.version}; this engine understands ${SETUP_VERSION} — update the engine or the module`); continue; }
		let bad = false;
		for (const f of ['inspect', 'plan']) if (typeof u[f] !== 'function') { errors.push(`unit ${u.id}: ${f} must be a function`); bad = true; }
		// apply is optional since 0.48.0: a unit whose every action carries `env` needs none (the engine
		// performs those); a non-env action from an apply-less unit fails at run time, named (src/setup.js)
		if (u.apply !== undefined && typeof u.apply !== 'function') { errors.push(`unit ${u.id}: apply must be a function when present`); bad = true; }
		// `dt status` and `dt doctor` call inspect without awaiting, so an async one would read as "no
		// evidence — never ready" with no error anywhere; refused here by name instead (review finding 5)
		if (typeof u.inspect === 'function' && u.inspect.constructor?.name === 'AsyncFunction') { errors.push(`unit ${u.id}: inspect must be synchronous — dt status reads it without awaiting`); bad = true; }
		const inputs = [];
		const rawInputs = u.inputs ?? [];
		if (!Array.isArray(rawInputs)) { errors.push(`unit ${u.id}: inputs must be a list`); bad = true; }
		else {
			for (const i of rawInputs) {
				if (!i || typeof i !== 'object') { errors.push(`unit ${u.id}: an input must be an object (got ${kindOf(i)})`); bad = true; continue; }
				if (typeof i.id !== 'string' || !INPUT_ID.test(i.id)) { errors.push(`unit ${u.id}: an input id is a lowercase identifier (got ${JSON.stringify(i.id)})`); bad = true; continue; }
				if (!INPUT_KINDS.includes(i.kind)) { errors.push(`unit ${u.id}: input ${i.id} has kind ${JSON.stringify(i.kind)} — one of ${INPUT_KINDS.join(', ')}`); bad = true; continue; }
				if (i.env !== undefined) {
					if (typeof i.env !== 'string' || !ENV_KEY.test(i.env)) { errors.push(`unit ${u.id}: input ${i.id} names env ${JSON.stringify(i.env)}, which is not an environment key`); bad = true; continue; }
					if (!declared.has(i.env)) { errors.push(`unit ${u.id}: input ${i.id} names env ${i.env}, which the package does not declare in dreamteamer.env or vars`); bad = true; continue; }
				}
				if (i.kind === 'rows' && !(Array.isArray(i.rows?.columns) && i.rows.columns.length && i.rows.columns.every((c) => typeof c === 'string'))) { errors.push(`unit ${u.id}: input ${i.id} is rows and must declare rows.columns`); bad = true; continue; }
				inputs.push({ id: i.id, kind: i.kind, env: i.env, required: i.required === true, title: i.title ?? i.id, default: i.default, prompt: i.prompt, rows: i.rows });
			}
		}
		if (bad) continue;
		units.push({ id: u.id, version: SETUP_VERSION, module: name, inputs, inspect: u.inspect, plan: u.plan, apply: u.apply });
	}
	return { units, errors };
}

/** Does this action ask the engine to write `.env`? (`env: { KEY: value, … }` on the action — D61.) */
export const isEnvAction = (action) => !!action && typeof action === 'object' && action.env !== undefined;

/**
 * Judge an env action's shape when a plan is read. `declared` is the Set of env keys the package
 * declares (`dreamteamer.env` ∪ `vars`). `{ ok: true }`, or `{ ok: false, state, reason }` where
 * `state` is what the driver writes on the action: `needs-input` for a value not yet known
 * (`undefined`/`null` — the shape a unit's plan has before its input arrives), `blocked` for anything
 * the unit got wrong. Pure; the file-level refusals (git exposure, a key assigned twice, a quote in
 * the value) are `src/env-write.js`'s, judged by the driver with the file in hand.
 */
export function validateEnvAction(action, declared) {
	const env = action?.env;
	if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, state: 'blocked', reason: 'env must be an object of KEY → value' };
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_KEY.test(key)) return { ok: false, state: 'blocked', reason: `${key} is not an environment key` };
		if (!declared.has(key)) return { ok: false, state: 'blocked', reason: `${key} is not declared by the package (dreamteamer.env or vars)` };
		if (value === undefined || value === null) return { ok: false, state: 'needs-input', reason: `${key} has no value yet` };
		if (typeof value !== 'string') return { ok: false, state: 'blocked', reason: `${key}: a value that is not a string` };
	}
	return { ok: true };
}
