#!/usr/bin/env node
// migrate-stubs — turn every stub record (`stub: true`, engines 0.41.0–0.44.x) into an entry of its repo's
// exports manifest, `dreamteamer-exports.json`, and delete the stub (cr-dt-004). Run it once per workspace
// that holds or reads stubs, on engine 0.45.0, right after `dt compile`:
//
//   node node_modules/dreamteamer/scripts/migrate-stubs.mjs --root <workspace> [--layers] [--dry-run]
//
// --layers also migrates every installed record layer's stubs, from this workspace's view — so an entry
// gets the live label and holder of a record this workspace reads. Per stub: an entry when a record of its
// repo names the id, or when this workspace does not read that repo completely (it cannot know, so it never
// deletes without an entry); label and holder from a non-stub claimant of the id in any root read here,
// else the stub's own title and no holder; then the repo's manifest is regenerated exactly as `dt exports`
// would, and ONE commit per repo holds the manifest and the deleted stubs. --dry-run writes nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { parseRecord, idFromRecordPath, walk } from '../src/records.js';
import { exportsFacts } from '../src/runtime.js';
import { storageOf, bodyFieldOf, recordTitleOf } from '../src/descriptor.js';
import { EXPORTS_FILE, readExports, serializeExports, exportsContext, outsideRefs } from '../src/exports.js';
import { planExports } from '../src/exports-cli.js';

// `stub: true` in the FRONTMATTER only — a body quoting a stub is a real record
const isStubText = (text) => /^stub:\s*true\s*$/m.test(/^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1] ?? '');
const title = (d, fields, id) => String(fields[/\{\{\s*([A-Za-z_][\w]*)/.exec(recordTitleOf(d))?.[1]] ?? id);

/** Every record file of `repo` (null: the workspace), per collection: `[{ d, id, file, stub }]`. */
function filesOf(store, repo) {
	const out = [];
	for (const d of store.descriptors.values()) {
		if (storageOf(d).runtime || storageOf(d).unavailable || storageOf(d).format === 'binary') continue;
		for (const r of store.rootsOf(d)) {
			if ((r.layer ?? null) !== repo || !fs.existsSync(r.abs)) continue;
			for (const file of walk(r.abs)) {
				const id = idFromRecordPath(d, path.relative(r.abs, file).split(path.sep).join('/'));
				if (id !== null) out.push({ d, id, file, stub: isStubText(fs.readFileSync(file, 'utf8')) });
			}
		}
	}
	return out;
}

export function migrate(root, { layers = false, dryRun = false, log = console.log } = {}) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const store = new Store({ root, pkg });
	const facts = exportsFacts(root);
	const ctx = exportsContext({ root, descriptors: store.descriptors, own: facts.own, layers: facts.layers, dataPath: facts.data });
	const repos = [null, ...(layers ? (facts.layers ?? []).filter((l) => fs.existsSync(path.join(root, l.root))).map((l) => l.name) : [])];
	const all = new Map(repos.map((repo) => [repo, filesOf(store, repo)]));
	const report = [];
	for (const repo of repos) {
		const files = all.get(repo);
		const stubs = files.filter((f) => f.stub);
		if (!stubs.length) continue;
		const own = files.filter((f) => !f.stub).map((f) => ({ collection: f.d.name, id: f.id, descriptor: f.d, fields: parseRecord(f.file, f.d, bodyFieldOf(f.d)) }));
		const named = outsideRefs({ records: own, held: () => false, resolve: () => null, namespaces: store.namespaces });
		const complete = ctx.complete(repo);
		const entries = readExports(ctx.rootOf(repo)) ?? {};
		const rows = [];
		for (const s of stubs) {
			const ref = `${s.d.name}/${s.id}`;
			const referrers = named.get(ref)?.referrers ?? [];
			if (!referrers.length && complete) { rows.push({ ref, fate: 'deleted — nothing in its repo references it' }); continue; }
			const real = [...all.values()].flat().find((f) => !f.stub && f.d.name === s.d.name && f.id === s.id);
			const e = real
				? { label: title(real.d, parseRecord(real.file, real.d, bodyFieldOf(real.d)), s.id), from: ctx.packageOf(store.layerOfFile(real.d, real.file)?.layer ?? null) }
				: { label: title(s.d, parseRecord(s.file, s.d, bodyFieldOf(s.d)), s.id) };
			(entries[s.d.name] ??= {})[s.id] = entries[s.d.name][s.id] ?? e;
			rows.push({ ref, fate: `entry ${JSON.stringify(e)}${referrers.length ? ` — named by ${referrers.slice(0, 3).join(', ')}${referrers.length > 3 ? ` +${referrers.length - 3}` : ''}` : ' — kept: this workspace does not read the repo completely'}` });
		}
		const dir = ctx.rootOf(repo);
		log(`${repo ?? 'this workspace'} · ${stubs.length} stub${stubs.length === 1 ? '' : 's'}${dryRun ? ' (dry run — nothing written)' : ''}`);
		for (const r of rows) log(`    ${r.ref} — ${r.fate}`);
		report.push({ repo, rows });
		if (dryRun) continue;
		for (const s of stubs) fs.rmSync(s.file);
		fs.writeFileSync(path.join(dir, EXPORTS_FILE), serializeExports(entries) ?? '{}\n');
		const plan = planExports(new Store({ root, pkg }), repo); // as dt exports would, on the migrated tree
		if (plan.text === null) fs.rmSync(plan.file, { force: true }); else fs.writeFileSync(plan.file, plan.text);
		const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
		// the manifest only when there is one or git tracks one: all-unreferenced stubs leave none to add
		const tracked = git(['ls-files', '--', EXPORTS_FILE]) !== '';
		const paths = [...(tracked || fs.existsSync(path.join(dir, EXPORTS_FILE)) ? [EXPORTS_FILE] : []), ...stubs.map((s) => path.relative(dir, s.file))];
		git(['add', '-A', '--', ...paths]);
		git(['commit', '--only', '-q', '-m', `dreamteamer: migrate ${stubs.length} stub record(s) to ${EXPORTS_FILE}`, '--', ...paths]);
		log(`    ✔ committed ${git(['rev-parse', '--short', 'HEAD'])}`);
	}
	if (!report.length) log('no stub records found');
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const at = argv.indexOf('--root');
	try { migrate(path.resolve(at >= 0 ? argv[at + 1] : '.'), { layers: argv.includes('--layers'), dryRun: argv.includes('--dry-run') }); }
	catch (e) { console.error(`✖ ${e.message}`); process.exit(1); }
}
