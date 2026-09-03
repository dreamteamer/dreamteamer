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
import { compile, staleness, warnIfStale, discoverModules, CHANNEL_LABEL, locationOf, KINDS } from './compile.js';
import { check } from './check.js';
import { collectionCommand, emit, relationsCommand } from './collections-cli.js';
import { init, install, installClone, update, listRepos } from './init.js';
import { deriveEvents } from './events.js';
import { commitPending } from './commit.js';
import { Store } from './store.js';
import { splitRef } from './ref.js';
import { envContext, renderTemplate } from './env-vars.js';

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
const QUIET = ['ignore', 'pipe', 'ignore'];


const USAGE = `usage: dreamteamer <verb> [<target>] [flags]

record verbs (hard validation — invalid writes are rejected before disk).
A <target> is either a collection name or a <collection>/<id> reference; the reference splits at
the longest DECLARED collection prefix, so finance/transactions/2026/03/coffee is ONE argument:
  list   <collection> [--filter k=v] [--where <json>] [--sort [-]<field>] [--json]
                                              (--filter is ONE condition — repeat it to AND more
                                               (--filter a=1 --filter b=2 wants both);
                                               anything compound goes in one --where, operator
                                               objects e.g. '{"starts":{"_gte":"2026-07-01"}}' —
                                               operators: _eq _neq _lt _lte _gt _gte _in _nin
                                               _null _empty _contains _starts_with _ends_with
                                               _between _regex _and _or, plus _n*/_i* negated and
                                               case-insensitive variants; date-times sort and
                                               compare as instants, across offsets)
  get    <collection>/<id> [--json]
  add    <collection> --<field> <value> … [--id <explicit-id>]
                                              (a codec-file collection takes --from <path>
                                               instead — the file IS the record, fields derive;
                                               --force replaces an existing file record.
                                               A repeated --<field> is one ELEMENT of an array
                                               field — refused on a scalar one; a single value
                                               still splits on commas)
  set    <collection>/<id> <field>=<value> …  (repeating a pair adds an element, exactly as a
                                               repeated --<field> does)
  rm     <collection>/<id> [--force]
  rename <collection>/<id> <new-id>           (rewrites all inbound refs in one WRITE —
                                               commit publishes the set together)
  move   <collection>/<id> --after|--before <id> | --top | --bottom
  move   <collection> --init                  (place every record that has no sort value yet)
  values <collection> <field> [--limit n]     (the vocabulary a field actually uses —
                                               what a filter/validator offers as choices)
  history <collection>/<id> [--json]          (git revisions of this record, newest first)
  diff    <collection>/<id> [--hash <sha>]    (the patch one revision applied; defaults to HEAD)
  revert  <collection>/<id> --hash <sha>      (restore the content at <sha> as a pending write)
  commands <collection>[/<id>] [--ids <id>,…] (bound commands + per-record state:
                                               available / done / not-applicable)
  relations [<collection>]                    (every two-way pair: owner.field → target.mirror)
  relations rebuild <collection> [--drop <f>] (regenerate mirror VALUES from the owning side;
                                               --drop removes a stale ex-mirror key from records)
  ensure  <repos-id> | --all [--json]         (materialize an attached repo's working tree ON
                                               DEMAND — never at install; --all is the explicit
                                               opt-in, e.g. before going offline)
  resolve '<string>' | <collection>/<id> <field>
                                              (render \${env:NAME} · \${workspaceFolder} ·
                                               \${userHome} — the ONLY substitution point; a
                                               record keeps the template verbatim. An array
                                               field prints one item per line)

system verbs — the SAME verbs, on the entities the compiler materializes (modules, collections,
skills, agents, commands, command-bindings, ui-views, collection-templates). ⚠ ONE difference in
POLICY, not in spelling: a SYSTEM write commits itself, because an uncompilable or unpublished
schema is not a state a workspace should sit in; a RECORD write does not — \`commit\` publishes it.
The commit lands in the repo that holds the source, so a write into a git module commits there.
  add    collections --name <name> [--module <m>] [--namespace <ns>] [--template docs|entity]
                                              [--description "…"] [--suffix <s>] [--id-shape dated|slug]
                                              (--namespace health --name doctors === --name
                                               health/doctors; a module declaring exactly ONE
                                               namespace infers it, and the resolved name is echoed.
                                               --namespace '' means no namespace)
  add    modules --name <id> [--description "…"]
                                              (modules/<id>/ + every kind folder + package.json.
                                               folder = package name = id, so a module never forks.
                                               the git shape is \`install --clone <url> [name]\`)
  add    skills --name <id> --description "…"  (skills/<id>/SKILL.md — --description is required,
                                               because an undescribed skill is undiscoverable)
  add    ui-views --path </route> --target list --collection collections/<c> --layout <id>
                                              [--id <id>] [k.v=…]
  set    <system>/<id> <field>=<value> …      (collections: description · use_when · title ·
                                               title_template · icon · group · list_fields ·
                                               sort_field · order, plus module=<m>, which MOVES it.
                                               modules: description · namespaces · dependencies ·
                                               peerDependencies, record-shaped (modules/core).
                                               ui-views: dotted keys — options.sort=-date. An empty
                                               value REMOVES the key; quote it to write the empty
                                               string itself ('options.sort=""').
                                               skills/agents/commands/…: frontmatter keys)
  rm     <system>/<id> [--force] [--dry-run]
  rename <system>/<id> <new-id>               (a collection's rename moves its records, re-suffixes
                                               the files and rewrites every inbound ref, ONE commit)
  move   <system>/<id> --after|--before <id>  (nav ordering — it writes \`order\`)
  get    collections/<c> [--module <m>]       (--module prints ONE module's source contribution
                                               rather than the merged descriptor)
  list   modules | collections | skills | …   (id · location · path · namespaces · package name)
  revert <system>/<id>                        (refused: its source is in git —
                                               \`git checkout <sha> -- <path>\` then \`dt compile\`)

field verbs — a field is the one sub-entity, and it has verbs of its own (there is no \`fields\`
collection: the ENGINE does not read one, and \`rename-field\` was the only capability it would buy):
  add-field    <collection> --name <field> --type <type> [--options a,b] [--default-value v]
                            [--required true] [--description "…"] [--many] [--inverse [name]]
                            [--inverse-description "…"] [--unique] [--body] [--module <m>]
                            [--on-delete restrict|set-null] [--mirror-of <collection>.<field>]
                            types: string text markdown boolean number integer date datetime
                                   enum tags <collection> — a date-time may be written as
                                   "2026-07-28 12:00" or "2026-07-28T12:00"; the local offset is
                                   stamped on for you (2026-07-28T12:00:00+03:00)
                            --inverse declares the two-way mirror on the target; --mirror-of
                            declares it from this side instead — there is no wrong side.
                            --body marks the field a record's PROSE lands in (the text after the
                            frontmatter). One per collection, and a relation mirror needs the
                            target to have one.
                            --module writes an OVERLAY in that module (it must declare the base's
                            module in dreamteamer.dependencies).
  update-field <collection> --name <field> [--type <type>] [--options a,b] [--default-value v]
                            [--required true|false] [--description "…"] [--body true|false]
                            [--many] [--inverse [name]] [--unique] [--module <m>]
                            [--on-delete restrict|set-null] [--mirror-of <collection>.<field>]
                            (an existing description survives a retype, and so does every relation
                             keyword you do not restate. --inverse on an EXISTING reference is the
                             migration: a plain foreign key gains its two-way mirror without
                             restating --type. --inverse= drops the mirror; --unique false clears
                             the one-to-one. Records written before the mirror existed are counted
                             for you, with the "relations rebuild" that repairs them.)
  remove-field <collection> --name <field> [--module <m>] [--dry-run]
                            (clears the field's VALUES in the same write, and reports the count)
  rename-field <collection> --name <field> --to <new-name> [--module <m>] [--dry-run]
                            (rewrites the key in every record AND everywhere a descriptor or view
                             names the field: list_fields, sort_field, x-inverse, x-inverse-of,
                             title_template, id.generate, a ui-view's options.columns and filter,
                             and a command-binding's can-enter/can-exit. ONE commit)

Every verb that MOVES records or CLEARS values takes --dry-run and prints its plan first:
  records N · refs M · descriptors K · values cleared V

workspace verbs:
  init        write the workspace skeleton into the current directory (never compiles)
  --version   print the engine version (works anywhere)
  install     restore git_modules/ from the lockfile map; --clone <url> [name] adds one
  update      pull git_modules clones forward (ff-only on the lockfile ref), rebuild,
              then compile; [<name>] updates just one. dirty clones are skipped
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
              [--watch] recompile on source changes
  check       validate every record against the compiled descriptors (report-only)
  status      workspace status: compiled runtime freshness, per-module channel/ref, staleness
  start       serve the clean REST api at /api [--port <n>]
  changes     what changed in every repo that holds records, as record events
              [--since <sha|YYYY-MM-DD>] (default: HEAD~1 — the last commit's own changes) [--json]
  commit      publish records already written to disk: samples git status over every
              collection's record dirs, one commit PER REPO, subject composed from the
              status letters. Scope it with any number of targets, each either a whole
              <collection> or one <collection>/<id> — the record form is what keeps a
              concurrent session's pending records out of your commit.
              [<collection>|<collection>/<id> …] [-m <subject>] [--dry-run] [--json]
  help        this text
`;

// Record verbs, split by what their <target> means. `move` and `commands` are in NEITHER set: both
// accept either shape, and which one it is has to be decided against the declared collections.
// How many rows a per-record listing prints before it summarises. ONE number, because a report that
// caps one of its lists and not the next reads as a bug in whichever list ran long.
const ROWS_SHOWN = 20;

const REF_VERBS = new Set(['get', 'set', 'rm', 'rename', 'history', 'diff', 'revert']);
const COLLECTION_VERBS = new Set(['list', 'add', 'values']);
const EITHER_VERBS = new Set(['move', 'commands']);

// FIELD VERBS. Their <target> is a collection and everything else is flags, which is the one shape
// that differs from the record verbs — so they get their own case arm rather than being folded into
// `dispatchRecordVerb`. There is no `schema <op>` table any more: system entities take the record
// verbs, and `collectionCommand`'s interceptors are the whole dispatch (§4).
const FIELD_VERBS = ['add-field', 'update-field', 'remove-field', 'rename-field'];

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
				// bare args are TARGETS — a whole collection or a `<collection>/<id>` reference,
				// told apart in commit.js against the declared collections — minus the token `-m`
				// consumed as its subject
				const only = rest.filter((a, i) => !a.startsWith('-') && (mi === -1 || i !== mi + 1));
				const results = commitPending(store, { only, message, dryRun: rest.includes('--dry-run') });
				if (rest.includes('--json')) { emit(JSON.stringify(results, null, 2)); process.exit(0); }
				if (!results.length) { console.log('nothing pending'); process.exit(0); }
				for (const r of results) {
					if (r.blocked) { console.error(`✖ ${r.repo}: ${r.blocked} — ${r.rows.length} record(s) left uncommitted`); continue; }
					if (r.warning) console.warn(`⚠ ${r.repo}: ${r.warning}`);
					console.log(`✔ ${r.repo === '.' ? 'workspace' : r.repo}${r.sha ? ` ${r.sha}` : ' (dry run)'} — ${r.subject}`);
					for (const row of r.rows.slice(0, ROWS_SHOWN)) console.log(`    ${row.verb} ${row.collection}/${row.id}`);
					if (r.rows.length > ROWS_SHOWN) console.log(`    + ${r.rows.length - ROWS_SHOWN} more`);
					// Half a pair was published — name the records that finish it. `dt commit
					// <collection>` publishes exactly that collection by design, so this is an honest
					// report of what it left behind, not a failure: HEAD fails `check` until they land.
					if (r.leftPending?.length) {
						const n = r.leftPending.length;
						console.warn(`⚠ ${n} relation partner(s) left pending — HEAD fails \`dreamteamer check\` until they are published:`);
						// CAPPED at the same ROWS_SHOWN as the rows above — this line was the one
						// unbounded list in the report, and 25 leftovers printed 25 refs on one line.
						// ⚠ But a truncated COMMAND is not a command, so the overflow is not "+ N more"
						// and nothing else: it names the collection-scoped form that does converge, and
						// what that costs (it sweeps whatever another session left pending there, which
						// is exactly why the record form is the default).
						console.warn(`    dreamteamer commit ${r.leftPending.slice(0, ROWS_SHOWN).join(' ')}`);
						if (n > ROWS_SHOWN) {
							const colls = [...new Set(r.leftPending.map((ref) => splitRef(store.descriptors, ref).collection))].sort();
							console.warn(`    + ${n - ROWS_SHOWN} more — or ${colls.map((c) => `dreamteamer commit ${c}`).join(' && ')}, which also publishes anything another session left pending there`);
						}
						// ⚠ AND IT CAN TAKE TWO COMMANDS, so say so rather than promise one. The command
						// above is planned by the same sweep every scoped commit runs, and a named
						// partner whose OTHER edge moved against a record this list does not carry is
						// refused as entangled — measured: `dt commit meetings` left one partner pending,
						// the printed `dt commit recordings/cap-zero` was refused over a second recording
						// sharing its topic, and the refusal named the pair that converges. Computing
						// that closure here would mean asking planSweep for strangers instead of
						// throwing on them, which is a redesign of the guard; naming the second step is
						// the honest half-measure.
						console.warn('    (if that refuses as entangled, the refusal names the other pending records — add them to the same command)');
					}
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
					// §10: the folder name IS the label. `hr  git_modules @ 3f2a1c (dirty)` needs no
					// legend, and `[inline]` needed one every single time.
					let line = `  ${m.name.padEnd(20)} ${locationOf(m, ws.root)}`;
					if (m.channel === 'git') {
						const ref = tryGit(m.root, ['rev-parse', '--short', 'HEAD']);
						const dirty = tryGit(m.root, ['status', '--porcelain']);
						// ⚠ A SCHEMA WRITE NOW COMMITS HERE (§9), so a clone can be ahead of its remote
						// with work the operator does not know they are holding. `status` is the command
						// they run when something feels wrong, so it is where the count belongs.
						const ahead = tryGit(m.root, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
						line += ` @ ${ref ?? '?'}${dirty ? ' (dirty)' : ''}${Number(ahead) > 0 ? ` — ahead ${ahead}, push when ready` : ''}`;
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
						// an UNRESOLVED path is not the same absence as a repo simply not cloned yet, and
						// `dreamteamer ensure` is not the fix for it — say which one this is.
						for (const r of repos) if (!r.present) console.log(`  absent: ${r.id} → ${r.path}${r.unresolved ? ` — ${r.unresolved}` : ` (dreamteamer ensure ${r.id})`}`);
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
			// The verb `check`'s stale-mirror message names. It reads the compiled relations, and
			// rebuild WRITES records, so both want the same staleness warning every record verb gets.
			// FIELD VERBS — see FIELD_VERBS. Their <target> is a collection and everything else is
			// flags, so they are their own case rather than being folded into `dispatchRecordVerb`.
			//
			// ⚠ `dt schema <op>` is GONE, not aliased. The 0.12.0 policy: a stale invocation must fail
			// loudly, because a half-working grammar teaches the wrong shape without ever saying so.
			// The `default` arm below names `schema` specifically.
			case 'add-field': case 'update-field': case 'remove-field': case 'rename-field': {
				warnIfStale(ws.root);
				const [target, ...flagArgs] = rest;
				if (!target || target.startsWith('--')) {
					throw new Error(`dt ${cmd} needs a collection: dreamteamer ${cmd} <collection> --name <field> …`);
				}
				process.exit(collectionCommand(ws, target, cmd, flagArgs));
			}
			case 'relations':
				warnIfStale(ws.root);
				process.exit(relationsCommand(ws, rest));
			// `repos ensure` lost its noun: the repos collection is still where the declaration lives,
			// but materializing one is a verb the operator types, not a record write.
			case 'ensure':
				warnIfStale(ws.root);
				process.exit(collectionCommand(ws, 'repos', 'ensure', rest));
			case 'resolve':
				process.exit(resolveVariables(ws, rest));
			default:
				// ⚠ NAMED, not just unknown. Every doc, skill and downstream script spelled these
				// `dt schema <op>` for seven releases, so the failure has to carry the translation —
				// an "unknown verb" alone sends the reader to `help` to guess which of nine verbs
				// replaced the one they typed. No alias layer and no deprecation window: 0.12.0's
				// policy, and the reason it is the right one is that `dt contacts list` failing
				// loudly is what taught the verb-first grammar in one command.
				if (cmd === 'schema') {
					console.error('✖ unknown verb "schema" — schema verbs are gone since 0.19.0. System entities take the RECORD verbs now:');
					console.error('    dt add collections --name <c> [--module <m>] · dt rm collections/<c> · dt rename collections/<old> <new>');
					console.error('    dt set collections/<c> module=<m> | <scalar>=<v>   · dt get collections/<c> [--module <m>]');
					console.error('    dt add-field <c> … · dt update-field <c> … · dt remove-field <c> … · dt rename-field <c> --name <f> --to <g>');
					console.error('    dt add|set|rm|rename modules/<id> …               · dt add|set|rm|rename ui-views/<id> …');
					console.error('  the full mapping table is in UPDATING.md (0.18.0 → 0.19.0), and `dt help` has the current spellings.');
					process.exit(1);
				}
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
	// An explicit `--ids` from the caller still wins — by NOT injecting ours, not by ordering. It
	// used to rely on "last flag parsed wins", which stopped being true when a repeated flag started
	// promoting to an array instead of overwriting: the pair would now be refused as a double.
	const ours = rest.some((a) => a === '--ids' || a.startsWith('--ids=')) ? [] : ['--ids', id];
	return collectionCommand(ws, 'commands', 'for', [collection, ...ours, ...rest]);
}

/**
 * `dt resolve '<string>'` | `dt resolve <collection>/<id> <field>` — the ONLY place a `${env:…}`
 * template becomes a value. Records hold the template verbatim; no read path substitutes anything,
 * so a reference means the same thing on every machine and the file says which is which.
 *
 * THE HEURISTIC: the first argument is a REFERENCE iff it contains no `${` AND splits against a
 * declared collection. Both halves are needed. `${` first, because `docs/${env:X}` is ref-SHAPED
 * and must not be split as one — a reference can never contain a template, so the marker decides it
 * outright. Then the split, because a plain path (`/tmp/x`, `nope/q3`) must render to itself rather
 * than report an unknown collection it was never naming. Two accepted consequences: a bare
 * collection name resolves to itself (splitRef refuses it, so it is "just a string"), and in an
 * UNCOMPILED workspace every argument is a string, because there are no descriptors to split
 * against — which keeps `dt resolve '${env:K}'` working before the first compile.
 */
function resolveVariables(ws, args) {
	const [target, field] = args;
	if (!target) throw new Error("dt resolve takes a string template or a <collection>/<id> and a field: dreamteamer resolve '${env:FILES_FOLDER}/x'");
	// resolve has no flags, so a flag-shaped target is a mistake — and the one that costs is
	// `dt resolve --help`, which would otherwise print `--help` back and exit 0.
	if (target.startsWith('--')) throw new Error(`dt resolve takes a string or a <collection>/<id>, not a flag ("${target}") — see \`dreamteamer help\``);
	const ctx = envContext(ws);

	let ref = null;
	let store = null;
	if (!target.includes('${')) {
		try {
			store = new Store(ws);
			ref = splitRef(store.descriptors, target);
		} catch { ref = null; }
	}
	// An argument nobody reads is a silent wrong answer: `dt resolve docs/q3 source_file garbage`
	// exited 0 on the field it happened to recognise.
	const takes = ref ? 2 : 1;
	if (args.length > takes) {
		throw new Error(`dt resolve takes ${takes === 1 ? 'one string template' : 'a reference and ONE field'} — ${args.length - takes} extra argument(s): ${args.slice(takes).join(' ')}`);
	}
	if (!ref) {
		console.log(renderTemplate(target, ctx));
		return 0;
	}
	if (!field) throw new Error(`dt resolve ${target} needs a field name: dreamteamer resolve ${target} <field>`);
	const { fields } = store.read(ref.collection, ref.id);
	const value = fields[field];
	if (value === undefined) throw new Error(`${target} has no field "${field}"`);
	// RENDER EVERY ITEM BEFORE PRINTING ANY. An array prints one item per line so the output pipes
	// into a shell loop unchanged — and a loop that does not check $? cannot tell a truncated list
	// from a short one, so a failure on item n must not leave items 1..n-1 on stdout. Anything that
	// is not text is refused rather than stringified: a number cannot hold a template.
	const items = Array.isArray(value) ? value : [value];
	const bad = items.findIndex((v) => typeof v !== 'string'); // index, not the value: an item may be null
	if (bad > -1) throw new Error(`${target} field "${field}" holds a ${typeof items[bad]} — resolve renders text (a string, or a list of them)`);
	const rendered = items.map((v) => renderTemplate(v, ctx));
	if (rendered.length) console.log(rendered.join('\n'));
	return 0;
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
