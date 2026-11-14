# src/

What each part of the engine is for, and why it is shaped the way it is. These notes were the header
comments of the engine's modules; they live here so the code opens on code. Each module has since been
split into one file per export, placed by who uses it, so a section names the files it now covers:

- `src/*.ts` — the entry points (`cli`, `api`, `records-api`, `testing`, `update-setup`), the public
  contract (`types.ts`), and the function each CLI verb dispatches to (`statusCommand`, `commitCommand` …)
- `src/<command>/` — code only that command uses
- `src/record/`, `src/runtime/`, `src/workspace/` — code two or more commands share, by layer
  (`npm run layers` holds the direction: record never imports workspace, a command folder never another's)

## api

Files: [api.ts](api.ts)

The PUBLIC API — `import … from 'dreamteamer'`. Everything a surface (the VS Code extension, the
mobile app) or an extension (http, workflows, notebooklm) may call, and nothing else: package.json
`exports` hides `src/*`, so an internal file can be split, renamed or deleted without a cross-repo
break. That break used to be the rule — the extension imported fifteen internal files by path, and
deleting one took `activate()` down before the tree view existed.

Grouped by task. Each name is the ONE implementation of its operation; nothing here wraps or
re-implements. Its declarations are GENERATED (dist/api.d.ts) from these signatures and src/types.ts;
test/types/consumer.ts is the contract they are held to.

Importing this module prints nothing, writes nothing, binds no port and touches no network.

## alone

Files: [check/ENGINE.ts](check/ENGINE.ts) · [check/checkAlone.ts](check/checkAlone.ts) · [check/engineRun.ts](check/engineRun.ts) · [check/freshWorkspace.ts](check/freshWorkspace.ts)

`dt check modules/<id> --alone` — is this inline module publishable? (cr-dt-007, G3, D63, D65)

The gate does to a module what a stranger's workspace will: packs it with `npm pack` (so its `files`
list is what is judged), `init`s a fresh workspace on THIS engine, `dt install`s the tarball with only
the module's declared `dreamteamer.dependencies` (each packed from this workspace — `modules/` or
`node_modules` — never fetched, so the gate is offline), then compiles and checks it and prints the
module's setup line. It learns nothing about the module beyond its manifest, and it runs no package
script of the author's (D63: the author's `npm test` is the author's).

  exit 0  publishable — including a unit that still needs an input a stranger supplies later (install 3)
  exit 1  refused, the first reason named: a dependency not held here, a floor above this engine, a
          refused install, a compile error, a check violation
  exit 2  usage

Dispatched from src/cli.js before the host workspace is opened: a module whose dependency is
missing would fail the HOST's compile, and the gate's whole point is to say so by name.

## check

Files: [check.ts](check.ts)

dreamteamer check — validate every record against the compiled descriptors.
report-only: JSON Schema (ajv), id patterns, reference resolution, stray files, plus any
`extra` violations a caller gathered (extension checks), reported after the schema's — an item marked
`warning` is printed as a warning and never counted. Under `strictExport` a reference this workspace's
own records reach only through a layer is a violation rather than a ⚠ line: a workspace reading this one without its layers would see them break.
NEVER modifies a file. returns the exit code.

## checkout

Files: [init/escapes.ts](init/escapes.ts) · [initCommand.ts](initCommand.ts) · [install/applyInstall.ts](install/applyInstall.ts) · [install/declaredDeps.ts](install/declaredDeps.ts) · [install/installCheckout.ts](install/installCheckout.ts) · [install/observeState.ts](install/observeState.ts) · [install/planInstall.ts](install/planInstall.ts) · [install/readHookInput.ts](install/readHookInput.ts) · [install/readStdin.ts](install/readStdin.ts) · [install/resolves.ts](install/resolves.ts) · [install/types.ts](install/types.ts) · [workspace/childEnv.ts](workspace/childEnv.ts) · and 3 more

src/checkout.ts — which checkout am I, and how does it become ready.
WORKSPACE layer: knows git and the compiler, never the harness.

## cli

Files: [cli.ts](cli.ts)

dreamteamer CLI — VERB-FIRST: `dt <verb> [<target>]`, over the same primitives every surface uses.

The verb set is CLOSED. `run()` switches on it and anything unrecognised is an error, because the
predecessor grammar (`dt <collection> <verb>`) made the FALLBACK the collection path: a typo
dispatched to a collection lookup and answered "unknown collection", which is a true sentence
about the wrong thing. It also meant no verb could ever be named without a noun in front of it
— `dt resolve '<string>'` had nowhere to live — and a namespaced reference had to be typed as two
arguments that only the caller knew belonged together.

This file TRANSLATES; it does not implement. Every record and schema verb lands on
`collectionCommand(ws, collection, verb, args)`, whose signature is unchanged.

## collections

Files: [collectionCommand.ts](collectionCommand.ts) · [collections/FIELD_FLAGS.ts](collections/FIELD_FLAGS.ts) · [collections/OWN_VERBS.ts](collections/OWN_VERBS.ts) · [collections/VERB_FLAGS.ts](collections/VERB_FLAGS.ts) · [collections/isEntityKind.ts](collections/isEntityKind.ts) · [collections/nearest.ts](collections/nearest.ts) · [collections/parseArgs.ts](collections/parseArgs.ts) · [collections/refuseUnknownFlags.ts](collections/refuseUnknownFlags.ts) · [collections/rel.ts](collections/rel.ts) · [record/emit.ts](record/emit.ts) · [relationsCommand.ts](relationsCommand.ts) · [workspace/reportCommits.ts](workspace/reportCommits.ts)

The IMPLEMENTATION layer behind the verb-first CLI: `collectionCommand(ws, collection, verb, args)`
is (collection, verb) shaped and stays that way — `cli.js` translates `dt <verb> <target>` onto it.
So a spelling here (`collections add`, `<collection> add-field`, `commands for`, `repos ensure`) is
an INTERNAL pair, not what the operator types; `dt add collections` is what they type.

## commit

Files: [changes/recordChanges.ts](changes/recordChanges.ts) · [record/QUIET.ts](record/QUIET.ts) · [record/commitPending.ts](record/commitPending.ts) · [record/composeSubject.ts](record/composeSubject.ts) · [record/inProgress.ts](record/inProgress.ts) · [record/layerOf.ts](record/layerOf.ts) · [record/rowChanges.ts](record/rowChanges.ts) · [record/types.ts](record/types.ts)

dt commit — publish what is already on disk. Model: GIT IS THE JOURNAL. There is no pending
file and no cursor; the set of things to commit is sampled from `git status` over the record
directories of every collection, which means it cannot disagree with reality.

## compile-collections

Files: [workspace/compileCollections.ts](workspace/compileCollections.ts) · [workspace/types.ts](workspace/types.ts) · [workspace/v1Refusal.ts](workspace/v1Refusal.ts)

Compiling collection descriptors — descriptor format v2, the only format the engine reads.

Input: every collection source a module ships, grouped by collection name, plus the mixins and the
module graph compile has already established. Output: one compiled descriptor per collection —
the authored keys (mixins and overlays merged in), and a `compiled` block holding everything
compile decided: the defaults it supplied, the module, the repo, whether the records are build
output, the parent a placed collection lives under, the mirrors, the overlaying modules, the peers
nothing installed provides, the resolved `fields` every reader asks through src/descriptor.ts, and
the `json_schema` the validator runs.

A v1 source — a descriptor without `fields`, or a collection-template — is refused, all of them in
one message naming the converter. Nothing here reads the v1 shape.

## compile

Files: [workspace/KINDS.ts](workspace/KINDS.ts) · [workspace/compile.ts](workspace/compile.ts) · [workspace/discoverModules.ts](workspace/discoverModules.ts) · [workspace/repoRootOf.ts](workspace/repoRootOf.ts) · [workspace/staleness.ts](workspace/staleness.ts)

dreamteamer compile — materialize (modules × workspace sources) into .dreamteamer,
the single runtime read surface: copies + provenance manifest, then harness adapters.
explicit only; nothing rebuilds implicitly.

## descriptor-v2

Files: [workspace/V2_KEYS.ts](workspace/V2_KEYS.ts) · [workspace/isV2.ts](workspace/isV2.ts) · [workspace/mergeMixins.ts](workspace/mergeMixins.ts) · [workspace/mergeOverlays.ts](workspace/mergeOverlays.ts) · [workspace/nameErrors.ts](workspace/nameErrors.ts) · [workspace/shapeErrors.ts](workspace/shapeErrors.ts)

The authored descriptor — validated, and merged with its mixins and overlays.

A descriptor is recognised by its `fields` block. It is validated here (closed top-level keys, the
storage, ids and display blocks, every template and every field name the descriptor mentions
outside `fields`), and its mixins and overlays are merged into ONE authored descriptor that
compile-collections.js resolves.

Pure: no fs, no git. Errors are returned, never thrown, so compile attributes each to a file.

## descriptor

Files: [record/descriptor.ts](record/descriptor.ts) · [record/displayOf.ts](record/displayOf.ts) · [record/storageOf.ts](record/storageOf.ts)

Accessors over a COMPILED descriptor — the one way any reader asks what a collection is.

A compiled descriptor is the authored v2 keys plus the `compiled` block compile wrote: `defaults`
(what compile supplied because the author did not), `module`, `repo`, `runtime`, `under_collection`,
`mirrors`, `overlaid_by`, `unresolved_peers`, `fields` (resolved) and `json_schema` (the validator's).
A reader never looks at the authored keys and the defaults separately, and never re-derives a fact
compile already decided: it asks here. Pure — no fs, no git, no knowledge of modules.

## doctor

Files: [doctor/doctorBoard.ts](doctor/doctorBoard.ts) · [doctor/renderBoard.ts](doctor/renderBoard.ts) · [doctor/types.ts](doctor/types.ts)

`dt doctor` — one board of what works in THIS environment: the engine's own rows, then each
extension's `doctor` contribution as one capability. A capability is READY (every row ok),
DEGRADED (a warning: the workspace still works) or UNAVAILABLE (a failure), and every row that is
not ok carries its fix on the same line. No network call; exit 0 unless --strict finds a failure.

## env-vars

Files: [record/envContext.ts](record/envContext.ts) · [record/parseEnvValues.ts](record/parseEnvValues.ts) · [record/renderTemplate.ts](record/renderTemplate.ts) · [record/types.ts](record/types.ts)

${env:KEY} / ${workspaceFolder} / ${userHome} — VS Code's variable grammar, three variables.
Values render ONLY on explicit request (dt resolve); records are never auto-substituted.
parseEnvValues reads .env TEXT only (never shell-evaluates). A QUOTED value (single or double)
may span multiple lines — the closing quote just has to end some later line, not the one it
opened on — because `[^"\\]`/`[^']` match newlines in JS regex same as any other character.
An UNQUOTED value is line-bound: it runs to end of line, so it can't span lines.
Two accepted non-goals, unchanged on purpose: `KEY =value` (space before `=`) doesn't match the
key pattern and is silently dropped, no diagnostic; an unquoted value keeps a trailing inline
`# comment` as part of its text (quote it to strip one).

## env-write

Files: [workspace/env-write.ts](workspace/env-write.ts) · [workspace/envSpans.ts](workspace/envSpans.ts) · [workspace/fingerprint.ts](workspace/fingerprint.ts) · [workspace/gitExposure.ts](workspace/gitExposure.ts) · [workspace/leftoverTemps.ts](workspace/leftoverTemps.ts) · [workspace/setEnvValues.ts](workspace/setEnvValues.ts) · [workspace/writeEnvAtomic.ts](workspace/writeEnvAtomic.ts)

The `.env` writer behind a unit's env action (cr-dt-007, D61): the engine performs the one write
every module's setup used to carry its own copy of — a key's value span replaced in place or
appended, every other byte kept, the file replaced whole by rename, and only while it still has
the fingerprint the plan saw. What is written reads back through `parseEnvValues` identically:
`envSpans` follows that reader's grammar (an unquoted value runs to end of line; a quoted one may
span lines), so this file is the writer half of one grammar, not a second grammar.

Refusals are `EnvRefusal` with a `code`, so the driver (src/setup.js) can turn the ones it can see
before writing into a plan-time `blocked` and keep only `changed` (the file moved after the plan)
and an I/O error as a write-time failure. Nothing here reads a value back to the caller.

## events

Files: [changes/changeKinds.ts](changes/changeKinds.ts) · [changes/deriveEvents.ts](changes/deriveEvents.ts) · [changes/types.ts](changes/types.ts) · [record/foldChanges.ts](record/foldChanges.ts) · [record/groupChanges.ts](record/groupChanges.ts) · [record/pathToRecord.ts](record/pathToRecord.ts) · [record/reportLine.ts](record/reportLine.ts) · [record/types.ts](record/types.ts)

item events — DERIVED from git history, never observed live (the slice-5 contract in
using-dreamteamer → references/changes.md): a closed laptop loses nothing, every evaluation is
auditable and replayable forever. history IS the queue; there is no events file.

## exports (the verb)

Files: [exports/planExports.ts](exports/planExports.ts) · [runExports.ts](runExports.ts)

dt exports [--layer <name> …] [--dry-run] [--json] — write a repo's exports manifest from this
context (cr-dt-004). Bare: this workspace's own; --layer: that layer's, written into its clone — how a
reader records the ids a layer names in the reader, which the layer alone cannot see. The rules are
src/record/regenerate.ts, shared with `check`, so `check` names a manifest stale exactly when this
would change or drop one of its entries. Writes and commits ONE path, `dreamteamer-exports.json`.

## exports (the manifest)

Files: [check/isStale.ts](check/isStale.ts) · [exports/serializeExports.ts](exports/serializeExports.ts) · [record/collectRefFields.ts](record/collectRefFields.ts) · [record/exports.ts](record/exports.ts) · [record/exportsContext.ts](record/exportsContext.ts) · [record/outsideRefs.ts](record/outsideRefs.ts) · [record/readExports.ts](record/readExports.ts) · [record/regenerate.ts](record/regenerate.ts) · [record/types.ts](record/types.ts)

The exports manifest (cr-dt-004) — `dreamteamer-exports.json` at a repo root: per id that repo's own
records name and no file of the repo holds, a display label and the package name of the workspace that
held it when the entry was written. A reader reads a layer WITHOUT that layer's own layers, so this is
the repo's proof that such an id exists elsewhere. Written only by `dt exports`; `check` reads it.

Record layer: pure over the roots, descriptors and the facts compile recorded in the runtime — it never
reads package.json. One walk of a repo's references (`outsideRefs`) and one judgement (`regenerate`)
serve `check`, `dt exports` and the migration script, so the three cannot disagree.

## extensions

Files: [collections/contributedNotes.ts](collections/contributedNotes.ts) · [workspace/MANIFEST_KEYS.ts](workspace/MANIFEST_KEYS.ts) · [workspace/declaredExtensions.ts](workspace/declaredExtensions.ts) · [workspace/extensions.ts](workspace/extensions.ts) · [workspace/loadExtensions.ts](workspace/loadExtensions.ts) · [workspace/manifestViolations.ts](workspace/manifestViolations.ts) · [workspace/v1ManifestRefusal.ts](workspace/v1ManifestRefusal.ts)

Engine extensions — the ONE seam an optional tool plugs into.

Core is records + the workspace compiler, and nothing that has a lifecycle of its own: an HTTP
server, a Docker host, a behaviour-test runner, an exporter to one vendor. Those ship as sibling
packages, and a workspace opts into one by DEPENDING on it — a direct dependency whose package.json
declares `"dreamteamer": { "extension": "./entry.js" }`. That is the whole declaration: npm already
put the code there on purpose, and a transitive package is never loaded however it advertises.

The entry's default export is `activate(dt)` — `dt` is the RUNNING engine's public API (api.js), so
an extension never imports a second engine copy of its own and can never disagree with the one the
operator ran (the dev-clone shadow and `--vault` both pick the engine before this file loads).
A workspace's own `modules/<id>/` may declare the same key: its code is the operator's, so it
loads without a package — the way a workspace carries an extension nobody has published.
It returns a contribution, every key optional:

  commands    { <verb>: { usage, run(ws, argv) } }       `dt <verb> …`, dispatched in-process
  sourceKinds [{ kind, exclude?: [subtree] }]             folders compile stages like a built-in kind
  analyze     (draft) → { errors?, warnings?, notes? }    judged after assembly, before any output
  harnesses   { <id>: (ctx) → { blocks: {file: text}, summary } }   a harness adapter
  orientation string                                      one paragraph appended to the orientation block
  hooks       { <ClaudeHookEvent>: '<dt verb args>' }     rendered by `dt install --print-adapters`
  check       ({ root, ws, dt }) → [{ file, message, warning? }]   cross-record rules `dt check` reports after
              the schema's; `warning: true` prints a warning that does not count (`dt.CHECK_WARNINGS` says so)
  doctor      ({ root, ws, dt }) → [{ label, state, detail?, fix? }]   rows `dt doctor` renders as one capability
  next        ({ root, ws, collection, ids }) → [{ id, text }]   a line about a record `dt next` prints (sync)
  setup       [{ id, version: 1, inputs, inspect, plan, apply }]   setup UNITS `dt install`, `dt setup` and `dt status`
              drive without knowing the module (src/setup-contract.js is the shape, src/setup.js the runner)

Two contributions claiming the same verb, kind or harness is a refusal — there is no "last one
wins", because the loser would be an extension the operator installed that silently does nothing.

## field-values

Files: [collections/distinctValues.ts](collections/distinctValues.ts)

distinct values actually present in a collection's field.

Why this exists: a filter (or a command-binding validator) can only offer a dropdown when
something tells it the value set. `enum` in the descriptor does that — but most string fields
aren't enums and never will be. `meetings.status` and `meetings.visibility` are plain
`type: string`, so the filter builder correctly fell back to a free-text box and the operator
had to know the vocabulary by heart (operator 2026-07-28: "still no dropdown for many things,
visibility, status — why?").

The data already knows. This derives the vocabulary from the records themselves, so every
low-cardinality field becomes selectable with no schema change and no risk of `check` failing
on a value that predates an enum someone added later.

## fields

Files: [record/INJECTED_FIELDS.ts](record/INJECTED_FIELDS.ts) · [record/SCALAR_TYPES.ts](record/SCALAR_TYPES.ts) · [record/enumChoices.ts](record/enumChoices.ts) · [record/fields.ts](record/fields.ts) · [record/resolveFields.ts](record/resolveFields.ts) · [record/toJsonSchema.ts](record/toJsonSchema.ts)

The field vocabulary — dreamteamer's own, compiled to JSON Schema.

An authored descriptor declares `fields` in the words a person uses (`type: datetime`, `required: true`,
`many: true`, `type: <collection>`); compile resolves them (defaults applied, mixins and overlays merged,
the three injected fields added) into `compiled.fields`, which every consumer reads, and emits
`compiled.json_schema`, which the validator alone reads. The two never carry the same fact in two
vocabularies: there is no `x-` keyword anywhere, and `json_schema.properties` is exactly the stored
(non-virtual) fields, type-mapped — `test/unit/fields.test.js` pins that equality.

This module is pure: no fs, no git, no knowledge of modules. It is handed the set of collection names
that exist so a `type: <collection>` can be told from a typo, and returns errors rather than throwing,
so compile can attribute each one to a file.

## filter

Files: [collections/UNKNOWN_TOKEN.ts](collections/UNKNOWN_TOKEN.ts) · [collections/looseEq.ts](collections/looseEq.ts) · [collections/matchesFilter.ts](collections/matchesFilter.ts) · [collections/tokenValue.ts](collections/tokenValue.ts) · [record/KNOWN_OPERATORS.ts](record/KNOWN_OPERATORS.ts) · [record/filter.ts](record/filter.ts) · [record/unknownOperators.ts](record/unknownOperators.ts) · [record/unknownTokens.ts](record/unknownTokens.ts)

record filtering — the operator set harvested from an earlier engine's
query/compare.ts (Directus-style), trimmed to what the studio FilterBuilder
and saved views actually emit. evaluated server-side over parsed records.
negative operators deliberately reject null (SQL semantics).

## fractional-index

Files: [collections/keyBetween.ts](collections/keyBetween.ts) · [collections/placementKey.ts](collections/placementKey.ts)

Manual ordering keys. Named for the ALGORITHM: the FIELD is named per collection via
its `type: position` field, and nothing here may assume what it is called.

⚠ THE ALPHABET IS LOAD-BEARING. `compareValues` (temporal.js) ends in `localeCompare`, which is
locale-aware, so the library's DEFAULT base-62 keys mis-sort here: prepending three times gives
`Zy Zz a0`, and `sortRows` returns `a0 Zy Zz`. Same trap that breaks fractional indexing on
Postgres under `en_US.utf8` instead of `C`. a-z is the intersection where three things hold at
once — locale order agrees with codepoint order, and no key can parse as a number (the numeric
branch of `compareValues` would sort "9" after "10") or as a temporal.

test/unit/fractional-index.test.js asserts the base-62 failure directly, so this argument cannot
be deleted as noise.

Why a dependency rather than 75 lines of our own: the naive midpoint (halve toward the open end)
degenerates on APPEND, which is the commonest write — measured at 200-character keys after 1000
appends. The library's integer-part-with-magnitude-head keeps that at 4.

## harnesses

Files: [doctor/MANAGED_BLOCKS.ts](doctor/MANAGED_BLOCKS.ts) · [workspace/buildCollectionsIndex.ts](workspace/buildCollectionsIndex.ts) · [workspace/buildModulesIndex.ts](workspace/buildModulesIndex.ts) · [workspace/harnessMarkers.ts](workspace/harnessMarkers.ts) · [workspace/renderContributions.ts](workspace/renderContributions.ts) · [workspace/runHarnessAdapters.ts](workspace/runHarnessAdapters.ts) · [workspace/types.ts](workspace/types.ts) · [workspace/writeLine.ts](workspace/writeLine.ts)

harness adapters — one thin stage per harness, dispatched from compile over the same
compiled entries. the superpowers lesson, kept deliberately: CONTENT NEVER FORKS PER
HARNESS — skills copy verbatim (+stamp), every root file gets the same managed
orientation block; only the injection points differ per harness:
  claude-code → .claude/{skills,agents,commands} + CLAUDE.md block  (native everything)
  codex       → AGENTS.md block + .agents/skills mirror             (~/.codex reads AGENTS.md)
  pi          → AGENTS.md block + .agents/skills mirror             (pi auto-discovers .agents/skills)
  cursor      → .cursor/rules/dreamteamer.mdc + .agents/skills      (.mdc is cursor's native rule file)
  gemini-cli  → GEMINI.md block + .agents/skills mirror             (GEMINI.md is its context file)
managed blocks live in USER-OWNED files (committed); generated dirs (.claude, .agents,
.cursor) are gitignored and pruned by stamp. removing a harness from config removes its
block/file on the next compile.

## history

Files: [collections/history.ts](collections/history.ts) · [collections/historyDiff.ts](collections/historyDiff.ts) · [collections/trackedPaths.ts](collections/trackedPaths.ts) · [record/commitArg.ts](record/commitArg.ts)

per-record revision history, straight out of git.

Extracted because it had drifted into being UI-only in practice: the exact same `git log
--follow --format=…` and `git diff <hash>~1 <hash>` lived inlined in `server.js`'s routes AND
copy-pasted into the VS Code extension's `src/api.ts`, with no CLI verb anywhere — so "show me
how this record changed" was a thing you could do by clicking and not by asking an agent. One
implementation here, three callers (CLI, server, extension).

## init

Files: [collections/materializeRepo.ts](collections/materializeRepo.ts) · [collections/repos.ts](collections/repos.ts) · [init/SKELETON_KINDS.ts](init/SKELETON_KINDS.ts) · [init/init.ts](init/init.ts) · [init/initFootprint.ts](init/initFootprint.ts) · [init/seedBlock.ts](init/seedBlock.ts) · [install/commitOf.ts](install/commitOf.ts) · [install/install.ts](install/install.ts) · [install/installClone.ts](install/installClone.ts) · [install/isLink.ts](install/isLink.ts) · [install/offRef.ts](install/offRef.ts) · [update/update.ts](update/update.ts) · and 8 more

dreamteamer init — write the workspace skeleton into the current directory.
non-interactive: flags override sensible defaults (RAD phase; prompts later).
never compiles — compile is always explicit.

## install

Files: [install/installModules.ts](install/installModules.ts) · [workspace/indexFolder.ts](workspace/indexFolder.ts) · [workspace/installedModules.ts](workspace/installedModules.ts) · [workspace/npmAndCompile.ts](workspace/npmAndCompile.ts) · [workspace/npmFloor.ts](workspace/npmFloor.ts) · [workspace/printUnitResults.ts](workspace/printUnitResults.ts) · [workspace/readSpecManifest.ts](workspace/readSpecManifest.ts) · [workspace/readTarballManifest.ts](workspace/readTarballManifest.ts) · [workspace/resolveClosure.ts](workspace/resolveClosure.ts) · [workspace/setupAndCommit.ts](workspace/setupAndCommit.ts) · [workspace/types.ts](workspace/types.ts) · [workspace/versions.ts](workspace/versions.ts)

`dt install <spec…>` — bring a module into this workspace: resolve the closure and refuse early,
npm install --save-exact, verify, compile (and restore on refusal), the safe part of the module's
setup, one scoped commit. The engine names no module and resolves no version itself: npm resolves
ranges, and the closure is the presence graph modules already declare (`dreamteamer.dependencies`,
the key compile enforces for cross-module references). A folder of tarballs (`--from <dir>`) stands
in for the registry — the offline form candidates and acceptance use.

The other `install` forms — make THIS checkout ready, `--clone`, `repos/<id>`, `--hook` — stay in
src/checkout.ts and src/init.ts; this file is only the spec form.

## namespace

Files: [collections/qualify.ts](collections/qualify.ts) · [record/namespace.ts](record/namespace.ts) · [record/namespaceProblems.ts](record/namespaceProblems.ts) · [record/normalizeNamespaces.ts](record/normalizeNamespaces.ts) · [record/parseRef.ts](record/parseRef.ts) · [record/singular.ts](record/singular.ts) · [record/storageOverlaps.ts](record/storageOverlaps.ts) · [record/unqualifiedProblems.ts](record/unqualifiedProblems.ts)

NAMESPACES — how a collection name is scoped, and how a reference splits back apart.

A namespace is a slash-delimited prefix on a collection name: `health/doctors` is the collection
`doctors` in the namespace `health`, and its records live under `data/health/doctors/`. A
reference to one of those records is `health/doctors/dana-levi`.

⚠ THE WHOLE PROBLEM IN ONE LINE: an id is ALSO a slash-delimited path (`meetings/2026/07/kickoff`
is one collection and a three-segment id), so `a/b/c` is either collection `a` + id `b/c` or
collection `a/b` + id `c`, and nothing about the STRING says which.

So namespaces are DECLARED, in the workspace package.json:

    "dreamteamer": { "namespaces": ["health", "finance", "work/clients"] }

and every split consults that closed set, longest match first. The alternative — inferring the
boundary from whichever collections happen to exist — was rejected: it makes the meaning of a
reference depend on the current descriptor set, so installing a module could silently re-point
references in records nobody edited. A declared list also turns the dangerous case (a namespace
whose name collides with a collection's) into a compile error instead of a longest-prefix win.

The DEFAULT namespace is the empty prefix. `tasks/kickoff` is a reference into it, `data/tasks/`
is where it lives, and that is exactly what every workspace already has — which is why adopting
namespaces migrates nothing. `default` is reserved precisely so there is never a second spelling
for the same collection.

This module is deliberately PURE — the declared list arrives as an argument. compile validates it
and writes it into the manifest; runtime.js hands it to the record layer. Nothing here reads a
file, so all of it is unit-testable without a workspace.

## placement

Files: [check/symlinkedChildRoots.ts](check/symlinkedChildRoots.ts) · [record/dirTreeStamps.ts](record/dirTreeStamps.ts) · [record/ownerIdOf.ts](record/ownerIdOf.ts) · [record/parentFolders.ts](record/parentFolders.ts) · [record/placedChildAt.ts](record/placedChildAt.ts) · [record/placedRecords.ts](record/placedRecords.ts) · [record/placement.ts](record/placement.ts) · [record/placementOfFile.ts](record/placementOfFile.ts) · [record/rootRecords.ts](record/rootRecords.ts) · [record/subpathProblem.ts](record/subpathProblem.ts) · [record/symlinkBelow.ts](record/symlinkBelow.ts) · [record/types.ts](record/types.ts)

RELATIONSHIP-BASED STORAGE — a record stored UNDER the record it belongs to.

A child collection declares, on its own `storage` block, which scalar reference field names its
parent and where inside the parent's folder its records go:

    storage: { under: { parent: company, subfolder: meetings } }

so a meeting whose `company` is `companies/northwind` lives at
`data/companies/northwind/meetings/<id>.meeting.md`, and one with no company stays in the
collection's own root (`data/meetings/`). The parent must be a folder-shape collection, because
only a folder can hold anything beside the record itself. compile records the parent collection,
so the record layer never reads a field's type to find it.

Three invariants every reader and writer here holds:
  - ONE logical collection. Listing walks the fallback root and every parent's child folder;
    a reference is `<collection>/<id>` wherever the file sits. The id is the path inside
    WHICHEVER root the file is in, so moving a record between parents changes no id.
  - PLACEMENT FOLLOWS THE FIELD, never the other way round. The field is the intended owner and
    the folder is observed placement; `check` reports the two disagreeing and `relocate` reconciles
    them. Nothing ever infers an owner from where a file was found.
  - ONE LEVEL. A placed collection cannot itself be a parent — enough for company → meetings /
    contacts / projects, and the nesting a second level needs can be added when something wants it.

This module is in the RECORD layer and reads compiled descriptors only: nothing here knows what a
module, an overlay or a schema source is. Store and check both enumerate through it so they cannot
disagree about which files are records.

## presentation

Files: [record/presentation.ts](record/presentation.ts)

The display contract — compiled descriptors → what every surface draws (the extension, the mobile
app, the REST layer). One read model, so no surface re-derives a label, a column list or a
read-only rule from a descriptor on its own.

It reads a compiled descriptor ONLY through `src/descriptor.ts` — the accessors resolve what the
author wrote over what compile supplied (`displayOf`, `titleOf`, `recordTitleOf`, `storageOf`) and
hand over the resolved field list, the three injected fields included (`fieldsOf`). Nothing here
names a `compiled` key, so the contract cannot drift from what the store and check read. Every key
it emits is a name from the design's display-contract table, one word per meaning;
`test/unit/presentation-contract.test.js` lists them and fails on any other.

  { collections: [CollectionRow], fields: { <collection>: [FieldRow] }, relations: [RelationRow] }

Pure: no fs, no git, no workspace.

## record-commands

Files: [collections/commandsFor.ts](collections/commandsFor.ts) · [collections/recordResolver.ts](collections/recordResolver.ts)

record⇄command evaluation — which bound commands apply to a record (or a list
selection), and in which state. a binding is a `command-bindings` record: a m2m
join (command × collection) carrying `available_when` / `done_when` filter predicates,
evaluated with the SAME operator set as list-view filters plus one-hop outbound
ref traversal (tier 1). serves `dreamteamer commands for`, GET /api/commands/:name,
and (through the extension's api.ts port) the studio's Commands tab.

## records-api

Files: [records-api.ts](records-api.ts)

The RECORD half of the public API — `import … from 'dreamteamer/records'`. Records over git and the
read models a surface draws, and nothing that knows modules, harnesses, extensions or the CLI.

It exists as its own entry for ONE consumer with a hard constraint: the mobile app runs the Store
unmodified in a browser over a virtual filesystem, with shims for `node:fs`, `node:path` and
`node:child_process` and nothing else. The full API pulls in the compiler, the extension loader
and the CLI, which reach for `node:url`, `node:crypto` and `node:os` at import time. This file's
import closure is pinned to those three builtins by test/integration/public-api.test.js.

`dreamteamer` (src/api.ts) re-exports everything here, so a node consumer never needs two imports.

## records

Files: [record/idFromRecordPath.ts](record/idFromRecordPath.ts) · [record/parseRecordText.ts](record/parseRecordText.ts) · [record/records.ts](record/records.ts) · [record/walk.ts](record/walk.ts)

shared record primitives — parsing, id patterns, error formatting — used by
both the validating store (hard, write-time) and check (soft, report-only).

## relations

Files: [record/expectedMirrors.ts](record/expectedMirrors.ts) · [record/ownersReadIn.ts](record/ownersReadIn.ts) · [record/relationsOf.ts](record/relationsOf.ts) · [record/types.ts](record/types.ts)

Relations, decoded ONCE. A relation is a mirror field (`mirror_of: <owner field>`) in the compiled
runtime, so check, the store's mirror maintenance, `dt relations`, rebuild and presentation all
read through here and can never disagree about what a relation is.

## runtime

Files: [runtime/exportsFacts.ts](runtime/exportsFacts.ts) · [runtime/loadDescriptors.ts](runtime/loadDescriptors.ts) · [runtime/runtime.ts](runtime/runtime.ts) · [runtime/sourceRoots.ts](runtime/sourceRoots.ts)

THE BOUNDARY — `.dreamteamer/` is the one artifact the two halves of this engine share.

The workspace compiler WRITES it (compile.js: modules × sources → merged descriptors + manifest).
The record layer READS it, and reads nothing else: store.js has never needed to know that
modules, channels, `extends` or `templates` exist. That seam was already real — it just wasn't
enforceable, because reaching the compiled output meant importing compile.js, which put a
record-layer → compiler edge in the graph for what is really a file-format dependency.

Everything the record layer actually wanted is already IN the compiled output: the merged
descriptors, and (in the manifest) which directories hold the sources behind runtime-based
records. So this module owns the runtime's shape, both halves import it, and `npm run layers`
fails if the old edge comes back.

## scaffold-templates

Files: [collections/extensionText.ts](collections/extensionText.ts) · [collections/readmeText.ts](collections/readmeText.ts) · [collections/scaffoldKey.ts](collections/scaffoldKey.ts) · [collections/testText.ts](collections/testText.ts)

The text `dt add modules` writes beside a new module's package.json (cr-dt-007, G4): a README with the
install line, and — under `--extension` — an extension entry whose one setup unit asks for one token and
lets the engine write it into .env (the env action, D61). Pure: strings in, strings out.

## schema-ops

Files: [collections/PARTIAL_OPS.ts](collections/PARTIAL_OPS.ts) · [collections/addField.ts](collections/addField.ts) · [collections/applyRewrites.ts](collections/applyRewrites.ts) · [collections/baseDescriptorSource.ts](collections/baseDescriptorSource.ts) · [collections/collectionSourceFile.ts](collections/collectionSourceFile.ts) · [collections/createCollection.ts](collections/createCollection.ts) · [collections/createModule.ts](collections/createModule.ts) · [collections/createSkill.ts](collections/createSkill.ts) · [collections/declaringSource.ts](collections/declaringSource.ts) · [collections/descriptorSources.ts](collections/descriptorSources.ts) · [collections/editWorkspacePkg.ts](collections/editWorkspacePkg.ts) · [collections/entitySource.ts](collections/entitySource.ts) · and 55 more

schema operations — source-writing mutations shared by the CLI meta verbs and the
server's schema endpoints. the contract (audit finding 11, clean-room bug 2): an op
writes sources, proves them with a REAL compile, and only then commits — an
uncompilable source can never land in history. the successful gate compile also
leaves the runtime fresh, which kills the add-field-right-after-collections-add
papercut (review finding 7): schema ops ARE explicit compiles.

## semver

Files: [workspace/satisfies.ts](workspace/satisfies.ts)

tiny semver-range checker for engine-pin checks — deliberately NOT npm's semver.
supported ranges: exact "1.2.3", "^1.2.3", "~1.2.3", ">=1.2.3", "*".
NOT supported (returns null, "can't tell"): "||" alternatives, hyphen ranges,
x-ranges (1.2.x), combined comparators (">=1.0.0 <2.0.0"), <, <=, >,
prerelease/build tags. callers treat null as "warn, don't guess".

## setup-contract

Files: [workspace/setup-contract.ts](workspace/setup-contract.ts) · [workspace/validateEnvAction.ts](workspace/validateEnvAction.ts) · [workspace/validateSetup.ts](workspace/validateSetup.ts)

The `setup` contribution — extension API 1, setup version 1.

A module that needs something from the person (a folder, a token, a download, a sign-in) declares
HOW through a list of units, and the engine drives every unit the same way: `dt install` fills the
unit's inputs and applies its safe actions, `dt setup` resumes and verifies, `dt status` folds its
checks into one line. The engine never learns a module's name — a unit is addressed by its `id`,
identical whether its module is installed alone or composed into a bigger package.

  setup: [{
    id: 'meetings', version: 1,
    inputs: [{ id, title?, env?, kind: 'string'|'path'|'rows'|'secret-path', required?, default?, prompt?, rows?: { columns } }],
    inspect(ctx)                 → { checks: [{ id, status, title, detail?, fix?, evidence? }] }
    plan(ctx, inputs)            → { checks, actions: [{ id, title, effects: [{ kind, detail }], preview?, expect?, runBy?, kind? }], needs: [inputId] }
    apply(ctx, action, inputs)   → { ok, changed: [paths], message? }
  }]

This file is the validator and nothing else: pure, no fs, so the contract is testable without a
workspace. `src/setup.ts` runs the units.

## setup

Files: [setupCommand.ts](setupCommand.ts) · [status/renderStatusLines.ts](status/renderStatusLines.ts) · [status/statusLines.ts](status/statusLines.ts) · [status/types.ts](status/types.ts) · [workspace/consent.ts](workspace/consent.ts) · [workspace/fillInputs.ts](workspace/fillInputs.ts) · [workspace/fold.ts](workspace/fold.ts) · [workspace/judgeEnvAction.ts](workspace/judgeEnvAction.ts) · [workspace/parseAllow.ts](workspace/parseAllow.ts) · [workspace/parseInputFlags.ts](workspace/parseInputFlags.ts) · [workspace/redact.ts](workspace/redact.ts) · [workspace/runUnit.ts](workspace/runUnit.ts) · and 7 more

`dt setup` — and the setup half of `dt install` and `dt status`: the engine's generic driver for
the units modules declare (src/setup-contract.ts). Nothing here knows a module: it fills inputs,
asks consent per effect, runs inspect → plan → apply → inspect, folds the checks into one line and
keeps a unit's receipts. The vocabulary is the design's (rnd/design-docs/2026-11-12--cli-first-module-lifecycle):

  inputs    --input id=value (or unit.id=value) → the environment → the declared default → a TTY
            prompt for what is still missing → `needs`. Two inputs naming one env key are ONE input.
  consent   workspace-files never asks; download / network / machine ask y/n in a TTY or run under
            --allow <kind>; account runs only under `setup <unit> --authorize`, in a TTY.
  status    skipped · no-evidence · blocked · configured · ready [· verified <date>]
  receipts  .dreamteamer/setup/<unit>/ — per machine, gitignored with the runtime, never committed

Pure functions first (tested without a workspace), then the runner and the verb.

## store

Files: [record/Store.ts](record/Store.ts) · [record/atomicWrite.ts](record/atomicWrite.ts) · [record/bodyField.ts](record/bodyField.ts) · [record/gitDateToStamp.ts](record/gitDateToStamp.ts) · [record/serialize.ts](record/serialize.ts)

the validating store — every tooling write goes through here:
parse → coerce → defaults → validate (HARD: rejected before disk) →
atomic write → one git commit. direct file edits stay first-class and are
covered by `check` after the fact.

## template

Files: [record/applyFilter.ts](record/applyFilter.ts) · [record/fmtDate.ts](record/fmtDate.ts) · [record/generateId.ts](record/generateId.ts) · [record/parseTemplate.ts](record/parseTemplate.ts) · [record/renderDisplay.ts](record/renderDisplay.ts) · [record/template.ts](record/template.ts) · [record/types.ts](record/types.ts) · [record/validateTemplate.ts](record/validateTemplate.ts)

The ONE template grammar — every `{{ … }}` string a descriptor carries is parsed, validated and
rendered here: `id.from`, `record_title`, `item_title`, `display.record.subtitle`, and the layout
options `card_title`, `group_title`, `group_summary`.

  token    {{ field }} · {{ field | filter }} · {{ field | filter:arg | … }}
  field    a declared field, or a built-in: `id`, `created`, `last_modified` (and `seq` in an id)
  filters  date[:fmt] · datetime · slug · pad:n · basename — nothing else, in any position

Two positions render differently, on purpose. In an ID a reference renders as the id it holds (so
`basename` is the useful filter); in a DISPLAY template it renders through the target record's own
`record_title` (so `{{ doctor }}` reads as the doctor's name). `validateTemplate` is what compile
runs on every template it finds, so an unknown filter or a field that does not exist is a compile
error naming the position rather than a blank label in a surface.

## temporal

Files: [collections/compareValues.ts](collections/compareValues.ts) · [collections/parseTemporal.ts](collections/parseTemporal.ts) · [collections/sortRows.ts](collections/sortRows.ts) · [record/normalizeRecord.ts](record/normalizeRecord.ts) · [record/normalizeTemporal.ts](record/normalizeTemporal.ts) · [record/temporal.ts](record/temporal.ts) · [record/types.ts](record/types.ts)

temporal values — the `format: date` and `format: date-time` fields — normalized on WRITE and
compared as INSTANTS, never as strings.

Two decisions live here, and they are a pair:

1. A date-time keeps its LOCAL OFFSET (`2026-07-28T12:00:00+03:00`), it is not folded to Z.
   These records are markdown files a human reads and reviews in a git diff. A meeting at noon
   must say 12:00 in the file, not 09:00 with the reader expected to do timezone arithmetic in
   their head. The offset is what makes that wall-clock reading unambiguous rather than merely
   convenient — the value still denotes exactly one instant.

2. Because (1) means two correct values can carry different offsets, ordering CANNOT be a string
   compare. `compareValues` parses both sides to epoch ms first. Everything that orders records
   — `_lt`/`_gt`/`_lte`/`_gte`/`_between` in filter.js and the `?sort=` in server.js and the
   extension's api.ts — goes through it. Sorting temporals lexicographically is exactly the bug
   (1) would otherwise have introduced: `…T12:00:00+03:00` sorts after `…T11:00:00+01:00`
   (an EARLIER instant) on every naive comparison.

The write-side normalizer is why the strictness is bearable: ajv's `date-time` accepts one
spelling, but humans type `2026-07-28 12:00` and `<input type="datetime-local">` emits
`2026-07-28T12:00`. Both become the canonical form before validation, so the CLI and the studio
accept the same input — the engine/UI parity test applied to a data format.

## testing

Files: [testing.ts](testing.ts)

`dreamteamer/testing` — what a module's own test suite needs to test itself on the real engine,
with nothing but `node --test` and this import (cr-dt-007, G2). Every helper spawns the engine the
way a consumer runs it: `init` in a fresh folder, `dt install` of the module packed with `npm pack`
(so the package's `files` list is what is tested), then `dt` verbs. Nothing imports src/ by path, and
the engine is THIS file's package — never a `dreamteamer` that happens to be on PATH.

  createWorkspace({ engine? })  a fresh, committed workspace on the engine (DT_ENGINE_DIR wins when set)
  pack(moduleDir)               the tarball npm would publish
  install(ws, spec, opts?)      `dt install` of a name, a tarball, or a folder (packed first)
  run(ws, args, opts?)          the CLI in the workspace — { status, stdout, stderr }; status null on timeout
  engineMeets(range)            does the running engine satisfy a semver range

Synchronous throughout, so a test reads top to bottom. Temp folders are removed at exit unless
DT_KEEP_FIXTURES is set. Policy (D64): on 0.x a breaking change to this export lands in a minor,
announced one release ahead in UPDATING.md.

## types

Files: [types.ts](types.ts)

The PUBLIC CONTRACT's shapes — every type `dreamteamer` and `dreamteamer/records` publish. The
declarations consumers compile against (dist/*.d.ts) are GENERATED from the source, so these are the
types the exported functions are annotated with, and the code has to satisfy them: a declaration can
no longer say one thing while the runtime does another (KNOWN_OPERATORS was declared an array and was
a Set — review F8). Shapes the engine does not constrain (a record's fields, a descriptor's schema)
are typed loosely on purpose: they are the workspace's.

Types only — every import here is `import type`, erased by construction, so this file is no runtime
edge of any layer (scripts/layers.ts skips type-only edges).

## update-setup

Files: [update-setup.ts](update-setup.ts)

The setup half of `dt update`, in a process of its own (rnd/issues …dt-update-runs-the-previous-version-s-setup-unit).
The process that ran npm imported every extension when it opened the workspace, and ESM caches an
entry and all it imports by path — so it can only ever run the version being replaced. This file is
started by updateModules with `process.execPath`: it opens the workspace fresh (the new version's
files), runs the named units' safe part and the one scoped commit, and writes the result as JSON to
the file it is given — never to stdout, which a unit's own output may share. Exit 0 means the result
file holds the outcome (its `code` is the update's); anything else means it does not.

## update

Files: [update/parseUpdateArgs.ts](update/parseUpdateArgs.ts) · [update/updateModules.ts](update/updateModules.ts)

`dt update <name>[@<version>] | --engine` — move ONE pin forward on purpose: an npm module to the
latest release within its ranges (or to the named version), or the engine itself. Re-pinned
exactly, closure-checked exactly as `dt install` checks it, compiled, committed with install's
pathspec. A downgrade needs `--allow downgrade`; a development link is skipped and named. Nothing
here runs on its own, and `dt update` with no target keeps its meaning: git modules fast-forward.
A module update is install's steps 2–6 on the whole resolved closure, so a version that adds a
dependency brings it in and a version that adds a setup unit runs its safe part.

## views

Files: [collections/viewOverlayOf.ts](collections/viewOverlayOf.ts) · [workspace/bindingErrors.ts](workspace/bindingErrors.ts) · [workspace/filterFields.ts](workspace/filterFields.ts) · [workspace/overlayView.ts](workspace/overlayView.ts) · [workspace/types.ts](workspace/types.ts) · [workspace/viewDisplay.ts](workspace/viewDisplay.ts) · [workspace/viewErrors.ts](workspace/viewErrors.ts) · [workspace/views.ts](workspace/views.ts)

ui-views and command-bindings — validated against the collection they name, and a view's display
resolved over that collection's.

A view is a named variant of a collection's default view: it carries the same `display` block a
collection does, and compile merges it over the collection's sub-block by sub-block, a key the
view sets winning. A binding joins a command to a collection and gates it on the record's own
fields (`available_when`, `done_when`). Both are checked here, in their own vocabulary, against
the fields of the collection they name, so a dangling name is a compile error naming the
position rather than a view that draws nothing or a gate that never opens.

A name a module may legitimately not see yet — a field an overlay of an absent PEER collection
adds — is reported as a warning instead when the caller says the module declares an absent peer:
the condition then reads as not met, which is the peer contract.

Pure: no fs, no git. Errors are returned, never thrown, so compile attributes each to a file.

## workspace

Files: [record/declaredGitModules.ts](record/declaredGitModules.ts) · [record/ensureEditorRecommendation.ts](record/ensureEditorRecommendation.ts) · [record/ensureEnvExample.ts](record/ensureEnvExample.ts) · [record/findWorkspace.ts](record/findWorkspace.ts) · [record/layerEntries.ts](record/layerEntries.ts) · [record/workspace.ts](record/workspace.ts)

workspace discovery: the NEAREST package.json with a `dreamteamer` section wins, except when
that candidate is only nested inside a higher one as a MODULE — modules are themselves
dreamteamer packages (fractal), so `git_modules/dreamteamer`, `node_modules/@dreamteamer/*` and
`modules/<workspace-module>` must all resolve outward to the workspace that contains them.
It used to be "topmost wins", which got the module cases right by accident and every genuinely
nested workspace wrong: a workspace living under another one's tree (a vault may keep per-identity
repos at projects/<identity>/<repo>/) resolved to the OUTER workspace, so every command
silently operated on the wrong repo — compile wrote the wrong runtime, check counted the wrong
records, all reporting success. `projects/` is not a module segment, so nesting there is a
real workspace and now resolves as one.

## yaml

Files: [collections/renameKeys.ts](collections/renameKeys.ts) · [fmt/formatSource.ts](fmt/formatSource.ts) · [record/emitDocument.ts](record/emitDocument.ts) · [record/endOf.ts](record/endOf.ts) · [record/writeSource.ts](record/writeSource.ts) · [record/yaml.ts](record/yaml.ts)

contract rule: YAML is parsed with the CORE schema — unquoted dates stay strings,
never timestamp objects. ALL dreamteamer tooling loads YAML through here.
