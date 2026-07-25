// dreamteamer CLI — noun-verb grammar over the same primitives every surface uses.
// this phase ships: compile, check, status. collection verbs land next.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWorkspace } from './workspace.js';
import { compile, staleness, warnIfStale, discoverModules, CHANNEL_LABEL } from './compile.js';
import { check } from './check.js';
import { collectionCommand } from './collections-cli.js';
import { init, install, installClone } from './init.js';

const USAGE = `usage: dreamteamer <command> | dreamteamer <collection> <verb> …

commands:
  init        write the workspace skeleton into the current directory (never compiles)
  install     restore git_modules/ from the lockfile map; --clone <url> [name] adds one
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
  check       validate every record against the compiled descriptors (report-only)
  status      workspace status: compiled runtime freshness, per-module channel/ref, staleness
  start       serve the clean REST api + the studio at /admin [--port <n>]

collection verbs (hard validation — invalid writes are rejected before disk):
  <collection> list [--filter k=v] [--json]
  <collection> get <id> [--json]
  <collection> add --<field> <value> … [--id <explicit-id>]
  <collection> set <id> <field>=<value> …
  <collection> rm <id> [--force]
  <collection> rename <old-id> <new-id>       (rewrites all inbound refs, ONE commit)

meta verbs (schema + workflow operations — write SOURCES, never the runtime):
  collections add --name <name> [--template <template>]
  <collection> add-field --name <field> --type <type> [--options a,b] [--default-value v] [--required true]
  workflows run <workflow-id> --items <ref>[,<ref>…]   (creates a validated run record)
`;

export function run(argv) {
	const [cmd, ...rest] = argv;
	try {
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
