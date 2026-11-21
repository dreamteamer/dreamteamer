# dreamteamer — the engine

`dreamteamer`: workspace compiler, CLI, store, schema-ops — and a public API (`src/api.ts`,
its declarations generated from `src/types.ts` and the signatures, plus the `dreamteamer/records` and
`dreamteamer/testing` subpaths) that is the ONLY importable surface. See `README.md` for the contract
(sources → `.dreamteamer/` → harness adapters; records are files; a write lands on disk and
`dreamteamer commit` publishes it, one commit per repo; hard validation before disk).

## IMPORTANT — the engine is TypeScript, and the bin runs the BUILD

`src/*.ts` is the source, and its relative imports name the `.ts` file (`./store.ts`).

- **`bin/dreamteamer.js` always runs `dist/`**, in the npm package and in a checkout alike — the bin
  runs what ships, and refuses with "not built" when `dist/` is missing. A checkout (including one a
  workspace links in as `node_modules/dreamteamer`) runs `npm run build` first. Running the TypeScript directly is a
  separate, explicit choice, never the bin's fallback.
- **`npm run build`** (also run by `prepack`, and by the test runner before tier 2) emits `dist/` with
  tsc, rewriting `.ts` imports to `.js`. Node refuses to strip types under `node_modules`, so `src/` is
  not published. `dist/` sits one level under the root like `src/`, so
  `new URL('../package.json', import.meta.url)` means the same from both. `engines` stays `>=20`
  because it describes `dist/`; CI proves 20 against the packed tarball, and the suite on 22/24.
- **The tests run as `.ts`** and import `src/` directly; every `dt` they launch runs the `dist/` the
  runner just built from the same tree. A test file run by hand with `node --test` needs a build first.
  A test that packs the engine passes `--ignore-scripts`, packing that build: `prepack` would delete
  `dist/` under the files running beside it.

So only ERASABLE syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter
properties; type-only imports are `import type`. `npm run typecheck` is part of `verify`.

**The tests are TypeScript too, checked PERMISSIVELY by their own `test/tsconfig.json`**
(`npm run typecheck:test`, also part of `verify`). It is not in `tsconfig.json` — no `strict`, implicit
`any` allowed, and ESLint relaxes its rules for `test/` the same way — because a test deliberately
passes partial or invalid shapes. Say so with the helpers rather than a cast per call site:
`desc()` / `descriptors()` (`test/helpers/partial.ts`) for a partial descriptor, `as any` on an input
that is wrong ON PURPOSE, `as Partial<X> as X` for a stub carrying only part of a context.
`test/types/consumer.ts` is the exception both ways: excluded from the test config and linted strict,
because it is the public-API contract `npm run contract` compiles.

**Lint and format are part of `verify`.** `npm run lint` is ESLint with the recommended rules of ESLint
and typescript-eslint, no exceptions beyond the `_`-prefix and rest-sibling conventions — no `any`
anywhere (a shape the engine does not constrain is `unknown`, a `Record<string, unknown>`, or a named
type in `src/types.ts`; parsed YAML is `load<T>()` with the shape the caller expects). `npm run format`
is Prettier with `.prettierrc`, over code only (`.prettierignore` keeps YAML, Markdown and JSON byte-for-
byte — they are engine input). That is also why TypeScript is 6.0, not the native 7: typescript-eslint
needs the compiler's JavaScript API, which 7 does not have. ⚠ A test or script that reads SOURCE AS TEXT
must not depend on formatting: match either quote, and normalise whitespace (`revision-args`), or a
reformat leaves the pattern matching nothing and the check passing — `layers` refuses a scan that finds
almost no import edges for exactly that reason. `code.total` is counted on formatted source: the
reformat alone multiplied it by 1.499, and the budget was scaled by the same factor (metrics.json says so).

`scripts/*.ts` are TypeScript too and run the same way (`node scripts/test.ts`), with one exception:
**the build runs through `tsx`** (`npm run build` / `prepack`), because CI's Node 20 job packs the
tarball on Node 20, which cannot strip types. The two migrations users run from the package
(`migrate-descriptors-v2`, `migrate-stubs`) are BUILT to `dist/scripts/*.js` — Node refuses to strip
types under `node_modules` — so their published path is `node_modules/dreamteamer/dist/scripts/…`.

**The declarations are GENERATED** (`dist/*.d.ts`, by the build) from the exported signatures and
`src/types.ts`, which holds every shape the contract publishes. They used to be hand-written, and nothing
held the code to them — `KNOWN_OPERATORS` was declared an array and was a Set (review F8). Generation
removes that drift and leaves one risk, PRECISION: a public signature sliding to `any`, which every
consumer then compiles against without a word. So `test/types/consumer.ts` is the contract — a strict
consumer of what the editor, the mobile app and extensions rely on, with `@ts-expect-error` lines that
fail when a signature loosens and a ratchet that no public function takes or returns `any` outside a
named list. `npm run contract` runs it; the public-API test runs it against `src/` AND the packed tarball.
A type-only edge (`import type`, `typeof import(…)`) is erased by construction, so `layers` and the
browser-closure test skip it — that is what lets both halves name `src/types.ts`.
`bin/dreamteamer.js` stays JavaScript (type-checked via `checkJs`): it is what npm links, and it runs
before any of the engine is loaded.

## IMPORTANT — core is records + the compiler; everything else is an EXTENSION

Since 0.31.0 anything with a lifecycle of its own lives outside core: `prove` · `land` · `worktree`,
`serve`, `notebooklm` and the local Docker host were extracted as extension packages, published under
`@dreamteamer/*` from [dreamteamer-modules](https://github.com/dreamteamer/dreamteamer-modules). The
extraction took core from 10,669 to ~7,600 code lines and its install from 77 packages to 10.

An extension is a module — one under `modules/<id>/`, or a DIRECT dependency — declaring
`dreamteamer.extension`; `src/extensions.js` activates it
with this engine's public API, and it may contribute `commands`, `sourceKinds` (+`exclude`), `analyze`,
`harnesses`, `orientation`, `hooks`, `check`, `doctor`, `next`, `setup` — nothing else, and a collision refuses. The contract lives in
`skills/using-dreamteamer/references/extensions.md`. **So the fourth leanness question below is: could
an extension do it instead?** A new verb whose engine reading is "the CLI dispatches it" is the
extension shape, not a core verb.

⚠ **Do not grow the seam casually.** Every contribution key has a consumer that needed it — `check`
carries the record guards modules used to chain after `dt check` by hand, and `doctor` gives every
module's machine checks one board (`dt doctor`) a stranger has without installing a setup tool, and
`next` lets the module that keeps live sessions say *in session by …* where `dt next` answers. The
next one is a design decision (the deferred ones: a storage driver, a record-write hook, a workflow
scheduler, an external harness REGISTRY beyond managed blocks). "An extension might want it" is not a
consumer.

## IMPORTANT — core stays EXTREMELY lean, and that is measured

Every addition to core arrives with a good local reason. Nothing ever argues for removal. So growth
is budgeted rather than trusted:

```bash
npm run metrics          # size, complexity, surface, and the drift since the baseline
npm run metrics:check    # exits 1 if any budget is exceeded
npm run metrics -- --update   # rewrite metrics.json — a DELIBERATE act, same commit as the growth
```

`metrics.json` is committed. A blown budget is not an error; it is the prompt to answer three
questions **before** writing the code, out loud, in the commit message:

1. **Does the ENGINE read it?** That is the whole test for a core collection or field. What survives
   it: the entity kinds the compiler materializes and `repos` (because `install repos/<id>` clones
   them) — **nine collections**. `proofs` was the tenth until 0.31.0; it passed this test only
   because compile hard-coded proof validation, which is the circular shape below — now the
   proofs extension contributes the kind AND its validator, and core reads neither.

   ⚠ **`users` failed it on 2026-08-17 (0.8.0), and the lesson is a CIRCULAR justification.** It was
   core "because `@me` resolves against it" — and `@me` existed because `users` was core. Nothing in
   the compiler, the store or `check` ever read a user record. One record per workspace whose only job
   was to restate `git config user.name` in a file that then had to *agree* with it; when it disagreed
   the symptom was an empty inbox and no error (decision 99b). **A justification that only points at
   another core feature is not a justification.** Read the operator from git at the point of need.

   What failed the test, all on 2026-07-31: `teams` (nothing in the engine, `check` or any view ever
   resolved a team) · `mounts` (a one-implementation `adapter` enum over what is really an `.env` key)
   · `module-registries` (zero records, zero readers) · `workflows` + `workflow-runs` +
   `workflow-triggers` + `cursors` and `migrations` + `migration-runs` (both **measured** unused — see
   below) · and `tasks`, whose only claim to core had been the workflow gate that no longer exists.

   ⚠ **The two measured removals are the ones to learn from,** because both subsystems were correct,
   gate-tested and plausible. The workflow layer produced 1 workflow record, 9 runs from a single
   burst with **7 abandoned mid-flight**, and a cursor that stopped advancing — while the work it
   automated was being done by a chain of commands a person runs. `dt migrate` was never invoked once:
   every real schema change in this project's history was a hand-written script that went around it.
   **Correctness is not usage.** Measure before you keep.
2. **Is this a recipe creeping into core?** Anything domain-shaped — people, meetings, products,
   content, funnels — belongs in a module. The published ones live in
   [dreamteamer-modules](https://github.com/dreamteamer/dreamteamer-modules) and arrive with
   `dt install <package>`; a workspace that wants a different shape overlays the collection or writes
   its own module. Four workspaces have wanted a CRM and all four wanted a different `contacts` —
   core must not absorb that variance on their behalf.
3. **Could a module do it instead?** A module can ship collections, skills, commands,
   command-bindings, agents, ui-views and component code. If the capability is expressible as a
   module, core growing to hold it is a decision to make everyone carry it.
4. **Could an EXTENSION do it instead?** If it is code with its own lifecycle — a server, a runner,
   an exporter, a host — it is an extension package, and core owes it at most a contribution key.

Two shapes to reject on sight, both learned here:

- **An enum that is a roadmap.** `adapter: gdrive|s3|git` with one implementation was a schema
  advertising work nobody had done. If only one value works, there is no field.
- **A capability that needs a record seeded before it exists.** A collection whose entire job is to
  name a folder is a level of indirection over an `.env` key. That is why `mounts` was deleted rather
  than kept.

⚠ **A measurement keeps its NUMBERS and never its source's NAME.** This engine is published; the
vault it is dogfooded on is private, so naming that vault in a comment leaks provenance and hands the
reader a figure nobody else can re-run. So: a finding discovered on a dogfood vault gets a **generated
fixture under `test/perf/`** before it gets a comment, and the comment cites **the reproduction, not
the vault** — `renameCollection`'s header is the worked example. Anonymise the identifier, keep every
digit, and never soften the explanation to achieve it.

The prose budget matters as much as the code one: a skill nobody can afford to load is not a
capability. Core ships **ONE** skill — `using-dreamteamer`, a digest with `references/` split into
two acts (working with data / modeling the workspace) — so the always-loaded file stays small and
detail is fetched on demand. Adding a second top-level skill to core is almost certainly wrong;
add a reference to the digest instead. (`building-dreamteamer` folded into it in 0.16.0.)

## IMPORTANT — sources are FLAT at a module root, and unknown folders are a compile ERROR

A module's sources live at its root — `modules/crm/skills/`, beside `data/` and `package.json` — and
the compiled runtime matches: `.dreamteamer/<kind>/`. There is no `system/` level. **KINDS was always
the allowlist**; the extra directory named nothing the engine read, and it is also the shape
coding-agent plugin repos use.

⚠ **The workspace's OWN module is `modules/default`, named for its ROLE** (0.8.0; `init` seeds it, and
`--workspace_module <name>` overrides). It used to be named after the workspace, and that name went
stale twice in one repo — decision 213, reversed by 224 — each rename rewriting every
path that RESOLVES while the historical documents deliberately kept the old spelling, so the old
`modules/<vault>` was correct in prose and a bug in a path. A role name cannot go stale.
It is deliberately the same word `RESERVED_NAMESPACES` holds: this module owns the DEFAULT-namespace
collections, and the default namespace is the empty prefix. The one misreading it invites,
`default/tasks`, is a compile error whose message states the rule. **An existing workspace is
unaffected** — its `workspace_module` key already exists and wins over the seed.

Three things hold this up, and all three exist because removing the wrapper removed a free guarantee:

1. **`compile` enumerates each module root and FAILS on a folder that is not a known kind.** Inside
   `system/` there was no legitimate non-kind folder, so "not a kind" could mean "ignore it". At a
   module root it cannot. This is the fix for decision 156 — a kind the engine stopped knowing
   (`workflows`) sat in a module for two days while compile said ✔. Generic package folders are
   allowed by `NON_SOURCE_DIRS`; anything else the module declares as
   `"dreamteamer": { "ignore": ["dashboard"] }`. That is genuine per-module variance (one module
   ships a `dashboard/`, another owns its `data/`), not a layout knob every module would set
   identically.
2. **`kindDir(root, kind)` still reads `system/<kind>` as a fallback**, and a module holding BOTH
   spellings of one kind gets a warning naming the half that is not compiled. ⚠ **Keep the fallback.**
   Every workspace on the current engine is flat as of 2026-08-05, so it looks dead —
   but recipes modules are **copied, not installed**, with no version discipline, so a module copied
   out of an older recipes commit arrives nested and must still compile. Ten lines that make a
   pre-flatten copy work are worth more than the ten lines are worth saving.
3. **`storage.base`, not a path prefix, answers "is this the runtime?"** Flattening inverted every
   `startsWith('system/')` test silently, because a runtime collection's path became a bare kind name.
   `compile` decides `base` once (an exact KINDS match) and everything else reads the field.

⚠ **A pre-flatten engine cannot read a runtime compiled by this one** — it looks for
`.dreamteamer/system/collections` and reports "no compiled runtime", which is accurate and fixed by
`dt compile`. Only reachable when two engines share a workspace.
The VS Code extension is immune from 0.6.33 on: it probes both layouts and reads `storage.base`.

## IMPORTANT — namespaces are DECLARED, and the delimiter is a slash

A collection name may carry a slash-delimited namespace: `health/doctors` lives in `data/health/doctors/`
and a record of it is referenced as `health/doctors/dana-levi`. The **default namespace is the empty
prefix** — `tasks/kickoff` in `data/tasks/`, exactly as before — so adopting namespaces migrates
nothing, and `default` is a RESERVED name so there is never a second spelling for one collection.

⚠ **The whole problem in one line: an id is also a slash-delimited path.** `meetings/2026/07/kickoff`
is one collection and a three-segment id, so `a/b/c` is either collection `a` + id `b/c` or collection
`a/b` + id `c`, and nothing about the string says which. That is why namespaces are **declared** — in
the `package.json` of the module that owns each one (since 0.19.0; the workspace's own block may
declare some too, and the effective set is the union):

```json
"dreamteamer": { "namespaces": ["health", "finance", "work/clients"] }
```

`src/namespace.js` (record layer, pure) owns the split, and every parser goes through its `parseRef` —
the store's write-time check, `check`'s report, and the extension. Longest declared prefix wins, which
is why `normalizeNamespaces` sorts longest-first: parent-first would read `work/clients/acme/2026` as
the namespace `work`, a different record. Four things compile REFUSES, each because the alternative was
silent:

1. **A slashed collection name whose prefix is not declared.** Before this existed it compiled clean,
   landed at `.dreamteamer/collections/<ns>/<name>.collection.yaml`, and then vanished — `loadDescriptors`
   read one directory level, so the collection was absent from the runtime while compile said ✔ and
   `dt list <c>` answered "unknown collection". The loader now walks; the declaration is enforced.
2. **A namespace colliding with a collection name.** With both a namespace `health` and a collection
   `health`, `health/doctors/dana-levi` is a record of two different collections and longest-match would
   silently pick one.
3. **`default` in any namespace segment**, per the transparency rule above.
4. **One collection's `storage.path` inside another's.** MEASURED data loss, not hypothetical: give A
   `data/health` and B `data/health/doctors` and A's recursive walk indexes B's records as its own —
   `dt list A` prints B's records, `check` reports B's fields as unknown fields of A, and a write through
   A can overwrite a record of B. compile reported ✔ through all of it because nothing compared two
   paths. `namespace.storageOverlaps` is now a hard gate, and namespaces make near-misses ordinary.

Two consequences worth keeping:

- **`dt rename collections/<old> <new>` is how EXISTING data gets namespaced** — descriptor, records, filenames and
  every inbound reference in one commit. It rewrites refs by asking the store once per record id rather
  than matching the collection prefix with a new regex: `store.rewriteRefs` already knows the boundary
  rules and already scopes prose to `[[wikilinks]]`, and a fresh `oldName/` pattern would corrupt
  `data/tasks/` in a path on its first outing. Bare `x-reference: <old>` needs its own pass — it is not
  a `<collection>/<id>` ref, so the per-record rewrite cannot see it.
- **`collections/` is enumerated RECURSIVELY at a module root** (every other kind stays flat — their ids
  are single segments). `schema-ops` derives a descriptor's source path from its name, so `add-field` on
  `health/doctors` writes `collections/health/doctors.collection.yaml`; with a flat readdir that file was
  written, skipped, and the verb reported ✔ while changing nothing.
- **The manifest carries `namespaces`**, and the record layer reads it from there — the `storage.base`
  precedent. It must never re-read package.json, and an older runtime with no key reads as `[]`, which is
  correct for a workspace that never declared any.
- **HTTP callers percent-encode the collection name** (`/api/collections/health%2Fdoctors/records`).
  `:name` stays one path segment and all 15 routes work unchanged; `*name` was rejected because a greedy
  wildcard, a literal and a second wildcard in one pattern has several readings.

## IMPORTANT — there are TESTS now, and they are meant to be fast

```bash
npm run verify:fast           # the inner loop: tier 1 + the tier-2 files your diff names + last failures
npm test -- --failed          # after a red run: only the files that failed, until they pass
npm run verify                # the gate: everything, ONCE, before the commit — run it in the background
npm test -- --only=namespace  # one file
npm test -- --unit            # tier 1 only: pure functions, no fs, no git — under a second
npm run perf                  # tier 4: generates a workspace, times renameCollection, PRINTS
```

**The full suite is ~3.5 minutes (211 s, 1,261 tests, measured 2026-10-01 on an idle 8-core laptop), so it
runs once per commit, not once per edit.** Iterate on `verify:fast`, which prints what it chose and why
(a tier-2 file is picked when it is changed, carries a changed `src/` module's stem in its name, or
mentions the changed file); it is a guess about relevance and never the gate. After a red run, fix with
`--failed` — never re-run the whole suite to check one file. Three things the runner does for you:

- **A full pass is remembered for the exact working tree** (`git write-tree` through a throwaway index,
  plus the node version). `npm run verify` again on the same tree prints the stamped result and exits 0
  in about a second; any edit runs it for real. `--rerun` forces a run.
- **One tier-2 suite per machine.** A second run — another session, another worktree — prints who holds
  the lock and waits, then re-checks the stamp. Two suites at once measured 466 s against 211 s alone.
- **Leaked fixtures are swept.** A killed run never reaches its cleanup; under the lock, fixture folders
  older than an hour are removed.

Tier 1 (`test/unit/`) is pure functions. Tier 2 (`test/integration/`) drives the real compiler, store
and CLI binary against a workspace built by `dreamteamer init` — cached once into `test/.tmp/` and
`cpSync`ed per test, keyed on a hash of `src/init.js` + `collections/`, so changing either rebuilds it
with nobody having to remember. **The fixture symlinks this checkout in as `node_modules/dreamteamer`**,
because without the engine as an installed module a fixture has no `collections`/`skills`/`agents` at all
and cannot reproduce the store refusing a compiled source. Tier 3 is the extension's `npm run test:ui`
(boots VS Code, opt-in, never on the default path). **Tier 4 is `npm run perf`** — it GENERATES its
workspace into gitignored `test/.perf/`, times the operation and prints; a timing belongs to the
machine that took it, so it asserts nothing and never gates a build. `--records=N` sets the scale,
and generation is timed too because N writes through the real Store is the write path's own number.

## IMPORTANT — a FEATURE is not done until the suite would fail without it, and a RELEASE is not made until the suite has been RUN

A standing rule, not a note about one release. Four parts:

- **Every new feature or fixed defect ships its test in the SAME commit.** The assertion must pin the
  BEHAVIOUR promised, not that the code path is reachable. A suite can be green and worthless.
- **A design doc or plan that adds a capability NAMES the assertion that will prove it**, per
  capability. Reviewing a design is the cheapest moment to notice a promise nothing can falsify.
- **Every escaped defect earns a regression test BEFORE or WITH its fix**, and that test must FAIL
  against the released build. "Fixed" with no test that would have caught it ships the defect again.
- **Before a release: run `npm run verify` (layers + metrics:check + tests) and QUOTE ITS EXIT CODE.**
  ⚠ Read the exit code, never a `# pass` grep — a grep reports green on a red suite. A check the
  suite cannot express is itself the defect: extend the harness rather than ship the gap.

⚠ **Why this is written here. 0.19.0 (2026-09-04) shipped with defects a three-command walk found.**
The release was clean by every instrument: `npm test` 892/892 exit 0, `layers` and `metrics:check`
green, every CI step green, npm serving it. Then walking the flow the release exists FOR —
`add modules` → `add collections --module` → `add-field` — surfaced two: `dt add modules --namespace hr`
**silently ignores the flag** (the module ships `"dreamteamer": {}`, the manifest keeps
`namespaces: []`, the next collection gets no prefix, nothing errors), and **the CLI accepts ANY
unknown flag without complaint**, which is what let the first one hide.

The suite asserted that `help` LISTS every verb and that each one dispatches. **Nothing asserted that a
flag is HONOURED.** So a whole class — the arg parser silently swallowing what it does not recognise —
had no coverage at all, and two features' worth of promises went out unexercised.

**The lesson to keep: verifying the pipeline is not verifying the thing.** Green tests, green gates and
a green publish prove the release mechanism worked. They say nothing about whether the feature does what
its spec says. Walk the user's actual flow before calling a release good — and when that walk finds
something, the suite was incomplete by definition, so the fix is two commits' worth of work: the
behaviour, and the assertion that would have caught it.

## IMPORTANT — the layout under `src/`, and what `npm run layers` holds

`npm run layers` reads a file's layer from its FOLDER and exits 1 on a violation, including a folder it
does not know, so a new folder costs a sentence of thought:

| folder | layer | may import |
|---|---|---|
| `src/compile/`, `src/extensions/`, `src/lib/`, `src/record/`, `src/runtime/`, `src/setup/`, `src/store/`, `src/workspace/` | shared — code two or more commands use | shared only |
| `src/<command>/` | one command's code, and what it owns that other commands use | shared, its own folder, and another command's ROOT files — never another command's `lib/` |
| `src/*.ts` | surface — entry points, and a verb's entry function when its command has no folder | anything |
| `src/commands/` | surface — one file per core verb (`commands/<verb>Command.ts`, exporting `<verb>Command` — `rm-field` → `rmFieldCommand` — which `cli.ts` imports lazily and calls by name); code several verbs share is in `commands/lib/` | anything |

⚠ **There is NO record → workspace direction any more** (removed on the `typescript` branch). It was a
proxy for one real constraint and it drove folder layout instead of protecting it. The real
constraint is the BROWSER-SAFE ENTRY: the mobile app runs `dreamteamer/records` (`src/records-api.ts`)
in a browser with shims for exactly `node:fs`, `node:path` and `node:child_process`, so that entry's
import closure must load no other node builtin — the compiler, the extension loader and install pull
in `node:url`/`node:crypto`/`node:os`/`node:zlib` at import time, and the app would die on load while
every Node-side test stays green. That is a property of the entry's CLOSURE, not of which folder a file
sits in; `test/integration/public-api.test.js` asserts it. Decide where a file lives by who uses it.

The runtime boundary is still real — the store reads compiled descriptors, never a source — and two
consequences of it are worth keeping:

- **`storage.base` (`workspace` | `runtime`) is written by compile and read by everything else.**
  It replaced `d.storage.path.startsWith('system/')`, which was re-derived in five places. compile
  is now the only module that knows `system/` means "compiled, therefore not writable". `runtime.js`
  keeps the derivation as compat for a runtime compiled by an older engine — do not delete it: in the
  `workspace_module` layout those collections otherwise resolve under the workspace root, read as
  **zero records**, and let the store treat a compiled artifact as writable.
- **`sourceRoots()` comes off the manifest, not from re-running discovery.** The manifest records what
  was actually *compiled*, so a shadowed copy is already excluded — same set, and no import.

⚠ **This is deliberately not a package split, and proposing one needs a consumer, not an argument.**
Nothing wants records-over-git *without* modules and harnesses; recipes is copy-not-install
(decision 129). Two packages would double the pinning surface, break `engine.ts`'s `engineRoot()`
probe (it tests `store.js` and `presentation.js` in one directory — different halves), and split a
hand-maintained non-tolerant import list across two versions. Decision 139 is what that costs. The
budget argument is the stronger one: one engine gives one ceiling and a hard "no"; two gives every
borderline addition a home — *"that's the DB's job"* — and the pressure to make a **database**
general is unbounded in a way the pressure on a workspace compiler is not.

## IMPORTANT — engine/UI split

**dreamteamer is the ENGINE. The desktop app (dreamteamer-app) is the surface for people** — it loads
this engine's public API in-process, one Electron utility process per workspace, and owns the route
protocol between its windows and that process. `dt web` and `@dreamteamer/protocol` were retired in
0.52.0. [dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode) is a second, older
surface held to the same rule. All functionality lives here; a surface is never a second
implementation.

**The engine has two APIs over the same code: the `dt` CLI, which agents use, and `src/api.ts`, which
the app loads.** Which side owns a fact is decided by one question — must the answer be the same for
every actor (a person in the app, an agent running `dt`, CI)? Then the engine owns it: anything that
writes to the repo, and any fact an agent also acts on through `dt` — pending records
(`commitPending(store, { dryRun: true })`), unpushed commits (`aheadCount`), the module enumeration
(`moduleRows`), history. The app keeps only what the engine never reads: last-modified and author in a
list, the activity feed, source marks, images, remote access, windows and transport. A fact
implemented on both sides is a design error.

**The test:** *anything that can be done in the VS Code extension can be done in a Claude Code (or
any supported coding-agent) session.* Concretely — every extension gesture must map to a
`dreamteamer <…>` CLI invocation an agent can run headlessly, with the same validation, the same
sources touched, and the same commit shape.

Corollaries:

- A new capability starts here — engine function **plus a CLI verb** — and only then gets a button.
- The extension may not hand-write module sources or `data/` records around the store. If it
  needs an operation, that operation is an engine export *and* is reachable from the CLI.
- Loading the engine in-process (what `dreamteamer-vscode/src/engine.ts` does) satisfies "one
  implementation" but **not** the test — an in-process-only export is still UI-exclusive until the
  CLI exposes it.
- The app's protocol handler and the editor's `src/api.ts` are thin skins over these functions. If a
  route exists with no CLI equivalent, that's a gap, not a design.

## parity status (closed 2026-07-27)

The six known gaps are closed. Every extension operation now has a CLI verb, verified in a
throwaway `dreamteamer init` workspace (9/9 assertions, `check` clean). The CLI column is in today's
verb-first spelling; `dt help` is the authority:

| extension op | engine function | CLI |
| --- | --- | --- |
| edit a field (`PATCH /schema/collections/:c/fields/:f`) | `schema-ops.updateField` | `set-field <c> --name <f> --type <t>` |
| remove a field (`DELETE …/fields/:f`) | `schema-ops.removeField` | `rm-field <c> --name <f>` |
| delete a collection (`DELETE /schema/collections/:c`) | `schema-ops.removeCollection` | `rm collections/<name> [--force]` |
| revert a record (`POST …/records-revert`) | `Store.revert` | `revert <c>/<id> --hash <sha>` |
| record history / diff (`GET /history`, `/history-diff`) | `history.js` | `history <c>/<id>` / `diff <c>/<id> [--hash]` |
| create/update/delete a ui-view (`POST/DELETE /schema/ui-views`) | `saveUiView` / `removeUiView` | `add ui-views` · `set`/`rm ui-views/<id>` |
| order a listing (`GET /items/:c?sort=`) | `temporal.sortRows` | `list <c> --sort [-]<field>` |
| filter a listing (`?filter=<json>`, saved views) | `filter.matchesFilter` | `list <c> --where <json>` |
| what changed in the data since a commit | `events.deriveEvents` | `changes [--since <sha\|date>] [--json]` |
| publish records written to disk | `commit.commitPending` | `commit [<collection>\|<collection>/<id> …] [-m <subject>] [--dry-run]` |
| move a collection (incl. into a namespace) | `schema-ops.renameCollection` | `rename collections/<old> <new>` |

Notes worth keeping:

- `src/history.js` exists because that logic was inlined in `server.js` AND copy-pasted into the
  extension's `api.ts` with no CLI anywhere. Three callers, one implementation. It resolves a
  SYSTEM-stored record (collection, ui-view, skill…) back to its manifest sources — reading
  `.dreamteamer/` directly is useless, that path is gitignored.
- `set ui-views/<id>` takes dotted keys (`display.list.sort=-date`, `display.nav.title=Recent`), and
  `add ui-views` derives the record id from `route` with the descriptor's own `{{ route | slug }}` rule, so a view saved from
  the CLI and one saved from the Layout options panel land on the SAME record.
- `revert` requires `--hash` on purpose. A revert with an implied target destroys the wrong record.
- `src/temporal.js` is the same story as `history.js`: `?sort=` was inlined in `server.js`, hand-
  copied into `api.ts`, and reachable from no CLI verb at all. It now also owns the write-side
  normalizer. **A `date-time` keeps its local offset** (`2026-07-28T12:00:00+03:00`) rather than
  being folded to Z, because these are markdown files a human reads in a git diff — so ordering
  MUST parse instants, and every range/sort path goes through `compareValues`. Never reintroduce a
  `localeCompare` on a temporal field: `…T12:00+03:00` sorts after `…T11:00+01:00`, which is the
  earlier moment.
- `src/events.js` is what survives of the trigger/run subsystem, exposed as `dt changes`. Keep it
  read-only: it has no cursor and stores nothing, which is why it can be run twice with no
  consequence. If automation is ever rebuilt on it, reuse the old dedupe key shape
  (`trigger + item + commit`) rather than inventing one.
- Testing the CLI with `npx dt` from a cwd inside a workspace runs THAT workspace's installed engine,
  not the checkout you are editing. Run this checkout's `bin/dreamteamer.js`, or import `src/cli.ts`
  directly.

## how to keep it closed

When you add an engine capability, the CLI verb is part of the change, not a follow-up. When you
add an extension gesture, the verb must already exist. A route in the HTTP extension or the editor's
`api.ts` with no CLI equivalent is a gap — re-derive this table rather than trusting it.

## ⚠ The PUBLIC API is the cross-repo contract — `src/api.ts`

Until 0.31.0 the editor imported fifteen internal files by path in a non-tolerant `Promise.all`, so
deleting or renaming ANY `src/` file threw out of `activate()` before the tree view existed (the
2026-07-31 `sync.js` incident, whose symptom named the one thing that was fine). Now every consumer —
the editor, the mobile app, every extension — reaches the engine through `src/api.ts` (published as `dist/api.js`) only (and its
two subpath exports, `dreamteamer/records` and `dreamteamer/testing`), and
package `exports` makes `dist/*` unimportable. So:

- **A file under `src/` may be split, renamed or deleted freely** as long as `src/api.ts` still
  exports the same names.
- **Removing or renaming an export of `src/api.ts` IS the cross-repo change**, and needs the same
  wave in every consumer. `test/integration/public-api.test.js` holds the generated declarations to
  `test/types/consumer.ts`, and installs the packed tarball to prove the API resolves and `dist/*` does not.
- An addition to the API needs a consumer, like anything else in core.
