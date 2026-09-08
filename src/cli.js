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
import { collectionCommand, emit, relationsCommand, parseArgs, refuseUnknownFlags } from './collections-cli.js';
import { init, installClone, update, listRepos } from './init.js';
import { installCommand, describeCheckout, listWorktrees, worktreeCommand } from './checkout.js';
import { proveCommand, readLedger, flagEnabled } from './prove.js';
import { landCommand } from './land.js';
import { deriveEvents } from './events.js';
import { commitPending } from './commit.js';
import { Store } from './store.js';
import { splitRef } from './ref.js';
import { envContext, renderTemplate } from './env-vars.js';
import { exportCommand, EXPORT_FLAGS } from './export-notebooklm.js';

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
const QUIET = ['ignore', 'pipe', 'ignore'];


export const USAGE = `usage: dreamteamer <verb> [<target>] [flags]

record verbs (hard validation — invalid writes are rejected before disk).
A <target> is either a collection name or a <collection>/<id> reference; the reference splits at
the longest DECLARED collection prefix, so finance/transactions/2026/03/coffee is ONE argument:
  list   <collection> [--filter k=v] [--where <json>] [--sort [-]<field>] [--json]
  list   proofs [--missing]                   (a proof listing appends two COMPUTED columns:
                                               availability on THIS machine, and the last verdict
                                               from its ledger. --missing inverts it — one line per
                                               artifact no proof is about, so it takes no filter)
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
  next    <collection>[/<id>] [--ids <id>,…]  (which bound commands apply, and in which state:
                                               available / done / not-applicable — what can
                                               happen to this record next)
  relations [<collection>]                    (every two-way pair: owner.field → target.mirror)
  relations rebuild <collection> [--drop <f>] (regenerate mirror VALUES from the owning side;
                                               --drop removes a stale ex-mirror key from records)
  resolve '<string>' | <collection>/<id> <field>
                                              (render \${env:NAME} · \${workspaceFolder} ·
                                               \${userHome} — the ONLY substitution point; a
                                               record keeps the template verbatim. An array
                                               field prints one item per line)

system verbs — the SAME verbs, on the entities the compiler materializes (modules, collections,
skills, agents, commands, command-bindings, ui-views, collection-templates, proofs). ⚠ ONE
difference in POLICY, not in spelling: a SYSTEM write commits itself, because an uncompilable or
unpublished schema is not a state a workspace should sit in; a RECORD write does not — \`commit\`
publishes it. The commit lands in the repo that holds the source, so a write into a git module
commits there.
  add    collections --name <name> [--module <m>] [--namespace <ns>] [--template docs|entity]
                                              [--description "…"] [--suffix <s>] [--id-shape dated|slug]
                                              (--namespace health --name doctors === --name
                                               health/doctors; a module declaring exactly ONE
                                               namespace infers it, and the resolved name is echoed.
                                               --namespace '' means no namespace)
  add    modules --name <id> [--description "…"] [--namespace <ns>]
                                              (modules/<id>/ + every kind folder + package.json.
                                               --namespace DECLARES it in the module (§8), so every
                                               later \`add collections --module <id>\` infers it.
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
                            [--inverse-description "…"] [--unique] [--body] [--sensitive] [--module <m>]
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
  set-field    <collection> --name <field> [--type <type>] [--options a,b] [--default-value v]
                            [--required true|false] [--description "…"] [--body true|false] [--sensitive true|false]
                            [--many] [--inverse [name]] [--unique] [--module <m>]
                            [--on-delete restrict|set-null] [--mirror-of <collection>.<field>]
                            (an existing description survives a retype, and so does every relation
                             keyword you do not restate. --inverse on an EXISTING reference is the
                             migration: a plain foreign key gains its two-way mirror without
                             restating --type. --inverse= drops the mirror; --unique false clears
                             the one-to-one. Records written before the mirror existed are counted
                             for you, with the "relations rebuild" that repairs them.)
  rm-field     <collection> --name <field> [--module <m>] [--dry-run]
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
              [--harnesses claude-code,codex,pi,gemini-cli,cursor,notebooklm]
  --version   print the engine version (works anywhere)
  install     make THIS checkout ready — the engine, .env (linked from the primary when this is a
              worktree), declared local assets, git modules, compile, and a declared postinstall.
              Idempotent: it prints a board of what it found and what it did
              [--dry-run] plan only  [--json] the board as data
              [--link-env] link .env even into a worktree OUTSIDE the primary root
  install     --hook | --print-adapters
              --hook: read a harness hook's JSON payload from stdin and install the checkout its
              \`cwd\` names — the process cwd is the harness's, never the worktree's. In a linked
              worktree the board's last line is the landing instruction.
              --print-adapters: print the hook snippet for each declared harness. Merging it into
              the harness's own settings file is the operator's act — the engine never writes one
  install     repos/<id> | repos --all [--json]
              materialize an attached repo's working tree ON DEMAND — never as part of making a
              checkout ready; --all is the explicit opt-in, e.g. before going offline
  install     --clone <url> [name]            attach a git module to this workspace
  add         worktrees --name <n> [--path <dir>] [--base <ref>] [--temp] | --hook
              cut a linked git worktree on branch worktree-<n> and \`install\` it, so it is ready
              to work in; it prints its absolute path LAST, which is what a creation hook echoes.
              --temp: detached, no branch, under .worktrees/.tmp-* inside this root — a sandbox
              --hook: take the name from a WorktreeCreate payload on stdin; implies .worktrees/<n>
  list        worktrees | get worktrees/<n> | rm worktrees/<n> [--force]
              observed from \`git worktree list\`, never stored. rm refuses a worktree holding
              dirty records or commits not on the primary branch — neither is visible from here
  land        worktrees/<name|path> [--keep] [--dry-run] [--branch <n>] [--json]
              land a worktree's commits onto the primary branch — the one MOVEMENT verb. It refuses
              while the primary holds pending record writes, rebases a COPY of the branch under one
              engine-owned lock, resolves ONLY the generated harness block, fast-forwards, recompiles
              the primary, then removes the worktree and its branch. A conflict in a record aborts
              and leaves every tree exactly as it was
              [--keep] keep the worktree, reset onto what landed
              [--branch <n>] give a DETACHED worktree the branch worktree-<n> first
              [--dry-run] print the plan and change nothing
  land        --hook [--dry-run] [--json]
              read a WorktreeRemove payload on stdin and report what that worktree still holds.
              ALWAYS a dry run — the engine never lands while a harness is deleting the tree
  update      pull git_modules clones forward (ff-only on the lockfile ref), rebuild,
              then compile; [<name>] updates just one. dirty clones are skipped
  compile     materialize modules + workspace sources into .dreamteamer (+ harness adapters)
              [--watch] recompile on source changes
  check       validate every record against the compiled descriptors (report-only)
  prove       <proof> | <artifact-ref> | --all
              run a proof and answer with an EXIT CODE: 0 pass · 1 fail · 3 unavailable (this
              machine lacks a required var or binary) · 4 no-fixture (the given matched no record)
              · 5 a \`perform\` step is owed a human/agent · 6 vacuous (every expectation already
              held, so the proof cannot fail). Evidence lands in .dreamteamer/.proofs/<id>.jsonl
              <proof>          [--record <c>/<id>] finish the pending run for that record
                               [--restart] discard a pending run and start over
                               [--here] run a \`writes\` proof in this workspace, not a sandbox
                               [--keep] keep the sandbox afterwards — under --json that is
                               \`kept: true\` beside the \`sandbox\` path  [--json] one object on stdout
              <artifact-ref>   every proof whose \`about\` names skills/<id>, commands/<id>,
                               command-bindings/<id> or <module>/bin/<file> — board semantics, so
                               it takes the same [--kind gate|live] [--external] [--strict] [--json]
              --all            every proof; a \`perform\` one is LISTED, never started, so this
                               never exits 5. ONE line per proof — a step transcript is what a
                               single-proof run is for [--kind gate|live] [--external] include
                               external proofs [--strict] make an unavailable fatal [--json]
  status      workspace status: compiled runtime freshness, per-module channel/ref, staleness,
              and one \`proofs:\` line counting each proof's LAST verdict on this machine
              [--strict] exit 1 when any proof's ledger tail is a FAIL
  start       serve the clean REST api at /api [--port <n>]
  changes     what changed in every repo that holds records, as record events
              [--since <sha|YYYY-MM-DD>] (default: HEAD~1 — the last commit's own changes) [--json]
  commit      publish records already written to disk: samples git status over every
              collection's record dirs, one commit PER REPO, subject composed from the
              status letters. Scope it with any number of targets, each either a whole
              <collection> or one <collection>/<id> — the record form is what keeps a
              concurrent session's pending records out of your commit.
              [<collection>|<collection>/<id> …] [-m <subject>] [--dry-run] [--json]
  export      render the workspace for a consumer that is not a coding agent, and optionally sync it
              export notebooklm [--out <dir>] [--plan standard|plus|pro|ultra|<n>] [--max-words <n>]
                                [--collections a,b] [--instructions <template.md>]
                                [--notebook <id> | --create "<title>"] [--response-length default|longer|shorter]
                                [--mode default|learning-guide|concise|detailed] [--wait] [--json]
              writes one schema source (workspace → module → collection → field), one source per
              collection (sharded by --max-words, titled \`dt · <c> [n/m]\`), and the persona from a
              template; a collection marked \`sensitive: true\` and a field marked \`x-sensitive: true\`
              never travel. Refuses when the sources exceed the plan. With --notebook/--create it
              adds, replaces and removes its own sources to match and applies the persona.
  help        this text
`;

// Record verbs, split by what their <target> means. `move` and `next` are in NEITHER set: both
// accept either shape, and which one it is has to be decided against the declared collections.
// How many rows a per-record listing prints before it summarises. ONE number, because a report that
// caps one of its lists and not the next reads as a bug in whichever list ran long.
const ROWS_SHOWN = 20;

const REF_VERBS = new Set(['get', 'set', 'rm', 'rename', 'history', 'diff', 'revert']);
const COLLECTION_VERBS = new Set(['list', 'add', 'values']);
const EITHER_VERBS = new Set(['move', 'next']);

// FIELD VERBS. Their <target> is a collection and everything else is flags, which is the one shape
// that differs from the record verbs — so they get their own case arm rather than being folded into
// `dispatchRecordVerb`. There is no `schema <op>` table any more: system entities take the record
// verbs, and `collectionCommand`'s interceptors are the whole dispatch (§4).
const FIELD_VERBS = ['add-field', 'set-field', 'rm-field', 'rename-field'];

// WORKSPACE VERBS take a closed set of options, and nothing downstream of here would notice a
// misspelling — `dt commit --dryrun` COMMITTED, because `rest.includes('--dry-run')` is false for a
// flag nobody typed correctly. The record/system/field verbs are checked in `collections-cli.js`,
// beside the parser they share; these nine have no shared parser, so the table is here.
export const WORKSPACE_FLAGS = {
	init: ['name', 'data-path', 'harnesses', 'workspace-module'], update: [],
	install: ['clone', 'dry-run', 'json', 'link-env', 'all', 'hook', 'print-adapters'],
	start: ['port'], compile: ['watch'], check: [], status: ['strict'],
	changes: ['since', 'json'], commit: ['dry-run', 'json'],
	export: EXPORT_FLAGS,
	// the UNION of every form's flags — the outer typo gate. Which flags each FORM takes is refused
	// inside `proveCommand`, where the target has been resolved against the compiled proofs.
	prove: ['all', 'kind', 'record', 'restart', 'json', 'keep', 'here', 'external', 'strict'],
	// same shape: the union of both forms, with `--hook`'s vocabulary refused in the arm below
	land: ['keep', 'dry-run', 'branch', 'hook', 'json'],
};

export function run(argv) {
	const [cmd, ...rest] = argv;
	try {
		if (cmd in WORKSPACE_FLAGS) {
			const bad = rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]).find((f) => !WORKSPACE_FLAGS[cmd].includes(f));
			if (bad) throw new Error(`unknown flag "--${bad}" on \`dt ${cmd}\`\n  known: ${WORKSPACE_FLAGS[cmd].map((f) => `--${f}`).join(', ') || '(none — this verb takes no flags)'}`);
		}
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
			emit(USAGE);
			process.exit(0);
		}
		const ws = findWorkspace();
		switch (cmd) {
			// ONE verb makes a thing present and ready: this checkout, or an attached repo's
			// working tree. `ensure` was the second spelling of the same idea and is retired in the
			// `default` arm below — no alias, per the 0.12.0 policy.
			//
			// ⚠ THREE FORMS, ONE FLAG TABLE — so each form REFUSES the other's vocabulary itself.
			// `WORKSPACE_FLAGS.install` can only say which flags the verb has; it cannot know that
			// `--dry-run` is meaningless once a target is named. Forwarding just the flags a form
			// understands DROPS the rest in silence, and that is not a cosmetic loss:
			// `dt install repos/x --dry-run` materialized the repo for real, driven past a flag
			// whose entire meaning is "do nothing". A bare positional had the same shape of bug —
			// `dt install <repo-id>`, the muscle memory `dt ensure <id>` taught for nine releases,
			// matched neither branch, so the target was ignored and a whole checkout install ran.
			// Same policy as the retired verbs below: a stale invocation fails loudly.
			case 'install': {
				const given = rest.filter((a) => a.startsWith('--'));
				const refuse = (form, allowed) => {
					const stray = given.filter((f) => !allowed.includes(f));
					if (!stray.length) return;
					throw new Error(`${stray.join(' ')} ${stray.length > 1 ? 'are not flags' : 'is not a flag'} of \`${form}\` — that form takes ${allowed.join(' ')}`);
				};
				const ci = rest.indexOf('--clone');
				if (ci > -1) {
					refuse('dt install --clone <url> [name]', ['--clone']);
					process.exit(installClone(ws, rest[ci + 1], rest[ci + 2]));
				}
				const target = rest.find((a) => !a.startsWith('--'));
				if (target === 'repos' || target?.startsWith('repos/')) {
					refuse(`dt install ${target}`, ['--all', '--json']);
					warnIfStale(ws.root);
					const args = target === 'repos' ? given : [target.slice('repos/'.length), ...given];
					process.exit(collectionCommand(ws, 'repos', 'ensure', args));
				}
				if (target) {
					throw new Error(`dt install takes no target "${target}" — \`dt install\` makes THIS checkout ready, and \`dt install repos/${target}\` materializes an attached repo`);
				}
				// ⚠ TWO MORE FORMS, EACH ITS OWN VOCABULARY. `--hook` reads a JSON payload off stdin
				// and installs the checkout that payload names; `--print-adapters` installs nothing
				// at all. Folding either into `dt install`'s flag list would let `--hook --dry-run`
				// through as a plan of a checkout nobody named, and `--print-adapters --link-env`
				// as a symlink placed by a verb whose whole job is to print.
				if (given.includes('--hook')) {
					refuse('dt install --hook', ['--hook']);
					process.exit(installCommand(ws, rest));
				}
				if (given.includes('--print-adapters')) {
					refuse('dt install --print-adapters', ['--print-adapters']);
					process.exit(installCommand(ws, rest));
				}
				refuse('dt install', ['--dry-run', '--json', '--link-env']);
				process.exit(installCommand(ws, rest));
			}
			// ⚠ THE EXIT CODE IS THE WHOLE POINT OF THIS VERB, so `proveCommand` RETURNS it and this
			// line is the only place it becomes a process exit. Six codes are a contract — 0 pass ·
			// 1 fail · 3 unavailable · 4 no-fixture · 5 an actor is owed a step · 6 vacuous — and a
			// `throw` inside `prove` becomes 1 through the shared catch below, which is right for
			// every refusal it makes (a target that names nothing, a resume with nothing to resume,
			// a stray flag of the other form): those are errors about the INVOCATION, not verdicts
			// about an artifact, and 2 is already spoken for by "you typed a verb that is gone".
			//
			// The per-form flag refusal lives in `proveCommand` rather than here, unlike `install`'s:
			// deciding which form was typed means resolving the target against the compiled proofs
			// and artifacts, and a second copy of that resolution in this file — purely to choose
			// which message to print — is the drift the comment above `case 'install':` describes.
			case 'prove':
				warnIfStale(ws.root);
				process.exit(proveCommand(ws, rest).code);
			// THE ONE MOVEMENT VERB (decision 309). Two forms and, like `install`'s, each refuses the
			// other's vocabulary here: the flag table can only say which flags `land` HAS, and a
			// `--hook --keep` accepted-and-dropped would promise a worktree kept by a form that is
			// always a dry run. A refusal or a conflict throws or returns 1; 2 stays what it is
			// everywhere else — "you typed a verb that is gone".
			case 'land': {
				const given = rest.filter((a) => a.startsWith('--'));
				const stray = given.filter((f) => !(given.includes('--hook') ? ['--hook', '--dry-run', '--json'] : ['--keep', '--dry-run', '--branch', '--json']).includes(f));
				if (stray.length) {
					const form = given.includes('--hook') ? 'dt land --hook' : 'dt land worktrees/<name>';
					throw new Error(`${stray.join(' ')} ${stray.length > 1 ? 'are not flags' : 'is not a flag'} of \`${form}\` — that form takes ${(given.includes('--hook') ? ['--hook', '--dry-run', '--json'] : ['--keep', '--dry-run', '--branch', '--json']).join(' ')}`);
				}
				warnIfStale(ws.root);
				process.exit(landCommand(ws, rest));
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
				// ⚠ WHICH CHECKOUT AM I. Everything `install` decides turns on this, and a linked
				// worktree is indistinguishable from the primary by eye — so it is stated, with the
				// count of sibling worktrees holding records and commits that are invisible from
				// here. Wrapped like every other block below: `status` is the command run when
				// things are already wrong, and it must still print.
				try {
					const co = describeCheckout(ws.root);
					console.log(`checkout: ${co.kind === 'primary' ? 'primary' : `linked worktree of ${co.primary}`}`);
					const wts = listWorktrees(ws).filter((w) => !w.primary);
					console.log(`worktrees: ${wts.length} · ${wts.filter((w) => w.dirtyRecords).length} with dirty records · ${wts.filter((w) => w.ahead).length} ahead`);
				} catch { /* not a git checkout — nothing to report about worktrees */ }
				// ⚠ WHAT THIS MACHINE HAS ACTUALLY PROVED. A ledger is per-machine and gitignored, so
				// this line cannot be derived from the repo — and it is the only place a FAIL from
				// last week surfaces without being asked for. The TAIL per proof, not every row: a
				// proof that failed on Monday and passed on Tuesday is passing. Wrapped like every
				// block here — an older runtime has no `proofs` descriptor, and status must still print.
				// ⚠ M5 — COUNTED AS THE WALK GOES, NEVER ASSIGNED AT THE END OF IT. `proofsFailed =
				// tally.FAIL` sat below the loop, inside the try — so a throw partway through (an
				// unreadable ledger, a record that will not parse) left the gate reading ZERO failures
				// and `--strict` exiting 0 BECAUSE the count broke. That is the one direction a gate
				// must never fail: a silent green bought with a swallowed exception.
				let proofsFailed = 0;
				try {
					const tally = { PASS: 0, FAIL: 0, UNAVAILABLE: 0 };
					let declared = 0; let never = 0; let other = 0;
					// ⚠ A SANDBOX NOTHING WILL COME BACK FOR. `.worktrees/` is gitignored, so a kept or
					// un-removable one accumulates in silence and the ledger is the only thing that
					// knows the directory exists. `kept` is not a row field: a terminal row with a
					// sandbox and NO removal attempted (`null`) is exactly what `--keep` leaves behind.
					// `existsSync` because a count nothing can clear is a lie.
					const left = new Set();
					for (const { id } of new Store(ws).readAll('proofs')) {
						declared++;
						const rows = readLedger(ws.root, id);
						const t = rows[rows.length - 1];
						if (!t) never++;
						else if (t.verdict in tally) { tally[t.verdict]++; if (t.verdict === 'FAIL') proofsFailed++; }
						else other++;
						for (const r of rows) {
							const behind = r.sandbox_removed === false || (r.verdict !== 'PENDING' && r.sandbox_removed === null);
							if (r.sandbox && behind && fs.existsSync(r.sandbox)) left.add(r.sandbox);
						}
					}
					console.log(`proofs: ${declared} declared · ${tally.PASS} passed · ${tally.FAIL} failed · ${tally.UNAVAILABLE} unavailable · ${never} never${other ? ` · ${other} other` : ''}`);
					if (left.size) console.log(`  sandboxes left behind: ${left.size} — dt list worktrees`);
				} catch { /* no proofs descriptor compiled — nothing to report */ }
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
						// `dreamteamer install repos/<id>` is not the fix for it — say which one this is.
						for (const r of repos) if (!r.present) console.log(`  absent: ${r.id} → ${r.path}${r.unresolved ? ` — ${r.unresolved}` : ` (dreamteamer install repos/${r.id})`}`);
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
				// ⚠ THE FAIL IS FATAL ONLY WHEN ASKED. `status` is the command you run when things are
				// already wrong, so it prints EVERYTHING first and gates last — the same shape the
				// staleness exit above has.
				// ⚠ R38/R46 — `--strict=true` IS THE SAME FLAG, AND `--strict=false` IS OFF. The
				// unknown-flag gate above splits on `=`, so the `=` spelling was ACCEPTED and then read
				// as "no --strict at all" — a CI step written that way stayed green over a failing
				// proof, for a reason nothing printed. `flagEnabled` is the one reader of that shape,
				// shared with `dt prove`, so the two verbs cannot disagree about what was typed.
				if (flagEnabled(rest, 'strict') && proofsFailed) {
					console.log(`✖ ${proofsFailed} proof(s) FAILED on this machine — dt list proofs`);
					process.exit(1);
				}
				process.exit(0);
			}
			// `export <target>` — the workspace rendered for a consumer that is not a coding agent. One
			// target today; the map in export-notebooklm.js is where a second one would register, the way
			// harnesses do. Without --notebook/--create it is a pure render and touches no network.
			case 'export': {
				warnIfStale(ws.root);
				const { flags, pos } = parseArgs(rest);
				process.exit(exportCommand(ws, pos[0], flags));
			}
			case 'help':
				emit(USAGE);
				process.exit(0);
			case 'list': case 'add': case 'values':
			case 'get': case 'set': case 'rm': case 'rename': case 'history': case 'diff': case 'revert':
			case 'move': case 'next': {
				// ⚠ `worktrees` IS NOT A COLLECTION — it is observed from git — so it is intercepted
				// here rather than being dispatched. Which means it never reaches
				// `collectionCommand`, where every other verb's flags are refused: the parse and the
				// refusal have to be done HERE or `--tmep` is swallowed and a request for a
				// throwaway sandbox silently becomes a permanent branch worktree.
				const target = rest[0];
				if (target === 'worktrees' || target?.startsWith('worktrees/')) {
					const { flags } = parseArgs(rest.slice(1));
					refuseUnknownFlags(null, 'worktrees', cmd, flags);
					process.exit(worktreeCommand(ws, cmd, target, flags));
				}
				warnIfStale(ws.root);
				process.exit(dispatchRecordVerb(ws, cmd, rest));
			}
			// The verb `check`'s stale-mirror message names. It reads the compiled relations, and
			// rebuild WRITES records, so both want the same staleness warning every record verb gets.
			// FIELD VERBS — see FIELD_VERBS. Their <target> is a collection and everything else is
			// flags, so they are their own case rather than being folded into `dispatchRecordVerb`.
			//
			// ⚠ THE RETIRED SPELLINGS ARE GONE, not aliased. The 0.12.0 policy: a stale invocation
			// must fail loudly, because a half-working grammar teaches the wrong shape without ever
			// saying so. The `default` arm below names each one — `schema`, `ensure`, `update-field`,
			// `remove-field`, `commands` — and carries its replacement.
			case 'add-field': case 'set-field': case 'rm-field': case 'rename-field': {
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
			case 'resolve':
				process.exit(resolveVariables(ws, rest));
			default:
				// ⚠ NAMED, not just unknown. Every doc, skill and downstream script spelled these
				// `dt schema <op>` for seven releases, so the failure has to carry the translation —
				// an "unknown verb" alone sends the reader to `help` to guess which of thirty verbs
				// replaced the one they typed. No alias layer and no deprecation window: 0.12.0's
				// policy, and the reason it is the right one is that `dt contacts list` failing
				// loudly is what taught the verb-first grammar in one command.
				//
				// ⚠ ONE EXIT CODE FOR ALL OF THEM: 2, the usage code. "You typed a verb that is
				// gone" is one answer, so a script (and an operator) asks it once rather than
				// learning which retirement exits 1 and which exits 2.
				if (cmd === 'schema') {
					console.error('✖ unknown verb "schema" — schema verbs are gone since 0.19.0. System entities take the RECORD verbs now:');
					console.error('    dt add collections --name <c> [--module <m>] · dt rm collections/<c> · dt rename collections/<old> <new>');
					console.error('    dt set collections/<c> module=<m> | <scalar>=<v>   · dt get collections/<c> [--module <m>]');
					console.error('    dt add-field <c> … · dt set-field <c> … · dt rm-field <c> … · dt rename-field <c> --name <f> --to <g>');
					console.error('    dt add|set|rm|rename modules/<id> …               · dt add|set|rm|rename ui-views/<id> …');
					console.error('  the full mapping table is in UPDATING.md (0.18.0 → 0.19.0), and `dt help` has the current spellings.');
					process.exit(2);
				}
				if (cmd === 'ensure') {
					console.error('✖ unknown verb "ensure" — gone since 0.22.0 (decision 309: install is the one verb that makes a thing present and ready):');
					console.error('    dt install                 this checkout — engine, .env, local assets, git modules, compile, postinstall');
					console.error('    dt install repos/<id>      materialize one attached repo · dt install repos --all');
					process.exit(2);
				}
				// The change verbs spell one way. `add · set · rm · rename` are the record verbs, so
				// `update-field`/`remove-field` were a second spelling for one action inside one
				// grammar — the field verbs now say `add-field · set-field · rm-field · rename-field`.
				if (cmd === 'update-field' || cmd === 'remove-field') {
					const to = cmd === 'update-field' ? 'set-field' : 'rm-field';
					console.error(`✖ unknown verb "${cmd}" — gone since 0.22.0 (decision 309: a field verb spells its action the way the record verbs do):`);
					console.error(`    dt ${to} <collection> --name <field> …`);
					console.error('    the field verbs are: dt add-field · dt set-field · dt rm-field · dt rename-field');
					process.exit(2);
				}
				// `dt commands <ref>` and `dt list commands` were one word for two things — the read
				// verb and the system entity. `next` also says what it answers.
				if (cmd === 'commands') {
					console.error('✖ unknown verb "commands" — gone since 0.22.0 (decision 309: it collided with the `commands` ENTITY, which `dt list commands` reads):');
					console.error('    dt next <collection>[/<id>]   which bound commands apply to this record, and in which state');
					console.error('    dt list commands              the command entities this workspace ships');
					process.exit(2);
				}
				console.error(`✖ unknown verb "${cmd}" — dreamteamer is verb-first since 0.12.0: dt <verb> [<target>]`);
				emit(USAGE, 2);
				process.exit(1);
		}
	} catch (e) {
		console.error(`✖ ${e.message}`);
		// ⚠ AND ON STDOUT UNDER `--hook`, because that is the whole reason the shim exists.
		// `bin/dt-hook.sh` fails onto stdout with a comment saying why: a hook's stdout is added to
		// the session's context and its stderr is nobody's problem. Every success path here already
		// prints to stdout; every FAILURE went to stderr alone, so a mis-wired hook, a bad payload, a
		// TTY invocation or a refusal was invisible to exactly the reader the shim was built for.
		if (process.argv.includes('--hook')) console.log(`✖ ${e.message}`);
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
	// `next <collection>`.
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
