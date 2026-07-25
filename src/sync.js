// dreamteamer sync — trigger evaluation over the git cursor (slice 5; deferral lifted by
// the operator, decision 38). derive events since this evaluator's cursor, match enabled
// workflow-trigger records, create run records, advance the cursor. report THEN act THEN
// advance — a failed run creation leaves the cursor behind, and the deterministic dedupe
// key (trigger + item + event commit) makes re-evaluation of the same range create
// nothing twice.
import { execFileSync } from 'node:child_process';
import { Store } from './store.js';
import { deriveEvents, eventCommit } from './events.js';
import { matchesFilter } from './filter.js';
import { createRun } from './runs.js';

export function sync(ws, { evaluator = 'cli', dryRun = false } = {}) {
	const store = new Store(ws);
	const head = git(ws.root, ['rev-parse', 'HEAD']);

	// per-evaluator cursor (decision 37): a laptop and an always-on server never fight
	// over one file. first run starts from the root commit — full history replay is the
	// contract, and dedupe makes it safe.
	let cursor = null;
	try { cursor = store.read('cursors', evaluator).fields['last-evaluated']; } catch { /* first run */ }
	const from = cursor ?? git(ws.root, ['rev-list', '--max-parents=0', 'HEAD']);

	const events = from === head ? [] : deriveEvents(ws.root, store.descriptors, from, head);

	const triggers = [...store.readAll('workflow-triggers')].filter((t) => t.fields.enabled !== false);
	const cronSkipped = triggers.filter((t) => t.fields['trigger-type'] === 'cron').map((t) => t.id);

	// match: trigger-type + collection (+ optional filter over the record's CURRENT fields)
	const matches = [];
	for (const ev of events) {
		for (const t of triggers) {
			const f = t.fields;
			if (f['trigger-type'] !== ev.type) continue;
			const coll = (f.collection ?? '').replace(/^collections\//, '');
			if (coll && coll !== ev.collection) continue;
			if (f.filter) {
				if (ev.type === 'item-removed') continue; // nothing left to match a filter against
				let rec;
				try { rec = store.read(ev.collection, ev.id).fields; } catch { continue; } // gone since the event
				if (!matchesFilter(rec, f.filter)) continue;
			}
			matches.push({ trigger: t.id, workflow: f.workflow, event: ev });
		}
	}

	// idempotency: a run already carrying this (trigger, item, commit) provenance blocks re-creation
	const existing = new Set();
	for (const r of store.readAll('workflow-runs')) {
		if (!r.fields.trigger || !r.fields.commit) continue;
		for (const it of r.fields.items ?? []) existing.add(`${r.fields.trigger}|${it}|${r.fields.commit}`);
	}

	const toCreate = [];
	const deduped = [];
	for (const m of matches) {
		const item = `${m.event.collection}/${m.event.id}`;
		const commit = eventCommit(ws.root, from, head, m.event.path);
		const key = `workflow-triggers/${m.trigger}|${item}|${commit}`;
		(existing.has(key) ? deduped : toCreate).push({ ...m, item, commit });
		existing.add(key); // two matches in one range for the same key collapse to one run
	}

	const created = [];
	if (!dryRun) {
		for (const m of toCreate) {
			const { id } = createRun(store, m.workflow.replace(/^workflows\//, ''), [m.item], {
				trigger: `workflow-triggers/${m.trigger}`,
				commit: m.commit,
			});
			created.push({ run: `workflow-runs/${id}`, trigger: m.trigger, item: m.item });
		}
		// advance LAST — if anything above threw, the range replays next time
		if (head !== cursor) {
			try { store.set('cursors', evaluator, { evaluator, 'last-evaluated': head }); } catch {
				store.add('cursors', { evaluator, 'last-evaluated': head }, { id: evaluator });
			}
		}
	}

	return { evaluator, from, to: head, events, matches: toCreate.concat(deduped), created, deduped, cronSkipped, dryRun };
}

export function printSyncReport(r) {
	const range = r.from === r.to ? '(cursor already at HEAD)' : `${r.from.slice(0, 7)}..${r.to.slice(0, 7)}`;
	console.log(`sync [${r.evaluator}] ${range}${r.dryRun ? ' — DRY RUN' : ''}`);
	const byColl = {};
	for (const e of r.events) {
		byColl[e.collection] ??= { 'item-added': 0, 'item-updated': 0, 'item-removed': 0 };
		byColl[e.collection][e.type]++;
	}
	for (const [c, n] of Object.entries(byColl)) {
		console.log(`  ${c}: ${n['item-added']} added, ${n['item-updated']} updated, ${n['item-removed']} removed`);
	}
	if (!r.events.length) console.log('  no item events in range');
	for (const m of r.deduped) console.log(`  ↺ ${m.trigger} already ran for ${m.item} @ ${m.commit.slice(0, 7)}`);
	if (r.dryRun) {
		for (const m of r.matches) console.log(`  ▶ would create: ${m.workflow} for ${m.item} (trigger ${m.trigger})`);
		if (r.matches.length) console.log('  dry run — nothing created, cursor NOT advanced');
	} else {
		for (const c of r.created) console.log(`✔ run created: ${c.run} (${c.trigger} ← ${c.item})`);
		if (r.created.length) console.log('… execution is attended: follow the `executing-workflows` skill to advance runs');
	}
	if (r.cronSkipped.length) console.log(`⚠ cron triggers not implemented yet — skipped: ${r.cronSkipped.join(', ')}`);
}

function git(cwd, args) {
	return execFileSync('git', args, { cwd }).toString().trim();
}
