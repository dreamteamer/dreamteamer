# dreamteamer — the engine

`@dreamteamer/dreamteamer`: workspace compiler, CLI, store, schema-ops. See `README.md` for
the contract (sources → `.dreamteamer/` → harness adapters; records are files; a write lands on
disk and `dreamteamer commit` publishes it, one commit per repo; hard validation before disk).

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
   it: the entity kinds the compiler materializes, and `repos` (because `repos ensure` clones them).
   **Nine collections, and that is the intended ceiling.**

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
   content, funnels — belongs in a module, and a *generic* version of it belongs in
   [dreamteamer/recipes](https://github.com/dreamteamer/recipes) where a workspace copies and adapts
   it. Domain modules are deliberately **not** installable packages: four workspaces have wanted a
   CRM and all four wanted a different `contacts`, so an import would force one answer and make
   every divergence a fork. Core must not absorb that variance on their behalf.
3. **Could a module do it instead?** A module can ship collections, skills, commands,
   command-bindings, agents, ui-views and component code. If the capability is expressible as a
   module, core growing to hold it is a decision to make everyone carry it.

Two shapes to reject on sight, both learned here:

- **An enum that is a roadmap.** `adapter: gdrive|s3|git` with one implementation was a schema
  advertising work nobody had done. If only one value works, there is no field.
- **A capability that needs a record seeded before it exists.** A collection whose entire job is to
  name a folder is a level of indirection over an `.env` key. That is why `mounts` was deleted rather
  than kept.

The prose budget matters as much as the code one: a skill nobody can afford to load is not a
capability. Core ships **2** skills — `using-dreamteamer` (the map) and `building-dreamteamer` (how to author) —
and both are **digests with `references/`**, so the always-loaded file stays small and detail is
fetched on demand. Adding a third top-level skill to core is almost certainly wrong; add a reference
to an existing digest instead.

## IMPORTANT — sources are FLAT at a module root, and unknown folders are a compile ERROR

A module's sources live at its root — `modules/crm/skills/`, beside `data/` and `package.json` — and
the compiled runtime matches: `.dreamteamer/<kind>/`. There is no `system/` level. **KINDS was always
the allowlist**; the extra directory named nothing the engine read, and it is also the shape
coding-agent plugin repos use.

⚠ **The workspace's OWN module is `modules/default`, named for its ROLE** (0.8.0; `init` seeds it, and
`--workspace-module <name>` overrides). It used to be named after the workspace, and that name went
stale twice in one repo — `hq3` → `gk`, decision 213 reversed by 224 — each rename rewriting every
path that RESOLVES while the historical documents deliberately kept the old spelling, so a
stale-looking `modules/hq3` was correct in prose and a bug in a path. A role name cannot go stale.
It is deliberately the same word `RESERVED_NAMESPACES` holds: this module owns the DEFAULT-namespace
collections, and the default namespace is the empty prefix. The one misreading it invites,
`default/tasks`, is a compile error whose message states the rule. **An existing workspace is
unaffected** — its `workspace-module` key already exists and wins over the seed.

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
`dt compile`. Only reachable when two engines share a workspace (the self-shadowing dev-clone case).
The VS Code extension is immune from 0.6.33 on: it probes both layouts and reads `storage.base`.

## IMPORTANT — namespaces are DECLARED, and the delimiter is a slash

A collection name may carry a slash-delimited namespace: `health/doctors` lives in `data/health/doctors/`
and a record of it is referenced as `health/doctors/dana-levi`. The **default namespace is the empty
prefix** — `tasks/kickoff` in `data/tasks/`, exactly as before — so adopting namespaces migrates
nothing, and `default` is a RESERVED name so there is never a second spelling for one collection.

⚠ **The whole problem in one line: an id is also a slash-delimited path.** `meetings/2026/07/kickoff`
is one collection and a three-segment id, so `a/b/c` is either collection `a` + id `b/c` or collection
`a/b` + id `c`, and nothing about the string says which. That is why namespaces are **declared** in the
workspace package.json:

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
   `dt <c> list` answered "unknown collection". The loader now walks; the declaration is enforced.
2. **A namespace colliding with a collection name.** With both a namespace `health` and a collection
   `health`, `health/doctors/dana-levi` is a record of two different collections and longest-match would
   silently pick one.
3. **`default` in any namespace segment**, per the transparency rule above.
4. **One collection's `storage.path` inside another's.** MEASURED data loss, not hypothetical: give A
   `data/health` and B `data/health/doctors` and A's recursive walk indexes B's records as its own —
   `dt A list` prints B's records, `check` reports B's fields as unknown fields of A, and a write through
   A can overwrite a record of B. compile reported ✔ through all of it because nothing compared two
   paths. `namespace.storageOverlaps` is now a hard gate, and namespaces make near-misses ordinary.

Two consequences worth keeping:

- **`dt collections rename` is how EXISTING data gets namespaced** — descriptor, records, filenames and
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
npm test                      # tiers 1+2, zero dependencies, ~7s
npm test -- --only=namespace  # one file
npm test -- --unit            # tier 1 only: pure functions, no fs, no git
npm run verify                # layers + metrics:check + tests — what to run before a commit
```

Tier 1 (`test/unit/`) is pure functions. Tier 2 (`test/integration/`) drives the real compiler, store
and CLI binary against a workspace built by `dreamteamer init` — cached once into `test/.tmp/` and
`cpSync`ed per test, keyed on a hash of `src/init.js` + `collections/`, so changing either rebuilds it
with nobody having to remember. **The fixture symlinks this checkout in as `node_modules/dreamteamer`**,
because without the engine as an installed module a fixture has no `collections`/`skills`/`users` at all
and cannot reproduce the store refusing a compiled source. Tier 3 is the extension's `npm run test:ui`
(boots VS Code, opt-in, never on the default path).

## IMPORTANT — the record/workspace split is enforced, and it is NOT two packages

The engine has two halves and the edge between them goes ONE way. `npm run layers` prints the graph
and exits 1 on a violation — including on a file under `src/` that is not assigned to a layer, so
adding one costs the same sentence of thought as adding a core collection.

| layer | modules | rule |
|---|---|---|
| **record** | store · records · check · temporal · filter · field-values · commit · events · history · template · workspace · yaml · namespace | schema-validated records over git. **Must not know that modules, channels, `extends` or skills exist.** |
| **boundary** | runtime | the compiled `.dreamteamer/` artifact — descriptors + manifest. The whole interface. |
| **workspace** | compile · harnesses · schema-ops · init · record-commands · semver | the compiler and the agent-harness surface. May import record. |
| **surface** | cli · collections-cli · server · presentation | entry points; span both halves by definition. |

The seam was always real — the store has only ever read compiled descriptors, never a source. What
it lacked was a direction: `store.js` and `history.js` imported `compile.js` to reach a manifest,
which is a *file-format* dependency wearing a *module-system* import. Both now go through
`runtime.js`. Two consequences to keep:

- **`storage.base` (`workspace` | `runtime`) is written by compile and read by everything else.**
  It replaced `d.storage.path.startsWith('system/')`, which was re-derived in five places. compile
  is now the only module that knows `system/` means "compiled, therefore not writable". `runtime.js`
  keeps the derivation as compat for a runtime compiled by an older engine — do not delete it: in the
  `workspace-module` layout those collections otherwise resolve under the workspace root, read as
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

**dreamteamer is the ENGINE. [dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode)
is the UI.** All functionality lives here; the extension is a surface over it, never a second
implementation.

**The test:** *anything that can be done in the VS Code extension can be done in a Claude Code (or
any supported coding-agent) session.* Concretely — every extension gesture must map to a
`dreamteamer <…>` CLI invocation an agent can run headlessly, with the same validation, the same
sources touched, and the same commit shape.

Corollaries:

- A new capability starts here — engine function **plus a CLI verb** — and only then gets a button.
- The extension may not hand-write `system/` sources or `data/` records around the store. If it
  needs an operation, that operation is an engine export *and* is reachable from the CLI.
- Loading the engine in-process (what `dreamteamer-vscode/src/engine.ts` does) satisfies "one
  implementation" but **not** the test — an in-process-only export is still UI-exclusive until the
  CLI exposes it.
- `src/server.js` and the extension's `src/api.ts` are thin skins over these functions. If a route
  exists with no CLI equivalent, that's a gap, not a design.

## parity status (closed 2026-07-27)

The six known gaps are closed. Every extension operation now has a CLI verb, verified in a
throwaway `dreamteamer init` workspace (9/9 assertions, `check` clean):

| extension op | engine function | CLI |
| --- | --- | --- |
| edit a field (`PATCH /schema/collections/:c/fields/:f`) | `schema-ops.updateField` | `<c> update-field --name <f> --type <t>` |
| remove a field (`DELETE …/fields/:f`) | `schema-ops.removeField` | `<c> remove-field --name <f>` |
| delete a collection (`DELETE /schema/collections/:c`) | `schema-ops.removeCollection` | `collections rm <name> [--force]` |
| revert a record (`POST …/records-revert`) | `Store.revert` | `<c> revert <id> --hash <sha>` |
| record history / diff (`GET /history`, `/history-diff`) | `history.js` | `<c> history <id>` / `<c> diff <id> [--hash]` |
| create/update/delete a ui-view (`POST/DELETE /schema/ui-views`) | `saveUiView` / `removeUiView` | `ui-views add|set|rm` |
| order a listing (`GET /items/:c?sort=`) | `temporal.sortRows` | `<c> list --sort [-]<field>` |
| filter a listing (`?filter=<json>`, saved views) | `filter.matchesFilter` | `<c> list --where <json>` |
| what changed in the data since a commit | `events.deriveEvents` | `changes [--since <sha\|date>] [--json]` |
| publish records written to disk | `commit.commitPending` | `commit [<collection> …] [-m <subject>] [--dry-run]` |
| move a collection (incl. into a namespace) | `schema-ops.renameCollection` | `collections rename <old> <new>` |

Notes worth keeping:

- `src/history.js` exists because that logic was inlined in `server.js` AND copy-pasted into the
  extension's `api.ts` with no CLI anywhere. Three callers, one implementation. It resolves a
  SYSTEM-stored record (collection, ui-view, skill…) back to its manifest sources — reading
  `.dreamteamer/` directly is useless, that path is gitignored.
- `ui-views set` takes dotted keys (`options.sort=-date`, `nav.label=Recent`) and derives the
  record id from `path` with the descriptor's own `{{ path | slug }}` rule, so a view saved from
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
- Testing the CLI from a cwd inside a workspace runs THAT workspace's `git_modules/dreamteamer`,
  not the checkout you are editing (self-shadowing, decision 24). Test from outside, or import
  `src/cli.js` directly.

## how to keep it closed

When you add an engine capability, the CLI verb is part of the change, not a follow-up. When you
add an extension gesture, the verb must already exist. A route in `server.js` or the extension's
`api.ts` with no CLI equivalent is a gap — re-derive this table rather than trusting it.

## ⚠ DELETING a `src/` module is a CROSS-REPO change

The extension loads the engine in-process, and `dreamteamer-vscode/src/engine.ts` imports a fixed
list of modules in a **non-tolerant `Promise.all`**. One missing file rejects it, which throws out of
`activate()` **before the tree view is created**, which leaves the view empty, which makes VS Code
print its `viewsWelcome` text. On 2026-07-31 that text still claimed *"this folder is not a
dreamteamer workspace (no .dreamteamer/manifest.yaml found)"* — for a workspace whose manifest was
freshly compiled and 52KB. The symptom named the one thing that was definitely fine, and the real
cause was `sync.js` having been deleted an hour earlier.

**So: when you remove or rename a file under `src/`, grep the extension for it in the same wave.**

```bash
grep -rn "<module>.js\|eng\.<export>\|engine()\.<export>" ../dreamteamer-vscode/src/
```

The extension's welcome text is now `when`-gated so the two failures name themselves, but that makes
the mistake *legible*, not impossible. The import list is still a hand-maintained mirror of this
repo's file names, and nothing checks it automatically — a real check would have to know which engine
a given workspace pins, which only that workspace knows.
