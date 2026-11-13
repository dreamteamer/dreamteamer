// @probe/setup — the engine's own test double for the setup contract. It is what every unit the
// engine ever drives looks like from the engine's side: inputs of every kind, checks in every status,
// actions carrying every effect kind, a receipt-writing verify, and switches that make it misbehave.
//   PROBE_THROW=apply   apply() throws (with a secret in the message, which must be redacted)
//   PROBE_THROW=inspect inspect() throws (one bad doctor row, a blocked status line)
//   PROBE_BLOCK=1       the download is blocked, with a reason the line must carry
//   PROBE_EMPTY=1       inspect() returns zero checks (the "no evidence" line)
//   PROBE_TOUCH_ENV=1   plan() appends a comment to .env — the file moves after the fingerprint the
//                       engine took before plan, so the env action's write must refuse (cr-dt-007)
//   PROBE_NOAPPLY=1     the unit is declared without apply (read at load)
//   PROBE_EXTRA=1       plan() adds a non-env action `extra` (fails by name on an apply-less unit)
//   PROBE_CTX_LOG=<f>   inspect() appends `<verb>=<typeof ctx.dt>` to the file, for the ctx table
// Since 0.48.0 make-home is an ENV ACTION: the unit names the keys and values, the engine writes .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const apiVersion = 1;

const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

/** The probe's home: the filled input first, else the environment the engine handed over, else the default. */
const homeOf = (ctx, inputs = {}) => expand(inputs.home ?? ctx.env?.PROBE_HOME ?? '~/.cache/probe');
const envFile = (ctx) => path.join(ctx.root, '.env');
const receiptFile = (ctx) => path.join(ctx.receiptDir, 'verify.json');

function inspect(ctx) {
	if (ctx.env?.PROBE_CTX_LOG) {
		// which verb is running is not something a unit knows; the argv of the engine process says
		const verb = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? '?';
		fs.appendFileSync(ctx.env.PROBE_CTX_LOG, `${verb}=${ctx.dt === null ? 'null' : typeof ctx.dt}\n`);
	}
	if (ctx.env?.PROBE_THROW === 'inspect') throw new Error('probe inspect exploded: secret=hunter2');
	if (ctx.env?.PROBE_EMPTY) return { checks: [] };
	const home = homeOf(ctx);
	const token = ctx.env?.PROBE_TOKEN_PATH;
	const receipt = exists(receiptFile(ctx)) ? JSON.parse(fs.readFileSync(receiptFile(ctx), 'utf8')) : null;
	const row = (id, ok, title, detail, fix) => ({ id, status: ok ? 'configured' : 'missing', title, detail, fix });
	return { checks: [
		row('probe.home', exists(home), 'probe home', exists(home) ? 'the folder exists' : 'no folder yet', 'dt setup probe'),
		row('probe.label', !!ctx.env?.PROBE_LABEL, 'label', ctx.env?.PROBE_LABEL ? 'set' : 'PROBE_LABEL is unset', 'dt setup probe --input label=<label>'),
		row('probe.token', !!token && exists(expand(token)), 'token file', token ? (exists(expand(token)) ? 'present (never read)' : 'the configured path does not exist') : 'PROBE_TOKEN_PATH is unset', 'set PROBE_TOKEN_PATH'),
		row('probe.weights', exists(path.join(home, 'weights.txt')), 'weights', 'downloaded weights', 'dt setup probe --allow download'),
		row('probe.tuned', exists(path.join(home, 'tuned')), 'tuned', 'machine tuning', 'dt setup probe --allow machine'),
		{ id: 'probe.live', status: receipt ? 'ready' : 'unverified', title: 'live check', detail: receipt ? `verified ${receipt.at}` : 'never verified', fix: 'dt setup probe --verify --allow machine', evidence: receipt ? { at: receipt.at } : undefined },
	] };
}

function plan(ctx, inputs = {}) {
	if (ctx.env?.PROBE_TOUCH_ENV) fs.appendFileSync(envFile(ctx), `# touched ${Date.now()}\n`);
	const { checks } = inspect(ctx);
	const home = homeOf(ctx, inputs);
	const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
	const needs = inputs.label === undefined ? ['label'] : [];
	const actions = [
		// the env action: keys and values; state, done-ness, consent and the write are the engine's
		{ id: 'make-home', title: 'write PROBE_HOME and PROBE_LABEL into .env', env: { PROBE_HOME: inputs.home ?? ctx.env?.PROBE_HOME ?? '~/.cache/probe', PROBE_LABEL: inputs.label }, state: needs.length ? 'needs-input' : 'ready' },
		...(ctx.env?.PROBE_EXTRA ? [{ id: 'extra', title: 'an action with no env', effects: [{ kind: 'workspace-files', detail: 'nothing' }], runBy: 'engine', state: 'ready' }] : []),
		{ id: 'fetch', title: 'download the weights', effects: [{ kind: 'download', detail: `${home}/weights.txt (synthetic, 12 bytes)` }], runBy: 'engine', ...(ctx.env?.PROBE_BLOCK ? { state: 'blocked', reason: 'the weights server is down (simulated)' } : { state: status['probe.weights'] === 'configured' ? 'done' : 'ready' }) },
		{ id: 'tune', title: 'tune the machine', effects: [{ kind: 'machine', detail: `${home}/tuned` }], runBy: 'engine', state: status['probe.tuned'] === 'configured' ? 'done' : 'ready' },
		{ id: 'sign-in', title: 'sign in to the probe account', effects: [{ kind: 'account', detail: 'opens a browser (simulated)' }], runBy: 'owner', state: 'ready' },
		{ id: 'verify', title: 'run the live check', kind: 'verify', effects: [{ kind: 'machine', detail: 'runs the probe once and writes the receipt' }], runBy: 'engine', state: status['probe.live'] === 'ready' ? 'done' : 'ready' },
	];
	return { checks, actions, needs };
}

function apply(ctx, action, inputs = {}) {
	if (ctx.env?.PROBE_THROW === 'apply') throw new Error('probe exploded: token=hunter2 at ' + homeOf(ctx, inputs));
	const home = homeOf(ctx, inputs);
	switch (action.id) {
		case 'fetch': fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'weights.txt'), 'synthetic\n'); return { ok: true, changed: [path.join(home, 'weights.txt')] };
		case 'tune': fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'tuned'), ''); return { ok: true, changed: [path.join(home, 'tuned')] };
		case 'sign-in': return { ok: true, changed: [], message: 'signed in (simulated)' };
		case 'verify': {
			fs.mkdirSync(ctx.receiptDir, { recursive: true });
			const receipt = { what: 'probe ran once', at: new Date().toISOString().slice(0, 10), home };
			fs.writeFileSync(receiptFile(ctx), JSON.stringify(receipt, null, 2) + '\n');
			return { ok: true, changed: [receiptFile(ctx)], message: 'receipt written' };
		}
		default: return { ok: false, changed: [], message: `unknown action ${action.id}` };
	}
}

export default function activate() {
	return {
		setup: [{
			id: 'probe', version: 1,
			inputs: [
				{ id: 'home', kind: 'path', env: 'PROBE_HOME', title: 'probe home', default: '~/.cache/probe', prompt: 'Where should probe keep its files?' },
				{ id: 'label', kind: 'string', env: 'PROBE_LABEL', required: true, title: 'label', prompt: 'A label for this workspace' },
				{ id: 'token', kind: 'secret-path', env: 'PROBE_TOKEN_PATH', title: 'token file', prompt: 'Path to the probe token file (never read)' },
				{ id: 'rows', kind: 'rows', title: 'rows', rows: { columns: ['name', 'value'] } },
			],
			inspect, plan, ...(process.env.PROBE_NOAPPLY ? {} : { apply }),
		}],
	};
}
