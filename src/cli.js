// dreamteamer CLI — noun-verb grammar over the same primitives every surface uses.
// this phase ships: compile, check, status. collection verbs land next.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWorkspace } from './workspace.js';
import { compile, staleness, warnIfStale, discoverModules, CHANNEL_LABEL } from './compile.js';
import { check } from './check.js';
import { collectionCommand } from './collections-cli.js';
import { init, install, installClone, update, listRepos } from './init.js';
import { sync, printSyncReport } from './sync.js';
import { migrate, printMigrateReport } from './migrate.js';

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
  migrate     apply pending module-shipped schema migrations [--dry-run] (one commit each)
  sync        evaluate triggers over the git cursor: derive item events, create runs,
              advance this evaluator's cursor [--dry-run] [--evaluator <name>] [--from <sha|root>]

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

meta verbs (schema + workflow operations — write SOURCES, never the runtime):
  collections add --name <name> [--template docs|entity]
  collections rm <name> [--force]             (--force required if it still has records)
  <collection> add-field    --name <field> --type <type> [--options a,b] [--default-value v] [--required true]
                            types: string text markdown boolean number integer date datetime
                                   enum tags <collection> — a date-time may be written as
                                   "2026-07-28 12:00" or "2026-07-28T12:00"; the local offset is
                                   stamped on for you (2026-07-28T12:00:00+03:00)
  <collection> update-field --name <field> --type <type> [--options a,b] [--default-value v] [--required true|false]
  <collection> remove-field --name <field>
  ui-views add --path </route> --target list --collection collections/<c> --layout <id> [--id <id>] [k.v=…]
  ui-views set <id> <key>=<value> …           (dotted keys: options.sort=-date, nav.label=Recent)
  ui-views rm <id>
  workflows run <workflow-id> --items <ref>[,<ref>…]   (creates a validated run record)
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
				console.log('… watching sources (modules/*/system, git_modules/*/system, system/) — ctrl-c to stop');
				watchAndRecompile(ws);
				return;
			}
			case 'check':
				warnIfStale(ws.root);
				process.exit(check(ws));
			case 'migrate': {
				warnIfStale(ws.root);
				printMigrateReport(migrate(ws, { dryRun: rest.includes('--dry-run') }));
				process.exit(0);
			}
			case 'sync': {
				warnIfStale(ws.root);
				const ei = rest.indexOf('--evaluator');
				const fi = rest.indexOf('--from');
				const report = sync(ws, { evaluator: ei > -1 ? rest[ei + 1] : 'cli', dryRun: rest.includes('--dry-run'), from: fi > -1 ? rest[fi + 1] : null });
				printSyncReport(report);
				process.exit(0);
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
	for (const dir of ['system', 'modules', 'git_modules'].map((d) => path.join(ws.root, d))) {
		if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, trigger);
	}
}
