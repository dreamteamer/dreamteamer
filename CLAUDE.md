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
   it: the entity kinds the compiler materializes, `users` (because `@me` resolves against it), and
   `repos` (because `repos ensure` clones them). **Nine collections, and that is the intended ceiling.**

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

Three things hold this up, and all three exist because removing the wrapper removed a free guarantee:

1. **`compile` enumerates each module root and FAILS on a folder that is not a known kind.** Inside
   `system/` there was no legitimate non-kind folder, so "not a kind" could mean "ignore it". At a
   module root it cannot. This is the fix for decision 156 — a kind the engine stopped knowing
   (`workflows`) sat in a module for two days while compile said ✔. Generic package folders are
   allowed by `NON_SOURCE_DIRS`; anything else the module declares as
   `"dreamteamer": { "ignore": ["dashboard"] }`. That is genuine per-module variance (`services` has
   `dashboard/`, `agentlog` has `data/`), not a layout knob every module would set identically.
2. **`kindDir(root, kind)` still reads `system/<kind>` as a fallback**, and a module holding BOTH
   spellings of one kind gets a warning naming the half that is not compiled. ⚠ **Do not remove the
   fallback yet** — `recipes` and `dt-hq` are still nested and both pin a pre-flatten engine, so the
   fallback is what keeps them readable. Dropping it is gated on those two moving, which is gated on
   their engine pins moving (decision 103: a pin is one party's to move).
3. **`storage.base`, not a path prefix, answers "is this the runtime?"** Flattening inverted every
   `startsWith('system/')` test silently, because a runtime collection's path became a bare kind name.
   `compile` decides `base` once (an exact KINDS match) and everything else reads the field.

⚠ **A pre-flatten engine cannot read a runtime compiled by this one** — it looks for
`.dreamteamer/system/collections` and reports "no compiled runtime", which is accurate and fixed by
`dt compile`. Only reachable when two engines share a workspace (the self-shadowing dev-clone case).
The VS Code extension is immune from 0.6.33 on: it probes both layouts and reads `storage.base`.

## IMPORTANT — the record/workspace split is enforced, and it is NOT two packages

The engine has two halves and the edge between them goes ONE way. `npm run layers` prints the graph
and exits 1 on a violation — including on a file under `src/` that is not assigned to a layer, so
adding one costs the same sentence of thought as adding a core collection.

| layer | modules | rule |
|---|---|---|
| **record** | store · records · check · temporal · filter · field-values · commit · events · history · template · workspace · yaml | schema-validated records over git. **Must not know that modules, channels, `extends` or skills exist.** |
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
