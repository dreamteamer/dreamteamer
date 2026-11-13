// `dt setup` — and the setup half of `dt install` and `dt status`: the engine's generic driver for
// the units modules declare (src/setup-contract.js). Nothing here knows a module: it fills inputs,
// asks consent per effect, runs inspect → plan → apply → inspect, folds the checks into one line and
// keeps a unit's receipts. The vocabulary is the design's (rnd/design-docs/2026-11-12--cli-first-module-lifecycle):
//
//   inputs    --input id=value (or unit.id=value) → the environment → the declared default → a TTY
//             prompt for what is still missing → `needs`. Two inputs naming one env key are ONE input.
//   consent   workspace-files never asks; download / network / machine ask y/n in a TTY or run under
//             --allow <kind>; account runs only under `setup <unit> --authorize`, in a TTY.
//   status    skipped · no-evidence · blocked · configured · ready [· verified <date>]
//   receipts  .dreamteamer/setup/<unit>/ — per machine, gitignored with the runtime, never committed
//
// Pure functions first (tested without a workspace), then the runner and the verb.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { CHECK_STATUSES } from './setup-contract.js';
import { parseEnvValues } from './env-vars.js';
import { RUNTIME_DIR } from './runtime.js';
import { discoverModules } from './compile.js';

export const EFFECTS_ALLOWED = ['download', 'network', 'machine'];
export const EXIT = { done: 0, failed: 1, usage: 2, needsInput: 3 };

// ---- pure ---------------------------------------------------------------------------------------

/** `--input id=value` and `--input unit.id=value`, repeated; the value may itself hold `=`. */
export function parseInputFlags(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== '--input') continue;
		const raw = argv[++i];
		const eq = raw?.indexOf('=') ?? -1;
		if (eq < 1) throw usage('--input takes id=value (or unit.id=value)');
		const key = raw.slice(0, eq), value = raw.slice(eq + 1);
		const dot = key.indexOf('.');
		out.push(dot > 0 ? { unit: key.slice(0, dot), id: key.slice(dot + 1), value } : { unit: null, id: key, value });
	}
	return out;
}

/** `--allow <kind>`, repeated; an unknown kind is a usage error naming the vocabulary. */
export function parseAllow(argv) {
	const allow = new Set();
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== '--allow') continue;
		const kind = argv[++i];
		if (!EFFECTS_ALLOWED.includes(kind)) throw usage(`--allow takes one of ${EFFECTS_ALLOWED.join(', ')} (got ${JSON.stringify(kind)}); an account step is \`dt setup <unit> --authorize\``);
		allow.add(kind);
	}
	return allow;
}

export class SetupUsage extends Error { constructor(m) { super(m); this.code = EXIT.usage; } }
const usage = (m) => new SetupUsage(m);

const expandHome = (p, home) => (typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? path.join(home, p.slice(1)) : p);

/** A secret-path input's file: it must exist, be a file, and (posix) be readable by its owner only. The engine never reads it. */
function secretPathProblem(value) {
	let st;
	try { st = fs.statSync(value); } catch { return `${value}: no such file`; }
	if (!st.isFile()) return `${value}: not a file`;
	if (process.platform !== 'win32' && (st.mode & 0o077)) return `${value} is readable by other users — chmod 600 ${value}`;
	return null;
}
const flagText = (f) => `--input ${f.unit ? `${f.unit}.` : ''}${f.id}=`;

/**
 * Fill every unit's inputs. Returns `inputs` (unit id → { inputId: value }), `missing` (required
 * inputs with no value from any source), `ignored` and `problems`. `prompt(input, default)` is called
 * only in a TTY, only for what is still missing, and only when `noInput` is false. Strict (the default)
 * throws a usage error for a flag naming no input, two values for one shared key, or a secret-path
 * that does not exist or is not owner-only — nothing has run yet. `lenient` (install, where npm has
 * already written) keeps going: the unknown flag is listed in `ignored`, the bad value in `problems`
 * with the input left unfilled, so the install still commits and the line says what is still needed.
 */
export async function fillInputs(units, { flags = [], env = {}, tty = false, noInput = false, prompt = null, home = os.homedir(), lenient = false } = {}) {
	const inputs = new Map(units.map((u) => [u.id, {}]));
	const missing = [], ignored = [], problems = [];
	const refuse = (text, problem = null) => { if (!lenient) throw usage(text); if (problem) problems.push(problem); else ignored.push(text); };
	// a bare --input id= is unambiguous when every unit declaring that id names the same env key
	const byId = new Map();
	for (const u of units) for (const i of u.inputs) (byId.get(i.id) ?? byId.set(i.id, []).get(i.id)).push({ unit: u.id, env: i.env ?? null });
	const valueOf = (u, i, f) => (f.unit ? f.unit === u.id && f.id === i.id : f.id === i.id && (byId.get(i.id).every((d) => d.env === (i.env ?? null) && (d.env !== null || d.unit === u.id))));
	const live = [];
	for (const f of flags) {
		const owners = byId.get(f.id) ?? [];
		if (f.unit && !units.some((u) => u.id === f.unit && u.inputs.some((i) => i.id === f.id))) { refuse(`${flagText(f)} names no input of ${f.unit}`); continue; }
		if (!f.unit && !owners.length) { refuse(`${flagText(f)} names no input of ${units.map((u) => u.id).join(', ') || 'any unit'}`); continue; }
		if (!f.unit && owners.length > 1 && !(owners.every((o) => o.env !== null && o.env === owners[0].env))) { refuse(`${flagText(f)} is ambiguous: ${owners.map((o) => `${o.unit}.${f.id}`).join(', ')} — say which with unit.id=`); continue; }
		live.push(f);
	}
	// an env key shared by several inputs is one input: a flag for any of them fills all of them, and two
	// different values for it in one call are a refusal naming both (D39)
	const envValues = new Map(), envFlag = new Map(), conflicted = new Set();
	for (const u of units) for (const i of u.inputs) for (const f of live) {
		if (!i.env || i.kind === 'rows' || !valueOf(u, i, f)) continue;   // a rows input is repeatable: every flag is one more row
		if (envValues.has(i.env) && envValues.get(i.env) !== f.value && envFlag.get(i.env) !== f) {
			const first = envFlag.get(i.env);
			refuse(`${flagText(first)} and ${flagText(f)} name one key, ${i.env}, with different values — give one`, { unit: u.id, id: i.id, reason: `${flagText(first)} and ${flagText(f)} name one key, ${i.env}, with different values — give one`, required: false, env: i.env });
			conflicted.add(i.env);
			continue;
		}
		if (!envValues.has(i.env)) { envValues.set(i.env, f.value); envFlag.set(i.env, f); }
	}
	// a default declared by any input sharing the key is the key's default, and required is the OR of
	// every declaration sharing it (D39: one key, one input)
	const envDefaults = new Map(), envRequired = new Set();
	for (const u of units) for (const i of u.inputs) if (i.env) { if (i.default !== undefined && !envDefaults.has(i.env)) envDefaults.set(i.env, i.default); if (i.required) envRequired.add(i.env); }
	const isRequired = (i) => !!i.required || (!!i.env && envRequired.has(i.env));
	for (const u of units) {
		for (const i of u.inputs) {
			if (i.env && conflicted.has(i.env)) continue;
			let value;
			const given = live.filter((f) => valueOf(u, i, f)).map((f) => f.value);
			if (i.kind === 'rows') {
				if (given.length) value = given;
			} else if (given.length) value = given.at(-1);
			else if (i.env && envValues.has(i.env)) value = envValues.get(i.env);
			else if (i.env && env[i.env] !== undefined && String(env[i.env]).trim() !== '') value = String(env[i.env]);
			else if (i.default !== undefined) value = i.default;
			else if (i.env && envDefaults.has(i.env)) value = envDefaults.get(i.env);
			if (value === undefined && tty && !noInput && prompt) {
				const answer = await prompt(i, i.default);
				if (answer !== undefined && answer !== null && String(answer).trim() !== '') value = i.kind === 'rows' ? [String(answer)] : String(answer);
			}
			if (value === undefined) { if (isRequired(i)) missing.push({ unit: u.id, id: i.id }); continue; }
			if (i.kind === 'path' || i.kind === 'secret-path') value = expandHome(value, home);
			if (i.kind === 'secret-path') {
				// a flag's bad value is the caller's to fix (usage, strict); one the environment or a default holds
				// is reported on the unit's line and left unfilled, whoever runs
				const problem = secretPathProblem(value);
				if (problem && given.length) { refuse(`--input ${i.id}=${problem}`, { unit: u.id, id: i.id, reason: problem, required: true, env: i.env ?? null }); continue; }
				if (problem) { problems.push({ unit: u.id, id: i.id, reason: problem, required: isRequired(i), env: i.env ?? null }); continue; }
			}
			inputs.get(u.id)[i.id] = value;
		}
	}
	return { inputs, missing, ignored, problems };
}

/** The env keys a unit must not see: those whose value the engine refused for it. */
export const droppedKeys = (problems, unitId) => [...new Set(problems.filter((p) => p.unit === unitId && p.env).map((p) => p.env))];

/** May this action run now? `ask(action)` is the y/n in a TTY; `allow` the --allow kinds. */
export async function consent(action, { allow = new Set(), tty = false, ask = null, authorize = false } = {}) {
	const kinds = [...new Set((action.effects ?? []).map((e) => e.kind))];
	if (kinds.includes('account')) return authorize && tty;
	const asked = kinds.filter((k) => k !== 'workspace-files');
	if (!asked.length) return true;
	if (asked.every((k) => allow.has(k))) return true;
	if (tty && ask) return !!(await ask(action, asked));
	return false;
}

/** One line from a unit's checks — the design's status table, in its order. */
export function fold(checks, { skipped = false } = {}) {
	if (skipped) return { state: 'skipped', detail: 'dt setup <unit> to resume', verified: null };
	if (!checks.length) return { state: 'no-evidence', detail: 'inspect returned no checks — never ready', verified: null };
	const unknown = checks.filter((c) => !CHECK_STATUSES.includes(c.status));
	if (unknown.length) return { state: 'blocked', detail: unknown.map((c) => `${c.title ?? c.id}: unknown status ${JSON.stringify(c.status)}`).join(' · '), verified: null };
	const blocked = checks.filter((c) => c.status === 'blocked');
	if (blocked.length) return { state: 'blocked', detail: blocked.map((c) => `${c.title ?? c.id}${c.detail ? ` — ${c.detail}` : ''}`).join(' · '), verified: null };
	const open = checks.filter((c) => c.status === 'missing' || c.status === 'unverified');
	if (open.length) return { state: 'configured', detail: open.map((c) => `${c.title ?? c.id} ${c.status}`).join(' · '), verified: null };
	const dates = checks.map((c) => c.evidence?.at).filter((d) => typeof d === 'string').sort();
	return { state: 'ready', detail: '', verified: dates.at(-1) ?? null };
}

/** A provider's error, with anything that looks like a value gone. Key names and shapes stay. */
export function redact(text) {
	return String(text ?? '')
		.replace(/\b(token|secret|password|passwd|api[_-]?key|key|client[_-]?secret|credential)=\S+/gi, '$1=[redacted]')
		.replace(/\bBearer\s+\S+/g, 'Bearer [redacted]');
}

// ---- the workspace side -----------------------------------------------------------------------

/** Every setup unit the loaded extensions contribute, with its package. */
export const units = (ws) => (ws.extensions ?? []).flatMap((e) => (e.setup ?? []).map((u) => ({ ...u, module: e.name, dir: e.dir })));
export const skippedUnits = (ws) => ws.pkg?.dreamteamer?.setup?.skipped ?? [];
export const receiptDir = (ws, unitId) => path.join(ws.root, RUNTIME_DIR, 'setup', unitId);

/** The environment a unit sees: the process's, with the workspace `.env` filling what it lacks. */
export function unitEnv(ws, processEnv = process.env) {
	const file = path.join(ws.root, '.env');
	const dotenv = fs.existsSync(file) ? parseEnvValues(fs.readFileSync(file, 'utf8')) : new Map();
	return { ...Object.fromEntries(dotenv), ...processEnv };
}

/** Run one unit: inspect → plan(inputs) → apply what is consented → inspect. Never throws for a
 *  provider's fault: a throwing apply is one failed action, redacted, and the unit reads blocked. */
export async function runUnit(ws, unit, { inputs = {}, allow = new Set(), tty = false, ask = null, authorize = false, verify = false, processEnv = process.env, api = null, drop = [] } = {}) {
	// the env is re-read after every applied action: a safe action's whole point is often to write the
	// key the next inspect reads (`PROBE_HOME=` into .env), and a stale copy would report it missing.
	// `drop` names the keys whose value the engine refused (a secret-path that is missing or not
	// owner-only): the unit never sees them, so it can neither trust nor record them
	const envFor = () => { const e = unitEnv(ws, processEnv); for (const k of drop) delete e[k]; return e; };
	const ctx = { root: ws.root, ws, dt: api, env: envFor(), tty, receiptDir: receiptDir(ws, unit.id) };
	const applied = [], failed = [];
	let pending = [], needs = [];
	const done = new Set(), refused = new Set();
	// the plan is asked again after every applied action: an action's preconditions are often what the
	// previous one made (a venv before the download, a key in .env before the check that reads it), so
	// one pass would leave them pending for a second call that a person should not have to make
	for (let round = 0; round < 50; round++) {
		let planned;
		try { planned = (await unit.plan(ctx, inputs)) ?? {}; } catch (e) { return { checks: safeInspect(unit, ctx), applied, pending, failed: [...failed, { id: 'plan', message: redact(e.message) }], needs }; }
		needs = planned.needs ?? [];
		pending = [];
		let next = null;
		for (const action of planned.actions ?? []) {
			if (done.has(action.id)) continue;
			if (action.state && action.state !== 'ready') { if (action.state !== 'done') pending.push({ ...action, why: action.state === 'needs-input' ? 'needs input' : action.state }); else done.add(action.id); continue; }
			if (refused.has(action.id)) { pending.push({ ...action, why: refused.get?.(action.id) ?? 'declined' }); continue; }
			const isVerify = action.kind === 'verify';
			if (isVerify && !verify) { pending.push({ ...action, why: 'run with --verify' }); continue; }
			if ((action.runBy === 'owner' || (action.effects ?? []).some((e) => e.kind === 'account')) && !(authorize && tty)) { pending.push({ ...action, why: 'the owner\'s step: dt setup <unit> --authorize' }); continue; }
			if (!next) next = action; else pending.push({ ...action, why: 'after the step before it' });
		}
		if (!next) break;
		if (!(await consent(next, { allow, tty, ask, authorize }))) {
			refused.add(next.id);
			pending.push({ ...next, why: `needs --allow ${[...new Set((next.effects ?? []).map((e) => e.kind).filter((k) => k !== 'workspace-files'))].join(' --allow ')}` });
			// the actions queued behind it stay listed as they are; nothing else can run this round
			continue;
		}
		done.add(next.id);
		try {
			const r = (await unit.apply(ctx, next, inputs)) ?? { ok: false, message: 'apply returned nothing' };
			if (r.ok) { applied.push({ id: next.id, changed: r.changed ?? [], message: r.message }); ctx.env = envFor(); }
			else failed.push({ id: next.id, message: redact(r.message ?? 'apply refused') });
		} catch (e) { failed.push({ id: next.id, message: redact(e.message) }); }
	}
	// the final word on what is still open comes from one more plan, so a declined action and the ones
	// behind it read with their own states, never as "after the step before it"
	try {
		const last = (await unit.plan(ctx, inputs)) ?? {};
		needs = last.needs ?? needs;
		pending = (last.actions ?? []).filter((a) => !done.has(a.id) && a.state !== 'done').map((a) => {
			if (a.state && a.state !== 'ready') return { ...a, why: a.state === 'needs-input' ? 'needs input' : a.state };
			if (a.kind === 'verify' && !verify) return { ...a, why: 'run with --verify' };
			if (a.runBy === 'owner' || (a.effects ?? []).some((e) => e.kind === 'account')) return { ...a, why: 'the owner\'s step: dt setup <unit> --authorize' };
			return { ...a, why: `needs --allow ${[...new Set((a.effects ?? []).map((e) => e.kind).filter((k) => k !== 'workspace-files'))].join(' --allow ')}` };
		});
	} catch { /* the loop's own view stands */ }
	return { checks: safeInspect(unit, ctx), applied, pending, failed, needs };
}

function safeInspect(unit, ctx) {
	try { const r = unit.inspect(ctx); return Array.isArray(r?.checks) ? r.checks : []; } catch (e) { return [{ id: `${unit.id}.inspect`, status: 'blocked', title: 'inspect', detail: redact(e.message) }]; }
}

/** The setup section of `dt status`: one entry per unit, then one per package with no unit. */
export function statusLines(ws, { processEnv = process.env } = {}) {
	const env = unitEnv(ws, processEnv);
	const lines = [];
	const skipped = new Set(skippedUnits(ws));
	const byModule = new Map();
	for (const u of units(ws)) (byModule.get(u.module) ?? byModule.set(u.module, []).get(u.module)).push(u);
	for (const [module, us] of byModule) {
		for (const u of us) {
			// the same rule as setup: a secret-path the environment holds that is missing or not owner-only is
			// never handed to the unit — status shows it as its own missing row, with the fix
			const unitEnvHere = { ...env };
			const refused = [];
			for (const i of u.inputs ?? []) {
				if (i.kind !== 'secret-path' || !i.env || unitEnvHere[i.env] === undefined || String(unitEnvHere[i.env]).trim() === '') continue;
				const problem = secretPathProblem(expandHome(String(unitEnvHere[i.env]), os.homedir()));
				if (problem) { delete unitEnvHere[i.env]; refused.push({ id: `${u.id}.${i.id}`, status: 'missing', title: i.title ?? i.id, detail: problem, fix: `dt setup ${u.id} --input ${i.id}=<path>` }); }
			}
			const ctx = { root: ws.root, ws, dt: null, env: unitEnvHere, tty: false, receiptDir: receiptDir(ws, u.id) };
			const checks = [...refused, ...safeInspect(u, ctx)];
			const f = fold(checks, { skipped: skipped.has(u.id) });
			lines.push({ package: module, unit: u.id, grouped: us.length > 1, ...f, checks, next: nextCommand(u.id, f, checks) });
		}
	}
	// a skip entry no installed package provides is not silent: one line names it and how to clear it
	const provided = new Set([...byModule.values()].flat().map((u) => u.id));
	for (const id of skipped) if (!provided.has(id)) lines.push({ package: null, unit: id, grouped: false, state: 'skipped', detail: 'no installed package provides it', verified: null, checks: [], next: `remove "${id}" from dreamteamer.setup.skipped in package.json` });
	// every other installed module — an extension without a unit, or a plain module with no code at all —
	// reads `no setup`, naming the declared env keys and vars nobody set; the engine and the workspace's own
	// module are not modules anybody installs
	const own = ws.pkg?.dreamteamer?.workspace_module ?? 'default';
	for (const m of discoverModules(ws.root, ws.pkg).modules) {
		let manifest = {};
		try { manifest = JSON.parse(fs.readFileSync(path.join(m.root, 'package.json'), 'utf8')); } catch { /* no manifest */ }
		const name = manifest.name ?? m.name;
		if (name === 'dreamteamer' || m.name === own || byModule.has(name)) continue;
		const dt = manifest.dreamteamer ?? {};
		const needs = [...(dt.env ?? []), ...(dt.vars ?? [])].filter((k) => env[k] === undefined || String(env[k]).trim() === '');
		lines.push({ package: name, unit: null, state: 'no-setup', detail: needs.length ? `needs: ${needs.join(', ')}` : '', verified: null, checks: [], next: needs.length ? `set ${needs.join(', ')} in .env` : '' });
	}
	return lines;
}

function nextCommand(unitId, f, checks) {
	if (f.state === 'skipped') return `dt setup ${unitId}`;
	if (f.state === 'ready') return '';
	const fix = checks.find((c) => c.status !== 'ready' && c.status !== 'configured' && c.fix)?.fix;
	return fix ?? `dt setup ${unitId}`;
}

export function renderStatusLines(lines) {
	if (!lines.length) return [];
	const out = ['setup:'];
	const label = (l) => (l.unit ? (l.grouped ? `${moduleId(l.package)} › ${l.unit}` : l.unit) : moduleId(l.package));
	const width = Math.max(...lines.map((l) => label(l).length));
	for (const l of lines) {
		const state = l.state === 'no-setup' ? 'no setup' : l.state === 'no-evidence' ? 'no evidence' : l.state;
		const verified = l.verified ? ` · verified ${l.verified}` : '';
		out.push(`  ${label(l).padEnd(width)}  ${state}${verified}${l.detail ? `   ${l.detail}` : ''}${l.next ? `   → ${l.next}` : ''}`);
	}
	return out;
}
const moduleId = (name) => String(name).replace(/^@[^/]+\//, '');

/** Record a skip (or clear one) in package.json → dreamteamer.setup.skipped, keeping the file's own indentation. */
export function setSkipped(ws, unitId, on) {
	const file = path.join(ws.root, 'package.json');
	const text = fs.readFileSync(file, 'utf8');
	const indent = /^\t/m.test(text) ? '\t' : (/^( +)"/m.exec(text)?.[1] ?? '  ');
	const pkg = JSON.parse(text);
	const block = (pkg.dreamteamer ??= {});
	const list = new Set(block.setup?.skipped ?? []);
	if (on) list.add(unitId); else list.delete(unitId);
	if (list.size) (block.setup ??= {}).skipped = [...list].sort();
	else if (block.setup) { delete block.setup.skipped; if (!Object.keys(block.setup).length) delete block.setup; }
	fs.writeFileSync(file, JSON.stringify(pkg, null, indent) + '\n');
	ws.pkg = pkg;
	try {
		execFileSync('git', ['add', '--', 'package.json'], { cwd: ws.root, stdio: 'ignore' });
		execFileSync('git', ['commit', '--quiet', '-m', `dreamteamer: ${on ? 'skip' : 'resume'} setup of ${unitId}`, '--', 'package.json'], { cwd: ws.root, stdio: 'ignore' });
	} catch { /* no repo, or nothing to commit — the file is written either way */ }
}

// ---- the verb -----------------------------------------------------------------------------------

/** The terminal's prompt and y/n, on one readline — `dt setup` and `dt install` share it. */
export function ttyIO() {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return { prompt: ttyPrompt(rl), ask: ttyAsk(rl), close: () => rl.close() };
}
// an EOF (Ctrl-D) at a prompt is no answer — the input stays missing (exit 3), the action declined — never a crash
const question = async (rl, text) => { try { return (await rl.question(text)).trim(); } catch { return ''; } };
const ttyPrompt = (rl) => async (input, def) => {
	const hint = def !== undefined ? ` [${def}]` : input.required ? ' (required)' : ' (enter to skip)';
	const answer = await question(rl, `${input.prompt ?? input.title ?? input.id}${hint}: `);
	return answer === '' ? def : answer;
};
const ttyAsk = (rl) => async (action, kinds) => {
	const effects = (action.effects ?? []).map((e) => `${e.kind}: ${e.detail}`).join('\n    ');
	const answer = (await question(rl, `${action.title} — ${kinds.join(', ')}\n    ${effects}\n  run it? [y/N] `)).toLowerCase();
	return answer === 'y' || answer === 'yes';
};

/**
 * `dt setup [<unit>] [--input k=v]… [--allow <kind>]… [--authorize] [--verify] [--skip] [--no-input] [--json]`
 * Exit: 0 done (pending and blocked steps printed — a unit's own failure is its blocked line, never a crash), 2 usage, 3 a required input missing.
 */
export async function setupCommand(ws, argv, { processEnv = process.env, tty = !!(process.stdin.isTTY && process.stdout.isTTY), log = console.log, api = null, io = null } = {}) {
	const env = unitEnv(ws, processEnv);
	const json = argv.includes('--json');
	const noInput = json || argv.includes('--no-input');
	const flags = { authorize: argv.includes('--authorize'), verify: argv.includes('--verify'), skip: argv.includes('--skip') };
	let allow, inputFlags;
	try { allow = parseAllow(argv); inputFlags = parseInputFlags(argv); } catch (e) { if (e instanceof SetupUsage) { console.error(`✖ ${e.message}`); return EXIT.usage; } throw e; }
	const target = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--input' && argv[i - 1] !== '--allow');
	const all = units(ws);
	const chosen = target ? all.filter((u) => u.id === target) : all;
	if (target && !chosen.length) { console.error(`✖ no setup unit "${target}" — installed units: ${all.map((u) => u.id).join(', ') || '(none)'}`); return EXIT.usage; }
	if (!all.length) { log('— no installed module declares setup — `dt status` lists what is installed, `dt install <package>` adds a module'); return EXIT.done; }
	if (flags.authorize && !target) { console.error('✖ --authorize takes one unit: dt setup <unit> --authorize'); return EXIT.usage; }
	if (flags.authorize && !tty) { console.error('✖ --authorize needs a terminal: the owner signs in; a script cannot'); return EXIT.usage; }
	if (flags.skip) {
		if (!target) { console.error('✖ --skip takes one unit: dt setup <unit> --skip'); return EXIT.usage; }
		setSkipped(ws, target, true);
		log(`— ${target}: skipped (dt setup ${target} to resume)`);
		return EXIT.done;
	}
	if (target && skippedUnits(ws).includes(target)) { setSkipped(ws, target, false); log(`✔ ${target}: no longer skipped`); }
	const skipped = new Set(skippedUnits(ws));
	const run = chosen.filter((u) => !skipped.has(u.id));
	const term = tty && !noInput && !io ? ttyIO() : null;
	const prompt = io?.prompt ?? term?.prompt ?? null;
	const ask = io?.ask ?? term?.ask ?? null;
	let code = EXIT.done;
	const results = [];
	try {
		const filled = await fillInputs(run, { flags: inputFlags, env, tty, noInput, prompt });
		for (const u of run) {
			const r = await runUnit(ws, u, { inputs: filled.inputs.get(u.id) ?? {}, allow, tty, ask, authorize: flags.authorize, verify: flags.verify, processEnv, api, drop: droppedKeys(filled.problems, u.id) });
			const problems = filled.problems.filter((m) => m.unit === u.id);
			const missing = [...filled.missing.filter((m) => m.unit === u.id).map((m) => m.id), ...problems.filter((m) => m.required).map((m) => m.id)];
			const f = fold(r.failed.length ? [...r.checks, ...r.failed.map((x) => ({ id: x.id, status: 'blocked', title: x.id, detail: x.message }))] : r.checks, {});
			results.push({ id: u.id, module: u.module, ...f, checks: r.checks, applied: r.applied, pending: r.pending, failed: r.failed, problems, needs: [...new Set([...missing, ...r.needs])] });
			if (missing.length) code = Math.max(code, EXIT.needsInput);
		}
		for (const u of chosen.filter((x) => skipped.has(x.id))) results.push({ id: u.id, module: u.module, ...fold([], { skipped: true }), checks: [], applied: [], pending: [], failed: [], needs: [] });
	} catch (e) {
		if (e instanceof SetupUsage) { console.error(`✖ ${e.message}`); return EXIT.usage; }
		throw e;
	} finally { term?.close(); }
	if (json) { log(JSON.stringify({ workspace: { root: ws.root, name: ws.pkg?.name ?? null }, units: results }, null, 2)); return code; }
	for (const r of results) {
		const verified = r.verified ? ` · verified ${r.verified}` : '';
		log(`${r.state === 'ready' ? '✔' : r.state === 'blocked' ? '✖' : '—'} ${r.id}: ${r.state}${verified}${r.detail ? ` — ${r.detail}` : ''}`);
		for (const a of r.applied) log(`    ✔ ${a.id}${a.message ? ` — ${a.message}` : ''}`);
		for (const f of r.failed) log(`    ✖ ${f.id} — ${f.message}`);
		for (const p of r.problems ?? []) log(`    ✖ ${p.id} — ${p.reason}`);
		for (const p of r.pending) log(`    … ${p.id} (${p.why})${p.reason ? ` — ${p.reason}` : ''}`);
		if (r.needs.length) log(`    needs input: ${r.needs.join(', ')} — --input ${r.needs[0]}=<value>`);
	}
	return code;
}
