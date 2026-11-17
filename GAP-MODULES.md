# Module gap analysis

What it would take for every published DreamTeamer module to run on this engine, module by module, in the order the
modules are actually used. It builds on [GAP-2.md](GAP-2.md), whose gap ids it reuses, and adds what measuring the
modules and real workspaces found that GAP-2 did not.

Measured on 2026-11-17 against engine commit `1863bee` (2,279 lines), the modules repository at `67a6f870`
(37 modules), and 76 workspace repositories on one development machine, all read-only. Workspace and repository names
are left out; their numbers are kept.

## What we learned

1. **The schema core is not the hard part.** All 37 modules load together with 0 errors and 0 warnings, provided
   the collections that DreamTeamer itself defines (`repos`, `agents` and the other system collections) are available.
   On the one large real workspace this engine has been compared on, `check` agrees with the released engine to the
   record (4,837 records, 0 errors, 0 warnings), and records written here pass the released `check`.
2. **What the modules lean on is the surface around the schema.** 15 of 37 modules ship an extension; 36 commands,
   47 command bindings, 39 UI views and 2 agents exist; the modules' documents call 34 distinct verbs, and 26 are
   missing here — 13 engine verbs and 13 that extensions add. Extensions call about 45 distinct engine functions.
3. **Real data finds what fixtures do not.** Across 76 repositories the two engines agree on 43 (both clean). In 24
   the released engine is clean and this one reports errors. Four causes explain nearly all of them, and three were
   not in any gap report: enums written as maps, references to system records, and records in record layers.
4. **The UI is reusable as it is; the protocol's server side is not.** The Web UI ran unchanged on a 290-line host
   that answers 9 of the protocol's 37 routes. The protocol package's own handler, nav and presentation code load the
   released engine, so only its route table could be reused. The contract worth keeping is the route table and the
   shapes, not the server code.
5. **Estimates held; the house style costs lines.** The sweet spot landed inside its estimate; reverse fields took
   about 250 lines against an estimate of 110–210, because one file per export and Prettier's wrapping roughly double
   the line count of the same logic. Every figure below is in the house style.
6. **Compatibility has to be measured from both sides.** This engine's `check` on released-written data, and the
   released `check` on data written here. Each found defects the other did not.

## How it was measured

| Measurement | How | Result |
|---|---|---|
| Every module's schema | the 37 module folders copied into one scratch workspace, plus the released engine's system module; `check` | 84 collections, 38 modules, 0 errors, 0 warnings. Without the system module: 30 errors, all a type `repos` or `agents` |
| What each module ships | its folders and descriptors, counted | the per-module table below |
| What the skills call | every `dt <verb>` in a module's Markdown | 34 verbs. Missing engine verbs, by modules naming them: `commit` 9, `status` 9, `resolve` 6, `next` 5, `rename` 5, `setup` 5, `install` 4, `doctor` 3, `add-field` 2, `export` 2, `init` 1, `set-field` 1, `values` 1. The other 13 missing verbs are extensions' own (`files`, `session`, `worktree`, `prove`, `web` …) |
| Expected use | each repository's direct dependencies, and the records this engine reads per module | the order of the table below |
| Agreement on real data | this engine's `check` and each repository's own released engine's `check`, on all 76 | 43 both clean · 24 only this engine reports errors · 3 only the released engine does · 6 both · 1 unreadable by the released engine |

Records counted here are a lower bound: records in record layers and in folders this engine does not read are not
counted.

### Why the two engines disagree on real data

| Cause | Gap | Evidence | Fix |
|---|---|---|---|
| An enum written as a map (`low: { label: Low }`) is refused, so the field is dropped and every record holding it reports an unknown field | **E1**, new | 98 field definitions in compiled workspaces use the map form, among them `confidence`, `status`, `kind`, `origin`, `lane` of older module versions; they account for most of the 10,000+ "unknown field" errors | Read a map enum: its keys are the values, its entries carry `label`, `color`, `icon`, `description` |
| A reference to a system record (`collections/<name>`, `repos/<id>`, `agents/<id>`) has nothing to resolve to | **D10** | 6,281 broken references in `rnd` user stories (`reads`, `writes` → `collections/…`); every `repo` field in rnd, projects, sessions and perspective | Ship the system collections, and read their records from the model and the module folders |
| Records and modules in record layers (`git_modules`) are not read | **M8** | 55 collections the released engine compiles from layers are absent; most of the broken `meeting`, `company`, `decider`, `ours` references | Read layers as further roots |
| Records stored inside their owner's folder (`storage.under`) are not found | **D11** | 383 "unrecognized file in the companies folder"; broken `meeting` references from recordings, meeting docs and contacts | Read `under` placement |

The remaining differences are smaller: 8 collections from workspace modules this engine does not discover, 29 from
installed packages not yet traced individually, and 40 fields contributed by overlays from layers.

## Modules by expected use

Ordered by how many repositories install the module, then by how much data it holds. A preset's members are counted
where they are listed directly; `core` carries all seventeen of them in another 59.

**Columns.** *Use*: repositories installing it · repositories where this engine reads records of it · records read.
*Ships*: c collections, o overlays, s skills, cmd commands, b bindings, v UI views, a agents. *Code*: lines of
JavaScript and Vue, tests excluded. *Needs*: what the module relies on beyond what runs today.
*Runs today*: **S** schema loads, **R** records agree with the released `check` where measured, **K** its skills'
verbs exist, **X** its extension runs. ✔ yes · ◐ partly · ✖ no · — nothing to run.

| # | Module | Use | Ships | Code | Needs | S | R | K | X |
|---|---|---|---|---|---|---|---|---|---|
| 1 | core (preset) | 59 · 30 · 1,680 | preset of 17, nav | 0 | preset members installed (M1), nav (U1) | ✔ | ◐ | — | — |
| 2 | rnd | 58 · 29 · 8,929 | 21c, 10s, 12cmd, 32b, 11v, 2a | 2,619 | D10, V3 (8 objects, 2 constraint sets), `resolve` (8 env paths), M4/A1, `next`, `commit`, `rename`, `values`, extension (check, next, setup), nav, U1 | ✔ | ◐ | ✖ | ✖ |
| 3 | search | 14 · 0 · 0 | 1s, 1cmd | 343 | extension (setup), `status`, `setup` | ✔ | — | ✖ | ✖ |
| 4 | tasks | 8 · 6 · 556 | 1c 2o, 1s, 9v | 273 | E1 for older versions, `commit`, U1 for its views | ✔ | ◐ | ◐ | — |
| 5 | contacts | 9 · 5 · 425 | 1c 1o | 0 | E1 (older versions), M8/D11 for meeting references | ✔ | ◐ | — | — |
| 6 | users | 9 · 5 · 17 | 2c | 77 | E1 (older versions) | ✔ | ◐ | — | — |
| 7 | companies | 9 · 3 · 62 | 1c | 0 | E1 (older versions) | ✔ | ◐ | — | — |
| 8 | assets | 9 · 0 · 0 | 1c, 1v | 0 | binary records (D11) | ✔ | ✖ | — | — |
| 9 | files | 7 · 4 · 1,725 | 2c, 1s, 1cmd, 1b, 2v | 722 | E1, `resolve`, extension (commands, check, doctor, next, setup), `commit`, `rename` | ✔ | ◐ | ✖ | ✖ |
| 10 | meeting-docs | 7 · 4 · 677 | 3c 2o, 2s, 6cmd, 5b, 1v | 0 | V3 (2 unique), D11/M8 for meeting references, M4/A1, `resolve`, `rename` | ✔ | ◐ | ◐ | — |
| 11 | recordings | 7 · 4 · 510 | 1c 1o, 2s, 3cmd, 3b | 790 | V3 (map), D11/M8, `resolve`, `commit`, `install`, extension (setup) | ✔ | ◐ | ✖ | ✖ |
| 12 | meetings | 7 · 4 · 387 | 1c 1o, 1s, 2cmd, 1b, 2v | 933 | V3 (2 objects), `resolve`, `commit`, D11 placement, M4/A1 | ✔ | ◐ | ◐ | — |
| 13 | engagements | 7 · 2 · 15 | 1c 1o, 1cmd, 1b, 1v | 0 | V3 (constraints), M4/A1 | ✔ | ◐ | ✔ | — |
| 14 | projects | 4 · 3 · 899 | 4c 2o | 163 | D10 (`repos`), V3 (constraints), `resolve` | ✔* | ✔ | ✔ | — |
| 15 | notebooklm | 4 · 3 · 19 | 1c 1o, 2s, 2cmd, 2b | 1,129 | E1, V3 (2 objects), `resolve`, extension (commands, harnesses, next, setup), schema verbs | ✔ | ◐ | ✖ | ✖ |
| 16 | wikis | 4 · 1 · 5 | 1c, 1s | 1,154 | E1, `resolve`, extension (setup) | ✔ | ◐ | ✖ | ✖ |
| 17 | knowledge | 3 · 1 · 68 | 3c, 1s, nav | 0 | D10/M8 for related records, nav (U1) | ✔ | ◐ | ✔ | — |
| 18 | routines | 3 · 3 · 5 | 1c, 1s | 262 | — | ✔ | ✔ | ✔ | — |
| 19 | workflows | 3 · 0 · 0 | 1c, 1s, 1cmd | 155 | V3 (object, constraints), `next`, `commit`, `install` | ✔ | — | ✖ | — |
| 20 | sessions | 3 · 1 · 1 | 1c 1o, 1s, 3cmd | 630 | D10 (`agents`, `repos`), `resolve`, extension (commands, source kinds, analyze, hooks, check, next) | ✔* | ✔ | ✖ | ✖ |
| 21 | web | 3 · — · — | 1s, 1cmd | 2,098 | extension (commands, hooks, next) and the full protocol host (U1) | — | — | ✖ | ✖ |
| 22 | git-identities | 3 · — · — | 1s | 123 | extension (setup), `status` | — | — | ✖ | ✖ |
| 23 | artifacts | 3 · 2 · 10 | 1c (folder records) | 0 | — | ✔ | ✔ | — | — |
| 24 | metrics | 3 · 0 · 0 | 1c | 0 | D10 (`agents`), V3 (object) | ✔* | — | — | — |
| 25 | roles | 3 · 0 · 0 | 1c 1o | 0 | — | ✔ | — | — | — |
| 26 | responsibilities | 3 · 0 · 0 | 1c 1o | 0 | — | ✔ | — | — | — |
| 27 | perspective | 2 · 2 · 3,572 | 23c, 11s, 1cmd, 10v | 7,160 | D10 (`repos`), V3 (6 objects, 2 maps, 3 unique), extension (commands, next, setup), schema verbs, `rename`, `commit` | ✔* | ✔ | ✖ | ✖ |
| 28 | http | 2 · — · — | — | 241 | extension (commands) | — | — | — | ✖ |
| 29 | proofs | 1 · 0 · 0 | 1c, 1s | 2,296 | V3 (2 objects, 2 maps), extension (commands, source kinds, analyze, orientation, check, next) | ✔ | — | ✖ | ✖ |
| 30 | connectors-google-workspace | 1 · — · — | 2s, 1cmd, 1b | 1,597 | extension (commands, doctor, next, setup), `setup`, `install`, `status` | — | — | ✖ | ✖ |
| 31 | connectors-linkedin | 1 · — · — | 1s, 1cmd, 1b, 2v | 377 | M4/A1, U1 | — | — | ✔ | — |
| 32 | ui | 1 (via web) | the UI | 38,234 | the protocol host (U1) | — | — | — | — |
| 33 | protocol | 1 (via web) | route table and contract | 5,488 | a host that does not load the released engine | — | — | — | — |
| 34 | worktrees | 0 | 1s | 872 | extension (commands, hooks), `commit` | — | — | ✖ | ✖ |
| 35 | code | 0 | — | 408 | extension (commands) | — | — | — | ✖ |
| 36 | docker-workspaces | 0 | 1s | 1,182 | its own scripts only | — | — | ✔ | — |
| 37 | connectors-macos | 0 | 1s | 0 | — | — | — | ✔ | — |

\* loads only with the system collections, which today come from the released engine's package (D10).

**Where R is ◐**, the measured disagreements trace to E1, D10, M8 and D11 above, not to the module's current
descriptors: the published versions of tasks, users, companies, contacts, files and meetings write their enums as
lists. **Where K is ✖**, a skill tells the agent to run a verb this engine does not have. **Where X is ✖**, the module
does nothing beyond its collections until extensions can load.

### What the modules ask of the engine, counted

| Need | Modules | Gap | Size, lines |
|---|---|---|---|
| System collections and records (`repos`, `agents`, `collections/<name>`) | rnd, projects, sessions, metrics, perspective, knowledge | D10 | E 80–160 · T 40–70 |
| Enums written as maps | older versions of 10 modules; workspace modules | E1 | E 15–30 · T 15–25 |
| Object and map contents, uniqueness, constraints | rnd, perspective, proofs, meetings, notebooklm, metrics, workflows, recordings, meeting-docs, engagements, projects | V3 | E 90–210 · T 50–90 |
| Record layers | every workspace that uses `git_modules` | M8 | E 100–200 · T 60–110 |
| Records under their owner; binary records | meetings placement, assets | D11 | E 100–200 · T 60–100 |
| `resolve` (`${env:…}` paths) | rnd, files, meetings, recordings, notebooklm, wikis, sessions, projects, perspective | D13 | A 20–35 |
| Commands, agents, bindings read and delivered to the harness | 14 modules with 36 commands, 47 bindings, 2 agents | M4 · A1 · A5 | A 180–330 · T 80–140 |
| `commit`, `changes`, `next`, `rename`, `values` | 13 modules' skills | G1 · D13 | A 240–455 · T 110–190 |
| The extension API | 15 modules: contributions `commands` 9, `setup` 8, `next` 7, `check` 4, `hooks` 3, `doctor` 2, `analyze` 2, `sourceKinds` 2, `harnesses` 1, `orientation` 1 | M5 | A 150–400 for the API · T 80–150; each extension then needs checking against it |
| `install`, `setup`, `status`, `doctor`, presets | core, search, recordings, google, git-identities, workflows | S2 · M1 | A 230–500 · T 130–250 |
| The full protocol host, UI views, nav | ui, web, and every module that ships views | U1 · R1 | A 500–1,000 · T 150–300; the read path measured at 290 |
| Schema verbs (`add-field`, `set-field` …) | notebooklm, perspective | D13 | A 300–700 |

## The best path

Each wave is ordered so that its work unlocks the most-used modules first, and each ends with a measurement: the
76-repository comparison, and the modules' own skills run against the engine.

| Wave | Work | Size, lines | What it unlocks |
|---|---|---|---|
| **1. Agree on the data** | E1, D10, V3 with N1 | E 200–430 · T 120–210 | Records agree with the released `check` in most of the 24 repositories that disagree today; the schema of all 37 modules loads without the released package. Fully usable at the record level: core's members, rnd's records, projects, metrics, artifacts, roles, responsibilities, routines |
| **2. Read every record** | M8, D11 | E 200–400 · T 120–210 | The remaining broken references; assets; meetings stored under companies; every workspace that composes record layers |
| **3. Reach the agent** | M4, A1, A5; `resolve`, `commit`, `changes`, `next`, `rename`, `values` | A 440–820 · T 190–330 | The skills and commands of rnd, tasks, meetings, meeting-docs, recordings, engagements, files, workflows and linkedin run as written; the lifecycle runs on `next` |
| **4. Extensions** | M5, designed against the 45 functions extensions call today, then each extension checked in order of use: rnd, search, files, recordings, sessions, notebooklm, wikis, web, git-identities, google, perspective, proofs, http, worktrees, code | A 150–400 for the API, plus an unmeasured amount per extension | Everything a module does beyond its collections |
| **5. See and install** | the full protocol host (U1, R1), then S2, M1 | A 730–1,500 · T 280–550 | The Web UI with writes, history and views; installing, setting up and upgrading modules through the engine |

**Together** about 1,700 to 3,600 lines of engine and adapter code before extension ports, against 4,700 lines left
in the 7,000-line budget. Waves 1 to 3 fit with room to spare. Wave 4 is the uncertain one: the API is bounded, but 15
extensions written against the released engine's internals (`Store`, `describeCheckout`, `openWorkspace` …) will need
changes on their side, and what remains of the budget decides how much of wave 5 is engine and how much stays in
modules.

**Why this order.** Wave 1 is the cheapest work with the widest reach: E1 alone removes most of the measured
disagreement, and D10 is what rnd — the second most installed module and the one with the most data — depends on.
Wave 2 completes the data before any verb builds on it. Wave 3 is what makes an agent able to follow the modules'
skills, which is the purpose of a module. Extensions come after, because their API should be designed against an
engine that already reads every record and serves every verb they call.

## Decisions the path needs

1. **System collections: shipped by this engine, or read from the released package?** Recommended: shipped, as a
   small system module of this engine, with the records projected from the model. Reading the released package keeps
   a runtime dependency on the engine being replaced.
2. **The extension API: the released one, or a smaller one?** Recommended: smaller, measured from use — the ten
   contribution keys and the functions extensions actually call — with a shim per extension where needed.
3. **The protocol host: grow the 290-line host, or make the protocol package's server code engine-neutral?**
   Recommended: grow the host and keep the protocol's route table and contract suite as the authority; run the
   contract suite against it.

## Assumptions and uncertainty

- **Expected use** is measured on one development machine: 76 repositories, many of them templates, pilots and
  clones of one another. It ranks modules reliably at the top and bottom; the middle is close.
- **Record counts** are what this engine reads, and therefore a lower bound wherever M8 or D11 applies.
- **The causes of disagreement** were traced by kind, not record by record. 29 missing collections from installed
  packages are not yet explained.
- **Sizes** reuse GAP-2's estimates where the gap is the same and are new for E1, D10's records, the protocol host and
  the waves. Extension ports are not estimated: no extension has been run against this engine.

## What has changed since

- **E1 closed** (enum maps are read: the keys are the values, the entries are kept as `choices`). Across the 76
  repositories, the new engine's errors fell from 21,050 to 7,948, and the repositories where both engines are clean
  rose from 43 to 46. What remains is references: to system records (D10), and to records in layers or under their
  owners (M8, D11).
- **The command line is table-driven** (no behaviour change): each verb is one file in `src/cli/verbs/` with its
  usage line, options and handler, and `main.ts` only dispatches, so a new verb is a new file and one line in the
  table. Engine 2,424 lines.
- **A name every object inherits is not a verb**: `constructor`, `toString` and the like are refused as an unknown
  verb with exit status 2, where they used to run `check`. Engine 2,419 lines.
- **D10 closed for references and reads**: the engine ships the system module as data (the released 0.49.1 files,
  pinned byte for byte by a test) and loads it always, once. References to `repos/…`, `collections/<name>`,
  `modules/<id>`, `skills/<id>`, `mixins/<id>`, `agents/…`, `commands/…`, `command-bindings/…` and `ui-views/…`
  resolve; `list` and `get` answer for the source kinds from the model, and writes to them are refused. On the large
  real workspace `check` still reports 4,837 records, 0 errors, 0 warnings (source records are not counted); the 37
  modules' schemas load with 0 errors without the released package. Across the 76 repositories, errors fell from
  7,948 to 1,578 and both-clean rose from 46 to 53; this engine alone reports errors in 14, down from 21. What remains
  is mostly references into record layers and owner folders (M8, D11): `meeting`, `company`, `item`, and 68 `repo`
  references to records held elsewhere. Engine 2,619 lines.
- **R1 closed**: a collection's `display`, `title`, `record_title`, `internal`, `sensitive` and `constraints` are kept
  in the model and in `.dt/model.json` as written, with mixins beneath the descriptor and overlays above it, the
  released engine's merge; everything its `presentation()` reads from a collection is now there. No other behaviour
  changed: the large real workspace still checks at 4,837 records, 0 errors, 0 warnings. Engine 2,687 lines.
