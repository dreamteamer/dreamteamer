// dt exports [--layer <name> …] [--dry-run] [--json] — write a repo's exports manifest from this
// context (cr-dt-004). Bare: this workspace's own; --layer: that layer's, written into its clone — how a
// reader records the ids a layer names in the reader, which the layer alone cannot see. The rules are
// src/exports.js `regenerate`, shared with `check`, so `check` names a manifest stale exactly when this
// would change or drop one of its entries. Writes and commits ONE path, `dreamteamer-exports.json`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseRecord } from './records.js';
import { inProgress } from './commit.js';
import { exportsFacts } from './runtime.js';
import { storageOf, bodyFieldOf, recordTitleOf } from './descriptor.js';
import { EXPORTS_FILE, readExports, serializeExports, exportsContext, outsideRefs, regenerate } from './exports.js';

/** The manifest `dt exports` would write for `repo` (null: this workspace) and what changes. */
export function planExports(store, repo) {
	const facts = exportsFacts(store.root);
	const ctx = exportsContext({ root: store.root, descriptors: store.descriptors, own: facts.own, layers: facts.layers, dataPath: facts.data });
	const readableD = (d) => d && !storageOf(d).runtime && !storageOf(d).unavailable;
	const readable = [...store.descriptors.values()].filter(readableD);
	// an unparseable record (a conflict mid-merge) is check's to report — skipped here, never fatal
	const fieldsAt = (d, file) => { try { return parseRecord(file, d, bodyFieldOf(d)); } catch { return null; } };
	const repoOf = (c, id) => {
		const d = store.descriptors.get(c);
		const f = readableD(d) ? store.ids(c).get(id) : undefined;
		return f ? store.layerOfFile(d, f)?.layer ?? null : undefined;
	};
	const titled = (d, id, file) => {
		if (storageOf(d).format === 'binary') return id;
		const t = /\{\{\s*([A-Za-z_][\w]*)/.exec(recordTitleOf(d))?.[1];
		return String(fieldsAt(d, file)?.[t] ?? id);
	};
	const records = readable.flatMap((d) => [...store.ids(d.name)]
		.filter(([id]) => repoOf(d.name, id) === repo && storageOf(d).format !== 'binary')
		.map(([id, file]) => ({ collection: d.name, id, descriptor: d, fields: fieldsAt(d, file) })).filter((r) => r.fields));
	const resolve = (c, id) => (repoOf(c, id) === undefined ? null : { label: titled(store.descriptors.get(c), id, store.ids(c).get(id)), from: ctx.packageOf(repoOf(c, id)) });
	const held = (c, id) => repoOf(c, id) === repo;
	const dir = ctx.rootOf(repo);
	const current = readExports(dir); // throws on an unparseable file, naming it — never overwritten
	const outside = outsideRefs({ records, held, resolve, namespaces: store.namespaces });
	const { next, changes } = regenerate({ current: current ?? {}, outside, ctx, repo, held });
	return { dir, file: path.join(dir, EXPORTS_FILE), text: serializeExports(next), changes, entries: Object.values(next).reduce((n, m) => n + Object.keys(m).length, 0) };
}

/** Write (and commit) each named repo's manifest; returns the exit code. */
export function runExports(store, { layers = [], dryRun = false, json = false } = {}) {
	const known = new Set((exportsFacts(store.root).layers ?? []).map((l) => l.name));
	for (const l of layers) if (!known.has(l)) throw new Error(`--layer ${l}: not a record layer of this workspace (have: ${[...known].join(', ') || 'none'})`);
	const out = [];
	for (const repo of layers.length ? layers : [null]) {
		const plan = planExports(store, repo);
		const before = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : null;
		const where = path.relative(store.root, plan.file);
		let committed = null;
		let note = null;
		if (!dryRun && before !== plan.text) {
			if (plan.text === null) fs.rmSync(plan.file); else fs.writeFileSync(plan.file, plan.text);
			// a merge, rebase, cherry-pick or revert refuses a one-path commit: write, and say how to finish
			const busy = inProgress(plan.dir);
			if (busy) note = `${busy} — the manifest is written; git add it and conclude it`;
			else {
				const git = (args) => {
					try { return execFileSync('git', args, { cwd: plan.dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
					catch (e) { throw new Error(`git ${args[0]} in ${path.relative(store.root, plan.dir) || '.'} failed: ${String(e.stderr || e.message).trim()}`); }
				};
				// an emptied manifest git never tracked: nothing to add, nothing to commit
				// an emptied manifest is un-staged with --ignore-unmatch: one git never tracked leaves nothing to commit
				git(plan.text === null ? ['rm', '--cached', '-q', '--ignore-unmatch', '--', EXPORTS_FILE] : ['add', '--', EXPORTS_FILE]);
				// back to what HEAD already holds (a hand edit undone), or never tracked: nothing to commit
				let same = false;
				try { execFileSync('git', ['diff', '--cached', '--quiet', 'HEAD', '--', EXPORTS_FILE], { cwd: plan.dir, stdio: 'ignore' }); same = true; } catch { /* differs, or no HEAD yet */ }
				if (!same) {
					git(['commit', '--only', '-q', '-m', `dreamteamer: exports — ${plan.entries} entr${plan.entries === 1 ? 'y' : 'ies'}`, '--', EXPORTS_FILE]);
					committed = git(['rev-parse', '--short', 'HEAD']);
				}
			}
		}
		const count = (k) => plan.changes.filter((c) => c.kind === k).length;
		out.push({ repo, path: where, changed: before !== plan.text, changes: plan.changes, entries: plan.entries, committed, note });
		if (json) continue;
		console.log(before === plan.text
			? `✔ ${repo ?? 'this workspace'} · ${where} — exports manifest current (${plan.entries} entr${plan.entries === 1 ? 'y' : 'ies'})`
			: `${dryRun ? '·' : '✔'} ${repo ?? 'this workspace'} · ${where} — ${count('add')} added, ${count('refresh') + count('fill')} changed, ${count('drop')} dropped (${plan.entries} entr${plan.entries === 1 ? 'y' : 'ies'})${dryRun ? ' — dry run, nothing written' : committed ? ` · committed ${committed}` : ''}`);
		for (const c of plan.changes) console.log(`    ${c.kind} ${c.ref} — ${c.why}`);
		if (note) console.log(`⚠ ${note}`);
	}
	if (json) console.log(JSON.stringify({ dryRun, manifests: out }, null, 2));
	return 0;
}
