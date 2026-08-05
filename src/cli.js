// dreamteamer CLI — noun-verb grammar over the same primitives every surface uses.
// this phase ships: compile, check, status. collection verbs land next.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWorkspace } from './workspace.js';
import { compile, staleness, warnIfStale, discoverModules, CHANNEL_LABEL, KINDS } from './compile.js';
import { check } from './check.js';
import { collectionCommand, emit } from './collections-cli.js';
import { init, install, installClone, update, listRepos } from './init.js';
import { deriveEvents } from './events.js';
import { commitPending } from './commit.js';
import { Store } from './store.js';

const USAGE = `usage: dreamteamer <command> | dreamteamer <collection> <verb> …

commands:
  init        write the workspace skeleton into the current directory (never compiles)
  --version   print the engine version (works anywhere)
  install     restore git_modules/ from the lockfile map; --clone <url> [name] adds one
  update      pull git_modules clones forward (ff-only on the lockfile ref), rebuild,
              then compile; [<name>] updates just one. dirty clones are skipped
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
  check       validate every record against the compiled descriptors (report-only)
  status      workspace status: compiled runtime freshness, per-module channel/ref, staleness
  start       serve the clean REST api + the studio at /admin [--port <n>]
  changes     what changed in every repo that holds records, as record events
              [--since <sha|YYYY-MM-DD>] (default: the last commit) [--json]
  commit      publish records already written to disk: samples git status over every
              collection's record dirs, one commit PER REPO, subject composed from the
              status letters. [<collection> …] to scope, [-m <subject>], [--dry-run]

collection verbs (hard validation — invalid writes are rejected before disk):
  <collection> list [--filter k=v] [--where <json>] [--sort [-]<field>] [--json]
                                              (--where takes the studio's operator set, e.g.
                                               '{"starts":{"_gte":"2026-07-01"}}'; date-times
                                               sort and compare as instants, across offsets)
  <collection> get <id> [--json]
  <collection> add --<field> <value> … [--id <explicit-id>]
  <collection> set <id> <field>=<value> …
  <collection> rm <id> [--force]
  <collection> rename <old-id> <new-id>       (rewrites all inbound refs, ONE commit)
  <collection> history <id> [--json]          (git revisions of this record, newest first)
  <collection> diff <id> [--hash <sha>]       (the patch one revision applied; defaults to HEAD)
  <collection> revert <id> --hash <sha>       (restore the content at <sha>, as a NEW commit)

repo attachment (working trees are materialized ON DEMAND, never at install):
  repos ensure <id> [--json]                  (clone if missing, then print the path; idempotent)
  repos ensure --all [--json]                 (explicit opt-in: everything, e.g. before going offline)

meta verbs (schema operations — write SOURCES through a compile gate, never the runtime):
  collections add --name <name> [--template docs|entity]
  collections rm <name> [--force]             (--force required if it still has records)
  <collection> add-field    --name <field> --type <type> [--options a,b] [--default-value v] [--required true]
                            [--description "what this field means"]
                            types: string text markdown boolean number integer date datetime
                                   enum tags <collection> — a date-time may be written as
                                   "2026-07-28 12:00" or "2026-07-28T12:00"; the local offset is
                                   stamped on for you (2026-07-28T12:00:00+03:00)
  <collection> update-field --name <field> --type <type> [--options a,b] [--default-value v] [--required true|false]
                            [--description "…"]   (an existing description survives a retype)
  <collection> remove-field --name <field>
  ui-views add --path </route> --target list --collection collections/<c> --layout <id> [--id <id>] [k.v=…]
  ui-views set <id> <key>=<value> …           (dotted keys: options.sort=-date, nav.label=Recent)
  ui-views rm <id>
  commands for <collection>[/<id>] [--ids <id>,…]      (bound commands + per-record state:
                                                        available / done / not-applicable)
  <collection> values <field> [--limit n]              (the vocabulary a field actually uses —
                                                        what a filter/validator offers as choices)
`;

export function run(argv) {
	const [cmd, ...rest] = argv;
	try {
		if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
			// works OUTSIDE a workspace — the post-install "did it land?" affordance
			const p = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
			console.log(`${p.name}@${p.version}`);
			process.exit(0);
		}
		if (cmd === 'init') {
			// init runs BEFORE a workspace exists — no findWorkspace
			const flags = {};
			for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1];
			process.exit(init({ flags }));
		}
		const ws = findWorkspace();
		switch (cmd) {
			case 'install': {
				const ci = rest.indexOf('--clone');
				if (ci > -1) process.exit(installClone(ws, rest[ci + 1], rest[ci + 2]));
				process.exit(install(ws));
			}
			case 'update': {
				const code = update(ws, rest.find((a) => !a.startsWith('--')));
				compile(ws); // pulled modules may carry new sources — prints its own summary
				process.exit(code);
			}
			case 'start': {
				warnIfStale(ws.root);
				const portIdx = rest.indexOf('--port');
				import('./server.js').then(({ startServer }) =>
					startServer(ws, { port: portIdx > -1 ? Number(rest[portIdx + 1]) : 8080 }));
				return; // keep the process alive
			}
			case 'compile': {
				const code = compile(ws);
				if (!rest.includes('--watch')) process.exit(code);
				console.log('… watching sources (modules/*, git_modules/*, and the workspace root) — ctrl-c to stop');
				watchAndRecompile(ws);
				return;
			}
			case 'check':
				warnIfStale(ws.root);
				process.exit(check(ws));
			// `changes` is what survives of the trigger/run subsystem removed 2026-07-31: deriving
			// record events from git history was the genuinely used half (catch-up — "what happened
			// while I was away"), while creating run records from triggers was not. Read-only by
			// construction: no cursor to advance, nothing to store, so it is safe to run twice.
			case 'changes': {
				warnIfStale(ws.root);
				const si = rest.indexOf('--since');
				const since = si > -1 ? rest[si + 1] : 'HEAD~1';
				const store = new Store(ws);
				const events = deriveEvents(ws.root, store.descriptors, since, 'HEAD');
				if (rest.includes('--json')) { emit(JSON.stringify({ since, head: 'HEAD', events }, null, 2)); process.exit(0); }
				if (!events.length) { console.log(`✔ no record changes since ${since}`); process.exit(0); }
				const byCollection = new Map();
				for (const e of events) {
					if (!byCollection.has(e.collection)) byCollection.set(e.collection, []);
					byCollection.get(e.collection).push(e);
				}
				console.log(`${events.length} record change(s) since ${since}:`);
				for (const [c, list] of [...byCollection].sort()) {
					const n = (t) => list.filter((e) => e.type === t).length;
					console.log(`  ${c}: ${n('item-added')} added, ${n('item-updated')} updated, ${n('item-removed')} removed`);
					for (const e of list) console.log(`    ${e.type.replace('item-', '').padEnd(7)} ${c}/${e.id}`);
				}
				process.exit(0);
			}
			// the other half of `auto-commit: false` — record writes land on disk uncommitted, and
			// this publishes them. No pending file: the set is sampled from `git status`, so a
			// hand-edited record is indistinguishable from one the store wrote, which is the point.
			case 'commit': {
				const store = new Store(ws);
				const mi = rest.indexOf('-m');
				const message = mi > -1 ? rest[mi + 1] : undefined;
				// bare args are collection names — minus the token `-m` consumed as its subject
				const only = rest.filter((a, i) => !a.startsWith('-') && (mi === -1 || i !== mi + 1));
				const results = commitPending(store, { only, message, dryRun: rest.includes('--dry-run') });
				if (rest.includes('--json')) { emit(JSON.stringify(results, null, 2)); process.exit(0); }
				if (!results.length) { console.log('nothing pending'); process.exit(0); }
				for (const r of results) {
					if (r.blocked) { console.error(`✖ ${r.repo}: ${r.blocked} — ${r.rows.length} record(s) left uncommitted`); continue; }
					if (r.warning) console.warn(`⚠ ${r.repo}: ${r.warning}`);
					console.log(`✔ ${r.repo === '.' ? 'workspace' : r.repo}${r.sha ? ` ${r.sha}` : ' (dry run)'} — ${r.subject}`);
					for (const row of r.rows.slice(0, 20)) console.log(`    ${row.verb} ${row.collection}/${row.id}`);
					if (r.rows.length > 20) console.log(`    + ${r.rows.length - 20} more`);
				}
				process.exit(results.some((r) => r.blocked) ? 1 : 0);
			}
			case 'status': {
				const s = staleness(ws.root);
				if (!s.compiled) {
					console.log(`✖ ${s.message}`);
					process.exit(1);
				}
				console.log(`compiled: ${s.manifest.compiled}`);
				// provenance is LIVE discovery (not the manifest) — shows what the next compile would use
				const { modules, shadows } = discoverModules(ws.root, ws.pkg);
				const shadowed = new Map(shadows.map((sh) => [sh.name, sh]));
				console.log('modules:');
				for (const m of modules) {
					let line = `  ${m.name} [${m.channel}]`;
					if (m.channel === 'git') {
						const ref = tryGit(m.root, ['rev-parse', '--short', 'HEAD']);
						const dirty = tryGit(m.root, ['status', '--porcelain']);
						line += ` @ ${ref ?? '?'}${dirty ? ' (dirty)' : ''}`;
					}
					const sh = shadowed.get(m.name);
					if (sh) line += ` — shadows ${CHANNEL_LABEL[sh.loser]} copy`;
					console.log(line);
				}
				console.log(`entries:  ${Object.keys(s.manifest.entries).length}`);
				// repos materialize LAZILY, so presence is REPORTED here rather than stored on the
				// record. Wrapped: an older workspace may predate the repos descriptor, and status
				// must never crash — it is the command you run when things are already wrong.
				try {
					const repos = listRepos(ws);
					if (repos.length) {
						const here = repos.filter((r) => r.present).length;
						console.log(`repos:    ${here}/${repos.length} materialized`);
						for (const r of repos) if (!r.present) console.log(`  absent: ${r.id} → ${r.path} (dreamteamer repos ensure ${r.id})`);
					}
				} catch { /* no repos descriptor compiled — nothing to report */ }
				// Uncommitted records are invisible to `dt changes` (it diffs commits), so the
				// count belongs here — otherwise deferred work accumulates silently.
				try {
					const pending = commitPending(new Store(ws), { dryRun: true });
					const total = pending.reduce((n, r) => n + r.rows.length, 0);
					if (total) {
						console.log(`\npending: ${total} record(s) written but not committed — run \`dreamteamer commit\``);
						for (const r of pending) console.log(`  ${r.repo === '.' ? 'workspace' : r.repo}: ${r.rows.length}`);
					}
				} catch { /* no runtime yet, or not a git repo — status must still print */ }
				if (s.stale.length) {
					for (const line of s.stale) console.log(`  stale: ${line}`);
					console.log(`✖ .dreamteamer is stale (${s.stale.length}) — run \`dreamteamer compile\``);
					process.exit(1);
				}
				console.log('✔ .dreamteamer is fresh');
				process.exit(0);
			}
			case 'help':
				console.log(USAGE);
				process.exit(0);
			default: {
				if (!cmd || rest.length === 0) {
					console.log(USAGE);
					process.exit(cmd ? 1 : 0);
				}
				warnIfStale(ws.root);
				process.exit(collectionCommand(ws, cmd, rest[0], rest.slice(1)));
			}
		}
	} catch (e) {
		console.error(`✖ ${e.message}`);
		process.exit(1);
	}
}

function tryGit(cwd, args) {
	try { return execFileSync('git', args, { cwd }).toString().trim() || null; } catch { return null; }
}

function watchAndRecompile(ws) {
	let timer = null;
	const trigger = (_, file) => {
		if (file && /^\./.test(String(file))) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			try { compile(ws); } catch (e) { console.error(`✖ ${e.message}`); }
		}, 200);
	};
	// 'system' plus the flat kinds: the classic layout can put sources at the workspace root under
	// either spelling, and a watcher that misses one makes --watch quietly stop recompiling.
	for (const dir of ['system', ...KINDS, 'modules', 'git_modules'].map((d) => path.join(ws.root, d))) {
		if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, trigger);
	}
}
