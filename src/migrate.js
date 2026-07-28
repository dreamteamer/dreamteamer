// dreamteamer migrate — schema migrations, the M4 contract (decision 39, proxy-amended):
// migrations are MODULE-SHIPPED records (system/migrations/<seq>--<slug>.migration.yaml),
// applied ONLY by this explicit verb. per migration: rewrite affected records in memory,
// re-validate the collection, write the LEDGER record, and land everything in ONE commit —
// the single revert unit ("down" = `git revert` that commit; the ledger dies with it, so
// pending recomputes correctly). ops are idempotent; re-application is harmless. dirty
// affected files = refusal (rollback-by-checkout is only safe from clean state).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from './yaml.js';
import { Store, bodyField, serialize, atomicWrite } from './store.js';
import { readManifest } from './compile.js';
import { parseRecord } from './records.js';

export function pendingMigrations(root) {
	const manifest = readManifest(root);
	if (!manifest) return [];
	const all = [];
	for (const [rt, entry] of Object.entries(manifest.entries ?? {})) {
		const m = /^system\/migrations\/(\d+)--(.+)\.migration\.yaml$/.exec(rt);
		if (!m) continue;
		const srcPath = typeof entry.sources[0] === 'string' ? entry.sources[0] : entry.sources[0].path;
		const owner = (manifest.modules ?? []).find((mod) => mod.root !== '.' && srcPath.startsWith(mod.root + '/'));
		all.push({
			id: `${m[1]}--${m[2]}`,
			seq: Number(m[1]),
			module: owner?.name ?? manifest.modules?.find((mod) => mod.root === '.')?.name ?? 'workspace',
			file: path.join(root, '.dreamteamer', rt),
		});
	}
	// applied ledger — state records, read directly (this runs from compile too, pre-Store)
	const ledgerDir = path.join(root, 'state', 'migration-runs');
	const applied = new Set();
	if (fs.existsSync(ledgerDir)) {
		for (const f of fs.readdirSync(ledgerDir)) {
			if (!f.endsWith('.migration-run.yaml')) continue;
			const doc = load(fs.readFileSync(path.join(ledgerDir, f), 'utf8')) ?? {};
			applied.add(`${doc.module}|${doc.seq}`);
		}
	}
	return all
		.filter((mg) => !applied.has(`${mg.module}|${mg.seq}`))
		.sort((a, b) => (a.module === b.module ? a.seq - b.seq : a.module.localeCompare(b.module)));
}

export function migrate(ws, { dryRun = false } = {}) {
	const store = new Store(ws);
	const pending = pendingMigrations(ws.root);
	const report = { pending: pending.map((p) => `${p.module}/${p.id}`), applied: [], warnings: [], dryRun };

	for (const mg of pending) {
		const doc = load(fs.readFileSync(mg.file, 'utf8'));
		const d = store.descriptor(String(doc.collection).replace(/^collections\//, ''));
		if (d.storage.path.startsWith('system/')) throw new Error(`${mg.id}: migrations apply to data/state collections — "${d.name}" is system-stored`);
		const bf = bodyField(d);

		// dirty-tree guard: every affected record file must be clean
		const dirty = execFileSync('git', ['status', '--porcelain', '--', d.storage.path], { cwd: ws.root })
			.toString().trim();
		if (dirty) throw new Error(`${mg.module}/${mg.id}: uncommitted changes under ${d.storage.path} — commit or stash first, migrate refuses on a dirty tree:\n${dirty}`);

		// apply ops in memory, idempotently
		const changed = [];
		const counts = {};
		for (const [id, file] of store.ids(d.name)) {
			let fields = parseRecord(file, d, bf);
			let touched = false;
			for (const op of doc.operations ?? []) {
				const k = op.op;
				counts[k] ??= 0;
				if (k === 'rename-field') {
					if (!(op.from in fields)) continue; // idempotent: already renamed / never had it
					if (op.to in fields) {
						report.warnings.push(`⚠ ${d.name}/${id}: both "${op.from}" and "${op.to}" present — skipped (resolve by hand)`);
						continue;
					}
					fields[op.to] = fields[op.from];
					delete fields[op.from];
					touched = true; counts[k]++;
				} else if (k === 'fill-default') {
					if (fields[op.field] !== undefined) continue; // fill only where MISSING
					fields[op.field] = op.value;
					touched = true; counts[k]++;
				} else if (k === 'remove-field') {
					if (!(op.field in fields)) continue;
					delete fields[op.field];
					touched = true; counts[k]++;
				} else {
					throw new Error(`${mg.id}: unknown op "${k}" (known: rename-field, fill-default, remove-field)`);
				}
			}
			if (touched) changed.push({ id, file, fields });
		}

		// rename cascade scan (decision-34 pattern: count + warn, never touch): the old field
		// name may survive in ui-view/trigger configs and the descriptor's own list_fields —
		// AND in command-binding can-enter/can-exit predicates or workflow step prompts. those two
		// were the blind spot: filter.js NARROWS on an unknown key, so a stale binding predicate
		// silently reports not-applicable for every record instead of failing loudly.
		for (const op of (doc.operations ?? []).filter((o) => o.op === 'rename-field')) {
			const needle = new RegExp(`\\b${op.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
			const suspects = [];
			if ((d.list_fields ?? []).includes(op.from)) suspects.push(`descriptor list_fields (module-owned — update the source)`);
			for (const scanDir of [
				path.join(ws.root, '.dreamteamer', 'system', 'ui-views'),
				path.join(ws.root, '.dreamteamer', 'system', 'command-bindings'),
				path.join(ws.root, '.dreamteamer', 'system', 'workflows'),
				path.join(ws.root, 'state', 'workflow-triggers'),
			]) {
				if (!fs.existsSync(scanDir)) continue;
				for (const f of fs.readdirSync(scanDir)) {
					const p = path.join(scanDir, f);
					if (fs.statSync(p).isFile() && needle.test(fs.readFileSync(p, 'utf8'))) suspects.push(path.relative(ws.root, p));
				}
			}
			if (suspects.length) report.warnings.push(`⚠ rename ${d.name}.${op.from}→${op.to}: "${op.from}" still referenced by: ${suspects.join(', ')} — review by hand (never auto-rewritten)`);
		}

		if (dryRun) {
			report.applied.push({ migration: `${mg.module}/${mg.id}`, collection: d.name, wouldChange: changed.length, ops: counts });
			continue;
		}

		// write + re-validate + ledger, ONE commit; any failure restores from HEAD (clean by guard)
		store.withWriteLock(() => {
			const files = [];
			try {
				for (const c of changed) {
					atomicWrite(c.file, serialize(d, c.fields));
					files.push(c.file);
				}
				for (const c of changed) store.validate(d, structuredClone(c.fields)); // schema + refs, post-op
				// ledger record — SAME commit as the rewrites (proxy amendment: no crash window)
				const ledgerFields = { module: mg.module, seq: mg.seq, migration: mg.id, collection: `collections/${d.name}`, changed: changed.length };
				const ld = store.descriptor('migration-runs');
				store.validate(ld, structuredClone(ledgerFields));
				// full-name shortening, same transform as UI bundles: @a/crm and @b/crm must not share a ledger id
				const ledgerFile = store.filePath(ld, `${mg.module.replace(/^@/, '').replace(/\//g, '--')}--${String(mg.seq).padStart(3, '0')}`);
				fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
				atomicWrite(ledgerFile, serialize(ld, ledgerFields));
				files.push(ledgerFile);
				store.commit(files, `dreamteamer: migrate ${mg.module}/${mg.id} (${d.name}, ${changed.length} record(s))`, () => {
					execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', ...files.map((f) => path.relative(ws.root, f))], { cwd: ws.root });
					fs.rmSync(ledgerFile, { force: true });
				});
			} catch (e) {
				if (files.length) {
					try { execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', ...changed.map((c) => path.relative(ws.root, c.file))], { cwd: ws.root }); } catch { /* nothing tracked changed */ }
				}
				throw new Error(`${mg.module}/${mg.id}: ${e.message}\nmigration rolled back — no records were changed.`);
			}
		});
		report.applied.push({ migration: `${mg.module}/${mg.id}`, collection: d.name, changed: changed.length, ops: counts });
	}
	return report;
}

export function printMigrateReport(r) {
	if (!r.pending.length) { console.log('✔ no pending migrations'); return; }
	for (const a of r.applied) {
		const ops = Object.entries(a.ops).map(([k, n]) => `${k}×${n}`).join(', ') || 'no-op';
		if (r.dryRun) console.log(`  ▶ would apply ${a.migration} → ${a.collection}: ${a.wouldChange} record(s) (${ops})`);
		else console.log(`✔ applied ${a.migration} → ${a.collection}: ${a.changed} record(s) changed (${ops}) — one commit`);
	}
	for (const w of r.warnings) console.log(w);
	if (r.dryRun) console.log('  dry run — nothing written, ledger untouched');
}
