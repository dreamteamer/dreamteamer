// `dt doctor` — one board of what works in THIS environment: the engine's own rows, then each
// extension's `doctor` contribution as one capability. A capability is READY (every row ok),
// DEGRADED (a warning: the workspace still works) or UNAVAILABLE (a failure), and every row that is
// not ok carries its fix on the same line. No network call; exit 0 unless --strict finds a failure.
import fs from 'node:fs';
import path from 'node:path';
import { engineId, readManifest } from './runtime.js';
import { satisfies } from './semver.js';
import { MANAGED_BLOCKS } from './harnesses.js';

const STATES = new Set(['ok', 'warn', 'bad']);
const GLYPH = { ok: '✔', warn: '⚠', bad: '✖' };

export const verdictOf = (checks) => (checks.some((k) => k.state === 'bad') ? 'UNAVAILABLE'
	: checks.some((k) => k.state === 'warn') ? 'DEGRADED' : 'READY');

const hasBlock = (file) => {
	try { const text = fs.readFileSync(file, 'utf8'); return MANAGED_BLOCKS.some((b) => text.includes(b.begin)); } catch { return false; }
};

/** The engine's rows: its version, the Node it runs on, and the harness files the last compile wrote. */
function engineChecks(root) {
	const need = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node ?? '>=20';
	const node = process.versions.node;
	const checks = [
		{ label: 'engine', state: 'ok', detail: engineId() },
		satisfies(node, need) === false
			? { label: 'node', state: 'bad', detail: `${node}, needs ${need}`, fix: `install Node.js ${need}` }
			: { label: 'node', state: 'ok', detail: node },
	];
	const manifest = readManifest(root);
	if (!manifest) return [...checks, { label: 'harness files', state: 'bad', detail: 'never compiled', fix: 'dt compile' }];
	const blocks = manifest['adapter-blocks'] ?? [];
	const missing = [...blocks.filter((f) => !hasBlock(path.join(root, f))), ...(manifest['adapter-outputs'] ?? []).filter((f) => !fs.existsSync(path.join(root, f)))];
	checks.push(missing.length
		? { label: 'harness files', state: 'warn', detail: `${missing.length} missing (${missing.slice(0, 3).join(', ')})`, fix: 'dt compile' }
		: { label: 'harness files', state: 'ok', detail: blocks.join(', ') || 'no harness declared' });
	return checks;
}

/** Every capability with its verdict. An extension's doctor that throws, or returns a row with an
 *  unknown state, reads as a failure of that extension rather than a crash. */
export async function doctorBoard(ws, dt) {
	const caps = [{ name: 'engine', checks: engineChecks(ws.root) }];
	for (const e of (ws.extensions ?? []).filter((x) => x.doctor)) {
		const name = e.name.replace(/^@[^/]+\//, '');
		let checks;
		try { checks = (await e.doctor({ root: ws.root, ws, dt })) ?? []; } catch (err) { checks = [{ label: 'doctor', state: 'bad', detail: err.message, fix: `report it to ${e.name}` }]; }
		caps.push({ name, checks: checks.map((k) => (STATES.has(k?.state) ? k : { ...k, state: 'bad', detail: `unknown state ${JSON.stringify(k?.state)}` })) });
	}
	return caps.map((c) => ({ ...c, verdict: verdictOf(c.checks) }));
}

export function renderBoard(caps) {
	return caps.flatMap((c) => [`${c.name} — ${c.verdict}`, ...c.checks.map((k) =>
		`  ${GLYPH[k.state]} ${k.label}${k.detail ? `  ${k.detail}` : ''}${k.state !== 'ok' && k.fix ? ` — fix: ${k.fix}` : ''}`)]).join('\n');
}
