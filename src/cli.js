// dreamteamer CLI — VERB-FIRST: `dt <verb> [<target>]`, over the same primitives every surface uses.
//
// The verb set is CLOSED. `run()` switches on it and anything unrecognised is an error, because the
// predecessor grammar (`dt <collection> <verb>`) made the FALLBACK the collection path: a typo
// dispatched to a collection lookup and answered "unknown collection", which is a true sentence
// about the wrong thing. It also meant no verb could ever be named without a noun in front of it
// — `dt resolve '<string>'` had nowhere to live — and a namespaced reference had to be typed as two
// arguments that only the caller knew belonged together.
//
// This file TRANSLATES; it does not implement. Every record and schema verb lands on
// `collectionCommand(ws, collection, verb, args)`, whose signature is unchanged.
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
import { splitRef } from './ref.js';

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
const QUIET = ['ignore', 'pipe', 'ignore'];


const USAGE = `usage: dreamteamer <verb> [<target>] [flags]

record verbs (hard validation — invalid writes are rejected before disk).
A <target> is either a collection name or a <collection>/<id> reference; the reference splits at
the longest DECLARED collection prefix, so finance/transactions/2026/03/coffee is ONE argument:
  list   <collection> [--filter k=v] [--where <json>] [--sort [-]<field>] [--json]
                                              (--where takes the studio's operator set, e.g.
                                               '{"starts":{"_gte":"2026-07-01"}}'; date-times
                                               sort and compare as instants, across offsets)
  get    <collection>/<id> [--json]
  add    <collection> --<field> <value> … [--id <explicit-id>]
  set    <collection>/<id> <field>=<value> …
  rm     <collection>/<id> [--force]
  rename <collection>/<id> <new-id>           (rewrites all inbound refs, ONE commit)
  move   <collection>/<id> --after|--before <id> | --top | --bottom
  move   <collection> --init                  (place every record that has no sort value yet)
  values <collection> <field> [--limit n]     (the vocabulary a field actually uses —
                                               what a filter/validator offers as choices)
  history <collection>/<id> [--json]          (git revisions of this record, newest first)
  diff    <collection>/<id> [--hash <sha>]    (the patch one revision applied; defaults to HEAD)
  revert  <collection>/<id> --hash <sha>      (restore the content at <sha>, as a NEW commit)
  commands <collection>[/<id>] [--ids <id>,…] (bound commands + per-record state:
                                               available / done / not-applicable)
  ensure  <repos-id> | --all [--json]         (materialize an attached repo's working tree ON
                                               DEMAND — never at install; --all is the explicit
                                               opt-in, e.g. before going offline)
  resolve '<string>' | <collection>/<id> <field>
                                              (render \${env:…} templates against .env —
                                               ⚠ LANDS IN 0.12.0, not wired yet)

schema verbs (write SOURCES through a compile gate, never the runtime — a different act, so a
different word in front of it):
  schema add-collection --name <name> [--namespace <ns>] [--template docs|entity]
                            (--namespace health --name doctors === --name health/doctors; the
                             namespace must already be declared in dreamteamer.namespaces, and
                             records land in data/<ns>/<name>/)
  schema rm-collection <name> [--force]       (--force required if it still has records)
  schema rename-collection <old> <new>        (or <old> --namespace <ns> to move it into one)
                            moves the descriptor AND the records, re-suffixes files when the
                            suffix was derived, rewrites every inbound reference, ONE commit
  schema add-field    <collection> --name <field> --type <type> [--options a,b] [--default-value v]
                            [--required true] [--description "what this field means"]
                            types: string text markdown boolean number integer date datetime
                                   enum tags <collection> — a date-time may be written as
                                   "2026-07-28 12:00" or "2026-07-28T12:00"; the local offset is
                                   stamped on for you (2026-07-28T12:00:00+03:00)
  schema update-field <collection> --name <field> --type <type> [--options a,b] [--default-value v]
                            [--required true|false] [--description "…"]
                            (an existing description survives a retype)
  schema remove-field <collection> --name <field>
  schema add-view --path </route> --target list --collection collections/<c> --layout <id>
                            [--id <id>] [k.v=…]
  schema set-view <id> <key>=<value> …        (dotted keys: options.sort=-date, nav.label=Recent)
  schema rm-view <id>

workspace verbs:
  init        write the workspace skeleton into the current directory (never compiles)
  --version   print the engine version (works anywhere)
  install     restore git_modules/ from the lockfile map; --clone <url> [name] adds one
  update      pull git_modules clones forward (ff-only on the lockfile ref), rebuild,
              then compile; [<name>] updates just one. dirty clones are skipped
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
  check       validate every record against the compiled descriptors (report-only)
  status      workspace status: compiled runtime freshness, per-module channel/ref, staleness
  start       serve the clean REST api at /api [--port <n>]
  changes     what changed in every repo that holds records, as record events
              [--since <sha|YYYY-MM-DD>] (default: the last commit) [--json]
  commit      publish records already written to disk: samples git status over every
              collection's record dirs, one commit PER REPO, subject composed from the
              status letters. [<collection> …] to scope, [-m <subject>], [--dry-run]
  help        this text
`;

// Record verbs, split by what their <target> means. `move` and `commands` are in NEITHER set: both
// accept either shape, and which one it is has to be decided against the declared collections.
const REF_VERBS = new Set(['get', 'set', 'rm', 'rename', 'history', 'diff', 'revert']);
const COLLECTION_VERBS = new Set(['list', 'add', 'values']);
const EITHER_VERBS = new Set(['move', 'commands']);

// `schema <op>` → the (collection, verb) pair the implementation layer already answers to. The
// collections are literals: `collections` and `ui-views` are SYSTEM-stored, which is precisely what
// makes these a separate group in the grammar rather than records like any other.
const SCHEMA_OPS = {
	'add-collection': ['collections', 'add'],
	'rm-collection': ['collections', 'rm'],
	'rename-collection': ['collections', 'rename'],
	'add-view': ['ui-views', 'add'],
	'set-view': ['ui-views', 'set'],
	'rm-view': ['ui-views', 'rm'],
};
// These three name their collection POSITIONALLY (`schema add-field contacts --name phone`) and keep
// their existing verb spelling on it — the schema group is a prefix here, not a rename.
const SCHEMA_FIELD_OPS = new Set(['add-field', 'update-field', 'remove-field']);
const SCHEMA_OP_LIST = [...Object.keys(SCHEMA_OPS), ...SCHEMA_FIELD_OPS].join(' | ');

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
		if (!cmd) {
			console.log(USAGE);
			process.exit(0);
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
						for (const r of repos) if (!r.present) console.log(`  absent: ${r.id} → ${r.path} (dreamteamer ensure ${r.id})`);
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
			case 'list': case 'add': case 'values':
			case 'get': case 'set': case 'rm': case 'rename': case 'history': case 'diff': case 'revert':
			case 'move': case 'commands':
				warnIfStale(ws.root);
				process.exit(dispatchRecordVerb(ws, cmd, rest));
			// `repos ensure` lost its noun: the repos collection is still where the declaration lives,
			// but materializing one is a verb the operator types, not a record write.
			case 'ensure':
				warnIfStale(ws.root);
				process.exit(collectionCommand(ws, 'repos', 'ensure', rest));
			case 'schema':
				warnIfStale(ws.root);
				process.exit(dispatchSchemaVerb(ws, rest));
			case 'resolve':
				throw new Error('resolve lands in 0.12.0');
			default:
				console.error(`✖ unknown verb "${cmd}" — dreamteamer is verb-first since 0.12.0: dt <verb> [<target>]`);
				console.error(USAGE);
				process.exit(1);
		}
	} catch (e) {
		console.error(`✖ ${e.message}`);
		process.exit(1);
	}
}

/** Translate `dt <verb> <target> …` into the noun-verb call the implementation layer takes. */
function dispatchRecordVerb(ws, verb, args) {
	const [target, ...rest] = args;
	if (!target) throw new Error(`dt ${verb} needs a target — see \`dreamteamer help\``);
	// A flag in the target slot is a word-order mistake, not a collection: without this,
	// `dt list --json contacts` reported `unknown collection "--json"` and dumped every name.
	if (target.startsWith('--')) throw new Error(`dt ${verb} takes its target BEFORE the flags: dreamteamer ${verb} <target> ${target} …`);
	if (COLLECTION_VERBS.has(verb)) return collectionCommand(ws, target, verb, rest);
	if (REF_VERBS.has(verb)) {
		const { collection, id } = splitRef(new Store(ws).descriptors, target);
		return collectionCommand(ws, collection, verb, [id, ...rest]);
	}
	// EITHER_VERBS from here: a bare collection is legal for both — `move <collection> --init`,
	// `commands <collection>`.
	const { descriptors } = new Store(ws);
	if (descriptors.has(target)) {
		return verb === 'move'
			? collectionCommand(ws, target, 'move', rest)
			: collectionCommand(ws, 'commands', 'for', [target, ...rest]);
	}
	const { collection, id } = splitRef(descriptors, target);
	if (verb === 'move') return collectionCommand(ws, collection, 'move', [id, ...rest]);
	// `commands for <c>/<id>` split its own target at the FIRST slash, which cannot name a
	// namespaced collection. splitRef can, so the id is handed over as `--ids` — the same
	// `commandsFor(store, collection, ids)` call, reached without re-encoding the reference.
	// Ours goes FIRST so an explicit `--ids` from the caller still wins (last flag parsed wins).
	return collectionCommand(ws, 'commands', 'for', [collection, '--ids', id, ...rest]);
}

/** Translate `dt schema <op> …` onto the same meta verbs `collectionCommand` already routes. */
function dispatchSchemaVerb(ws, args) {
	const [op, ...rest] = args;
	if (!op) throw new Error(`dt schema needs an operation — use ${SCHEMA_OP_LIST}`);
	if (SCHEMA_FIELD_OPS.has(op)) {
		const [collection, ...flags] = rest;
		if (!collection || collection.startsWith('--')) {
			throw new Error(`dt schema ${op} needs a collection: dreamteamer schema ${op} <collection> --name <field> …`);
		}
		return collectionCommand(ws, collection, op, flags);
	}
	const pair = SCHEMA_OPS[op];
	if (!pair) throw new Error(`unknown schema operation "${op}" — use ${SCHEMA_OP_LIST}`);
	return collectionCommand(ws, pair[0], pair[1], rest);
}

function tryGit(cwd, args) {
	try { return execFileSync('git', args, { cwd, stdio: QUIET }).toString().trim() || null; } catch { return null; }
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
